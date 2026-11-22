package main

import (
	"crypto/sha256"
	"errors"
	"net/http"
	"os"
	"path/filepath"
)

// Called with a.mu held. Read the current document even if the folder has an
// open session: it may have been replaced since the last poll. Neither a saved
// profile nor an old history directory proves the identity of today's main.
func (a *App) serverFolderSession(dir, lineage string) (*folderSpaceSession, error) {
	if !a.loaded {
		return nil, errLocked
	}
	path := filepath.Join(dir, folderSpaceFilename)
	raw, info, err := readSpaceFile(path)
	if errors.Is(err, errSpaceMissing) {
		return nil, errServerFolder
	}
	if err != nil {
		return nil, err
	}
	defer clear(raw)
	if session := a.folderSpaces[spaceSessionID(dir)]; session != nil {
		if session.sync.meta.Lineage != lineage {
			return nil, errServerSpace
		}
		m, _, err := session.mainPayload(raw)
		if errors.Is(err, errSpaceIdentity) || errors.Is(err, errPassword) {
			return nil, errServerSpace
		}
		if err != nil {
			return nil, err
		}
		// openReplica identifies an unstamped legacy document by its exact
		// bytes. Apply that same check when the document is already open.
		if m.Lineage != lineage && !(m.Lineage == "" && hexID(raw) == lineage) {
			return nil, errServerSpace
		}
		return session, nil
	}
	plain, env, err := parseSpaceFile(raw)
	if err != nil {
		return nil, err
	}
	if env != nil {
		return nil, errLocked
	}
	session := &folderSpaceSession{path: path, info: info, digest: sha256.Sum256(raw)}
	if _, err = session.openReplica(plain); err != nil {
		return nil, err
	}
	if session.sync.meta.Lineage != lineage {
		return nil, errServerSpace
	}
	return session, nil
}

// These are suggestions from small local markers. Reading the main document
// here can hydrate large cloud files. Join verifies the selected document.
func (a *App) MatchingServerFolders(code string, folders []string) ([]string, error) {
	p, err := a.resolveServerTicket(code)
	if err != nil {
		return nil, err
	}
	if p.ProjectDeleted {
		return nil, errProjectDeleted
	}
	if p.Lineage == "" && len(folders) != 0 {
		c := p.client()
		defer c.CloseIdleConnections()
		m, err := p.manifest(c)
		if err != nil {
			return nil, err
		}
		p.Lineage = m.Lineage
	}
	matches := []string{}
	if p.Lineage == "" {
		return matches, nil
	}
	a.mu.Lock()
	if !a.loaded {
		a.mu.Unlock()
		return nil, errLocked
	}
	open := make(map[string]string, len(a.folderSpaces))
	for id, s := range a.folderSpaces {
		open[id] = s.sync.meta.Lineage
	}
	a.mu.Unlock()
	seen := make(map[string]bool)
	for _, folder := range folders {
		dir, err := spaceDir(folder)
		if err != nil {
			continue
		}
		id := spaceSessionID(dir)
		if seen[id] || open[id] != "" && open[id] != p.Lineage {
			continue
		}
		seen[id] = true
		main := filepath.Join(dir, folderSpaceFilename)
		info, err := os.Lstat(main)
		if err != nil || !supportedSpaceFile(main, info) {
			continue
		}
		profile, err := loadProfile(dir)
		if err != nil || (profile != nil && !p.sameProject(profile)) {
			continue
		}
		if open[id] == p.Lineage {
			matches = append(matches, dir)
			continue
		}
		if profile != nil {
			if profile.Lineage == p.Lineage {
				matches = append(matches, dir)
			}
			continue
		}
		if _, err := historyDir(dir, p.Lineage, "revisions", false); err == nil {
			matches = append(matches, dir)
		}
	}
	return matches, nil
}

func (a *App) rejoinServerFolder(p *serverProfile, c *http.Client, dir string, m serverManifest) error {
	path := filepath.Join(dir, folderSpaceFilename)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return errServerFolder
	} else if err != nil {
		return err
	}
	a.mu.Lock()
	id := spaceSessionID(dir)
	temporary := a.folderSpaces[id] == nil
	var s *folderSpaceSession
	err := withSpaceWriteLock(path, func() error {
		var err error
		s, err = a.serverFolderSession(dir, m.Lineage)
		if err != nil {
			return err
		}
		// Capture both the local cursor and any independent edits to the main
		// document as immutable revisions before exchanging history.
		if err := s.initReplica(); err != nil {
			return err
		}
		return s.importMain(true)
	})
	if err == nil && temporary {
		a.setSpaceSession(dir, s)
	}
	a.mu.Unlock()
	if err != nil {
		return err
	}
	if temporary {
		defer func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			if a.folderSpaces[id] == s {
				delete(a.folderSpaces, id)
			}
		}()
	}
	if err = p.exchange(c, dir, m, a); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, err = a.serverFolderSession(dir, m.Lineage); err != nil {
		return err
	}
	return p.saveSuccessfulSync(dir)
}
