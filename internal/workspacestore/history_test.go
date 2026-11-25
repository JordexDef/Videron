package workspacestore

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"videron/internal/vault"
)

const historyPassword = "storage fixture password"

type fixtureNote struct{}

var fixtureNotes = vault.NewNoteValidator(nil)

func (*fixtureNote) UnmarshalJSON(raw []byte) error { return fixtureNotes.Validate(raw) }

func historyStore(t *testing.T) *Store {
	t.Helper()
	// Each OS resolves the private cursor below its own config directory.
	dir := t.TempDir()
	t.Setenv("AppData", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	return New[fixtureNote]()
}

func createHistorySession(t *testing.T, store *Store, dir, payload, password string) *Session {
	t.Helper()
	s, err := store.Create(dir, payload, password)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Key().Forget)
	return s
}

func readHistoryFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func historyDoc(x, y string) string {
	b, _ := json.Marshal(map[string]any{"name": "test space", "notes": []any{map[string]string{"id": "x", "title": x}, map[string]string{"id": "y", "title": y}}, "areas": []any{}})
	return string(b)
}
func historyTitles(s string) []string {
	var shape struct{ Notes []struct{ Title string } }
	_ = json.Unmarshal([]byte(s), &shape)
	r := []string{}
	for _, v := range shape.Notes {
		r = append(r, v.Title)
	}
	return r
}
func wantHistoryDoc(t *testing.T, raw, x, y string) {
	t.Helper()
	titles := historyTitles(raw)
	if len(titles) != 2 || titles[0] != x || titles[1] != y {
		t.Fatalf("wrong notes: %v, wanted %s, %s", titles, x, y)
	}
}

