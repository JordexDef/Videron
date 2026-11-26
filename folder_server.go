package main

import (
	"videron/internal/syncclient"
	"videron/internal/syncworkspace"
	"videron/internal/workspacestore"
)

type ServerConnectionInfo = syncworkspace.ServerConnectionInfo

func (a *App) withOpenFolder(folder string, action func(*workspacestore.Session, *syncworkspace.FolderConnection) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.useOpenFolder(folder, action)
}

// useOpenFolder borrows the current session and its connection under App.mu.
func (a *App) useOpenFolder(folder string, action func(*workspacestore.Session, *syncworkspace.FolderConnection) error) error {
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return err
	}
	return action(s.Session, &s.connection)
}

// An upload or enrollment commit must still belong to the vault session that
// started the operation, even if another session has reopened the same folder.
func (session *syncSession) withOpenFolder(folder string, action func(*workspacestore.Session, *syncworkspace.FolderConnection) error) error {
	a := session.app
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := session.check(); err != nil {
		return err
	}
	return a.useOpenFolder(folder, action)
}

func (session *syncSession) TransferRecord(dir, lineage, kind, id string) ([]byte, error) {
	var record []byte
	err := session.withOpenFolder(dir, func(s *workspacestore.Session, _ *syncworkspace.FolderConnection) error {
		var err error
		record, err = s.TransferRecord(lineage, kind, id)
		return err
	})
	return record, err
}

func (a *App) openLineage(dir string) (string, error) {
	var lineage string
	err := a.withOpenFolder(dir, func(s *workspacestore.Session, _ *syncworkspace.FolderConnection) error {
		lineage = s.Lineage()
		return nil
	})
	return lineage, err
}

func (a *App) ServerConnection(folder string) (ServerConnectionInfo, error) {
	dir, err := spaceDir(folder)
	if err != nil {
		return ServerConnectionInfo{}, err
	}
	return syncworkspace.ConnectionInfo(dir, a.withOpenFolder)
}

func (a *App) SetServerAutoConnect(folder string, enabled bool) error {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	return syncworkspace.SetAutoConnect(folder, enabled, a.withOpenFolder)
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
	return syncworkspace.Connect(dir, p, a.withOpenFolder, session.withOpenFolder, session.TransferRecord)
}

func (a *App) SyncSpaceServer(folder string) (string, error) {
	session := a.syncSession()
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	dir, err := spaceDir(folder)
	if err != nil {
		return "", err
	}
	return syncworkspace.Sync(dir, a.withOpenFolder, session.TransferRecord)
}

func (a *App) WaitSpaceServerChange(folder, cursor string) (string, error) {
	dir, err := spaceDir(folder)
	if err != nil {
		return "", err
	}
	return syncworkspace.WaitForChange(dir, cursor, a.withOpenFolder, &a.serverMu)
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
	var conn *syncworkspace.FolderConnection
	if s := a.folderSpaces[workspacestore.SessionID(dir)]; s != nil {
		conn = &s.connection
	}
	return syncworkspace.Disconnect(dir, conn)
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
