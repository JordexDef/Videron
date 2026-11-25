package syncclient

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	ErrProjectName                  = errors.New("VD_PROJECT_NAME")
	ErrProjectExists                = errors.New("VD_PROJECT_EXISTS")
	ErrProjectMissing               = errors.New("VD_PROJECT_MISSING")
	ErrProjectUnsupported           = errors.New("VD_PROJECT_UNSUPPORTED")
	ErrProjectManagementUnsupported = errors.New("VD_PROJECT_MANAGEMENT_UNSUPPORTED")
	ErrProjectDeleted               = errors.New("VD_PROJECT_DELETED")
	ErrProjectChanged               = errors.New("VD_PROJECT_CHANGED")
	errProjectIDSpent               = errors.New("previous creation ID no longer identifies the requested project")
)

type Project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ProjectList struct {
	Supported bool      `json:"supported"`
	CanManage bool      `json:"canManage"`
	Projects  []Project `json:"projects"`
}

func ValidProjectName(name string) bool {
	return name != "" && utf8.ValidString(name) && utf8.RuneCountInString(name) <= 80 &&
		name == strings.TrimSpace(name) && strings.IndexFunc(name, unicode.IsControl) < 0
}

func (p *Profile) SameProject(other *Profile) bool {
	return p.Pin == other.Pin && p.ProjectID == other.ProjectID
}

func readProjectJSON(res *http.Response, dst any) error {
	defer res.Body.Close()
	const maxSize = 4 << 20
	data, err := io.ReadAll(io.LimitReader(res.Body, maxSize+1))
	if err != nil || len(data) > maxSize || json.Unmarshal(data, dst) != nil {
		return ErrProtocol
	}
	return nil
}

func (p *Profile) ListProjects(ctx context.Context, c *http.Client) (ProjectList, error) {
	resp, err := p.requestContext(ctx, c, http.MethodGet, "/v1/projects?version=2", nil)
	if errors.Is(err, ErrSpaceMissing) {
		// Servers predating the catalog expose their single project at /v1/index.
		return ProjectList{Projects: []Project{{}}}, nil
	}
	if err != nil {
		return ProjectList{}, err
	}
	var projects []Project
	canManage := resp.Header.Get("X-Videron-Project-Management") == "1"
	if err = readProjectJSON(resp, &projects); err != nil {
		return ProjectList{}, err
	}
	seen := make(map[string]bool, len(projects))
	for _, entry := range projects {
		if seen[entry.ID] || entry.ID == "" && entry.Name != "" && (!canManage || !ValidProjectName(entry.Name)) ||
			entry.ID != "" && (!ValidID(entry.ID) || !ValidProjectName(entry.Name)) {
			return ProjectList{}, ErrProtocol
		}
		seen[entry.ID] = true
	}
	if projects == nil || (!canManage && !seen[""]) {
		return ProjectList{}, ErrProtocol
	}
	return ProjectList{Supported: true, CanManage: canManage, Projects: projects}, nil
}

// SelectProject checks the selected scope against its own manifest.
func (p Profile) SelectProject(ctx context.Context, c *http.Client, id string) (Profile, error) {
	if id != "" && !ValidID(id) {
		return Profile{}, ErrProjectMissing
	}
	list, err := p.ListProjects(ctx, c)
	if err != nil {
		return Profile{}, err
	}
	for _, entry := range list.Projects {
		if entry.ID == id {
			return p.selectProject(ctx, c, entry)
		}
	}
	if !list.Supported {
		return Profile{}, ErrProjectUnsupported
	}
	return Profile{}, ErrProjectMissing
}

