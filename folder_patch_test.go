package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFolderPatchKeepsLocalHeadAndRetriesExactPayload(t *testing.T) {
	for _, password := range []string{"", "folder-password"} {
		t.Run(map[bool]string{false: "plain", true: "encrypted"}[password != ""], func(t *testing.T) {
			a, _ := testStore(t)
			dir := t.TempDir()
			if err := a.CreateFolderSpace(dir, syncDoc("before", "untouched"), password); err != nil {
				t.Fatal(err)
			}
			initial, err := a.FolderPatchRevision(dir)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = os.Stat(filepath.Join(dir, syncFolderName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("reading a baseline created history: %v", err)
			}
			// A background poll can initialize history between opening and typing.
			if _, err = a.PollFolderSpace(dir, false); err != nil {
				t.Fatal(err)
			}
			patch := `{"notes":{"put":[{"id":"x","title":"after"}]}}`
			head, err := a.SaveFolderPatch(dir, initial, patch)
			if err != nil || !validSyncID(head) {
				t.Fatalf("patch head %q: %v", head, err)
			}
			retry, err := a.SaveFolderPatch(dir, initial, patch)
			if err != nil || retry != head {
				t.Fatalf("retry %q: %v", retry, err)
			}
			if _, err = a.SaveFolderPatch(dir, initial, `{"notes":{"remove":["x"]}}`); !errors.Is(err, errChanged) {
				t.Fatalf("stale patch: %v", err)
			}
			if _, err = a.SaveFolderPatch(dir, head, `{"set":{"_videronSync":1}}`); err == nil {
				t.Fatal("accepted reserved metadata")
			}
			a.CloseFolderSpace(dir)
			got, err := a.OpenFolderSpace(dir, password)
			if err != nil {
				t.Fatal(err)
			}
			sameDoc(t, got, "after", "untouched")
		})
	}
}
