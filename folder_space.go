package main

import (
	"path/filepath"

	"videron/internal/foldersession"
	"videron/internal/syncworkspace"
	"videron/internal/workspacestore"
)

const folderSpaceFilename = workspacestore.Filename
const folderSpaceFormat = workspacestore.Format

var errSpaceMissing = workspacestore.ErrMissing
var errSpaceExists = workspacestore.ErrExists

type SpaceFolderInfo = workspacestore.SpaceFolderInfo

func (a *App) InspectSpaceFolder(folder string) (SpaceFolderInfo, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.library.Loaded() {
		return SpaceFolderInfo{}, errLocked
	}
	return a.folderSessions.Inspect(workspaceStore, folder)
}

func (a *App) OpenFolderSpace(folder, password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.library.Loaded() {
		return "", errLocked
	}
	return a.folderSessions.Open(workspaceStore, folder, password)
}

func (a *App) ResumeFolderSpace(folder string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.library.Loaded() {
		return "", errLocked
	}
	return a.folderSessions.Resume(workspaceStore, folder)
}

func (a *App) CreateFolderSpace(folder, payload, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.library.Loaded() {
		return errLocked
	}
	return a.folderSessions.Create(workspaceStore, folder, payload, password)
}

func (a *App) currentSpaceSession(folder string) (*foldersession.Session, error) {
	if !a.library.Loaded() {
		return nil, errLocked
	}
	return a.folderSessions.Current(folder)
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

func (a *App) ForgetSuspendedFolderKeys() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.folderSessions.ForgetSuspended()
}

func (a *App) SuspendFolderSpace(folder string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.folderSessions.Suspend(folder)
}

func (a *App) CloseFolderSpace(folder string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.folderSessions.Close(folder)
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
	dir := filepath.Dir(session.Path())
	a.folderSessions.Close(dir)
	// The document is already deleted. Credential cleanup does not roll it back.
	_ = syncworkspace.RemoveProfile(dir)
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
