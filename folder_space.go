package main

import (
	"os"
	"path/filepath"

	"videron/internal/syncclient"
	"videron/internal/vault"
	"videron/internal/workspacestore"
)

const folderSpaceFilename = workspacestore.Filename
const folderSpaceFormat = workspacestore.Format

var errSpaceMissing = workspacestore.ErrMissing
var errSpaceExists = workspacestore.ErrExists

type SpaceFolderInfo = workspacestore.SpaceFolderInfo

// Folder grants and network caches belong to this desktop session.
type folderSpaceSession struct {
	*workspacestore.Session
	discardKeyOnSuspend bool
	serverIndex         *syncclient.IndexCache
}

func spaceDir(folder string) (string, error) {
	dir, err := existingFolder(folder)
	if err != nil {
		return "", err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return "", errFolderAccess
	}
	return dir, nil
}

func (a *App) InspectSpaceFolder(folder string) (SpaceFolderInfo, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var result SpaceFolderInfo
	if !a.loaded {
		return result, errLocked
	}
	dir, err := spaceDir(folder)
	if err != nil {
		a.forgetSuspendedFolder(workspacestore.SessionID(folder))
		return result, err
	}

	id := workspacestore.SessionID(dir)
	result, err = workspaceStore.Inspect(dir, a.suspendedFolderKeys[id])
	if !result.CanResume || err != nil {
		a.forgetSuspendedFolder(id)
	}
	return result, err
}

func (a *App) setSpaceSession(dir string, session *folderSpaceSession) {
	if a.folderSpaces == nil {
		a.folderSpaces = make(map[string]*folderSpaceSession)
	}
	id := workspacestore.SessionID(dir)
	a.forgetSuspendedFolder(id)
	if old := a.folderSpaces[id]; old != nil {
		old.Key().Forget()
	}
	a.folderSpaces[id] = session
}

func (a *App) OpenFolderSpace(folder, password string) (string, error) {
	return a.openFolderSpace(folder, password, false)
}

func (a *App) ResumeFolderSpace(folder string) (string, error) {
	return a.openFolderSpace(folder, "", true)
}

func (a *App) openFolderSpace(folder, password string, resume bool) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded || (resume && a.revokingFolderKeys.Load()) {
		return "", errLocked
	}
	dir, err := spaceDir(folder)
	if err != nil {
		a.forgetSuspendedFolder(workspacestore.SessionID(folder))
		return "", err
	}
	id := workspacestore.SessionID(dir)
	var key *vault.Key
	if resume {
		key = a.suspendedFolderKeys[id]
		if key == nil {
			return "", errLocked
		}
		delete(a.suspendedFolderKeys, id)
	} else {
		a.forgetSuspendedFolder(id)
	}

	opened, payload, err := workspaceStore.Open(dir, password, key)
	if err != nil {
		return "", err
	}
	if resume && a.revokingFolderKeys.Load() {
		opened.Key().Forget()
		return "", errLocked
	}
	a.setSpaceSession(dir, &folderSpaceSession{Session: opened})
	return payload, nil
}

func (a *App) CreateFolderSpace(folder, payload, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return errLocked
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return err
	}

	opened, err := workspaceStore.Create(dir, payload, password)
	if err != nil {
		return err
	}
	a.setSpaceSession(dir, &folderSpaceSession{Session: opened})
	return nil
}

func (a *App) currentSpaceSession(folder string) (*folderSpaceSession, error) {
	if !a.loaded {
		return nil, errLocked
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return nil, err
	}
	session := a.folderSpaces[workspacestore.SessionID(dir)]
	if session == nil {
		return nil, errLocked
	}
	return session, nil
}

func (a *App) SaveFolderSpace(folder, payload string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	session, err := a.currentSpaceSession(folder)
	if err != nil {
		return err
	}

	return session.Save(payload)
}

func (a *App) folderKeyID(folder string) string {
	// The canonical path returned by InspectSpaceFolder also works offline.
	id := workspacestore.SessionID(folder)
	if a.folderSpaces[id] == nil && a.suspendedFolderKeys[id] == nil {
		if dir, err := spaceDir(folder); err == nil {
			id = workspacestore.SessionID(dir)
		}
	}
	return id
}

func (a *App) forgetSuspendedFolder(id string) {
	a.suspendedFolderKeys[id].Forget()
	delete(a.suspendedFolderKeys, id)
}

func (a *App) forgetSuspendedFolderKeys() {
	for id := range a.suspendedFolderKeys {
		a.forgetSuspendedFolder(id)
	}
}

func (a *App) ForgetSuspendedFolderKeys() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.forgetSuspendedFolderKeys()
	// A pending save still needs its live key. A concurrent workspace
	// switch may finish after the lock event; never cache that key again.
	for _, s := range a.folderSpaces {
		s.discardKeyOnSuspend = true
	}
}

// Keep only the derived key. Closed spaces cannot be edited or synced through
// their old session; returning to one reopens the file from disk.
func (a *App) SuspendFolderSpace(folder string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := a.folderKeyID(folder)
	session := a.folderSpaces[id]
	if session == nil {
		return a.suspendedFolderKeys[id] != nil
	}
	delete(a.folderSpaces, id)
	if session.Key() == nil || session.discardKeyOnSuspend || a.revokingFolderKeys.Load() {
		session.Key().Forget()
		return false
	}
	if a.suspendedFolderKeys == nil {
		a.suspendedFolderKeys = make(map[string]*vault.Key)
	}
	a.suspendedFolderKeys[id] = session.Key().Clone()
	session.Key().Forget()
	return true
}

func (a *App) CloseFolderSpace(folder string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := a.folderKeyID(folder)
	a.forgetSuspendedFolder(id)
	if session := a.folderSpaces[id]; session != nil {
		session.Key().Forget()
		delete(a.folderSpaces, id)
	}
}

func (a *App) DeleteFolderSpace(folder string) error {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	session, err := a.currentSpaceSession(folder)
	if err != nil {
		return err
	}

	if err = session.Delete(); err != nil {
		return err
	}
	id := workspacestore.SessionID(filepath.Dir(session.Path()))
	a.forgetSuspendedFolder(id)
	delete(a.folderSpaces, id)
	if path, e := profilePath(filepath.Dir(session.Path())); e == nil {
		// The document is already deleted. A credentials cleanup failure cannot roll back the file deletion.
		_ = os.Remove(path)
	}
	return nil
}

type FolderSpaceUpdate = workspacestore.Update

func (a *App) FolderSpaceLineage(folder string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return "", err
	}
	return s.EnsureLineage()
}

func (a *App) PollFolderSpace(folder string, force bool) (FolderSpaceUpdate, error) {
	return a.pollFolderSpace(folder, force, "")
}

// CheckFolderSpace omits the snapshots when the caller already has both heads.
func (a *App) CheckFolderSpace(folder, knownToken string) (FolderSpaceUpdate, error) {
	return a.pollFolderSpace(folder, false, knownToken)
}

func (a *App) pollFolderSpace(folder string, force bool, knownToken string) (FolderSpaceUpdate, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return FolderSpaceUpdate{}, err
	}
	return s.Poll(force, knownToken)
}

func (a *App) SaveFolderBranch(folder, payload string) error {
	return a.commitFolderBranch(folder, "", payload)
}
func (a *App) CommitFolderMerge(folder, token, payload string) error {
	if token == "" {
		return errInvalid
	}
	return a.commitFolderBranch(folder, token, payload)
}
func (a *App) commitFolderBranch(folder, token, data string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return err
	}
	if token == "" {
		return s.SaveBranch(data)
	}
	return s.CommitMerge(token, data)
}
