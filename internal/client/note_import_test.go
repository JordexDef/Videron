package client

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"videron/internal/noteimport"
)

func TestReadNoteImportReadsOnlyThePickedSource(t *testing.T) {
	a, _ := testStore(t)
	root := t.TempDir()
	first, second := filepath.Join(root, "first.md"), filepath.Join(root, "second.md")
	for _, file := range []string{first, second} {
		if err := os.WriteFile(file, []byte("# A note"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var filePicks, folderPicks int
	a.hooks.PickImportFile = func(_ context.Context, title string) (string, error) {
		filePicks++
		if filePicks == 1 {
			if title != second {
				t.Fatalf("title was %q", title)
			}
			return first, nil
		}
		return "", nil
	}
	a.hooks.PickFolder = func(_ context.Context, _ string) (string, error) {
		folderPicks++
		return root, nil
	}
	folder, err := a.ReadNoteImport("folder", "Import folder")
	if err != nil || len(folder.Files) != 2 || folderPicks != 1 || filePicks != 0 {
		t.Fatalf("folder import: %#v %v", folder, err)
	}
	file, err := a.ReadNoteImport("file", second)
	if err != nil || len(file.Files) != 1 || file.Files[0].Path != "first.md" || filePicks != 1 {
		t.Fatalf("file import: %#v %v", file, err)
	}
	if bundle, err := a.ReadNoteImport("file", "Import file"); bundle != nil || err != nil || filePicks != 2 {
		t.Fatalf("canceled picker: %#v %v", bundle, err)
	}
	if _, err := a.ReadNoteImport(first, "not a source kind"); !errors.Is(err, noteimport.ErrFormat) || filePicks != 2 {
		t.Fatalf("invalid picker kind: %v", err)
	}
}

func TestReadNoteImportDiscardsSelectionWhenAppLocks(t *testing.T) {
	a, _ := testStore(t)
	file := filepath.Join(t.TempDir(), "secret.md")
	if err := os.WriteFile(file, []byte("# Selected note"), 0o600); err != nil {
		t.Fatal(err)
	}
	called := 0
	a.hooks.PickImportFile = func(context.Context, string) (string, error) {
		called++
		a.LockSession("")
		return file, nil
	}
	if bundle, err := a.ReadNoteImport("file", "Import file"); bundle != nil || !errors.Is(err, errLocked) || called != 1 {
		t.Fatalf("lock during pick returned %#v %v", bundle, err)
	}
	if bundle, err := a.ReadNoteImport("file", "Import file"); bundle != nil || !errors.Is(err, errLocked) || called != 1 {
		t.Fatalf("locked pick returned %#v %v", bundle, err)
	}
}
