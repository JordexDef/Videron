package workspacestore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMoveWaitsForMissingCloudHistory(t *testing.T) {
	store := historyStore(t)
	from, to := t.TempDir(), t.TempDir()
	s := createHistorySession(t, store, from, historyDoc("initial", "second"), historyPassword)
	if err := s.SaveBranch(historyDoc(strings.Repeat("q", separateStringBytes+20), "second")); err != nil {
		t.Fatal(err)
	}
	profiles := t.TempDir()
	move := func() error {
		_, _, err := s.Move(to, filepath.Join(profiles, "old"), filepath.Join(profiles, "new"), func() error { return nil })
		return err
	}
	rev, err := s.readRevision(s.sync.meta.Head)
	if err != nil {
		t.Fatal(err)
	}
	note := rev.Lists["notes"][0]
	raw, err := s.readRecord("objects", note)
	if err != nil {
		t.Fatal(err)
	}
	var val archivedValue
	if json.Unmarshal(raw, &val) != nil || len(val.Refs) == 0 || len(rev.Parents) == 0 {
		t.Fatal("invalid attachment fixture")
	}
	pending := [][2]string{{"revisions", rev.Parents[0]}, {"objects", note}, {"objects", val.Refs[0]}}
	for _, missing := range pending {
		src := filepath.Join(s.graphPath(), missing[0], missing[1]+".json")
		late := filepath.Join(t.TempDir(), "late")
		if err := os.Rename(src, late); err != nil {
			t.Fatal(err)
		}
		if err := move(); !errors.Is(err, ErrSyncPending) {
			t.Fatal("incomplete history moved", err)
		}
		if err := s.verifyCurrent(); err != nil {
			t.Fatal("source main retired", err)
		}
		if entries, err := os.ReadDir(to); err != nil || len(entries) != 0 {
			t.Fatal("staged files left", err)
		}
		if err := os.Rename(late, src); err != nil {
			t.Fatal(err)
		}
	}
	if err = move(); err != nil {
		t.Fatal("retry after cloud delivery", err)
	}
}
