package client

import (
	"videron/internal/workspacemerge"
	"videron/internal/workspacestore"
)

type FolderMergeProposal = workspacestore.MergeProposal
type FolderMergePatch = workspacemerge.Patch

func (a *App) PrepareFolderMerge(folder string, force bool, knownToken string) (FolderMergeProposal, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var proposal FolderMergeProposal
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return proposal, err
	}
	return s.PrepareMerge(force, knownToken)
}

func (a *App) CommitFolderMergeChoices(folder, token string, choices map[string]string) (FolderMergePatch, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var empty FolderMergePatch
	if token == "" {
		return empty, errInvalid
	}
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return empty, err
	}
	return s.CommitMergeChoices(token, choices)
}

func (a *App) FolderPatchRevision(folder string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return "", err
	}
	return s.PatchRevision(), nil
}

func (a *App) SaveFolderPatch(folder, expectedHead, patch string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return "", err
	}
	return s.SavePatch(expectedHead, patch)
}
