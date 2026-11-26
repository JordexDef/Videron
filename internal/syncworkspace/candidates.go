package syncworkspace

import (
	"context"
	"os"
	"path/filepath"

	"videron/internal/syncclient"
	"videron/internal/workspacestore"
)

// SuggestWorkingCopies uses a short server manifest to learn the lineage of a
// legacy connection. It snapshots open sessions only when there is a project
// to match against, then leaves file lookups outside the desktop lock.
func SuggestWorkingCopies(p syncclient.Profile, folders []string, snapshot func() (map[string]string, error), resolveFolder func(string) (string, error)) ([]string, error) {
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
	if p.Lineage == "" {
		return []string{}, nil
	}
	open, err := snapshot()
	if err != nil {
		return nil, err
	}
	return matchingFolders(p, folders, open, resolveFolder), nil
}

// matchingFolders uses small local markers so suggestions do not hydrate large
// cloud files. Joining a working copy verifies the contents of its main file.
// The caller snapshots the live lineages and resolves folder aliases.
func matchingFolders(p syncclient.Profile, folders []string, open map[string]string, resolveFolder func(string) (string, error)) []string {
	matches := []string{}
	if p.Lineage == "" {
		return matches
	}
	seen := make(map[string]bool)
	for _, folder := range folders {
		dir, err := resolveFolder(folder)
		if err != nil {
			continue
		}
		id := workspacestore.SessionID(dir)
		if seen[id] || open[id] != "" && open[id] != p.Lineage {
			continue
		}
		seen[id] = true
		main := filepath.Join(dir, workspacestore.Filename)
		info, err := os.Lstat(main)
		if err != nil || !workspacestore.SupportedFile(main, info) {
			continue
		}
		profile, err := LoadProfile(dir)
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
	return matches
}
