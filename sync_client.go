package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	errServerCode    = errors.New("VD_SERVER_CODE")
	errServerCert    = errors.New("VD_SERVER_CERT")
	errServerAuth    = errors.New("VD_SERVER_AUTH")
	errServerOffline = errors.New("VD_SERVER_OFFLINE")
	errServerSpace   = errors.New("VD_SERVER_SPACE")
	errServerEmpty   = errors.New("VD_SERVER_EMPTY")
	errServerFolder  = errors.New("VD_SERVER_FOLDER")
	serverHex        = regexp.MustCompile("^[0-9a-f]{64}$")
)

const maxSyncBlob int64 = 1 << 30

type serverProfile struct {
	Address, Pin, Token, Lineage string
	Transport                    string `json:",omitempty"`
	LastSync                     int64  `json:",omitempty"`
	ProjectID                    string `json:",omitempty"`
	ProjectName                  string `json:",omitempty"`
	ProjectDeleted               bool   `json:"-"` // Only a verified ticket can refer to a deleted project.
}
type ServerConnectionInfo struct {
	Address     string `json:"address"`
	Transport   string `json:"transport,omitempty"`
	LastSync    int64  `json:"lastSync,omitempty"`
	ProjectID   string `json:"projectId,omitempty"`
	ProjectName string `json:"projectName,omitempty"`
}
type serverManifest struct {
	Cursor      string            `json:"cursor"`
	Main        string            `json:"main"`
	Lineage     string            `json:"lineage"`
	Files       map[string]string `json:"files"`
	ProjectName *string           `json:"projectName,omitempty"`
}

func parsePairCode(code string) (serverProfile, error) {
	var p serverProfile
	u, e := url.Parse(strings.TrimSpace(code))
	if e != nil || u.Scheme != "videron-sync" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || (u.Path != "" && u.Path != "/") {
		return p, errServerCode
	}
	port, e := strconv.Atoi(u.Port())
	if e != nil || port < 1 || port > 65535 {
		return p, errServerCode
	}
	pin, token, ok := strings.Cut(u.Fragment, ".")
	if !ok || !serverHex.MatchString(pin) || !serverHex.MatchString(token) {
		return p, errServerCode
	}
	return serverProfile{Address: "https://" + u.Host, Pin: pin, Token: token}, nil
}

func profilePath(folder string) (string, error) {
	p, err := workspacePath()
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(spaceSessionID(folder)))
	return filepath.Join(filepath.Dir(p), "connections", fmt.Sprintf("%x.key", h)), nil
}
func storeProfile(folder string, p serverProfile) error {
	path, err := profilePath(folder)
	if err != nil {
		return err
	}
	var stored any = p
	if p.ProjectID != "" {
		// Older clients ignore unknown fields such as ProjectID. Without an
		// envelope, a downgrade could reconnect to the default project of
		// the same server if that project shares this copy's lineage.
		stored = namedProjectProfile{Format: namedProjectFormat, Profile: p}
	}
	raw, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	defer clear(raw)
	data, err := protectPairing(raw)
	if err != nil {
		return err
	}
	defer clear(data)
	_, err = writeAtomic(path, data, ".connection-*.tmp")
	return err
}
func loadProfile(folder string) (*serverProfile, error) {
	path, err := profilePath(folder)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer clear(raw)
	data, err := unprotectPairing(raw)
	if err != nil {
		return nil, err
	}
	defer clear(data)
	var envelope namedProjectProfile
	if json.Unmarshal(data, &envelope) != nil {
		return nil, errServerCode
	}
	var p serverProfile
	if envelope.Format != "" {
		if envelope.Format != namedProjectFormat || envelope.Profile.ProjectID == "" {
			return nil, errServerCode
		}
		p = envelope.Profile
	} else if json.Unmarshal(data, &p) != nil {
		return nil, errServerCode
	}
	if !serverHex.MatchString(p.Lineage) ||
		(p.ProjectID != "" && !serverHex.MatchString(p.ProjectID)) {
		return nil, errServerCode
	}
	parsed, err := parsePairCode(strings.Replace(p.Address, "https://", "videron-sync://", 1) + "#" + p.Pin + "." + p.Token)
	if err != nil || parsed.Address != p.Address || (p.Transport != "" && p.Transport != transportDirect && p.Transport != transportTunnel) {
		return nil, errServerCode
	}
	return &p, nil
}

