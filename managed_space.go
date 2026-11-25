package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"videron/internal/syncclient"
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
	if !a.loaded {
		return "", errLocked
	}
	catalog, err := workspacestore.CatalogPath()
	if err != nil {
		return "", err
	}
	id := hexID([]byte(profile.Pin + "/" + profile.ProjectID))
	dir := filepath.Join(filepath.Dir(catalog), "spaces", "sync-"+id)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
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
	dir, err := spaceDir(destination)
	if err != nil {
		return result, err
	}
	oldDir := filepath.Dir(s.Path())
	oldID, newID := workspacestore.SessionID(oldDir), workspacestore.SessionID(dir)
	if oldID == newID {
		return result, syncclient.ErrFolder
	}
	if a.folderSpaces[newID] != nil {
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
	oldProfile, err := profilePath(oldDir)
	if err != nil {
		return result, err
	}
	newProfile, err := profilePath(dir)
	if err != nil {
		return result, err
	}
	next, keptSource, err := s.Move(dir, oldProfile, newProfile, func() error { return a.writeSnapshot(catalog, a.projectKey) })
	if err != nil {
		return result, err
	}
	a.forgetSuspendedFolder(newID)
	delete(a.folderSpaces, oldID)
	relocated := *s
	relocated.Session = next
	a.folderSpaces[newID] = &relocated
	return SpaceMoveResult{KeptSource: keptSource}, nil
}
