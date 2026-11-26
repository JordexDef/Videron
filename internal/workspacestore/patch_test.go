package workspacestore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestFolderPatchKeepsLocalHeadAndRetriesExactPayload(t *testing.T) {
	const original = `{"name":"Test","notes":[{"id":"x","title":"Data","type":"data","dataText":"before"},{"id":"y","title":"Untouched"}],"areas":[]}`
	const splice = `{"notes":{"edit":[{"id":"x","textSplice":{"start":6,"remove":0,"insert":" + after"}}]}}`
	for _, password := range []string{"", "folder-password"} {
		t.Run(map[bool]string{false: "plain", true: "encrypted"}[password != ""], func(t *testing.T) {
			store, dir := historyStore(t), t.TempDir()
			s := createHistorySession(t, store, dir, original, password)
			initial := s.PatchRevision()
			if _, err := os.Stat(filepath.Join(dir, ".videron-sync")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("reading a baseline created history: %v", err)
			}
			// A background poll can initialize the head between opening and typing.
			if _, err := s.Poll(false, ""); err != nil {
				t.Fatal(err)
			}
			head, err := s.SavePatch(initial, splice)
			if err != nil || !validSyncID(head) {
				t.Fatalf("patch head %q: %v", head, err)
			}
			retry, err := s.SavePatch(initial, splice)
			if err != nil || retry != head {
				t.Fatalf("retry %q: %v", retry, err)
			}
			if _, err := s.SavePatch(initial, `{"set":{"name":"Stale"}}`); !errors.Is(err, errChanged) {
				t.Fatalf("stale patch: %v", err)
			}
			if _, err := s.SavePatch(head, `{"set":{"_videronSync":1}}`); err == nil {
				t.Fatal("accepted reserved metadata")
			}
			s.key.Forget()
			reopened, got, err := store.Open(dir, password, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.key.Forget()
			var doc struct {
				Notes []struct{ ID, Title, DataText string }
			}
			if err := json.Unmarshal([]byte(got), &doc); err != nil || !slices.Equal(historyTitles(got), []string{"Data", "Untouched"}) {
				t.Fatalf("reopened notes: %s, %v", got, err)
			}
			if doc.Notes[0].DataText != "before + after" {
				t.Fatalf("patch did not apply exactly once: %q", doc.Notes[0].DataText)
			}
		})
	}
}