func (p *serverProfile) request(c *http.Client, method, route string, body io.Reader) (*http.Response, error) {
	return p.requestContext(context.Background(), c, method, route, body)
}

func (p *serverProfile) requestContext(ctx context.Context, c *http.Client, method, route string, body io.Reader) (*http.Response, error) {
	var mode string
	path, _, _ := strings.Cut(route, "?")
	catalog := path == "/v1/projects" || strings.HasPrefix(path, "/v1/projects/")
	management := catalog && (method == http.MethodPatch || method == http.MethodDelete)
	scoped := p.ProjectID != "" && !catalog
	if scoped {
		if !serverHex.MatchString(p.ProjectID) || !strings.HasPrefix(route, "/v1/") {
			return nil, errServerCode
		}
		// A legacy server ignores unknown headers. A distinct path prevents
		// any write to its default store if the server is rolled back.
		route = "/v1/projects/" + p.ProjectID + "/" + strings.TrimPrefix(route, "/v1/")
	}
	req, err := http.NewRequestWithContext(traceSyncTransport(ctx, &mode), method, p.Address+route, body)
	if err != nil {
		return nil, errServerCode
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	if path == "/v1/index" {
		req.Header.Set("X-Videron-Catalog-Version", "2")
	}
	if scoped {
		req.Header.Set("X-Videron-Project", p.ProjectID)
	}
	if method == "PUT" {
		req.Header.Set("If-None-Match", "*")
		req.Header.Set("X-Videron-Lineage", p.Lineage)
		req.Header.Set("Content-Type", "application/octet-stream")
	} else if catalog && body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.Do(req)
	if err != nil {
		if errors.Is(err, errServerCert) {
			return nil, errServerCert
		}
		return nil, errServerOffline
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		if scoped && res.Header.Get("X-Videron-Project") != p.ProjectID {
			res.Body.Close()
			return nil, errServerProtocol
		}
		if mode != "" {
			p.Transport = mode
		}
		return res, nil
	}
	res.Body.Close()
	switch res.StatusCode {
	case 401, 403:
		return nil, errServerAuth
	case http.StatusGone:
		if res.Header.Get("X-Videron-Project-Deleted") == "1" && res.Header.Get("X-Videron-Project") == p.ProjectID {
			return nil, errProjectDeleted
		}
		return nil, errServerProtocol
	case 412:
		if management {
			return nil, errProjectChanged
		}
		return nil, errChanged
	case 409:
		if management {
			return nil, errProjectExists
		}
		return nil, errChanged
	case http.StatusMethodNotAllowed:
		if management {
			return nil, errProjectManagementUnsupported
		}
		return nil, fmt.Errorf("VD_SERVER_RESPONSE|HTTP %d", res.StatusCode)
	case 404:
		return nil, errSpaceMissing
	}
	return nil, fmt.Errorf("VD_SERVER_RESPONSE|HTTP %d", res.StatusCode)
}

func validBlobPath(path, lineage string) bool {
	parts := strings.Split(path, "/")
	return len(parts) == 4 && parts[0] == ".videron-sync" && parts[1] == lineage && (parts[2] == "objects" || parts[2] == "revisions") &&
		strings.HasSuffix(parts[3], ".json") && serverHex.MatchString(strings.TrimSuffix(parts[3], ".json"))
}

func (p *serverProfile) manifest(c *http.Client) (serverManifest, error) {
	return p.manifestContext(context.Background(), c)
}

func (p *serverProfile) manifestContext(ctx context.Context, c *http.Client) (serverManifest, error) {
	var m serverManifest
	resp, err := p.requestContext(ctx, c, "GET", "/v1/index", nil)
	if err != nil {
		return m, err
	}
	defer resp.Body.Close()
	if err = json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&m); err != nil {
		return m, errCorrupt
	}
	if m.Cursor == "" || m.Files == nil {
		return m, errCorrupt
	}
	if m.ProjectName != nil {
		if !validProjectName(*m.ProjectName) && !(p.ProjectID == "" && *m.ProjectName == "") {
			return m, errServerProtocol
		}
		p.ProjectName = *m.ProjectName
	}
	if m.Main == "" && m.Lineage == "" && len(m.Files) == 0 {
		return m, nil
	}
	if !serverHex.MatchString(m.Lineage) || !serverHex.MatchString(m.Main) {
		return m, errCorrupt
	}
	for path, hash := range m.Files {
		if !validBlobPath(path, m.Lineage) || !serverHex.MatchString(hash) {
			return m, errCorrupt
		}
	}
	return m, nil
}