// CreateProject uses the enrollment nonce to make repeated requests for the same name idempotent.
func (p Profile) CreateProject(ctx context.Context, c *http.Client, nonce, name string) (Profile, error) {
	name = strings.TrimSpace(name)
	if !ValidProjectName(name) {
		return Profile{}, ErrProjectName
	}
	want := Project{ID: projectCreationID("create-project/" + nonce + "/" + name), Name: name}
	for {
		err := p.createProject(ctx, c, want)
		if !errors.Is(err, errProjectIDSpent) {
			if err != nil {
				return Profile{}, err
			}
			return p.selectProject(ctx, c, want)
		}
		// A freed name needs a new identity, even within the same enrollment.
		want.ID = projectCreationID("reuse-project-name/" + want.ID)
	}
}

func projectCreationID(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

func (p Profile) createProject(ctx context.Context, c *http.Client, want Project) error {
	p.ProjectID = want.ID
	raw, err := json.Marshal(want)
	if err != nil {
		return err
	}
	resp, err := p.requestContext(ctx, c, http.MethodPost, "/v1/projects", bytes.NewReader(raw))
	if errors.Is(err, ErrSpaceMissing) {
		return ErrProjectUnsupported
	}
	if errors.Is(err, ErrProjectDeleted) {
		return errProjectIDSpent
	}
	if errors.Is(err, ErrChanged) {
		list, err := p.ListProjects(ctx, c)
		if err != nil {
			return err
		}
		for _, entry := range list.Projects {
			if entry.ID == want.ID && entry.Name != want.Name {
				return errProjectIDSpent
			}
		}
		return ErrProjectExists
	}
	if err != nil {
		return err
	}
	var project Project
	if err = readProjectJSON(resp, &project); err != nil || project != want {
		return ErrProtocol
	}
	return nil
}

// RenameProject and DeleteProject condition the operation on the confirmed
// project ID and name, so an outdated selection cannot change another project.
func (p Profile) RenameProject(ctx context.Context, c *http.Client, id, newName, expectedName string) (Profile, error) {
	name := strings.TrimSpace(newName)
	if !ValidProjectName(name) {
		return Profile{}, ErrProjectName
	}
	return p.changeProject(ctx, c, id, expectedName, name, http.MethodPatch)
}

func (p Profile) DeleteProject(ctx context.Context, c *http.Client, id, expectedName string) (Profile, error) {
	return p.changeProject(ctx, c, id, expectedName, "", http.MethodDelete)
}

func (p Profile) changeProject(ctx context.Context, c *http.Client, id, expectedName, name, method string) (Profile, error) {
	if p.ProjectID != id || (id != "" && !ValidID(id)) {
		return Profile{}, ErrProjectChanged
	}
	if !(id == "" && expectedName == "") && !ValidProjectName(expectedName) {
		return Profile{}, ErrProjectChanged
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
		return Profile{}, err
	}
	resp, err := p.requestContext(ctx, c, method, "/v1/projects/"+key, bytes.NewReader(body))
	if errors.Is(err, ErrSpaceMissing) {
		list, why := p.ListProjects(ctx, c)
		if why != nil {
			return Profile{}, why
		}
		if !list.CanManage {
			return Profile{}, ErrProjectManagementUnsupported
		}
		return Profile{}, ErrProjectMissing
	}
	if err != nil {
		return Profile{}, err
	}
	if method == http.MethodDelete {
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			return Profile{}, ErrProtocol
		}

		p.ProjectDeleted = true
		p.Lineage = ""
		return p, nil
	}
	var result Project
	if readProjectJSON(resp, &result) != nil || result != (Project{ID: id, Name: name}) {
		return Profile{}, ErrProtocol
	}
	p.ProjectName = name
	return p, nil
}

func (p Profile) selectProject(ctx context.Context, c *http.Client, entry Project) (Profile, error) {
	p.ProjectID, p.ProjectName = entry.ID, entry.Name
	p.ProjectDeleted = false
	m, err := p.ManifestSummary(ctx, c)
	if errors.Is(err, ErrSpaceMissing) {
		return Profile{}, ErrProjectMissing
	}
	if err != nil {
		return Profile{}, err
	}
	p.Lineage = m.Lineage
	return p, nil
}
