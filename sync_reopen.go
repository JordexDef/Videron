package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"videron/internal/syncclient"
	"videron/internal/workspacestore"
)

// These are suggestions from small local markers. Reading the main document
// here can hydrate large cloud files. Join verifies the selected document.
func (a *App) MatchingServerFolders(code string, folders []string) ([]string, error) {
	p, err := a.resolveServerTicket(code)
	if err != nil {
		return nil, err
	}
	if p.ProjectDeleted {
		return nil, syncclient.ErrProjectDeleted
	}
	if p.Lineage == "" && len(folders) != 0 {
		c := p.Client()
		defer c.CloseIdleConnections()
		m, err := p.ManifestSummary(context.Background(), c)
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
		open[id] = s.Lineage()
	}
	a.mu.Unlock()
	seen := make(map[string]bool)
	for _, folder := range folders {
		dir, err := spaceDir(folder)
		if err != nil {
			continue
		}
		id := workspacestore.SessionID(dir)
		if seen[id] || open[id] != "" && open[id] != p.Lineage {
			continue
		}
		seen[id] = true
		main := filepath.Join(dir, folderSpaceFilename)
		info, err := os.Lstat(main)
		if err != nil || !workspacestore.SupportedFile(main, info) {
			continue
		}
		profile, err := loadProfile(dir)
		if err != nil || (profile != nil && !p.SameProject(profile)) {
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
		if _, err := syncclient.HistoryDir(dir, p.Lineage, "revisions", false); err == nil {
			matches = append(matches, dir)
		}
	}
	return matches, nil
}

func (session *syncSession) rejoinServerFolder(p *syncclient.Profile, c *http.Client, dir string, m syncclient.Manifest) error {
	a := session.app
	path := filepath.Join(dir, folderSpaceFilename)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return syncclient.ErrFolder
	} else if err != nil {
		return err
	}
	a.mu.Lock()
	if err := session.check(); err != nil {
		a.mu.Unlock()
		return err
	}
	id := workspacestore.SessionID(dir)
	s := a.folderSpaces[id]
	var current *workspacestore.Session
	if s != nil {
		current = s.Session
	}
	opened, err := workspaceStore.PrepareRejoin(dir, m.Lineage, current)
	temporary := s == nil
	if err == nil && temporary {
		s = &folderSpaceSession{Session: opened}
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
	if err = p.Exchange(c, dir, m, session.transferRecord, workspacestore.PublishNewFile); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err = session.check(); err != nil {
		return err
	}
	// A project switch or a replacement during the transfer must be reflected here.
	current = nil
	if active := a.folderSpaces[id]; active != nil {
		current = active.Session
	}
	if _, err = workspaceStore.MatchFolder(dir, m.Lineage, current); err != nil {
		return err
	}
	return saveSuccessfulSync(dir, p)
}
