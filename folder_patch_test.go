package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

func TestEncryptedDataTextSpliceReachesSecondClient(t *testing.T) {
	first, _ := testStore(t)
	second := new(App)
	if _, err := second.Load(); err != nil {
		t.Fatal(err)
	}
	server := startPasswordTestService(t, "Temporary sync test password")
	dir, copyDir := t.TempDir(), t.TempDir()
	prefix := strings.Repeat("строка\n", 8192)
	original := prefix + "😀xyz"
	document := func(body string) string {
		note := mergeTestNote("csv", "Data")
		note["type"], note["dataText"] = "data", body
		return mergeTestJSON(t, mergeTestSpace(note))
	}
	if err := first.CreateFolderSpace(dir, document(original), testPass); err != nil {
		t.Fatal(err)
	}
	if err := first.ConnectSpaceServer(dir, server.code); err != nil {
		t.Fatal(err)
	}
	if err := second.JoinSpaceServer(server.code, copyDir); err != nil {
		t.Fatal(err)
	}
	if _, err := second.OpenFolderSpace(copyDir, testPass); err != nil {
		t.Fatal(err)
	}
	head, err := first.FolderPatchRevision(dir)
	if err != nil {
		t.Fatal(err)
	}
	// The Cyrillic prefix takes one UTF-16 unit per rune, the emoji takes two.
	patch := fmt.Sprintf(`{"notes":{"edit":[{"id":"csv","textSplice":{"start":%d,"remove":2,"insert":"😇"}}]}}`, len([]rune(prefix)))
	next, err := first.SaveFolderPatch(dir, head, patch)
	if err != nil || next == head {
		t.Fatal("local edit", err)
	}
	if retry, err := first.SaveFolderPatch(dir, head, patch); err != nil || retry != next {
		t.Fatal("ambiguous acknowledgement", err)
	}
	for _, client := range []struct {
		app *App
		dir string
	}{{first, dir}, {second, copyDir}} {
		if _, err := client.app.SyncSpaceServer(client.dir); err != nil {
			t.Fatal(err)
		}
	}
	proposal, err := second.PrepareFolderMerge(copyDir, true, "")
	if err != nil || proposal.Token == "" || len(proposal.Conflicts) != 0 {
		t.Fatal("expected incoming edit", err)
	}
	if _, err := second.CommitFolderMergeChoices(copyDir, proposal.Token, nil); err != nil {
		t.Fatal(err)
	}
	second.CloseFolderSpace(copyDir)
	got, err := second.OpenFolderSpace(copyDir, testPass)
	if err != nil {
		t.Fatal(err)
	}
	sameTestJSON(t, []byte(got), []byte(document(prefix+"😇xyz")))
}
