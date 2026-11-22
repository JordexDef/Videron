package main

import (
	"errors"
	"testing"
)

func TestConflictPreviewLeavesEditorKeyAlone(t *testing.T) {
	a, _ := testStore(t)
	const id = "note-a"
	old, err := a.ProtectNote(id, originalNote, testPass)
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.ProtectNote(id, originalNote, nextPass)
	if err != nil {
		t.Fatal(err)
	}
	key := a.noteKeys[id]
	if plain, err := a.PreviewSealedNote(id, old, testPass); err != nil || plain != originalNote || key != a.noteKeys[id] {
		t.Fatal("preview replaced the editor's key", err)
	}
	a.LockNote(id)
	if _, err := a.PreviewSealedNote(id, old, testPass); err != nil || a.noteKeys[id] != nil {
		t.Fatal("preview unlocked a note", err)
	}
	if _, err := a.PreviewSealedNote(id, old, nextPass); !errors.Is(err, errPassword) {
		t.Fatal("wrong version's password", err)
	}
}
