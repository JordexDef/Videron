package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	errProjectName                  = errors.New("VD_PROJECT_NAME")
	errProjectExists                = errors.New("VD_PROJECT_EXISTS")
	errProjectMissing               = errors.New("VD_PROJECT_MISSING")
	errProjectUnsupported           = errors.New("VD_PROJECT_UNSUPPORTED")
	errProjectManagementUnsupported = errors.New("VD_PROJECT_MANAGEMENT_UNSUPPORTED")
	errProjectDeleted               = errors.New("VD_PROJECT_DELETED")
	errProjectChanged               = errors.New("VD_PROJECT_CHANGED")
	errProjectIDSpent               = errors.New("previous creation ID no longer identifies the requested project")
)

type ServerProject struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

const namedProjectFormat = "videron.named-server-project.v1"

type namedProjectProfile struct {
	Format  string        `json:"format"`
	Profile serverProfile `json:"profile"`
}

type ServerProjectList struct {
	Supported bool            `json:"supported"`
	CanManage bool            `json:"canManage"`
	Projects  []ServerProject `json:"projects"`
}

func validProjectName(name string) bool {
	return name != "" && utf8.ValidString(name) && utf8.RuneCountInString(name) <= 80 &&
		name == strings.TrimSpace(name) && strings.IndexFunc(name, unicode.IsControl) < 0
}

func (p *serverProfile) sameProject(other *serverProfile) bool {
	return p.ProjectID == other.ProjectID && (p.ProjectID == "" || p.Pin == other.Pin)
}

func (p *serverProfile) checkFolderProject(dir string) error {
	existing, err := loadProfile(dir)
	if err != nil {
		return err
	}
	if existing != nil && !p.sameProject(existing) {
		return errServerSpace
	}
	return nil
}

func readProjectJSON(res *http.Response, dst any) error {
	defer res.Body.Close()
	const maxSize = 4 << 20
	data, err := io.ReadAll(io.LimitReader(res.Body, maxSize+1))
	if err != nil || len(data) > maxSize || json.Unmarshal(data, dst) != nil {
		return errServerProtocol
	}
	return nil
}

func (p *serverProfile) listProjects(ctx context.Context, c *http.Client) (ServerProjectList, error) {
	resp, err := p.requestContext(ctx, c, http.MethodGet, "/v1/projects?version=2", nil)
	if errors.Is(err, errSpaceMissing) {
		// Servers predating the catalog expose their single project at /v1/index.
		return ServerProjectList{Projects: []ServerProject{{}}}, nil
	}
	if err != nil {
		return ServerProjectList{}, err
	}
	var projects []ServerProject
	canManage := resp.Header.Get("X-Videron-Project-Management") == "1"
	if err = readProjectJSON(resp, &projects); err != nil {
		return ServerProjectList{}, err
	}
	seen := make(map[string]bool, len(projects))
	for _, entry := range projects {
		if seen[entry.ID] || entry.ID == "" && entry.Name != "" && (!canManage || !validProjectName(entry.Name)) ||
			entry.ID != "" && (!serverHex.MatchString(entry.ID) || !validProjectName(entry.Name)) {
			return ServerProjectList{}, errServerProtocol
		}
		seen[entry.ID] = true
	}
	if projects == nil || (!canManage && !seen[""]) {
		return ServerProjectList{}, errServerProtocol
	}
	return ServerProjectList{Supported: true, CanManage: canManage, Projects: projects}, nil
}

// Project management uses an unlocked, verified session. A legacy pairing
// code still connects to its original default project via Connect/Join.
func (a *App) projectProfile(ticket string) (serverProfile, error) {
	if !strings.HasPrefix(ticket, verificationTicketPrefix) {
		return serverProfile{}, errServerTicket
	}
	return a.resolveServerTicket(ticket)
}

func (a *App) ListServerProjects(ticket string) (ServerProjectList, error) {
	p, err := a.projectProfile(ticket)
	if err != nil {
		return ServerProjectList{}, err
	}
	c := p.client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	return p.listProjects(ctx, c)
}

func (a *App) SelectServerProject(ticket, id string) (VerifiedSyncServer, error) {
	before, err := a.projectProfile(ticket)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	if id != "" && !serverHex.MatchString(id) {
		return VerifiedSyncServer{}, errProjectMissing
	}
	p := before
	c := p.client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	list, err := p.listProjects(ctx, c)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	for _, entry := range list.Projects {
		if entry.ID == id {
			return a.selectServerProject(ctx, c, ticket, before, p, entry)
		}
	}
	if !list.Supported {
		return VerifiedSyncServer{}, errProjectUnsupported
	}
	return VerifiedSyncServer{}, errProjectMissing
}

func (a *App) CreateServerProject(ticket, name string) (VerifiedSyncServer, error) {
	before, err := a.projectProfile(ticket)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	name = strings.TrimSpace(name)
	if !validProjectName(name) {
		return VerifiedSyncServer{}, errProjectName
	}
	// Retrying a create after a lost response should select the same project.
	// Each verified ticket contains a new cryptographically random nonce.
	want := ServerProject{ID: hexID([]byte("create-project/" + ticket + "/" + name)), Name: name}
	p := before
	c := p.client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	for {
		err := p.createProject(ctx, c, want)
		if !errors.Is(err, errProjectIDSpent) {
			if err != nil {
				return VerifiedSyncServer{}, err
			}
			return a.selectServerProject(ctx, c, ticket, before, p, want)
		}
		// Reusing a freed name within this session creates a fresh identity.
		// Derive its ID deterministically so a lost reply is still retryable.
		want.ID = hexID([]byte("reuse-project-name/" + want.ID))
	}
}