// Model two actual cloud directories. Merged paths keep immutable records from
// both peers. The cloud provider may choose either canonical snapshot as winner.
func deliverHistory(t *testing.T, source, target string, includeMain bool) {
	t.Helper()
	err := filepath.WalkDir(source, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		r, _ := filepath.Rel(source, path)
		dst := filepath.Join(target, r)
		if d.IsDir() {
			return os.MkdirAll(dst, 0700)
		}
		if r == Filename && !includeMain {
			return nil
		}
		if r != Filename {
			if _, err := os.Stat(dst); err == nil {
				return nil
			}
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, err = WriteAtomic(dst, b, ".sync-test-*")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
func TestUpgradeLegacyAndCanonicalOnlyClone(t *testing.T) {
	store := historyStore(t)
	one, two := t.TempDir(), t.TempDir()
	legacy, err := store.EncodeSpace(historyDoc("one", "two"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{one, two} {
		if err = os.WriteFile(filepath.Join(dir, Filename), legacy, 0600); err != nil {
			t.Fatal(err)
		}
	}
	s, _, err := store.Open(one, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	peer, _, err := store.Open(two, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	l1, err := s.EnsureLineage()
	if err != nil {
		t.Fatal(err)
	}
	l2, err := peer.EnsureLineage()
	if err != nil || l1 != l2 {
		t.Fatal(l1, l2, err)
	}
	if err = s.SaveBranch(historyDoc("new", "two")); err != nil {
		t.Fatal(err)
	}
	lone := t.TempDir()
	raw := readHistoryFile(t, filepath.Join(one, Filename))
	if err = os.WriteFile(filepath.Join(lone, Filename), raw, 0600); err != nil {
		t.Fatal(err)
	}
	clone, doc, err := store.Open(lone, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	wantHistoryDoc(t, doc, "new", "two")
	if _, err = clone.EnsureLineage(); err != nil {
		t.Fatal(err)
	}
	if err = clone.SaveBranch(historyDoc("new", "three")); err != nil {
		t.Fatal(err)
	}
	foreign := t.TempDir()
	createHistorySession(t, store, foreign, historyDoc("foreign", "space"), "")
	if err = os.WriteFile(filepath.Join(lone, Filename), readHistoryFile(t, filepath.Join(foreign, Filename)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = clone.Poll(true, ""); !errors.Is(err, ErrSpaceIdentity) {
		t.Fatal("foreign file accepted", err)
	}
}
func TestSpaceReplicaNeverTrustsDamagedObject(t *testing.T) {
	store := historyStore(t)
	dir := t.TempDir()
	s := createHistorySession(t, store, dir, historyDoc("first", "second"), historyPassword)
	l, err := s.EnsureLineage()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, HistoryDirName, l, "objects")
	files, err := os.ReadDir(root)
	if err != nil || len(files) == 0 {
		t.Fatal(err)
	}
	path := filepath.Join(root, files[0].Name())
	if err = os.WriteFile(path, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}

	_, err = s.readRecord("objects", strings.TrimSuffix(files[0].Name(), ".json"))
	if err == nil {
		t.Fatal("accepted damaged encrypted object")
	}
}

func TestReplicaDeletionPreservesForeignFiles(t *testing.T) {
	store := historyStore(t)
	dir := t.TempDir()
	s := createHistorySession(t, store, dir, historyDoc("first", "second"), historyPassword)
	l, err := s.EnsureLineage()
	if err != nil {
		t.Fatal(err)
	}
	neighbors := []string{filepath.Join(dir, "photos.txt"), filepath.Join(dir, HistoryDirName, "other-data.txt"), filepath.Join(dir, HistoryDirName, l, "objects", "readme.txt")}
	for _, f := range neighbors {
		if err = os.WriteFile(f, []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.Delete(); err != nil {
		t.Fatal(err)
	}
	for _, f := range neighbors {
		if string(readHistoryFile(t, f)) != "keep" {
			t.Fatal("removed unrelated file", f)
		}
	}
	if _, err = os.Stat(filepath.Join(dir, Filename)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func TestFailedRevisionWritePreservesCursorAndCanRetry(t *testing.T) {
	store := historyStore(t)
	dir := t.TempDir()
	before := historyDoc("first", "second")
	after := historyDoc("edited", "second")
	s := createHistorySession(t, store, dir, before, "")
	if _, err := s.EnsureLineage(); err != nil {
		t.Fatal(err)
	}

	head := s.sync.meta.Head
	revision, err := s.manifest(after, []string{head})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(revision)
	if err != nil {
		t.Fatal(err)
	}
	blocked := filepath.Join(s.graphPath(), "revisions", s.recordID("revisions", raw)+".json")
	if err := os.Mkdir(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveBranch(after); err == nil {
		t.Fatal("save reported success after revision could not be written")
	}
	if s.sync.meta.Head != head || s.storedCursor() != head || s.sync.payload != before {
		t.Fatal("failed save advanced the session or its on-disk cursor")
	}
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveBranch(after); err != nil {
		t.Fatal(err)
	}
	s.Key().Forget()
	_, got, err := store.Open(dir, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	wantHistoryDoc(t, got, "edited", "second")
}

func TestReopenWaitsForSavedLocalRevision(t *testing.T) {
	store := historyStore(t)
	dir := t.TempDir()
	s := createHistorySession(t, store, dir, historyDoc("old", "second"), historyPassword)
	if _, err := s.EnsureLineage(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, Filename)
	older := readHistoryFile(t, path)
	if err := s.SaveBranch(historyDoc("local edit", "second")); err != nil {
		t.Fatal(err)
	}

	head := s.sync.meta.Head
	s.Key().Forget()
	if err := os.WriteFile(path, older, 0600); err != nil {
		t.Fatal(err)
	}
	for _, late := range []string{s.graphPath(), filepath.Join(s.graphPath(), "revisions", head+".json")} {
		staging := filepath.Join(t.TempDir(), "late")
		if err := os.Rename(late, staging); err != nil {
			t.Fatal(err)
		}
		if _, text, err := store.Open(dir, historyPassword, nil); !errors.Is(err, ErrSyncPending) || text != "" || s.storedCursor() != head {
			t.Fatalf("offered a stale snapshot while the local branch was in transit: %v", err)
		}
		if err := os.Rename(staging, late); err != nil {
			t.Fatal(err)
		}
	}
	again, got, err := store.Open(dir, historyPassword, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Key().Forget()
	wantHistoryDoc(t, got, "local edit", "second")
}

func TestTwoCanonicalCopiesCanMergeWithoutOlderHistory(t *testing.T) {
	// Both devices started from the same Videron.space snapshot without its
	// history folder. Its common head is sufficient for subsequent edits.
	graph := map[string][]string{"snapshot": {"older"}, "a": {"snapshot"}, "b": {"snapshot"}}
	s := &Session{sync: spaceReplica{meta: spaceSyncMeta{Head: "a"}, parents: graph}}
	tip, base, err := s.candidate()
	if err != nil || tip != "b" || base != "snapshot" {
		t.Fatal("waiting for revisions older than the shared snapshot", tip, base, err)
	}
}

func TestPeriodicScanWithPreservedDirectoryTimestamp(t *testing.T) {
	store := historyStore(t)
	one, two := t.TempDir(), t.TempDir()
	s := createHistorySession(t, store, one, historyDoc("initial", "other"), "")
	if _, err := s.EnsureLineage(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Poll(true, ""); err != nil {
		t.Fatal(err)
	}

	modTime := s.sync.scanTime
	deliverHistory(t, one, two, true)
	peer, _, err := store.Open(two, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := peer.SaveBranch(historyDoc("cloud edit", "other")); err != nil {
		t.Fatal(err)
	}
	deliverHistory(t, two, one, false)
	if err := os.Chtimes(filepath.Join(s.graphPath(), "revisions"), modTime, modTime); err != nil {
		t.Fatal(err)
	}
	s.sync.lastScan = time.Now().Add(-2 * time.Minute)
	u, err := s.Poll(false, "")
	if err != nil {
		t.Fatal(err)
	}
	wantHistoryDoc(t, u.Remote, "cloud edit", "other")
}

func TestSaveRepairsMissingCachedObject(t *testing.T) {
	for _, preserved := range []bool{false, true} {
		t.Run(map[bool]string{false: "changed timestamp", true: "preserved timestamp"}[preserved], func(t *testing.T) {
			store := historyStore(t)
			dir := t.TempDir()
			s := createHistorySession(t, store, dir, historyDoc("first", "keep me"), historyPassword)
			if _, err := s.EnsureLineage(); err != nil {
				t.Fatal(err)
			}

			revision, err := s.readRevision(s.sync.meta.Head)
			if err != nil {
				t.Fatal(err)
			}
			parent := filepath.Join(s.graphPath(), "objects")
			id := revision.Lists["notes"][1]
			if err := os.Remove(filepath.Join(parent, id+".json")); err != nil {
				t.Fatal(err)
			}
			stamp := s.sync.objectDirTime.Add(time.Minute)
			if preserved {
				stamp = s.sync.objectDirTime
				s.sync.lastObjectScan = time.Now().Add(-2 * time.Minute)
			}
			if err := os.Chtimes(parent, stamp, stamp); err != nil {
				t.Fatal(err)
			}
			if err := s.SaveBranch(historyDoc("edited", "keep me")); err != nil {
				t.Fatal(err)
			}
			revision, err = s.readRevision(s.sync.meta.Head)
			if err != nil {
				t.Fatal(err)
			}
			text, err := s.materialize(revision)
			if err != nil {
				t.Fatal("new revision references an absent object", err)
			}
			wantHistoryDoc(t, text, "edited", "keep me")
		})
	}
}

func TestReplicaDeletionRetainsMainOnArchiveFailure(t *testing.T) {
	store := historyStore(t)
	dir := t.TempDir()
	s := createHistorySession(t, store, dir, historyDoc("first", "second"), "")
	l, err := s.EnsureLineage()
	if err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(dir, HistoryDirName, l, "objects", strings.Repeat("a", 64)+".json")
	if err = os.WriteFile(unknown, []byte("not an archive record"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = s.Delete(); err == nil {
		t.Fatal("deleted unverifiable data")
	}
	if _, err = os.Stat(filepath.Join(dir, Filename)); err != nil {
		t.Fatal("removed canonical file on archive error", err)
	}
	if string(readHistoryFile(t, unknown)) != "not an archive record" {
		t.Fatal("unrelated content changed")
	}
}

// Generated by CreateFolderSpace and SaveFolderBranch at tag v0.50.0
// (5fe0957). Keep the original record bytes when changing the reader.
func TestArchivedV050History(t *testing.T) {
	store := historyStore(t)
	dir := t.TempDir()
	archive, err := zip.OpenReader(filepath.Join("testdata", "v0.50.0-history.zip"))
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if err := os.CopyFS(dir, &archive.Reader); err != nil {
		t.Fatal(err)
	}
	s, payload, err := store.Open(dir, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	wantHistoryDoc(t, payload, "Saved by v0.50.0", "Second note")
	head, err := s.readRevision(s.Head())
	if err != nil || len(head.Parents) != 1 {
		t.Fatal("missing parent in archived v0.50.0 history", err)
	}
	current, err := s.materialize(head)
	if err != nil {
		t.Fatal(err)
	}
	wantHistoryDoc(t, current, "Saved by v0.50.0", "Second note")
	parent, err := s.readRevision(head.Parents[0])
	if err != nil {
		t.Fatal(err)
	}
	original, err := s.materialize(parent)
	if err != nil {
		t.Fatal(err)
	}
	wantHistoryDoc(t, original, "Before release edit", "Second note")
}
