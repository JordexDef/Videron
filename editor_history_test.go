package main

import (
	"bytes"
	"errors"
	"testing"
)

func TestProtectedEditorHistoryFollowsUnlockAndSurvivesInterruptedOpen(t *testing.T) {
	a, _ := testStore(t)
	ref := EditorHistoryRef{Space: "one", Note: "note-a", Kind: "text", Protection: "note"}
	plain := ref
	plain.Protection = "plain"
	if err := a.StoreEditorHistory(plain, "parked before encryption"); err != nil {
		t.Fatal(err)
	}
	sealed, err := a.ProtectNote(ref.Note, originalNote, testPass)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := a.ReadEditorHistory(ref); err != nil || got != "" || len(a.editorHistories) != 0 {
		t.Fatal("plaintext checkpoint retained after the note was encrypted", err)
	}
	const draft = "removed private paragraph in undo"
	if err := a.StoreEditorHistory(ref, draft); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(a.editorHistories[ref.id()].data, []byte(draft)) {
		t.Fatal("protected checkpoint held in plaintext")
	}
	foreign := ref
	foreign.Space = "two"
	foreignEntry := a.editorHistories[ref.id()]
	foreignEntry.data = bytes.Clone(foreignEntry.data)
	a.editorHistories[foreign.id()] = foreignEntry
	if got, err := a.ReadEditorHistory(foreign); got != "" || err != nil {
		t.Fatal("project boundary", err)
	}
	a.noteKeys[ref.Note].Forget()
	if _, err := a.ReadEditorHistory(ref); !errors.Is(err, errLocked) {
		t.Fatal("forgotten key discarded a recoverable checkpoint", err)
	}
	a.LockNote(ref.Note)
	if _, err := a.ReadEditorHistory(ref); !errors.Is(err, errLocked) {
		t.Fatal("closed note exposed history", err)
	}
	if _, err := a.UnlockNote(ref.Note, sealed, testPass); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if got, err := a.ReadEditorHistory(ref); got != draft || err != nil {
			t.Fatal("checkpoint lost on interrupted open", err)
		}
	}
	if _, err := a.ProtectNote(ref.Note, originalNote, nextPass); err != nil {
		t.Fatal(err)
	}
	if got, err := a.ReadEditorHistory(ref); got != "" || err != nil {
		t.Fatal("obsolete note key still reads history", err)
	}
}

func TestEditorHistoryUnderFolderAndLibraryLocks(t *testing.T) {
	for _, scope := range []string{"folder", "project"} {
		t.Run(scope, func(t *testing.T) {
			a, _ := testStore(t)
			ref := EditorHistoryRef{Space: "workspace", Note: "note-a", Kind: "canvas", Protection: scope}
			const previous = "deleted drawing text"
			if scope == "folder" {
				ref.Folder = t.TempDir()
				if err := a.CreateFolderSpace(ref.Folder, spaceFixture, testPass); err != nil {
					t.Fatal(err)
				}
			} else if err := a.ProtectProject(libraryPrefix+originalNote+librarySuffix, testPass); err != nil {
				t.Fatal(err)
			}
			if err := a.StoreEditorHistory(ref, previous); err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(a.editorHistories[ref.id()].data, []byte(previous)) {
				t.Fatal("exposed history")
			}
			if scope == "folder" {
				a.SuspendFolderSpace(ref.Folder)
			} else {
				a.LockSession(ref.Note)
			}
			if _, err := a.ReadEditorHistory(ref); !errors.Is(err, errLocked) {
				t.Fatal("read while locked", err)
			}
			var err error
			if scope == "folder" {
				_, err = a.ResumeFolderSpace(ref.Folder)
			} else {
				_, err = a.UnlockProject(testPass)
			}
			if err != nil {
				t.Fatal(err)
			}
			if got, err := a.ReadEditorHistory(ref); got != previous || err != nil {
				t.Fatal("missing history after unlock", err)
			}
			a.FinishClose()
			if len(a.editorHistories) != 0 {
				t.Fatal("history survived process close")
			}
		})
	}
}
