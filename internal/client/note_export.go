package client

import (
	"path/filepath"
	"strings"

	"videron/internal/noteexport"
)

type NoteExportResult struct {
	Folder string `json:"folder"`
}

// WriteNoteExport writes only to a location selected through a system picker.
// A lock revokes an outstanding export even if the vault reopens before the picker returns.
func (a *App) WriteNoteExport(kind, title, workspaceFolder string, allowPlaintext bool, bundle noteexport.Bundle) (*NoteExportResult, error) {
	if kind != "folder" && kind != "zip" {
		return nil, noteexport.ErrFormat
	}
	if (kind == "folder" && a.hooks.PickFolder == nil) || (kind == "zip" && a.hooks.SaveFile == nil) {
		return nil, noteexport.ErrWrite
	}
	generation := a.noteExportGeneration.Load()
	allowed := func() bool {
		return a.noteExportGeneration.Load() == generation && !a.sessionLockPending.Load() && !a.folderSessions.Revoking()
	}
	checkAccess := func() error {
		a.mu.Lock()
		defer a.mu.Unlock()
		if !allowed() || !a.canUnlockNote() {
			return errLocked
		}
		protected := a.library.IsProjectProtected()
		if workspaceFolder != "" {
			session := a.folderSessions.At(workspaceFolder)
			if session == nil {
				return errLocked
			}
			protected = protected || session.Key() != nil
		}
		if protected && !allowPlaintext {
			return noteexport.ErrCancelled
		}
		return nil
	}
	if err := checkAccess(); err != nil {
		return nil, err
	}
	ctx := a.runtimeContext()
	bundle.Name = noteexport.SafeName(bundle.Name)
	var target string
	var err error
	if kind == "folder" {
		target, err = a.hooks.PickFolder(ctx, title)
	} else {
		target, err = a.hooks.SaveFile(ctx, SaveFileOptions{
			Title: title, DefaultFilename: bundle.Name + ".zip", FilterName: "ZIP", FilterPattern: "*.zip",
		})
	}
	if err != nil {
		return nil, noteexport.ErrWrite
	}
	if target == "" {
		return nil, nil
	}
	if err := checkAccess(); err != nil {
		return nil, err
	}
	if kind == "folder" {
		target, err = noteexport.WriteFolder(target, bundle, allowed)
	} else {
		if !strings.EqualFold(filepath.Ext(target), ".zip") {
			target += ".zip"
		}
		err = noteexport.WriteZip(target, bundle, allowed)
		target = filepath.Dir(target)
	}
	if err != nil {
		return nil, err
	}
	return &NoteExportResult{Folder: target}, nil
}
