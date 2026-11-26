package client

import (
	"context"
	"errors"
	"testing"
)

// A Windows lock prevents reopening notes immediately, while an existing
// editor can still finish sealing its last edit before the session locks.
func TestNoteSessionBoundariesRevokeRememberedAccess(t *testing.T) {
	a, _ := testStore(t)
	const id, space = "note-a", "personal"
	sealed, err := a.ProtectNote(id, originalNote, testPass)
	if err != nil {
		t.Fatal(err)
	}
	assertLocked := func() {
		t.Helper()
		if _, err := a.ResumeNote(space, id, sealed); !errors.Is(err, errLocked) {
			t.Fatal("unexpected remembered access", err)
		}
	}
	unlock := func() {
		t.Helper()
		if got, err := a.UnlockNoteFor(space, id, sealed, testPass, -1); err != nil || !got.Remembered {
			t.Fatal("expected a remembered unlock", err)
		}
	}
	unlock()
	a.CloseNoteEditor(id)
	a.ForgetRememberedNotes()
	assertLocked()

	unlock()
	a.sessionLocked(context.Background())
	assertLocked()
	if _, err := a.SealNote(id, originalNote); err != nil {
		t.Fatal("OS lock lost the final editor save", err)
	}
	a.CloseNoteEditor(id)
	if !a.ConsumeSessionLock() {
		t.Fatal("missing lock notification")
	}
	assertLocked()

	unlock()
	a.FinishClose()
	if _, err := a.Load(); err != nil {
		t.Fatal(err)
	}
	assertLocked()
	if _, err := a.SealNote(id, originalNote); !errors.Is(err, errLocked) {
		t.Fatal("closed session retained the editor key", err)
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
			if scope == "folder" {
				if _, err := a.Load(); err != nil {
					t.Fatal(err)
				}
				_, err = a.OpenFolderSpace(ref.Folder, testPass)
			} else {
				_, err = a.UnlockProject(testPass)
			}
			if err != nil {
				t.Fatal(err)
			}
			if got, err := a.ReadEditorHistory(ref); got != "" || err != nil {
				t.Fatal("history survived process close", err)
			}
		})
	}
}
