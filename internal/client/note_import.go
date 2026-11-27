package client

import "videron/internal/noteimport"

// ReadNoteImport accepts a source only through a native picker. Local paths
// supplied by arbitrary WebView messages cannot authorize reading any file.
func (a *App) ReadNoteImport(kind, title string) (*noteimport.Bundle, error) {
	pick, read := a.hooks.PickImportFile, noteimport.ReadFile
	switch kind {
	case "folder":
		pick, read = a.hooks.PickFolder, noteimport.ReadFolder
	case "file":
	default:
		return nil, noteimport.ErrFormat
	}
	if pick == nil {
		return nil, noteimport.ErrRead
	}
	a.mu.Lock()
	ready, ctx := a.canUnlockNote(), a.ctx
	a.mu.Unlock()
	if !ready {
		return nil, errLocked
	}
	source, err := pick(ctx, title)
	if err != nil {
		return nil, noteimport.ErrRead
	}
	if source == "" {
		return nil, nil
	}
	bundle, err := read(source)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.canUnlockNote() {
		return nil, errLocked
	}
	return &bundle, nil
}
