package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

func sameTestJSON(t *testing.T, a, b []byte) {
	t.Helper()
	var actual, want any
	for _, item := range []struct {
		data  []byte
		value *any
	}{{a, &actual}, {b, &want}} {
		d := json.NewDecoder(bytes.NewReader(item.data))
		d.UseNumber()
		if err := d.Decode(item.value); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(actual, want) {
		t.Fatal("unexpected JSON document", string(a))
	}
}

func TestCatalogPatchPreservesOrderMetadataAndExactNumbers(t *testing.T) {
	a, path := testStore(t)
	first := `{"version":1,"active":"personal","spaces":{"personal":{"notes":[{"id":"n1","n":9007199254740993},{"id":"n2"},{"id":"n3"}],"areas":[{"id":"a"}],"keep":{"x":true}}},"plugins":[],"obsolete":0}`
	if revision, err := a.CatalogRevision(); err != nil || revision != "" {
		t.Fatal(revision, err)
	}
	if err := a.Save(first); err != nil {
		t.Fatal(err)
	}
	rev, _ := a.CatalogRevision()
	edit := `{"set":{"version":3,"autoLockMinutes":7},"unset":["obsolete"],"spaces":{"personal":{"notes":{"put":[{"id":"n2","title":"edited"},{"id":"n4"}],"remove":["n3"],"order":["n4","n1","n2"]},"areas":{"remove":["a"]},"set":{"name":"Local"}},"folder":{"replace":{"name":"Archive","folder":"example","encrypted":true}}}}`
	updated, err := a.SaveCatalogPatch(rev, edit)
	if err != nil || updated == rev {
		t.Fatal(updated, err)
	}
	want := `{"version":3,"active":"personal","spaces":{"personal":{"notes":[{"id":"n4"},{"id":"n1","n":9007199254740993},{"id":"n2","title":"edited"}],"areas":[],"keep":{"x":true},"name":"Local"},"folder":{"name":"Archive","folder":"example","encrypted":true}},"plugins":[],"autoLockMinutes":7}`
	sameTestJSON(t, stored(t, path), []byte(want))
	for _, bad := range []string{
		`{"set":{"spaces":{}}}`, `{"spaces":{"folder":{"set":{"plain":"x"}}}}`,
		`{"spaces":{"personal":{"set":{"folder":"x"}}}}`,
		`{"spaces":{"personal":{"notes":{"order":["n1","n4","n4"]}}}}`,
		`{"spaces":{"personal":{"notes":{"put":[{"id":"n4","sealed":"cipher","title":"plaintext"}]}}}}`,
		`{"spaces":{"personal":{"replace":{"name":"link","folder":"path","notes":[]}}}}`,
		`{"spaces":{"personal":{"remove":true}}}`, `{"set":{"active":"missing"}}`,
		`{"mysteryOperation":true}`,
	} {
		if _, err = a.SaveCatalogPatch(updated, bad); !errors.Is(err, errInvalid) {
			t.Fatalf("%s returned %v", bad, err)
		}
		if current, _ := a.CatalogRevision(); current != updated {
			t.Fatal("failed patch advanced revision")
		}
		sameTestJSON(t, stored(t, path), []byte(want))
	}
	if _, err := a.SaveCatalogPatch(rev, `{"set":{"view":{}}}`); !errors.Is(err, errChanged) {
		t.Fatal(err)
	}
	if _, err := a.SaveCatalogPatch(updated, `{"spaces":{"personal":{"notes":{"put":[{"id":"n5"}]}},"folder":{"remove":true}}}`); err != nil {
		t.Fatal(err)
	}
	want = strings.Replace(want, `"title":"edited"}],"areas"`, `"title":"edited"},{"id":"n5"}],"areas"`, 1)
	want = strings.Replace(want, `,"folder":{"name":"Archive","folder":"example","encrypted":true}`, "", 1)
	sameTestJSON(t, stored(t, path), []byte(want))
}

func TestEditedFieldsPreserveUnknownDataAndRejectInvalidBoundaries(t *testing.T) {
	initial := []byte(`{"name":"data","notes":[{"id":"n","ID":"legacy","dataText":"я😀猫Z","plugin":{"n":9007199254740993},"drop":0}],"areas":[]}`)
	raw := `{"notes":{"edit":[{"id":"n","textSplice":{"start":1,"remove":2,"insert":"😇ß"},"unset":["drop","ID"],"set":{"title":"renamed"}}]}}`
	next, err := applyWorkspacePatch(initial, raw)
	if err != nil {
		t.Fatal(err)
	}
	sameTestJSON(t, next, []byte(`{"name":"data","notes":[{"id":"n","dataText":"я😇ß猫Z","title":"renamed","plugin":{"n":9007199254740993}}],"areas":[]}`))
	for _, bad := range []string{
		`{"notes":{"edit":[{"id":"n","textSplice":{"start":2,"remove":0}}]}}`,
		`{"notes":{"edit":[{"id":"n","textSplice":{"start":0,"remove":2}}]}}`,
		`{"notes":{"edit":[{"id":"n","textSplice":{"start":9}}]}}`,
		`{"notes":{"edit":[{"id":"n","textSplice":{"start":-1}}]}}`,
		`{"notes":{"edit":[{"id":"n","textSplice":{},"set":{"dataText":"different"}}]}}`,
		`{"notes":{"edit":[{"id":"n","set":{"id":"other"}}]}}`,
		`{"notes":{"edit":[{"id":"n","set":{"sealed":"ciphertext"}}]}}`,
		`{"notes":{"edit":[{"id":"n","set":{"title":"first"}}],"remove":["n"]}}`,
		`{"notes":{"edit":[{"id":"other","set":{"title":"missing"}}]}}`,
	} {
		if _, err := applyWorkspacePatch(initial, bad); !errors.Is(err, errInvalid) {
			t.Errorf("invalid edit accepted: %s (%v)", bad, err)
		}
	}
}

func TestEncryptedCatalogPatchesRespectLockExternalChangesAndFullSaves(t *testing.T) {
	a, path := testStore(t)
	first := libraryPrefix + originalNote + librarySuffix
	if err := a.ProtectProject(first, testPass); err != nil {
		t.Fatal(err)
	}
	rev, _ := a.CatalogRevision()
	edit := `{"spaces":{"personal":{"notes":{"put":[{"id":"note-a","plain":"SECRET-EDIT"}]}}}}`
	updated, err := a.SaveCatalogPatch(rev, edit)
	if err != nil {
		t.Fatal(err)
	}
	encoded := stored(t, path)
	if bytes.Contains(encoded, []byte("SECRET-EDIT")) {
		t.Fatal("plaintext on disk")
	}
	buf := a.catalogIndex.spaces["personal"].notes.items["note-a"]
	if !bytes.Contains(buf, []byte("SECRET-EDIT")) {
		t.Fatal("record not indexed")
	}
	updated, err = a.SaveCatalogPatch(updated, strings.Replace(edit, "SECRET-EDIT", "SECRET-LATEST", 1))
	if err != nil || bytes.Contains(buf, []byte("SECRET-EDIT")) {
		t.Fatal("retired note data survived replacement", err)
	}
	buf = a.catalogIndex.spaces["personal"].notes.items["note-a"]
	if err = a.LockProject(); err != nil {
		t.Fatal(err)
	}
	if a.catalogIndex != nil || bytes.Contains(buf, []byte("SECRET-LATEST")) {
		t.Fatal("plaintext index survived lock")
	}
	if _, err = a.CatalogRevision(); !errors.Is(err, errLocked) {
		t.Fatal(err)
	}
	if _, err = a.SaveCatalogPatch(updated, edit); !errors.Is(err, errLocked) {
		t.Fatal(err)
	}
	plain, err := a.UnlockProject(testPass)
	if err != nil || !strings.Contains(plain, "SECRET-LATEST") {
		t.Fatal(err)
	}
	if err = a.RemoveProjectPassword(first, testPass); err != nil {
		t.Fatal(err)
	}
	if _, err = a.SaveCatalogPatch(updated, edit); !errors.Is(err, errChanged) {
		t.Fatal("stale patch survived policy change", err)
	}
	rev, _ = a.CatalogRevision()
	updated, err = a.SaveCatalogPatch(rev, edit)
	if err != nil {
		t.Fatal(err)
	}
	oldTime := a.disk.ModTime()
	tampered := bytes.Replace(stored(t, path), []byte("SECRET-EDIT"), []byte("OUTSIDER-00"), 1)
	if err = os.WriteFile(path, tampered, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	if _, err = a.SaveCatalogPatch(updated, `{"set":{"plugins":[]}}`); !errors.Is(err, errChanged) {
		t.Fatal("external file replacement not detected", err)
	}
	if !bytes.Equal(tampered, stored(t, path)) {
		t.Fatal("external edit overwritten")
	}
}

func TestFolderAndLibraryPatchHaveSameRecordSemantics(t *testing.T) {
	initial := []byte(`{"name":"A","notes":[{"id":"a"},{"id":"b"}],"areas":[],"routes":[1]}`)
	out, err := applyWorkspacePatch(initial, `{"set":{"routes":[2]},"notes":{"put":[{"id":"b","v":3}],"order":["b","a"]}}`)
	if err != nil {
		t.Fatal(err)
	}
	sameTestJSON(t, out, []byte(`{"name":"A","notes":[{"id":"b","v":3},{"id":"a"}],"areas":[],"routes":[2]}`))
	for _, invalid := range []string{`{"set":{"_videronSync":"head"}}`, `{"unset":["notes"]}`, `{"set":{"folder":"outside"}}`} {
		if _, err := applyWorkspacePatch(initial, invalid); !errors.Is(err, errInvalid) {
			t.Fatal(err)
		}
	}
}

func TestCatalogPatchRetryAndCompetingWriters(t *testing.T) {
	a, path := testStore(t)
	first := libraryPrefix + originalNote + librarySuffix
	if err := a.Save(first); err != nil {
		t.Fatal(err)
	}
	rev, _ := a.CatalogRevision()
	second := new(App)
	if _, err := second.Load(); err != nil {
		t.Fatal(err)
	}
	patches := []string{`{"set":{"autoLockMinutes":3}}`, `{"set":{"autoLockMinutes":5}}`}
	clients := []*App{a, second}
	type response struct {
		index int
		token string
		err   error
	}
	results := make(chan response, 2)
	start := make(chan struct{})
	for i, app := range clients {
		go func() {
			<-start
			newRev, err := app.SaveCatalogPatch(rev, patches[i])
			results <- response{i, newRev, err}
		}()
	}
	close(start)
	one, two := <-results, <-results
	if one.err != nil {
		one, two = two, one
	}
	if one.err != nil || !errors.Is(two.err, errChanged) {
		t.Fatalf("concurrent writes: %v, %v", one.err, two.err)
	}
	written := stored(t, path)
	token, err := clients[one.index].SaveCatalogPatch(rev, patches[one.index])
	if err != nil || token != one.token || !bytes.Equal(written, stored(t, path)) {
		t.Fatal("lost acknowledgement was not recoverable", err)
	}
	if _, err = clients[one.index].SaveCatalogPatch(rev, patches[two.index]); !errors.Is(err, errChanged) {
		t.Fatal("different retry accepted", err)
	}
}

func BenchmarkCatalogAutosave5000(b *testing.B) {
	var snapshot strings.Builder
	snapshot.WriteString(libraryPrefix)
	content := strings.Repeat("x", 1024)
	for i := 0; i < 5000; i++ {
		if i != 0 {
			snapshot.WriteByte(',')
		}
		fmt.Fprintf(&snapshot, `{"id":"n%d","title":"a","plain":"%s","body":[{"type":"text","text":"%s"}],"tags":[],"links":[]}`, i, content, content)
	}
	snapshot.WriteString(librarySuffix)
	initial := snapshot.String()
	changed := strings.Replace(initial, `"title":"a"`, `"title":"b"`, 1)
	patch := func(title string) string {
		return fmt.Sprintf(`{"spaces":{"personal":{"notes":{"edit":[{"id":"n0","set":{"title":%q}}]}}}}`, title)
	}
	for _, tc := range []struct {
		name     string
		payloads [2]string
		delta    bool
	}{{"full", [2]string{initial, changed}, false}, {"patch", [2]string{patch("a"), patch("b")}, true}} {
		b.Run(tc.name, func(b *testing.B) {
			dir := b.TempDir()
			for _, env := range []string{"AppData", "XDG_CONFIG_HOME", "HOME"} {
				b.Setenv(env, dir)
			}
			app := new(App)
			if _, err := app.Load(); err != nil {
				b.Fatal(err)
			}
			if err := app.Save(initial); err != nil {
				b.Fatal(err)
			}
			rev, _ := app.CatalogRevision()
			if tc.delta {
				var err error
				rev, err = app.SaveCatalogPatch(rev, tc.payloads[1])
				if err != nil {
					b.Fatal(err)
				}
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				var err error
				if tc.delta {
					rev, err = app.SaveCatalogPatch(rev, tc.payloads[i%2])
				} else {
					err = app.Save(tc.payloads[i%2])
				}
				if err != nil {
					b.Fatal(err)
				}
			}
			b.StopTimer()
			b.ReportMetric(float64(len(tc.payloads[0])), "bytes/IPC")
		})
	}
}
