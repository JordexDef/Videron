package main

import (
	"encoding/json"
	"path/filepath"

	"videron/internal/foldersession"
	"videron/internal/syncclient"
	"videron/internal/syncworkspace"
	"videron/internal/workspacestore"
)

// Reuse an automatic download even after it was unlisted or its first unlock
// was cancelled. A different server identity or project gets a different path.
func (a *App) ManagedServerFolder(ticket string) (string, error) {
	profile, err := a.resolveServerTicket(ticket)
	if err != nil {
		return "", err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.library.Loaded() {
		return "", errLocked
	}
	return syncworkspace.ManagedFolder(profile)
}

type SpaceMoveResult struct {
	KeptSource bool `json:"keptSource"`
}

// Publish the new catalog only after the complete working copy exists on disk.
// A crash before that point leaves the old location usable; a crash during
// cleanup leaves the catalog pointing at the complete new location.
func (a *App) MoveFolderSpace(source, destination, catalog string) (result SpaceMoveResult, err error) {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(source)
	if err != nil {
		return result, err
	}
	dir, err := foldersession.CanonicalFolder(destination)
	if err != nil {
		return result, err
	}
	oldDir := filepath.Dir(s.Path())
	oldID, newID := workspacestore.SessionID(oldDir), workspacestore.SessionID(dir)
	if oldID == newID {
		return result, syncclient.ErrFolder
	}
	if a.folderSessions.At(dir) != nil {
		return result, errSpaceExists
	}
	var library struct {
		Active string
		Spaces map[string]struct {
			Folder    string
			Encrypted bool
		}
	}
	if json.Unmarshal([]byte(catalog), &library) != nil {
		return result, errInvalid
	}
	active := library.Spaces[library.Active]
	if workspacestore.SessionID(active.Folder) != newID || active.Encrypted != (s.Key() != nil) {
		return result, errInvalid
	}
	oldProfile, err := syncworkspace.ProfilePath(oldDir)
	if err != nil {
		return result, err
	}
	newProfile, err := syncworkspace.ProfilePath(dir)
	if err != nil {
		return result, err
	}
	next, keptSource, err := s.Move(dir, oldProfile, newProfile, func() error {
		return a.library.Save(workspaceStore, catalog)
	})
	if err != nil {
		return result, err
	}
	a.folderSessions.Relocate(oldDir, dir, next)
	return SpaceMoveResult{KeptSource: keptSource}, nil
}
