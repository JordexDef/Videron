package workspacestore

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestFolderPatchKeepsLocalHeadAndRetriesExactPayload(t *testing.T) {
	original := historyDoc("before", "untouched")
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
			calls := 0
			rename := func(current []byte, title string) ([]byte, error) {
				calls++
				return bytes.Replace(current, []byte(`"before"`), []byte(`"`+title+`"`), 1), nil
			}
			head, err := s.SavePatch(initial, "after", rename)
			if err != nil || !validSyncID(head) {
				t.Fatalf("patch head %q: %v", head, err)
			}
			retry, err := s.SavePatch(initial, "after", rename)
			if err != nil || retry != head || calls != 1 {
				t.Fatalf("retry %q after %d applications: %v", retry, calls, err)
			}
			if _, err := s.SavePatch(initial, "other", rename); !errors.Is(err, errChanged) {
				t.Fatalf("stale patch: %v", err)
			}
			injectMetadata := func(current []byte, _ string) ([]byte, error) {
				return bytes.Replace(current, []byte("{"), []byte(`{"_videronSync":1,`), 1), nil
			}
			if _, err := s.SavePatch(head, "reserved", injectMetadata); err == nil {
				t.Fatal("accepted reserved metadata")
			}
			s.key.Forget()
			reopened, got, err := store.Open(dir, password, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.key.Forget()
			if !slices.Equal(historyTitles(got), []string{"after", "untouched"}) {
				t.Fatalf("reopened committed value: %s", got)
			}
		})
	}
}
