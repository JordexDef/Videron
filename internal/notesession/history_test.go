package notesession

import (
	"bytes"
	"errors"
	"os"
	"testing"

	"videron/internal/vault"
)

func TestProtectedEditorHistoryFollowsUnlockAndSurvivesInterruptedOpen(t *testing.T) {
	var history History
	ref := EditorHistoryRef{Space: "one", Note: "note-a", Kind: "text", Protection: "note"}
	plain := ref
	plain.Protection = "plain"
	if err := history.Store(plain, nil, "parked before encryption"); err != nil {
		t.Fatal(err)
	}
	cleartext := history.entries[ref.id()].data
	key, err := vault.NewKey("first history fixture")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(key.Forget)
	if got, err := history.Read(ref, key); err != nil || got != "" || len(history.entries) != 0 {
		t.Fatal("plaintext checkpoint retained after the note was encrypted", err)
	}
	if !bytes.Equal(cleartext, make([]byte, len(cleartext))) {
		t.Fatal("old plaintext was not wiped")
	}

	const draft = "removed private paragraph in undo"
	if err := history.Store(ref, nil, draft); !errors.Is(err, vault.ErrLocked) || len(history.entries) != 0 {
		t.Fatal("stored protected history without a key", err)
	}
	if err := history.Store(ref, key, draft); err != nil {
		t.Fatal(err)
	}
	entry := history.entries[ref.id()]
	if bytes.Contains(entry.data, []byte(draft)) {
		t.Fatal("protected checkpoint held in plaintext")
	}
	foreign := ref
	foreign.Space = "two"
	foreignEntry := entry
	foreignEntry.data = bytes.Clone(entry.data)
	history.entries[foreign.id()] = foreignEntry
	if got, err := history.Read(foreign, key); got != "" || err != nil {
		t.Fatal("project boundary", err)
	}

	reopened := key.Clone()
	t.Cleanup(reopened.Forget)
	key.Forget()
	if _, err := history.Read(ref, key); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("forgotten key discarded a recoverable checkpoint", err)
	}
	if _, err := history.Read(ref, nil); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("closed note exposed history", err)
	}
	for range 2 {
		if got, err := history.Read(ref, reopened); got != draft || err != nil {
			t.Fatal("checkpoint lost on interrupted open", err)
		}
	}
	rotated, err := vault.NewKey("rotated history fixture")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rotated.Forget)
	if got, err := history.Read(ref, rotated); got != "" || err != nil {
		t.Fatal("obsolete note key still reads history", err)
	}
	if len(history.entries) != 0 || !bytes.Equal(entry.data, make([]byte, len(entry.data))) {
		t.Fatal("obsolete checkpoint was not wiped")
	}
}

func TestEditorHistoryFolderIdentityAndForgetting(t *testing.T) {
	var history History
	key, err := vault.NewKey("shared history fixture")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(key.Forget)
	folder := EditorHistoryRef{Space: "one", Folder: t.TempDir(), Note: "same", Kind: "canvas", Protection: "folder"}
	other := folder
	other.Space = "two"
	other.Folder = t.TempDir()
	otherNote := folder
	otherNote.Note = "another note"
	for _, ref := range []EditorHistoryRef{folder, other, otherNote} {
		if err := history.Store(ref, key, ref.Space+" "+ref.Note); err != nil {
			t.Fatal(err)
		}
	}
	alias := folder
	alias.Folder += string(os.PathSeparator) + "."
	if got, err := history.Read(alias, key); got != "one same" || err != nil {
		t.Fatal("canonical path failed to find checkpoint", err)
	}
	forgotten := history.entries[folder.id()].data
	history.Forget("one", []string{"same"})
	if got, err := history.Read(alias, key); got != "" || err != nil {
		t.Fatal("closed note retained its checkpoint", err)
	}
	if !bytes.Equal(forgotten, make([]byte, len(forgotten))) {
		t.Fatal("forgotten checkpoint was not wiped")
	}
	if got, err := history.Read(other, key); got != "two same" || err != nil {
		t.Fatal("another project's checkpoint was lost", err)
	}
	if got, err := history.Read(otherNote, key); got != "one another note" || err != nil {
		t.Fatal("another note's checkpoint was lost", err)
	}
	remaining := history.entries[other.id()].data
	history.Forget("", nil)
	if len(history.entries) != 0 || !bytes.Equal(remaining, make([]byte, len(remaining))) {
		t.Fatal("process close did not clear checkpoints")
	}
}
