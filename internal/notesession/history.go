package notesession

import (
	"encoding/json"
	"errors"

	"videron/internal/vault"
	"videron/internal/workspacestore"
)

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

// FolderID uses the same path identity as the open folder session.
func (r EditorHistoryRef) FolderID() string {
	if r.Folder == "" {
		return ""
	}
	return workspacestore.SessionID(r.Folder)
}

func (r EditorHistoryRef) id() editorHistoryID {
	return editorHistoryID{r.Space, r.FolderID(), r.Note}
}

// History is the editor checkpoint store for a process. Its zero value is
// ready to use. Callers serialize access and keep the supplied key valid for
// the duration of each call.
type History struct {
	entries map[editorHistoryID]editorHistoryEntry
}

const editorHistoryScope = "videron.editor-history"

func historyContextID(r EditorHistoryRef) string {
	fields, _ := json.Marshal([]string{r.Space, r.FolderID(), r.Note, r.Kind, r.Protection})
	return string(fields)
}

// Store replaces the previous checkpoint, wiping its bytes.
func (h *History) Store(r EditorHistoryRef, key *vault.Key, snapshot string) error {
	if key == nil && r.Protection != "plain" {
		return vault.ErrLocked
	}
	id := r.id()
	data := []byte(snapshot)
	if key != nil && len(data) > 0 {
		defer clear(data)
		sealed, err := key.SealBytes(editorHistoryScope, historyContextID(r), data)
		if err != nil {
			return err
		}
		data = sealed
	}
	clear(h.entries[id].data)
	if len(data) == 0 {
		delete(h.entries, id)
		return nil
	}
	if h.entries == nil {
		h.entries = make(map[editorHistoryID]editorHistoryEntry)
	}
	h.entries[id] = editorHistoryEntry{r.Kind, r.Protection, data}
	return nil
}

// Opening can be interrupted by a lock before an editor mounts. Keep the
// checkpoint until the editor closes successfully or its protection changes.
func (h *History) Read(r EditorHistoryRef, key *vault.Key) (string, error) {
	if key == nil && r.Protection != "plain" {
		return "", vault.ErrLocked
	}
	id := r.id()
	entry, ok := h.entries[id]
	if !ok {
		return "", nil
	}
	if r.Kind != entry.kind || r.Protection != entry.protection {
		clear(entry.data)
		delete(h.entries, id)
		return "", nil
	}
	if key == nil {
		return string(entry.data), nil
	}
	plain, err := key.OpenBytes(editorHistoryScope, historyContextID(r), entry.data)
	if err != nil {
		if !errors.Is(err, vault.ErrPassword) {
			return "", err
		}
		clear(entry.data)
		delete(h.entries, id)
		return "", nil
	}
	defer clear(plain)
	return string(plain), nil
}

// Forget clears matching checkpoints. Empty space and notes filters match all.
func (h *History) Forget(space string, notes []string) {
	removed := make(map[string]bool, len(notes))
	for _, id := range notes {
		removed[id] = true
	}
	for id, entry := range h.entries {
		if (space == "" || id.space == space) && (len(notes) == 0 || removed[id.note]) {
			clear(entry.data)
			delete(h.entries, id)
		}
	}
}
