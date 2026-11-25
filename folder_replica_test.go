package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"videron/internal/workspacestore"
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

func TestReleasedFolderOfflineEditsReachSecondDesktop(t *testing.T) {
	first, _ := testStore(t)
	loadDesktop := func() *App {
		t.Helper()
		app := new(App)
		if _, err := app.Load(); err != nil {
			t.Fatal(err)
		}
		return app
	}
	second := loadDesktop()
	one, two := t.TempDir(), t.TempDir()
	archive, err := zip.OpenReader(filepath.Join("internal", "workspacestore", "testdata", "v0.50.0-history.zip"))
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if err := os.CopyFS(one, &archive.Reader); err != nil {
		t.Fatal(err)
	}
	openAndCheck := func(app *App, dir, firstTitle, secondTitle string) {
		t.Helper()
		doc, err := app.OpenFolderSpace(dir, "")
		if err != nil {
			t.Fatal(err)
		}
		sameDoc(t, doc, firstTitle, secondTitle)
		var space struct {
			Notes []struct {
				ID, Plain string
				Body      []struct{ Runs []struct{ Text string } }
			}
		}
		if err := json.Unmarshal([]byte(doc), &space); err != nil {
			t.Fatal(err)
		}
		for i, want := range []struct{ id, text string }{{"one", "First body"}, {"two", "Second body"}} {
			n := space.Notes[i]
			if n.ID != want.id || n.Plain != want.text || len(n.Body) != 1 || len(n.Body[0].Runs) != 1 || n.Body[0].Runs[0].Text != want.text {
				t.Fatalf("lost the original content of note %s", want.id)
			}
		}
	}
	openAndCheck(first, one, "Saved by v0.50.0", "Second note")
	server := startPasswordTestService(t, "Local history sync fixture")
	if err := first.ConnectSpaceServer(one, server.Code); err != nil {
		t.Fatal(err)
	}
	if err := second.JoinSpaceServer(server.Code, two); err != nil {
		t.Fatal(err)
	}
	openAndCheck(second, two, "Saved by v0.50.0", "Second note")

	server.Stop()
	edit := func(app *App, dir, patch string) {
		t.Helper()
		head, err := app.FolderPatchRevision(dir)
		if err != nil {
			t.Fatal(err)
		}
		if next, err := app.SaveFolderPatch(dir, head, patch); err != nil || next == head {
			t.Fatal("offline autosave", next, err)
		}
	}
	edit(first, one, `{"notes":{"edit":[{"id":"one","set":{"title":"From the first desktop"}}]}}`)
	edit(second, two, `{"notes":{"edit":[{"id":"two","set":{"title":"From the second desktop"}}]}}`)
	first.CloseFolderSpace(one)
	second.CloseFolderSpace(two)
	first, second = loadDesktop(), loadDesktop()
	openAndCheck(first, one, "From the first desktop", "Second note")
	openAndCheck(second, two, "Saved by v0.50.0", "From the second desktop")

	server.Start(t)
	exchange := func(app *App, dir string) {
		t.Helper()
		if cursor, err := app.SyncSpaceServer(dir); err != nil || cursor == "" {
			t.Fatal("exchange with restarted server", cursor, err)
		}
	}
	accept := func(app *App, dir, id string) string {
		t.Helper()
		proposal, err := app.PrepareFolderMerge(dir, true, "")
		if err != nil || !proposal.Prepared || len(proposal.Conflicts) != 0 {
			t.Fatalf("incoming changes for %s: %+v, %v", id, proposal, err)
		}
		if len(proposal.ChangedNotes) != 1 || proposal.ChangedNotes[0] != id {
			t.Fatalf("expected change to %s, got %v", id, proposal.ChangedNotes)
		}
		patch, err := app.CommitFolderMergeChoices(dir, proposal.Token, nil)
		if err != nil || patch.Head == "" {
			t.Fatal("apply peer change", err)
		}
		return patch.Head
	}
	exchange(first, one)
	exchange(second, two)
	merged := accept(second, two, "one")
	exchange(second, two)
	exchange(first, one)
	if head := accept(first, one, "two"); head != merged {
		t.Fatalf("desktops have different revisions: %s, %s", head, merged)
	}
	first.CloseFolderSpace(one)
	second.CloseFolderSpace(two)
	for _, dir := range []string{one, two} {
		app := loadDesktop()
		openAndCheck(app, dir, "From the first desktop", "From the second desktop")
		if u, err := app.PrepareFolderMerge(dir, true, ""); err != nil || u.Token != "" {
			t.Fatal("unexpected pending changes after reopen", u, err)
		}
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
		if r == workspacestore.Filename && !includeMain {
			return nil
		}
		if r != workspacestore.Filename {
			if _, err := os.Stat(dst); err == nil {
				return nil
			}
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, err = workspacestore.WriteAtomic(dst, b, ".sync-test-*")
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
			if _, err = os.Stat(filepath.Join(one, workspacestore.HistoryDirName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("retained private history", err)
			}
		})
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
	root := filepath.Join(one, workspacestore.HistoryDirName, l)
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
	deliver(t, filepath.Join(root, "revisions"), filepath.Join(two, workspacestore.HistoryDirName, l, "revisions"), true)
	if u, err := b.PollFolderSpace(two, true); !errors.Is(err, workspacestore.ErrSyncPending) || u.Token != "" {
		t.Fatal("premature partial merge", u.Token, err)
	}
	deliver(t, filepath.Join(root, "objects"), filepath.Join(two, workspacestore.HistoryDirName, l, "objects"), true)
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
	stashed := stored(t, filepath.Join(two, workspacestore.Filename))
	if err = b.SaveFolderBranch(two, doc("after again")); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(two, workspacestore.Filename), stashed, 0600); err != nil {
		t.Fatal(err)
	}
	if u, err = b.PollFolderSpace(two, true); err != nil || u.Token != "" {
		t.Fatal("old main became a branch", err, u.Token)
	}
	if !bytes.Contains(stored(t, filepath.Join(two, workspacestore.Filename)), []byte("after again")) {
		t.Fatal("older main remained after its new head was recovered")
	}
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
	lateParent := bs.Head()
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
	late := filepath.Join(one, workspacestore.HistoryDirName, s.Lineage(), "revisions", lateParent+".json")
	staging := filepath.Join(t.TempDir(), "parent.json")
	if err := os.Rename(late, staging); err != nil {
		t.Fatal(err)
	}
	if p, err := a.PrepareFolderMerge(one, true, ""); !errors.Is(err, workspacestore.ErrSyncPending) || p.Prepared {
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
