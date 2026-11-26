package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"videron/internal/syncclient"
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

func profilePath(folder string) (string, error) {
	p, err := workspacestore.CatalogPath()
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(workspacestore.SessionID(folder)))
	return filepath.Join(filepath.Dir(p), "connections", fmt.Sprintf("%x.key", h)), nil
}
func storeProfile(folder string, p syncclient.Profile) error {
	path, err := profilePath(folder)
	if err != nil {
		return err
	}
	raw, err := syncclient.EncodeProfile(p)
	if err != nil {
		return err
	}
	defer clear(raw)
	data, err := protectPairing(raw)
	if err != nil {
		return err
	}
	defer clear(data)
	_, err = workspacestore.WriteAtomic(path, data, ".connection-*.tmp")
	return err
}
func loadProfile(folder string) (*syncclient.Profile, error) {
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
	return syncclient.DecodeProfile(data)
}

func (session *syncSession) transferRecord(dir, lineage, kind, id string) ([]byte, error) {
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
	p, err := loadProfile(dir)
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
	return storeProfile(dir, *p)
}

func saveSuccessfulSync(dir string, p *syncclient.Profile) error {
	p.LastSync = time.Now().UnixMilli()
	return storeProfile(dir, *p)
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
	if err = bindWorkingCopy(&p, dir); err != nil {
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
	m, err := p.Enroll(c, dir, lineage, session.transferRecord, workspacestore.PublishNewFile)
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
	return saveSuccessfulSync(dir, &p)
}

func (a *App) SyncSpaceServer(folder string) (string, error) {
	session := a.syncSession()
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
	index, err := a.sessionServerIndex(dir, p.Lineage)
	if err != nil {
		return "", err
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	m, err := p.SyncManifest(c, index)
	if err != nil {
		return "", detachDeletedProject(dir, p, err)
	}
	// This cursor covers exactly the manifest we have downloaded. A concurrent
	// server write after that snapshot must wake the next subscription.
	if err := p.Exchange(c, dir, m, session.transferRecord, workspacestore.PublishNewFile); err != nil {
		return m.Cursor, detachDeletedProject(dir, p, err)
	}
	// A status write may fail after the exchange has completed. The existing
	// profile still works and the next successful check refreshes its details.
	_ = saveSuccessfulSync(dir, p)
	return m.Cursor, nil
}

// Call with serverMu held. A long-poll response may belong to an old project
// after the user reconnects this folder elsewhere. A tombstone only revokes
// the matching connection. The working copy, offline edits and history stay.
func detachDeletedProject(dir string, observed *syncclient.Profile, reason error) error {
	if !errors.Is(reason, syncclient.ErrProjectDeleted) {
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
		return "", syncclient.ErrSpace
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	nextCursor, err := p.WaitChange(c, cursor)
	if err != nil {
		if errors.Is(err, syncclient.ErrProjectDeleted) {
			a.serverMu.Lock()
			defer a.serverMu.Unlock()
			return "", detachDeletedProject(dir, p, err)
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
	if err = bindWorkingCopy(&p, dir); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	m, err := p.Manifest(c)
	if err != nil {
		return err
	}
	if m.Main == "" {
		return syncclient.ErrEmpty
	}
	if p.Lineage != "" && m.Lineage != p.Lineage {
		return syncclient.ErrSpace
	}
	p.Lineage = m.Lineage
	if len(entries) != 0 {
		return session.rejoinServerFolder(&p, c, dir, m)
	}
	a.mu.Lock()
	open := a.folderSpaces[workspacestore.SessionID(dir)] != nil
	err = session.check()
	a.mu.Unlock()
	if err != nil {
		return err
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
	if err = p.DownloadMain(c, file, m.Main, workspacestore.PublishNewFile); err != nil {
		return err
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	_, _, err = workspaceStore.ParseFile(raw)
	clear(raw)
	if err != nil {
		return err
	}
	if err = p.Exchange(c, stage, m, nil, workspacestore.PublishNewFile); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err = session.check(); err != nil {
		return err
	}
	if a.folderSpaces[workspacestore.SessionID(dir)] != nil {
		return errChanged
	}
	if err := workspacestore.PublishDownload(dir, stage, m.Lineage); err != nil {
		return err
	}
	return saveSuccessfulSync(dir, &p)
}
