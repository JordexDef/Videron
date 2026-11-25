package main

import "encoding/json"

// Undo belongs to this process. Protected snapshots are sealed with the key
// already unlocked for that note, folder or library. Nothing is written to disk.
type EditorHistoryRef struct {
	Space      string `json:"space"`
	Folder     string `json:"folder"`
	Note       string `json:"note"`
	Kind       string `json:"kind"`
	Protection string `json:"protection"`
}

type editorHistoryID struct{ space, folder, note string }
type editorHistoryEntry struct {
	kind, protection string
	data             []byte
}

func (r EditorHistoryRef) id() editorHistoryID {
	folder := r.Folder
	if folder != "" {
		folder = spaceSessionID(folder)
	}
	return editorHistoryID{r.Space, folder, r.Note}
}

func (a *App) editorHistoryKey(r EditorHistoryRef) (*vaultKey, error) {
	if !a.loaded {
		return nil, errLocked
	}
	if r.Space == "" || r.Note == "" || (r.Kind != "text" && r.Kind != "canvas" && r.Kind != "data") {
		return nil, errInvalid
	}
	var key *vaultKey
	switch r.Protection {
	case "note":
		key = a.noteKeys[r.Note]
	case "folder":
		if s := a.folderSpaces[r.id().folder]; s != nil {
			key = s.key
		}
	case "project":
		key = a.projectKey
	case "plain":
		if a.protected {
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

func historyAAD(r EditorHistoryRef) []byte {
	fields, _ := json.Marshal([]string{r.Space, r.id().folder, r.Note, r.Kind, r.Protection})
	return associatedData("videron.editor-history", string(fields))
}

func (a *App) StoreEditorHistory(r EditorHistoryRef, snapshot string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	key, err := a.editorHistoryKey(r)
	if err != nil {
		return err
	}
	id := r.id()
	data := []byte(snapshot)
	if key != nil && len(data) > 0 {
		defer clear(data)
		cipher, err := key.aead()
		if err != nil {
			return err
		}
		data = cipher.Seal(nil, nil, data, historyAAD(r))
	}
	clear(a.editorHistories[id].data)
	if len(data) == 0 {
		delete(a.editorHistories, id)
		return nil
	}
	if a.editorHistories == nil {
		a.editorHistories = make(map[editorHistoryID]editorHistoryEntry)
	}
	a.editorHistories[id] = editorHistoryEntry{r.Kind, r.Protection, data}
	return nil
}

// Opening can be interrupted by a lock before an editor mounts. Keep the
// checkpoint until the editor closes successfully or its protection changes.
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
	id := r.id()
	entry, ok := a.editorHistories[id]
	if !ok {
		return "", nil
	}
	if r.Kind != entry.kind || r.Protection != entry.protection {
		clear(entry.data)
		delete(a.editorHistories, id)
		return "", nil
	}
	if key == nil {
		return string(entry.data), nil
	}
	cipher, err := key.aead()
	if err != nil {
		return "", err
	}
	plain, err := cipher.Open(nil, nil, entry.data, historyAAD(r))
	if err != nil {
		clear(entry.data)
		delete(a.editorHistories, id)
		return "", nil
	}
	defer clear(plain)
	return string(plain), nil
}

func (a *App) ForgetEditorHistories(space string, notes []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.forgetEditorHistories(space, notes)
}

func (a *App) forgetEditorHistories(space string, notes []string) {
	removed := make(map[string]bool, len(notes))
	for _, id := range notes {
		removed[id] = true
	}
	for id, entry := range a.editorHistories {
		if (space == "" || id.space == space) && (len(notes) == 0 || removed[id.note]) {
			clear(entry.data)
			delete(a.editorHistories, id)
		}
	}
}