// Only regular files in the space's own history may leave the device.
func historyDir(dir, lineage, kind string, create bool) (string, error) {
	path := dir
	for _, name := range []string{".videron-sync", lineage, kind} {
		path = filepath.Join(path, name)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) && create {
			if err = os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return "", err
			}
			info, err = os.Lstat(path)
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errInvalid
		}
	}
	return path, nil
}
func (p *serverProfile) upload(c *http.Client, route string, raw []byte) error {
	res, err := p.request(c, "PUT", route, bytes.NewReader(raw))
	if err == nil {
		res.Body.Close()
	}
	return err
}
func (p *serverProfile) download(c *http.Client, route, path, expected string) error {
	resp, err := p.request(c, "GET", route, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	tmp, err := os.CreateTemp(filepath.Dir(path), ".videron-download-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, maxSyncBlob+1))
	if err != nil {
		return err
	}
	if n > maxSyncBlob || hex.EncodeToString(h.Sum(nil)) != expected {
		return errCorrupt
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return publishNewSpaceFile(tmp.Name(), path)
}

func (p *serverProfile) exchange(c *http.Client, dir string, m serverManifest, app *App) error {
	if m.Lineage != p.Lineage {
		return errServerSpace
	}
	type batch struct {
		kind, parent string
		entries      []os.DirEntry
	}
	// Writers publish a revision only after all of its objects. Snapshot the
	// revision list first so a save during transfer belongs to the next pass.
	var batches []batch
	for _, kind := range []string{"revisions", "objects"} {
		parent, err := historyDir(dir, p.Lineage, kind, true)
		if err != nil {
			return err
		}
		entries, err := os.ReadDir(parent)
		if err != nil {
			return err
		}
		batches = append(batches, batch{kind, parent, entries})
	}
	// Transfer the object batch before exposing the captured revisions.
	for i := len(batches) - 1; i >= 0; i-- {
		b := batches[i]
		prefix := ".videron-sync/" + p.Lineage + "/" + b.kind + "/"
		local := make(map[string]bool, len(b.entries))
		for _, entry := range b.entries {
			path := prefix + entry.Name()
			if !validBlobPath(path, p.Lineage) {
				continue
			}
			local[path] = true
			if _, present := m.Files[path]; present {
				continue
			}
			if app == nil {
				return errServerFolder
			}
			raw, err := app.transferRecord(dir, p.Lineage, b.kind, strings.TrimSuffix(entry.Name(), ".json"))
			if err != nil {
				return err
			}
			err = p.upload(c, "/v1/file?path="+url.QueryEscape(path), raw)
			clear(raw)
			if err != nil && !errors.Is(err, errChanged) {
				return err
			}
		}
		var missing []string
		for path := range m.Files {
			if strings.HasPrefix(path, prefix) && !local[path] {
				missing = append(missing, path)
			}
		}
		sort.Strings(missing)
		for _, path := range missing {
			err := p.download(c, "/v1/file?path="+url.QueryEscape(path), filepath.Join(b.parent, filepath.Base(path)), m.Files[path])
			if err != nil && !errors.Is(err, os.ErrExist) {
				return err
			}
		}
	}
	return nil
}

func (a *App) transferRecord(dir, lineage, kind, id string) ([]byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(dir)
	if err != nil {
		return nil, err
	}
	if s.sync.meta.Lineage != lineage {
		return nil, errServerSpace
	}
	if kind == "" {
		raw, _, err := readSpaceFile(s.path)
		if err != nil {
			return nil, err
		}
		m, _, err := s.mainPayload(raw)
		if err != nil || m.Lineage != lineage {
			clear(raw)
			return nil, errServerSpace
		}
		return raw, nil
	}
	raw, _, err := readSpaceFile(filepath.Join(s.graphPath(), kind, id+".json"))
	if err != nil {
		return nil, err
	}
	plain := raw
	if s.key != nil {
		env, err := parseEnvelope(raw, syncScope)
		if err != nil {
			clear(raw)
			return nil, err
		}
		plain, err = s.key.open(env, lineage+"/"+kind+"/"+id)
		if err != nil {
			clear(raw)
			return nil, err
		}
		defer clear(plain)
	}
	if s.recordID(kind, plain) != id {
		clear(raw)
		return nil, errCorrupt
	}
	return raw, nil
}

func (a *App) openLineage(dir string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(dir)
	if err != nil {
		return "", err
	}
	return s.sync.meta.Lineage, nil
}

func (a *App) ServerConnection(folder string) (ServerConnectionInfo, error) {
	dir, err := spaceDir(folder)
	if err != nil {
		return ServerConnectionInfo{}, err
	}
	p, err := loadProfile(dir)
	if err != nil || p == nil {
		return ServerConnectionInfo{}, err
	}
	lineage, err := a.openLineage(dir)
	if err != nil {
		return ServerConnectionInfo{}, err
	}
	if lineage != p.Lineage {
		return ServerConnectionInfo{}, nil
	}
	return ServerConnectionInfo{Address: p.Address, Transport: p.Transport, LastSync: p.LastSync, ProjectID: p.ProjectID, ProjectName: p.ProjectName}, nil
}

func (p *serverProfile) saveSuccessfulSync(dir string) error {
	p.LastSync = time.Now().UnixMilli()
	return storeProfile(dir, *p)
}

func (a *App) ConnectSpaceServer(folder, code string) error {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	p, err := a.resolveServerTicket(code)
	if err != nil {
		return err
	}
	if p.ProjectDeleted {
		return errProjectDeleted
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return err
	}
	if err = p.checkFolderProject(dir); err != nil {
		return err
	}
	lineage, err := a.FolderSpaceLineage(dir)
	if err != nil {
		return err
	}
	if p.Lineage != "" && p.Lineage != lineage {
		return errServerSpace
	}
	c := p.client()
	defer c.CloseIdleConnections()
	m, err := p.manifest(c)
	if err != nil {
		return err
	}
	if p.Lineage != "" && m.Lineage != p.Lineage {
		return errServerSpace
	}
	p.Lineage = lineage
	if m.Main == "" {
		raw, e := a.transferRecord(dir, p.Lineage, "", "")
		if e != nil {
			return e
		}
		err = p.upload(c, "/v1/main", raw)
		clear(raw)
		if err != nil && !errors.Is(err, errChanged) {
			return err
		}
		m, err = p.manifest(c)
		if err != nil {
			return err
		}
	}
	if err = p.exchange(c, dir, m, a); err != nil {
		return err
	}
	return p.saveSuccessfulSync(dir)
}

func (a *App) SyncSpaceServer(folder string) (string, error) {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	dir, err := spaceDir(folder)
	if err != nil {
		return "", err
	}
	p, err := loadProfile(dir)
	if err != nil || p == nil {
		return "", err
	}
	lineage, err := a.openLineage(dir)
	if err != nil {
		return "", err
	}
	if lineage != p.Lineage {
		return "", errServerSpace
	}
	c := p.client()
	defer c.CloseIdleConnections()
	m, err := p.manifest(c)
	if err != nil {
		return "", detachDeletedProject(dir, p, err)
	}
	// This cursor covers exactly the manifest we have downloaded. A concurrent
	// server write after that snapshot must wake the next subscription.
	if err := p.exchange(c, dir, m, a); err != nil {
		return m.Cursor, detachDeletedProject(dir, p, err)
	}
	// A status write may fail after the exchange has completed. The existing
	// profile still works and the next successful check refreshes its details.
	_ = p.saveSuccessfulSync(dir)
	return m.Cursor, nil
}

// Call with serverMu held. A long-poll response may belong to an old project
// after the user reconnects this folder elsewhere. A tombstone only revokes
// the matching connection. The working copy, offline edits and history stay.
func detachDeletedProject(dir string, observed *serverProfile, reason error) error {
	if !errors.Is(reason, errProjectDeleted) {
		return reason
	}
	current, err := loadProfile(dir)
	if err != nil {
		return err
	}
	if current == nil {
		return reason
	}
	if current.Pin != observed.Pin || current.ProjectID != observed.ProjectID || current.Lineage != observed.Lineage {
		return errChanged
	}
	path, err := profilePath(dir)
	if err != nil {
		return err
	}
	if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return reason
}

// A separate request waits for the server broadcast without blocking saves or uploads.
func (a *App) WaitSpaceServerChange(folder, cursor string) (string, error) {
	dir, err := spaceDir(folder)
	if err != nil {
		return "", err
	}
	lineage, err := a.openLineage(dir)
	if err != nil {
		return "", err
	}
	p, err := loadProfile(dir)
	if err != nil || p == nil {
		return "", err
	}
	if lineage != p.Lineage {
		return "", errServerSpace
	}
	c := p.client()
	defer c.CloseIdleConnections()
	resp, err := p.request(c, "GET", "/v1/events?since="+url.QueryEscape(cursor), nil)
	if err != nil {
		if errors.Is(err, errProjectDeleted) {
			a.serverMu.Lock()
			defer a.serverMu.Unlock()
			return "", detachDeletedProject(dir, p, err)
		}
		return "", err
	}
	defer resp.Body.Close()
	var event struct {
		Cursor string `json:"cursor"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&event) != nil || event.Cursor == "" {
		return "", errCorrupt
	}
	return event.Cursor, nil
}

func (a *App) DisconnectSpaceServer(folder string) error {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return errLocked
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return err
	}
	path, err := profilePath(dir)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (a *App) JoinSpaceServer(code, folder string) error {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	p, err := a.resolveServerTicket(code)
	if err != nil {
		return err
	}
	if p.ProjectDeleted {
		return errProjectDeleted
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return err
	}
	if err = p.checkFolderProject(dir); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	c := p.client()
	defer c.CloseIdleConnections()
	m, err := p.manifest(c)
	if err != nil {
		return err
	}
	if m.Main == "" {
		return errServerEmpty
	}
	if p.Lineage != "" && m.Lineage != p.Lineage {
		return errServerSpace
	}
	p.Lineage = m.Lineage
	if len(entries) != 0 {
		return a.rejoinServerFolder(&p, c, dir, m)
	}
	a.mu.Lock()
	open := a.folderSpaces[spaceSessionID(dir)] != nil
	loaded := a.loaded
	a.mu.Unlock()
	if !loaded {
		return errLocked
	}
	if open {
		return errChanged
	}
	stage, err := os.MkdirTemp(dir, ".videron-join-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	file := filepath.Join(stage, folderSpaceFilename)
	if err = p.download(c, "/v1/main", file, m.Main); err != nil {
		return err
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	_, _, err = parseSpaceFile(raw)
	clear(raw)
	if err != nil {
		return err
	}
	if err = p.exchange(c, stage, m, nil); err != nil {
		return err
	}
	entries, err = os.ReadDir(dir)
	if err != nil {
		return err
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(stage) {
		return errServerFolder
	}
	// Publish the main without replacement first. A concurrent document wins
	// without acquiring our history. Once our main exists, a retry can always
	// identify the replica and fill in missing history.
	if err = publishNewSpaceFile(file, filepath.Join(dir, folderSpaceFilename)); err != nil {
		return err
	}
	history := filepath.Join(dir, syncFolderName)
	if err = os.Mkdir(history, 0700); err != nil {
		return err
	}
	if err = os.Rename(filepath.Join(stage, syncFolderName, m.Lineage), filepath.Join(history, m.Lineage)); err != nil {
		return err
	}
	return p.saveSuccessfulSync(dir)
}
