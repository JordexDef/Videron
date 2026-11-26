package main

import (
	"videron/internal/notesession"
	"videron/internal/vault"
)

type UnlockedNote = notesession.UnlockedNote

// Workspace readiness can change while the key is being derived. Keep the
// callback live so note access rechecks the Windows lock before granting it.
func (a *App) canUnlockNote() bool {
	return a.loaded && !a.sessionLockPending.Load() && !a.folderSessions.Revoking()
}

func (a *App) UnlockNoteFor(spaceID, id, sealed, password string, minutes int) (UnlockedNote, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.noteSession.UnlockFor(spaceID, id, sealed, password, minutes, a.canUnlockNote)
}

func (a *App) ResumeNote(spaceID, id, sealed string) (UnlockedNote, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.noteSession.Resume(spaceID, id, sealed, a.canUnlockNote)
}

func (a *App) UnlockNote(id, sealed, password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.noteSession.Unlock(id, sealed, password, a.canUnlockNote)
}

func (a *App) PreviewSealedNote(id, sealed, password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.noteSession.Preview(id, sealed, password, a.canUnlockNote)
}

func (a *App) ProtectNote(id, payload, password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	return a.noteSession.Protect(id, payload, password)
}

func (a *App) SealNote(id, payload string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	return a.noteSession.Seal(id, payload)
}

func (a *App) CloseNoteEditor(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.noteSession.CloseEditor(id)
}

func (a *App) LockNote(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.noteSession.Lock(id)
}

func (a *App) ForgetRememberedNotes() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.noteSession.ForgetRemembered()
}

type EditorHistoryRef = notesession.EditorHistoryRef

func (a *App) editorHistoryKey(r EditorHistoryRef) (*vault.Key, error) {
	if !a.loaded {
		return nil, errLocked
	}
	if r.Space == "" || r.Note == "" || (r.Kind != "text" && r.Kind != "canvas" && r.Kind != "data") {
		return nil, errInvalid
	}
	var key *vault.Key
	switch r.Protection {
	case "note":
		key = a.noteSession.EditorKey(r.Note)
	case "folder":
		if s := a.folderSessions.At(r.FolderID()); s != nil {
			key = s.Key()
		}
	case "project":
		key = a.projectKey
	case "plain":
		if a.catalog.Protected() {
			return nil, errLocked
		}
		return nil, nil
	default:
		return nil, errInvalid
	}
	if key == nil {
		return nil, errLocked
	}
	return key, nil
}

func (a *App) StoreEditorHistory(r EditorHistoryRef, snapshot string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	key, err := a.editorHistoryKey(r)
	if err != nil {
		return err
	}
	return a.editorHistory.Store(r, key, snapshot)
}

func (a *App) ReadEditorHistory(r EditorHistoryRef) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.canUnlockNote() {
		return "", errLocked
	}
	key, err := a.editorHistoryKey(r)
	if err != nil {
		return "", err
	}
	return a.editorHistory.Read(r, key)
}

func (a *App) ForgetEditorHistories(space string, notes []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.editorHistory.Forget(space, notes)
}
