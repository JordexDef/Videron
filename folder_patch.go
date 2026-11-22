package main

import (
	"crypto/sha256"
	"strings"
)

func (a *App) FolderPatchRevision(folder string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return "", err
	}
	if !s.sync.initialized {
		// Reading a space (including read-only folders) must not create history.
		// The first background poll can initialize its head without changing the payload.
		return "snapshot:" + hexID([]byte(s.sync.payload)), nil
	}
	return s.sync.meta.Head, nil
}

func (a *App) SaveFolderPatch(folder, expectedHead, patch string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return "", err
	}
	initial, bootstrap := strings.CutPrefix(expectedHead, "snapshot:")
	if !validSyncID(initial) {
		return "", errChanged
	}
	digest := sha256.Sum256([]byte(patch))
	head := s.sync.meta.Head
	data := s.sync.payload
	if head == expectedHead || (bootstrap && initial == hexID([]byte(data))) {
		next, err := applyWorkspacePatch([]byte(data), patch)
		if err != nil {
			return "", err
		}
		if !validSpacePayload(next) {
			return "", errInvalid
		}
		data = string(next)
	} else if s.lastPatch != (savePatchReceipt{from: expectedHead, to: head, digest: digest}) {
		return "", errChanged
	}
	err = s.commitBranch("", data, false)
	if s.sync.meta.Head != expectedHead && s.sync.payload == data {
		s.lastPatch = savePatchReceipt{from: expectedHead, to: s.sync.meta.Head, digest: digest}
	}
	if err != nil {
		return "", err
	}
	return s.sync.meta.Head, nil
}
