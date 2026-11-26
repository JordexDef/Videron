package notesession

import (
	"errors"
	"testing"

	"videron/internal/vault"
)

func TestConflictPreviewLeavesEditorKeyAlone(t *testing.T) {
	var a NoteKeys
	const id = "note-a"
	old, err := a.Protect(id, noteFixture, notePassword)
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.Protect(id, noteFixture, nextNotePassword)
	if err != nil {
		t.Fatal(err)
	}
	key := a.EditorKey(id)
	if plain, err := a.Preview(id, old, notePassword, canUnlockFixture); err != nil || plain != noteFixture || key != a.EditorKey(id) {
		t.Fatal("preview replaced the editor's key", err)
	}
	a.Lock(id)
	if _, err := a.Preview(id, old, notePassword, canUnlockFixture); err != nil || a.EditorKey(id) != nil {
		t.Fatal("preview unlocked a note", err)
	}
	if _, err := a.Preview(id, old, nextNotePassword, canUnlockFixture); !errors.Is(err, vault.ErrPassword) {
		t.Fatal("wrong version's password", err)
	}
}
