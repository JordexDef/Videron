package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func syncDoc(x, y string) string {
	b, _ := json.Marshal(map[string]any{"name": "test space", "notes": []any{map[string]string{"id": "x", "title": x}, map[string]string{"id": "y", "title": y}}, "areas": []any{}})
	return string(b)
}
func titlesIn(s string) []string {
	var shape struct{ Notes []struct{ Title string } }
	_ = json.Unmarshal([]byte(s), &shape)
	r := []string{}
	for _, v := range shape.Notes {
		r = append(r, v.Title)
	}
	return r
}
func sameDoc(t *testing.T, raw, x, y string) {
	t.Helper()
	titles := titlesIn(raw)
	if len(titles) != 2 || titles[0] != x || titles[1] != y {
		t.Fatalf("wrong notes: %v, wanted %s, %s", titles, x, y)
	}
}

// Model two actual cloud directories. Merged paths keep immutable records from
// both peers. The cloud provider may choose either canonical snapshot as winner.
func deliver(t *testing.T, source, target string, includeMain bool) {
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
		if r == folderSpaceFilename && !includeMain {
			return nil
		}
		if r != folderSpaceFilename {
			if _, err := os.Stat(dst); err == nil {
				return nil
			}
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, err = writeAtomic(dst, b, ".sync-test-*")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
func TestRemoteBranchAfterBothAppsClosed(t *testing.T) {
	for _, pw := range []string{"", testPass} {
		t.Run(map[bool]string{true: "encrypted", false: "plain"}[pw != ""], func(t *testing.T) {
			a, _ := testStore(t)
			b := new(App)
			_, _ = b.Load()
			one, two := t.TempDir(), t.TempDir()
			if err := a.CreateFolderSpace(one, syncDoc("first", "second"), pw); err != nil {
				t.Fatal(err)
			}
			la, err := a.FolderSpaceLineage(one)
			if err != nil {
				t.Fatal(err)
			}
			deliver(t, one, two, true)
			if _, err = b.OpenFolderSpace(two, pw); err != nil {
				t.Fatal(err)
			}
			lb, err := b.FolderSpaceLineage(two)
			if err != nil || la != lb {
				t.Fatal(la, lb, err)
			}
			if err = a.SaveFolderBranch(one, syncDoc("laptop secret<&", "second")); err != nil {
				t.Fatal(err)
			}
			if err = b.SaveFolderBranch(two, syncDoc("first", "desktop secret>")); err != nil {
				t.Fatal(err)
			}
			a.CloseFolderSpace(one)
			b.CloseFolderSpace(two)
			deliver(t, two, one, true)
			deliver(t, one, two, false)
			got, err := a.OpenFolderSpace(one, pw)
			if err != nil {
				t.Fatal(err)
			}
			sameDoc(t, got, "laptop secret<&", "second")
			u, err := a.PollFolderSpace(one, true)
			if err != nil || u.Token == "" {
				t.Fatal("lost divergent branch", err, u.Token)
			}
			sameDoc(t, u.Base, "first", "second")
			sameDoc(t, u.Remote, "first", "desktop secret>")
			if err = a.SaveFolderBranch(one, syncDoc("laptop newer<&", "second")); err != nil {
				t.Fatal(err)
			}
			if err = a.CommitFolderMerge(one, u.Token, syncDoc("laptop secret<&", "desktop secret>")); !errors.Is(err, errChanged) {
				t.Fatal("stale choice", err)
			}
			u, err = a.PollFolderSpace(one, true)
			if err != nil {
				t.Fatal(err)
			}
			merged := syncDoc("laptop newer<&", "desktop secret>")
			if err = a.CommitFolderMerge(one, u.Token, merged); err != nil {
				t.Fatal(err)
			}
			if p, err := a.PollFolderSpace(one, true); err != nil || p.Token != "" {
				t.Fatal("repeated merge", err, p.Token)
			}
			deliver(t, one, two, false) // Immutable files alone suffice on later transfers.
			got, err = b.OpenFolderSpace(two, pw)
			if err != nil {
				t.Fatal(err)
			}
			sameDoc(t, got, "first", "desktop secret>")
			u, err = b.PollFolderSpace(two, true)
			if err != nil || u.Token == "" {
				t.Fatal(err, u.Token)
			}
			sameDoc(t, u.Remote, "laptop newer<&", "desktop secret>")
			if err = b.CommitFolderMerge(two, u.Token, u.Remote); err != nil {
				t.Fatal(err)
			}
			deliver(t, two, one, false)
			if u, err = a.PollFolderSpace(one, true); err != nil || u.Token != "" {
				t.Fatal("forked fast-forward", err, u.Token)
			}
			if pw != "" {
				for _, d := range []string{one, two} {
					err = filepath.WalkDir(d, func(path string, entry fs.DirEntry, err error) error {
						if err != nil || entry.IsDir() {
							return err
						}
						raw, e := os.ReadFile(path)
						if bytes.Contains(raw, []byte("secret")) || bytes.Contains(raw, []byte(testPass)) || bytes.Contains(raw, []byte("test space")) {
							t.Fatalf("plaintext in %s", path)
						}
						return e
					})
					if err != nil {
						t.Fatal(err)
					}
				}
			}
			if err = a.DeleteFolderSpace(one); err != nil {
				t.Fatal(err)
			}
			if _, err = os.Stat(filepath.Join(one, syncFolderName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("retained private history", err)
			}
		})
	}
}
func TestUpgradeLegacyAndCanonicalOnlyClone(t *testing.T) {
	a, _ := testStore(t)
	b := new(App)
	_, _ = b.Load()
	one, two := t.TempDir(), t.TempDir()
	legacy, err := encodeSpace(syncDoc("one", "two"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{one, two} {
		if err = os.WriteFile(filepath.Join(dir, folderSpaceFilename), legacy, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = a.OpenFolderSpace(one, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = b.OpenFolderSpace(two, ""); err != nil {
		t.Fatal(err)
	}
	l1, err := a.FolderSpaceLineage(one)
	if err != nil {
		t.Fatal(err)
	}
	l2, err := b.FolderSpaceLineage(two)
	if err != nil || l1 != l2 {
		t.Fatal(l1, l2, err)
	}
	if err = a.SaveFolderBranch(one, syncDoc("new", "two")); err != nil {
		t.Fatal(err)
	}
	lone := t.TempDir()
	raw := stored(t, filepath.Join(one, folderSpaceFilename))
	if err = os.WriteFile(filepath.Join(lone, folderSpaceFilename), raw, 0600); err != nil {
		t.Fatal(err)
	}
	doc, err := a.OpenFolderSpace(lone, "")
	if err != nil {
		t.Fatal(err)
	}
	sameDoc(t, doc, "new", "two")
	if _, err = a.FolderSpaceLineage(lone); err != nil {
		t.Fatal(err)
	}
	if err = a.SaveFolderBranch(lone, syncDoc("new", "three")); err != nil {
		t.Fatal(err)
	}
	foreign := t.TempDir()
	if err = a.CreateFolderSpace(foreign, syncDoc("foreign", "space"), ""); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(lone, folderSpaceFilename), stored(t, filepath.Join(foreign, folderSpaceFilename)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = a.PollFolderSpace(lone, true); !errors.Is(err, errSpaceIdentity) {
		t.Fatal("foreign file accepted", err)
	}
}
func TestSpaceReplicaNeverTrustsDamagedObject(t *testing.T) {
	a, _ := testStore(t)
	dir := t.TempDir()
	if err := a.CreateFolderSpace(dir, spaceFixture, testPass); err != nil {
		t.Fatal(err)
	}
	l, err := a.FolderSpaceLineage(dir)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, syncFolderName, l, "objects")
	files, err := os.ReadDir(root)
	if err != nil || len(files) == 0 {
		t.Fatal(err)
	}
	path := filepath.Join(root, files[0].Name())
	if err = os.WriteFile(path, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	s, _ := a.currentSpaceSession(dir)
	_, err = s.readRecord("objects", strings.TrimSuffix(files[0].Name(), ".json"))
	if err == nil {
		t.Fatal("accepted damaged encrypted object")
	}
}

func TestLateObjectsAndEmbeddedImageReuse(t *testing.T) {
	a, _ := testStore(t)
	b := new(App)
	_, _ = b.Load()
	one, two := t.TempDir(), t.TempDir()
	image := strings.Repeat("IMG_DATA_0123456789", 18000)
	doc := func(title string) string {
		raw, _ := json.Marshal(map[string]any{"name": "Photos", "areas": []string{}, "notes": []any{map[string]any{"id": "x", "title": title, "body": []any{map[string]any{"type": "image", "src": image}}}}})
		return string(raw)
	}
	if err := a.CreateFolderSpace(one, doc("before"), ""); err != nil {
		t.Fatal(err)
	}
	l, err := a.FolderSpaceLineage(one)
	if err != nil {
		t.Fatal(err)
	}
	deliver(t, one, two, true)
	if _, err = b.OpenFolderSpace(two, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = b.FolderSpaceLineage(two); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(one, syncFolderName, l)
	sizes := func() int64 {
		var total int64
		_ = filepath.WalkDir(root, func(_ string, e fs.DirEntry, _ error) error {
			if !e.IsDir() {
				i, _ := e.Info()
				total += i.Size()
			}
			return nil
		})
		return total
	}
	first := sizes()
	if err = a.SaveFolderBranch(one, doc("after")); err != nil {
		t.Fatal(err)
	}
	if added := sizes() - first; added > 5000 {
		t.Fatal("a caption duplicated its image", added)
	}
	deliver(t, filepath.Join(root, "revisions"), filepath.Join(two, syncFolderName, l, "revisions"), true)
	if u, err := b.PollFolderSpace(two, true); !errors.Is(err, errSyncPending) || u.Token != "" {
		t.Fatal("premature partial merge", u.Token, err)
	}
	deliver(t, filepath.Join(root, "objects"), filepath.Join(two, syncFolderName, l, "objects"), true)
	u, err := b.PollFolderSpace(two, false)
	if err != nil || u.Token == "" || !strings.Contains(u.Remote, image) {
		t.Fatal("late image object not picked up", err)
	}
	if err = b.CommitFolderMerge(two, u.Token, u.Remote); err != nil {
		t.Fatal(err)
	}
	if u, err = b.PollFolderSpace(two, true); err != nil || u.Token != "" {
		t.Fatal("unexpected new tip", u.Token, err)
	}
	stashed := stored(t, filepath.Join(two, folderSpaceFilename))
	if err = b.SaveFolderBranch(two, doc("after again")); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(two, folderSpaceFilename), stashed, 0600); err != nil {
		t.Fatal(err)
	}
	if u, err = b.PollFolderSpace(two, true); err != nil || u.Token != "" {
		t.Fatal("old main became a branch", err, u.Token)
	}
	if !bytes.Contains(stored(t, filepath.Join(two, folderSpaceFilename)), []byte("after again")) {
		t.Fatal("older main remained after its new head was recovered")
	}
}

func TestReplicaDeletionPreservesForeignFiles(t *testing.T) {
	a, _ := testStore(t)
	dir := t.TempDir()
	if err := a.CreateFolderSpace(dir, spaceFixture, testPass); err != nil {
		t.Fatal(err)
	}
	l, err := a.FolderSpaceLineage(dir)
	if err != nil {
		t.Fatal(err)
	}
	neighbors := []string{filepath.Join(dir, "photos.txt"), filepath.Join(dir, syncFolderName, "other-data.txt"), filepath.Join(dir, syncFolderName, l, "objects", "readme.txt")}
	for _, f := range neighbors {
		if err = os.WriteFile(f, []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = a.DeleteFolderSpace(dir); err != nil {
		t.Fatal(err)
	}
	for _, f := range neighbors {
		if string(stored(t, f)) != "keep" {
			t.Fatal("removed unrelated file", f)
		}
	}
	if _, err = os.Stat(filepath.Join(dir, folderSpaceFilename)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func TestFailedRevisionWritePreservesCursorAndCanRetry(t *testing.T) {
	a, _ := testStore(t)
	dir := t.TempDir()
	before := syncDoc("first", "second")
	after := syncDoc("edited", "second")
	if err := a.CreateFolderSpace(dir, before, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.FolderSpaceLineage(dir); err != nil {
		t.Fatal(err)
	}
	s, err := a.currentSpaceSession(dir)
	if err != nil {
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
	if err := a.SaveFolderBranch(dir, after); err == nil {
		t.Fatal("save reported success after revision could not be written")
	}
	if s.sync.meta.Head != head || s.storedCursor() != head || s.sync.payload != before {
		t.Fatal("failed save advanced the session or its on-disk cursor")
	}
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveFolderBranch(dir, after); err != nil {
		t.Fatal(err)
	}
	a.CloseFolderSpace(dir)
	got, err := a.OpenFolderSpace(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	sameDoc(t, got, "edited", "second")
}

func TestReopenWaitsForSavedLocalRevision(t *testing.T) {
	a, _ := testStore(t)
	dir := t.TempDir()
	if err := a.CreateFolderSpace(dir, syncDoc("old", "second"), testPass); err != nil {
		t.Fatal(err)
	}
	if _, err := a.FolderSpaceLineage(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, folderSpaceFilename)
	older := stored(t, path)
	if err := a.SaveFolderBranch(dir, syncDoc("local edit", "second")); err != nil {
		t.Fatal(err)
	}
	s, err := a.currentSpaceSession(dir)
	if err != nil {
		t.Fatal(err)
	}
	head := s.sync.meta.Head
	a.CloseFolderSpace(dir)
	if err := os.WriteFile(path, older, 0600); err != nil {
		t.Fatal(err)
	}
	for _, late := range []string{s.graphPath(), filepath.Join(s.graphPath(), "revisions", head+".json")} {
		staging := filepath.Join(t.TempDir(), "late")
		if err := os.Rename(late, staging); err != nil {
			t.Fatal(err)
		}
		if text, err := a.OpenFolderSpace(dir, testPass); !errors.Is(err, errSyncPending) || text != "" || s.storedCursor() != head {
			t.Fatalf("offered a stale snapshot while the local branch was in transit: %v", err)
		}
		if err := os.Rename(staging, late); err != nil {
			t.Fatal(err)
		}
	}
	got, err := a.OpenFolderSpace(dir, testPass)
	if err != nil {
		t.Fatal(err)
	}
	sameDoc(t, got, "local edit", "second")
}

func TestLateMergeParentPreservesRevertedEditOnThreeDevices(t *testing.T) {
	a, _ := testStore(t)
	b, c := new(App), new(App)
	_, _ = b.Load()
	_, _ = c.Load()
	one, two, three := t.TempDir(), t.TempDir(), t.TempDir()
	doc := func(x, y, z string) string {
		return mergeTestJSON(t, mergeTestSpace(mergeTestNote("x", x), mergeTestNote("y", y), mergeTestNote("z", z)))
	}
	apply := func(app *App, dir string) {
		t.Helper()
		proposal, err := app.PrepareFolderMerge(dir, true, "")
		if err != nil || !proposal.Prepared || len(proposal.Conflicts) != 0 {
			t.Fatalf("expected a merge without conflicts: %+v, %v", proposal, err)
		}
		if _, err = app.CommitFolderMergeChoices(dir, proposal.Token, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.CreateFolderSpace(one, doc("0", "0", "0"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.FolderSpaceLineage(one); err != nil {
		t.Fatal(err)
	}
	deliver(t, one, three, true) // C branches before X changes.
	if _, err := c.OpenFolderSpace(three, ""); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveFolderBranch(one, doc("1", "0", "0")); err != nil {
		t.Fatal(err)
	}
	deliver(t, one, two, true) // B sees X=1.
	if _, err := b.OpenFolderSpace(two, ""); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveFolderBranch(one, doc("0", "0", "0")); err != nil { // A explicitly reverts X.
		t.Fatal(err)
	}
	if err := b.SaveFolderBranch(two, doc("1", "B", "0")); err != nil {
		t.Fatal(err)
	}
	bs, err := b.currentSpaceSession(two)
	if err != nil {
		t.Fatal(err)
	}
	lateParent := bs.sync.meta.Head
	if err := c.SaveFolderBranch(three, doc("0", "0", "C")); err != nil {
		t.Fatal(err)
	}
	deliver(t, three, two, false)
	apply(b, two)
	deliver(t, two, one, false)
	s, err := a.currentSpaceSession(one)
	if err != nil {
		t.Fatal(err)
	}
	late := filepath.Join(s.graphPath(), "revisions", lateParent+".json")
	staging := filepath.Join(t.TempDir(), "parent.json")
	if err := os.Rename(late, staging); err != nil {
		t.Fatal(err)
	}
	if p, err := a.PrepareFolderMerge(one, true, ""); !errors.Is(err, errSyncPending) || p.Prepared {
		t.Fatalf("offered an obsolete merge base while B's revision was delayed: %+v, %v", p, err)
	}
	if err := os.Rename(staging, late); err != nil {
		t.Fatal(err)
	}
	apply(a, one)
	for app, dir := range map[*App]string{b: two, c: three} {
		deliver(t, one, dir, false)
		apply(app, dir)
	}
	for app, dir := range map[*App]string{a: one, b: two, c: three} {
		app.CloseFolderSpace(dir)
		got, err := app.OpenFolderSpace(dir, "")
		if err != nil || strings.Join(titlesIn(got), ",") != "0,B,C" {
			t.Fatal("devices did not retain all edits", titlesIn(got), err)
		}
	}
}

func TestTwoCanonicalCopiesCanMergeWithoutOlderHistory(t *testing.T) {
	// Both devices started from the same Videron.space snapshot without its
	// history folder. Its common head is sufficient for subsequent edits.
	graph := map[string][]string{"snapshot": {"older"}, "a": {"snapshot"}, "b": {"snapshot"}}
	s := &folderSpaceSession{sync: spaceReplica{meta: spaceSyncMeta{Head: "a"}, parents: graph}}
	tip, base, err := s.candidate()
	if err != nil || tip != "b" || base != "snapshot" {
		t.Fatal("waiting for revisions older than the shared snapshot", tip, base, err)
	}
}

func TestDeleteBeforeFirstPollPreservesUnmergedBranch(t *testing.T) {
	a, _ := testStore(t)
	b := new(App)
	_, _ = b.Load()
	one, two := t.TempDir(), t.TempDir()
	if err := a.CreateFolderSpace(one, syncDoc("initial", "other"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.FolderSpaceLineage(one); err != nil {
		t.Fatal(err)
	}
	deliver(t, one, two, true)
	if _, err := b.OpenFolderSpace(two, ""); err != nil {
		t.Fatal(err)
	}
	a.CloseFolderSpace(one)
	if err := b.SaveFolderBranch(two, syncDoc("remote edit", "other")); err != nil {
		t.Fatal(err)
	}
	deliver(t, two, one, false)
	if _, err := a.OpenFolderSpace(one, ""); err != nil {
		t.Fatal(err)
	}
	if err := a.DeleteFolderSpace(one); !errors.Is(err, errChanged) {
		t.Fatal("deletion ignored the unopened peer branch", err)
	}
	u, err := a.PollFolderSpace(one, true)
	if err != nil {
		t.Fatal(err)
	}
	sameDoc(t, u.Remote, "remote edit", "other")
}

func TestPeriodicScanWithPreservedDirectoryTimestamp(t *testing.T) {
	a, _ := testStore(t)
	b := new(App)
	_, _ = b.Load()
	one, two := t.TempDir(), t.TempDir()
	if err := a.CreateFolderSpace(one, syncDoc("initial", "other"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.FolderSpaceLineage(one); err != nil {
		t.Fatal(err)
	}
	if _, err := a.PollFolderSpace(one, true); err != nil {
		t.Fatal(err)
	}
	s, err := a.currentSpaceSession(one)
	if err != nil {
		t.Fatal(err)
	}
	modTime := s.sync.scanTime
	deliver(t, one, two, true)
	if _, err := b.OpenFolderSpace(two, ""); err != nil {
		t.Fatal(err)
	}
	if err := b.SaveFolderBranch(two, syncDoc("cloud edit", "other")); err != nil {
		t.Fatal(err)
	}
	deliver(t, two, one, false)
	if err := os.Chtimes(filepath.Join(s.graphPath(), "revisions"), modTime, modTime); err != nil {
		t.Fatal(err)
	}
	s.sync.lastScan = time.Now().Add(-2 * time.Minute)
	u, err := a.CheckFolderSpace(one, "")
	if err != nil {
		t.Fatal(err)
	}
	sameDoc(t, u.Remote, "cloud edit", "other")
}

func TestSaveRepairsMissingCachedObject(t *testing.T) {
	for _, preserved := range []bool{false, true} {
		t.Run(map[bool]string{false: "changed timestamp", true: "preserved timestamp"}[preserved], func(t *testing.T) {
			a, _ := testStore(t)
			dir := t.TempDir()
			if err := a.CreateFolderSpace(dir, syncDoc("first", "keep me"), testPass); err != nil {
				t.Fatal(err)
			}
			if _, err := a.FolderSpaceLineage(dir); err != nil {
				t.Fatal(err)
			}
			s, err := a.currentSpaceSession(dir)
			if err != nil {
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
			if err := a.SaveFolderBranch(dir, syncDoc("edited", "keep me")); err != nil {
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
			sameDoc(t, text, "edited", "keep me")
		})
	}
}

func TestReplicaDeletionRetainsMainOnArchiveFailure(t *testing.T) {
	a, _ := testStore(t)
	dir := t.TempDir()
	if err := a.CreateFolderSpace(dir, spaceFixture, ""); err != nil {
		t.Fatal(err)
	}
	l, err := a.FolderSpaceLineage(dir)
	if err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(dir, syncFolderName, l, "objects", strings.Repeat("a", 64)+".json")
	if err = os.WriteFile(unknown, []byte("not an archive record"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = a.DeleteFolderSpace(dir); err == nil {
		t.Fatal("deleted unverifiable data")
	}
	if _, err = os.Stat(filepath.Join(dir, folderSpaceFilename)); err != nil {
		t.Fatal("removed canonical file on archive error", err)
	}
	if string(stored(t, unknown)) != "not an archive record" {
		t.Fatal("unrelated content changed")
	}
}

func TestFolderReviewTracksLatestPeerEdit(t *testing.T) {
	a, _ := testStore(t)
	b := new(App)
	_, _ = b.Load()
	one, two := t.TempDir(), t.TempDir()
	base := syncDoc("shared", "untouched")
	if err := a.CreateFolderSpace(one, base, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.FolderSpaceLineage(one); err != nil {
		t.Fatal(err)
	}
	deliver(t, one, two, true)
	if _, err := b.OpenFolderSpace(two, ""); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveFolderBranch(one, syncDoc("A's draft", "untouched")); err != nil {
		t.Fatal(err)
	}
	if err := b.SaveFolderBranch(two, syncDoc("B's draft", "untouched")); err != nil {
		t.Fatal(err)
	}
	deliver(t, two, one, true)
	first, err := a.PollFolderSpace(one, true)
	if err != nil || first.Token == "" {
		t.Fatal(err)
	}
	sameDoc(t, first.Base, "shared", "untouched")
	sameDoc(t, first.Remote, "B's draft", "untouched")
	if same, err := a.CheckFolderSpace(one, first.Token); err != nil || same != (FolderSpaceUpdate{Token: first.Token}) {
		t.Fatal("repeated poll returned full snapshots or lost its token", err)
	}
	if fresh, err := a.CheckFolderSpace(one, ""); err != nil || fresh != first {
		t.Fatal("new reader did not receive both snapshots", err)
	}
	if err = b.SaveFolderBranch(two, syncDoc("B's revised draft", "untouched")); err != nil {
		t.Fatal(err)
	}
	deliver(t, two, one, true)
	if err = a.CommitFolderMerge(one, first.Token, first.Remote); !errors.Is(err, errChanged) {
		t.Fatal("stale remote selection accepted", err)
	}
	now, err := a.CheckFolderSpace(one, first.Token)
	if err != nil || now.Token == first.Token {
		t.Fatal(err)
	}
	sameDoc(t, now.Base, "shared", "untouched")
	sameDoc(t, now.Remote, "B's revised draft", "untouched")
	if err = a.CommitFolderMerge(one, now.Token, now.Remote); err != nil {
		t.Fatal(err)
	}
	if update, err := a.PollFolderSpace(one, true); err != nil || update.Token != "" {
		t.Fatal("asked for the same choice twice", err)
	}
}

func TestConcurrentOppositeResolutionsKeepBothVersions(t *testing.T) {
	a, _ := testStore(t)
	b := new(App)
	_, _ = b.Load()
	one, two := t.TempDir(), t.TempDir()
	if err := a.CreateFolderSpace(one, syncDoc("initial", "unchanged"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.FolderSpaceLineage(one); err != nil {
		t.Fatal(err)
	}
	deliver(t, one, two, true)
	if _, err := b.OpenFolderSpace(two, ""); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveFolderBranch(one, syncDoc("A version", "unchanged")); err != nil {
		t.Fatal(err)
	}
	if err := b.SaveFolderBranch(two, syncDoc("B version", "unchanged")); err != nil {
		t.Fatal(err)
	}
	deliver(t, one, two, false)
	deliver(t, two, one, false)
	ua, ea := a.PollFolderSpace(one, true)
	ub, eb := b.PollFolderSpace(two, true)
	if ea != nil || eb != nil || ua.Token == "" || ub.Token == "" {
		t.Fatal("missing initial conflict", ea, eb)
	}
	if err := a.CommitFolderMerge(one, ua.Token, syncDoc("A version", "unchanged")); err != nil {
		t.Fatal(err)
	}
	if err := b.CommitFolderMerge(two, ub.Token, syncDoc("B version", "unchanged")); err != nil {
		t.Fatal(err)
	}
	deliver(t, one, two, false)
	deliver(t, two, one, false)
	ua, ea = a.PollFolderSpace(one, true)
	if ea != nil || ua.Token == "" {
		t.Fatal("lost opposite decision", ea)
	}
	sameDoc(t, ua.Base, "initial", "unchanged")
	sameDoc(t, ua.Remote, "B version", "unchanged")
}