func (p serverProfile) createProject(ctx context.Context, c *http.Client, want ServerProject) error {
	p.ProjectID = want.ID
	raw, err := json.Marshal(want)
	if err != nil {
		return err
	}
	resp, err := p.requestContext(ctx, c, http.MethodPost, "/v1/projects", bytes.NewReader(raw))
	if errors.Is(err, errSpaceMissing) {
		return errProjectUnsupported
	}
	if errors.Is(err, errProjectDeleted) {
		return errProjectIDSpent
	}
	if errors.Is(err, errChanged) {
		list, err := p.listProjects(ctx, c)
		if err != nil {
			return err
		}
		for _, entry := range list.Projects {
			if entry.ID == want.ID && entry.Name != want.Name {
				return errProjectIDSpent
			}
		}
		return errProjectExists
	}
	if err != nil {
		return err
	}
	var project ServerProject
	if err = readProjectJSON(resp, &project); err != nil || project != want {
		return errServerProtocol
	}
	return nil
}

// The ID in the dialog and the selected ticket must agree. The expected name
// is checked by the server in the same critical section as the mutation.
func (a *App) RenameServerProject(ticket, id, newName, expectedName string) (VerifiedSyncServer, error) {
	name := strings.TrimSpace(newName)
	if !validProjectName(name) {
		return VerifiedSyncServer{}, errProjectName
	}
	return a.changeSelectedProject(ticket, id, expectedName, name, http.MethodPatch)
}

func (a *App) DeleteServerProject(ticket, id, expectedName string) error {
	_, err := a.changeSelectedProject(ticket, id, expectedName, "", http.MethodDelete)
	return err
}

func (a *App) changeSelectedProject(ticket, id, expectedName, name, method string) (VerifiedSyncServer, error) {
	before, err := a.projectProfile(ticket)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	if before.ProjectID != id || (id != "" && !serverHex.MatchString(id)) {
		return VerifiedSyncServer{}, errProjectChanged
	}
	if !(id == "" && expectedName == "") && !validProjectName(expectedName) {
		return VerifiedSyncServer{}, errProjectChanged
	}
	key := id
	if key == "" {
		key = "default"
	}
	update := struct {
		Name         string `json:"name,omitempty"`
		ExpectedName string `json:"expectedName"`
	}{name, expectedName}
	body, err := json.Marshal(update)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	p := before
	c := p.client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	resp, err := p.requestContext(ctx, c, method, "/v1/projects/"+key, bytes.NewReader(body))
	if errors.Is(err, errSpaceMissing) {
		list, why := p.listProjects(ctx, c)
		if why != nil {
			return VerifiedSyncServer{}, why
		}
		if !list.CanManage {
			return VerifiedSyncServer{}, errProjectManagementUnsupported
		}
		return VerifiedSyncServer{}, errProjectMissing
	}
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	if method == http.MethodDelete {
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			return VerifiedSyncServer{}, errServerProtocol
		}
		// The deletion is already durable even if this ticket expired while
		// waiting for the response. Never ask the user to delete it again.
		p.ProjectDeleted = true
		p.Lineage = ""
		_, _ = a.updateProjectTicket(ticket, before, p)
		return p.verified(ticket), nil
	}
	var result ServerProject
	if readProjectJSON(resp, &result) != nil || result != (ServerProject{ID: id, Name: name}) {
		return VerifiedSyncServer{}, errServerProtocol
	}
	p.ProjectName = name
	return a.updateProjectTicket(ticket, before, p)
}

func (a *App) selectServerProject(ctx context.Context, c *http.Client, ticket string, before, p serverProfile, entry ServerProject) (VerifiedSyncServer, error) {
	p.ProjectID, p.ProjectName = entry.ID, entry.Name
	p.ProjectDeleted = false
	m, err := p.manifestSummary(ctx, c)
	if errors.Is(err, errSpaceMissing) {
		return VerifiedSyncServer{}, errProjectMissing
	}
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	p.Lineage = m.Lineage
	return a.updateProjectTicket(ticket, before, p)
}

func (a *App) updateProjectTicket(ticket string, before, p serverProfile) (VerifiedSyncServer, error) {
	tickets := &a.serverTickets
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	saved, ok := tickets.entries[ticket]
	if !ok || time.Now().After(saved.expires) || saved.profile != before {
		return VerifiedSyncServer{}, errServerTicket
	}
	saved.profile = p
	tickets.entries[ticket] = saved
	return p.verified(ticket), nil
}

// Reuse the protected credential for this connected folder. Confirm both the
// local lineage and the remote scoped manifest before issuing a WebView ticket.
func (a *App) ConnectedServerTicket(folder string) (VerifiedSyncServer, error) {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	ctx, generation, err := a.ticketContext()
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	p, err := loadProfile(dir)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	if p == nil {
		return VerifiedSyncServer{}, errServerTicket
	}
	lineage, err := a.openLineage(dir)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	if lineage != p.Lineage {
		return VerifiedSyncServer{}, errServerSpace
	}
	c := p.client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	m, err := p.manifestSummary(ctx, c)
	if errors.Is(err, errProjectDeleted) {
		p.ProjectDeleted = true
		return a.issueServerTicket(*p, generation)
	}
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	if m.Lineage != p.Lineage {
		return VerifiedSyncServer{}, errServerSpace
	}
	return a.issueServerTicket(*p, generation)
}
