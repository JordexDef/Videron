package main

import (
	"errors"
	"path/filepath"

	"videron/internal/syncclient"
	"videron/internal/syncworkspace"
	"videron/internal/workspacestore"
)

type ServerConnectionInfo struct {
	Address     string `json:"address"`
	Transport   string `json:"transport,omitempty"`
	LastSync    int64  `json:"lastSync,omitempty"`
	ProjectID   string `json:"projectId,omitempty"`
	ProjectName string `json:"projectName,omitempty"`
	AutoConnect bool   `json:"autoConnect"`
}

func (session *syncSession) TransferRecord(dir, lineage, kind, id string) ([]byte, error) {
	a := session.app
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := session.check(); err != nil {
		return nil, err
	}
	s, err := a.currentSpaceSession(dir)
	if err != nil {
		return nil, err
	}
	return s.TransferRecord(lineage, kind, id)
}

func (a *App) openLineage(dir string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(dir)
	if err != nil {
		return "", err
	}
	return s.Lineage(), nil
}

func (a *App) sessionServerIndex(dir, lineage string) (*syncclient.IndexCache, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(dir)
	if err != nil {
		return nil, err
	}
	if s.Lineage() != lineage {
		return nil, syncclient.ErrSpace
	}
	if s.serverIndex == nil {
		s.serverIndex = new(syncclient.IndexCache)
	}
	return s.serverIndex, nil
}

func (a *App) ServerConnection(folder string) (ServerConnectionInfo, error) {
	dir, err := spaceDir(folder)
	if err != nil {
		return ServerConnectionInfo{}, err
	}
	p, err := syncworkspace.LoadProfile(dir)
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
	return ServerConnectionInfo{Address: p.Address, Transport: p.Transport, LastSync: p.LastSync, ProjectID: p.ProjectID, ProjectName: p.ProjectName, AutoConnect: !p.ManualConnect}, nil
}

func (a *App) SetServerAutoConnect(folder string, enabled bool) error {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.Path())
	p, err := syncworkspace.LoadProfile(dir)
	if err != nil {
		return err
	}
	if p == nil || p.Lineage != s.Lineage() {
		return errChanged
	}
	manual := !enabled
	if manual == p.ManualConnect {
		return nil
	}
	p.ManualConnect = manual
	return syncworkspace.StoreProfile(dir, *p)
}

func (a *App) ConnectSpaceServer(folder, code string) error {
	session := a.syncSession()
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	p, err := a.resolveServerTicket(code)
	if err != nil {
		return err
	}
	if p.ProjectDeleted {
		return syncclient.ErrProjectDeleted
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return err
	}
	if err = syncworkspace.BindWorkingCopy(&p, dir); err != nil {
		return err
	}
	lineage, err := a.FolderSpaceLineage(dir)
	if err != nil {
		return err
	}
	if p.Lineage != "" && p.Lineage != lineage {
		return syncclient.ErrSpace
	}
	index, err := a.sessionServerIndex(dir, lineage)
	if err != nil {
		return err
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	m, err := p.Enroll(c, dir, lineage, session.TransferRecord, workspacestore.PublishNewFile)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err = session.check(); err != nil {
		return err
	}
	s, err := a.currentSpaceSession(dir)
	if err != nil {
		return err
	}
	if s.serverIndex != index {
		return errChanged
	}
	// First background sync starts from the enrollment index. Any uploads
	// during the exchange are later than this cursor and will appear in its delta.
	index.Remember(&p, m)
	return syncworkspace.SaveSuccessfulSync(dir, &p)
}

func (a *App) SyncSpaceServer(folder string) (string, error) {
	session := a.syncSession()
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	dir, err := spaceDir(folder)
	if err != nil {
		return "", err
	}
	p, err := syncworkspace.LoadProfile(dir)
	if err != nil || p == nil {
		return "", err
	}
	index, err := a.sessionServerIndex(dir, p.Lineage)
	if err != nil {
		return "", err
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	m, err := p.SyncManifest(c, index)
	if err != nil {
		return "", syncworkspace.DetachDeletedProject(dir, p, err)
	}
	// This cursor covers exactly the manifest we have downloaded. A concurrent
	// server write after that snapshot must wake the next subscription.
	if err := p.Exchange(c, dir, m, session.TransferRecord, workspacestore.PublishNewFile); err != nil {
		return m.Cursor, syncworkspace.DetachDeletedProject(dir, p, err)
	}
	// A status write may fail after the exchange has completed. The existing
	// profile still works and the next successful check refreshes its details.
	_ = syncworkspace.SaveSuccessfulSync(dir, p)
	return m.Cursor, nil
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
	p, err := syncworkspace.LoadProfile(dir)
	if err != nil || p == nil {
		return "", err
	}
	if lineage != p.Lineage {
		return "", syncclient.ErrSpace
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	nextCursor, err := p.WaitChange(c, cursor)
	if err != nil {
		if errors.Is(err, syncclient.ErrProjectDeleted) {
			a.serverMu.Lock()
			defer a.serverMu.Unlock()
			return "", syncworkspace.DetachDeletedProject(dir, p, err)
		}
		return "", err
	}
	return nextCursor, nil
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
	if s := a.folderSpaces[workspacestore.SessionID(dir)]; s != nil {
		s.serverIndex = nil
	}
	return syncworkspace.RemoveProfile(dir)
}

func (a *App) JoinSpaceServer(code, folder string) error {
	session := a.syncSession()
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	p, err := a.resolveServerTicket(code)
	if err != nil {
		return err
	}
	if p.ProjectDeleted {
		return syncclient.ErrProjectDeleted
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return err
	}
	return syncworkspace.Join(workspaceStore, p, dir, session)
}

func (a *App) MatchingServerFolders(code string, folders []string) ([]string, error) {
	p, err := a.resolveServerTicket(code)
	if err != nil {
		return nil, err
	}
	return syncworkspace.SuggestWorkingCopies(p, folders, a.openFolderLineages, spaceDir)
}

func (a *App) openFolderLineages() (map[string]string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return nil, errLocked
	}
	open := make(map[string]string, len(a.folderSpaces))
	for id, s := range a.folderSpaces {
		open[id] = s.Lineage()
	}
	return open, nil
}

// WithFolder confirms the desktop session is still current while checking
// the working copy or publishing its downloaded files.
func (session *syncSession) WithFolder(dir string, check func(*workspacestore.Session) error) error {
	a := session.app
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := session.check(); err != nil {
		return err
	}
	var current *workspacestore.Session
	if s := a.folderSpaces[workspacestore.SessionID(dir)]; s != nil {
		current = s.Session
	}
	return check(current)
}

// MountFolder makes a closed plaintext copy available to the upload reader.
// The cleanup leaves any session opened during the transfer in place.
func (session *syncSession) MountFolder(dir string, prepare func(*workspacestore.Session) (*workspacestore.Session, error)) (func(), error) {
	a := session.app
	var temporary *folderSpaceSession
	id := workspacestore.SessionID(dir)
	err := session.WithFolder(dir, func(current *workspacestore.Session) error {
		opened, err := prepare(current)
		if err != nil {
			return err
		}
		if current == nil {
			temporary = &folderSpaceSession{Session: opened}
			a.setSpaceSession(dir, temporary)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return func() {
		if temporary == nil {
			return
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.folderSpaces[id] == temporary {
			delete(a.folderSpaces, id)
		}
	}, nil
}
