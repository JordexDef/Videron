package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"videron/internal/vault"
	"videron/internal/workspacestore"
)

const testPass = "пароль из четырёх слов"
const nextPass = "новая длинная фраза"
const libraryPrefix = `{"version":1,"active":"personal","spaces":{"personal":{"areas":[],"notes":[`
const librarySuffix = `]}},"plugins":[],"view":{}}`
const originalNote = `{"id":"note-a","title":"PRIVATE-TITLE","plain":"PRIVATE-INDEX","body":[{"type":"image","src":"PRIVATE-IMAGE"},{"type":"code","text":"PRIVATE-CODE"}],"tags":["PRIVATE-TAG"],"links":[]}`

func testStore(t *testing.T) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("AppData", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	a := new(App)
	path, err := workspacestore.CatalogPath()
	if err != nil {
		t.Fatal(err)
	}
	if raw, err := a.Load(); err != nil || raw != "" {
		t.Fatal("initial load", err)
	}
	return a, path
}

func stored(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

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

func TestIndependentNoteVault(t *testing.T) {
	a, path := testStore(t)
	sealed, err := a.ProtectNote("note-a", originalNote, testPass)
	if err != nil || strings.Contains(sealed, "PRIVATE") {
		t.Fatal("note protection", err)
	}
	var fields map[string]any
	if err := json.Unmarshal([]byte(sealed), &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 9 {
		t.Fatal("unexpected envelope field")
	}
	savedNote, _ := json.Marshal(map[string]string{"id": "note-a", "sealed": sealed})
	snapshot := strings.Replace(libraryPrefix, `"version":1`, `"version":2`, 1) + string(savedNote) + librarySuffix
	if err := a.Save(snapshot); err != nil || bytes.Contains(stored(t, path), []byte("PRIVATE")) {
		t.Fatal("private note projection", err)
	}
	a.LockNote("note-a")
	if _, err := a.SealNote("note-a", originalNote); !errors.Is(err, errLocked) {
		t.Fatal(err)
	}
	if _, err := a.UnlockNote("other-id", sealed, testPass); !errors.Is(err, errPassword) {
		t.Fatal("ID binding", err)
	}
	if cleartext, err := a.UnlockNote("note-a", sealed, testPass); err != nil || cleartext != originalNote {
		t.Fatal("unlock note", err)
	}
	if _, err := a.UnlockNote("note-a", sealed, "wrong"); !errors.Is(err, errPassword) {
		t.Fatal(err)
	}
	updated := strings.Replace(originalNote, "PRIVATE-CODE", "EDITED-CODE", 1)
	after, err := a.SealNote("note-a", updated)
	if err != nil || sealed == after || strings.Contains(after, "EDITED-CODE") {
		t.Fatal("updated content", err)
	}
	if cleartext, err := a.UnlockNote("note-a", after, testPass); err != nil || cleartext != updated {
		t.Fatal("re-open note", err)
	}
	if _, err := a.SealNote("note-a", `{"id":"other-id"}`); !errors.Is(err, errInvalid) {
		t.Fatal(err)
	}
	if _, err := a.SealNote("note-a", `{"ID":"note-a"}`); !errors.Is(err, errInvalid) {
		t.Fatal("encrypted a note the editor could not identify", err)
	}
	const withExtension = `{"id":"note-a","ID":"extension value"}`
	withExtensionSealed, err := a.SealNote("note-a", withExtension)
	if err != nil {
		t.Fatal(err)
	}
	if opened, err := a.UnlockNote("note-a", withExtensionSealed, testPass); err != nil || opened != withExtension {
		t.Fatal("case-sensitive identifier with an extension did not round-trip", err)
	}
	if err := a.ProtectProject(snapshot, nextPass); err != nil {
		t.Fatal(err)
	}
	if err := a.LockProject(); err != nil {
		t.Fatal(err)
	}
	if restored, err := a.UnlockProject(nextPass); err != nil || restored != snapshot {
		t.Fatal("protected project with individually sealed v2 notes", err)
	}
	if _, err := a.SealNote("note-a", updated); !errors.Is(err, errLocked) {
		t.Fatal("locking project must clear note session", err)
	}
}

func TestSessionLockForgetsKeysAndResumesOnce(t *testing.T) {
	for _, scope := range []string{"note", "project-and-note"} {
		t.Run(scope, func(t *testing.T) {
			a, path := testStore(t)
			const id = "note-a"
			sealed, err := a.ProtectNote(id, originalNote, testPass)
			if err != nil {
				t.Fatal(err)
			}
			record, err := json.Marshal(map[string]string{"id": id, "sealed": sealed})
			if err != nil {
				t.Fatal(err)
			}
			snapshot := strings.Replace(libraryPrefix, `"version":1`, `"version":2`, 1) + string(record) + librarySuffix
			if scope == "project-and-note" {
				err = a.ProtectProject(snapshot, nextPass)
			} else {
				err = a.Save(snapshot)
			}
			if err != nil {
				t.Fatal(err)
			}
			before := stored(t, path)
			a.LockSession(id)
			if a.TakeResumeNote() != "" {
				t.Fatal("resume note exposed before loading the workspace")
			}
			if err := a.Save(snapshot); !errors.Is(err, errLocked) {
				t.Fatal("stale save after lock", err)
			}
			if !bytes.Equal(before, stored(t, path)) {
				t.Fatal("lock or stale save changed the stored workspace")
			}
			reopened, err := a.Load()
			if scope == "project-and-note" {
				if !errors.Is(err, errLocked) {
					t.Fatal("missing project password request", err)
				}
				reopened, err = a.UnlockProject(nextPass)
			}
			if err != nil || reopened != snapshot {
				t.Fatal("restoring the workspace", err)
			}
			if a.TakeResumeNote() != id || a.TakeResumeNote() != "" {
				t.Fatal("expected a single navigation back to the open note")
			}
			if _, err := a.SealNote(id, originalNote); !errors.Is(err, errLocked) {
				t.Fatal("note key retained after lock", err)
			}
			if plain, err := a.UnlockNote(id, sealed, testPass); err != nil || plain != originalNote {
				t.Fatal("restoring the note", err)
			}
		})
	}
}

func TestFailedReloadForgetsOpenSessions(t *testing.T) {
	a, path := testStore(t)
	const snapshot = libraryPrefix + originalNote + librarySuffix
	if err := a.Save(snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ProtectNote("note-a", originalNote, testPass); err != nil {
		t.Fatal(err)
	}
	noteKey := a.noteSession.EditorKey("note-a")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Load(); !errors.Is(err, errChanged) {
		t.Fatal("missing existing library returned as a new one", err)
	}
	if a.library.Loaded() || a.noteSession.EditorKey("note-a") != nil {
		t.Fatal("failed refresh retained access to old note")
	}
	if _, err := noteKey.Seal(vault.NoteScope, "note-a", []byte(originalNote)); !errors.Is(err, errLocked) {
		t.Fatal("retired keys must refuse writes", err)
	}
	if err := a.Save(snapshot); !errors.Is(err, errLocked) {
		t.Fatal("stale save after failed reload", err)
	}
	if err := os.WriteFile(path, []byte(snapshot), 0600); err != nil {
		t.Fatal(err)
	}
	if restored, err := a.Load(); err != nil || restored != snapshot {
		t.Fatal("cannot recover after restoring library", err)
	}
	if _, err := a.SealNote("note-a", originalNote); !errors.Is(err, errLocked) {
		t.Fatal("freshly restored catalog inherited prior key", err)
	}
}

func TestExternallyEditedCatalogKeepsContents(t *testing.T) {
	a, path := testStore(t)
	const original = libraryPrefix + originalNote + librarySuffix
	if err := a.Save(original); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ProtectNote("note-a", originalNote, testPass); err != nil {
		t.Fatal(err)
	}
	updated := strings.Replace(original, "PRIVATE-TITLE", "UPDATED-TITLE", 1)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	oldTime := before.ModTime()
	if err := os.WriteFile(path, []byte(updated), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || !workspacestore.SameFileState(before, info) {
		t.Fatal("expected equal size, timestamp and identity", err)
	}
	if err := a.Save(original); !errors.Is(err, errChanged) {
		t.Fatal("missed external in-place edit", err)
	}
	if got := string(stored(t, path)); got != updated {
		t.Fatal("external content overwritten")
	}
	if got, err := a.Load(); err != nil || got != updated || a.noteSession.EditorKey("note-a") != nil {
		t.Fatal("catalog reload failed to reset old keys", err)
	}
}

func TestMixedProtectedRecordsCannotReachStorage(t *testing.T) {
	for _, id := range []string{"lucide/briefcase-business", "lucide/bookmark", "phosphor/house", "phosphor/lock-key"} {
		if !publicMapIcons()[id] {
			t.Fatalf("shipped icon %q missing from sealed-note policy", id)
		}
	}
	a, path := testStore(t)
	encoded, err := a.ProtectNote("note-a", originalNote, testPass)
	if err != nil {
		t.Fatal(err)
	}
	ok := map[string]any{"id": "note-a", "sealed": encoded, "pinned": true, "links": []string{"b"}, "slot": nil, "x": 3, "title": "", "plain": "", "body": []any{}, "weight": 0, "tags": []string{}}
	ok["appearance"] = map[string]any{"shape": "diamond", "color": "#a9c6ed", "icon": "lucide/bookmark"}
	ok["mapLabel"] = "Проект 🔒"
	ok["mapGroupId"] = "97cd34ca-4d71-4f91-a552-98745da71121"
	record, err := json.Marshal(ok)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := libraryPrefix + string(record) + librarySuffix
	if err := a.Save(snapshot); err != nil {
		t.Fatal("legitimate sealed note", err)
	}
	for field, value := range map[string]any{
		"plain": "PRIVATE-INDEX", "title": "PRIVATE-TITLE", "body": []any{map[string]string{"text": "PRIVATE-CODE"}},
		"tags": []string{"private-tag"}, "board": map[string]any{}, "extraAttachment": "PRIVATE-IMAGE", "sealed": originalNote,
		"appearance": map[string]any{"shape": "circle", "caption": "PRIVATE-TITLE"},
		"mapGroupId": "PRIVATE-GROUP-NAME",
	} {
		t.Run(field, func(t *testing.T) {
			bad := make(map[string]any, len(ok)+1)
			for k, v := range ok {
				bad[k] = v
			}
			bad[field] = value
			record, err := json.Marshal(bad)
			if err != nil {
				t.Fatal(err)
			}
			if err := a.Save(libraryPrefix + string(record) + librarySuffix); !errors.Is(err, errInvalid) {
				t.Fatal("catalog accepted mixed sealed/cleartext record", err)
			}
			if workspaceStore.ValidPayload([]byte(`{"name":"Notes","notes":[` + string(record) + `],"areas":[]}`)) {
				t.Fatal("folder storage accepted mixed record")
			}
			if got := string(stored(t, path)); got != snapshot {
				t.Fatal("existing catalog modified after rejection")
			}
		})
	}
	// A plaintext extension block and nested property called "sealed" are
	// ordinary note content and must still round-trip.
	ordinary := `{"id":"plain","Sealed":"extension label","custom":{"sealed":"example"},"type":"extension"}`
	if err := a.Save(libraryPrefix + ordinary + librarySuffix); err != nil {
		t.Fatal(err)
	}
}

func TestCredentialBlocksRequireIndividualNoteEncryption(t *testing.T) {
	a, path := testStore(t)
	const block = `{"type":"credentials","resource":"test service","login":"fixture","password":"value-for-test-only"}`
	const row = `{"id":"note-a","title":"Fixture","body":[` + block + `],"tags":[],"links":[]}`
	snapshot := libraryPrefix + row + librarySuffix
	safe := libraryPrefix + originalNote + librarySuffix
	if err := a.Save(safe); err != nil {
		t.Fatal(err)
	}
	for _, protectLibrary := range []bool{false, true} {
		if protectLibrary {
			if err := a.ProtectProject(safe, testPass); err != nil {
				t.Fatal(err)
			}
		}
		before := stored(t, path)
		if err := a.Save(snapshot); !errors.Is(err, errInvalid) || !bytes.Equal(before, stored(t, path)) {
			t.Fatal("accepted an individually unsealed credential block", err)
		}
	}
	if workspaceStore.ValidPayload([]byte(`{"name":"Shared","notes":[` + row + `],"areas":[]}`)) {
		t.Fatal("folder accepted an individually unsealed credential block")
	}
	head, err := a.CatalogRevision()
	if err != nil {
		t.Fatal(err)
	}
	patch := `{"spaces":{"personal":{"notes":{"edit":[{"id":"note-a","set":{"body":[` + block + `]}}]}}}}`
	before := stored(t, path)
	if _, err := a.SaveCatalogPatch(head, patch); !errors.Is(err, errInvalid) || !bytes.Equal(before, stored(t, path)) {
		t.Fatal("accepted a credential block in a note patch", err)
	}
	sealed, err := a.ProtectNote("note-a", row, nextPass)
	if err != nil {
		t.Fatal(err)
	}
	wrapper, err := json.Marshal(map[string]any{"id": "note-a", "sealed": sealed, "title": "", "body": []any{}, "tags": []any{}, "plain": ""})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Save(libraryPrefix + string(wrapper) + librarySuffix); err != nil {
		t.Fatal(err)
	}
	a.LockNote("note-a")
	if plain, err := a.UnlockNote("note-a", sealed, nextPass); err != nil || plain != row {
		t.Fatal("individually encrypted credential note did not round-trip", err)
	}
}

func TestSealedMapLabelStorage(t *testing.T) {
	a, path := testStore(t)
	sealed, err := a.ProtectNote("note-a", originalNote, testPass)
	if err != nil {
		t.Fatal(err)
	}
	a.LockNote("note-a")
	record := map[string]any{"id": "note-a", "sealed": sealed, "title": ""}
	encode := func() string {
		t.Helper()
		b, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	folderAccepts := func(row string) bool {
		return workspaceStore.ValidPayload([]byte(`{"name":"Notes","notes":[` + row + `],"areas":[]}`))
	}
	for _, label := range []string{strings.Repeat("🌳", 120), "Проект №2", ""} {
		if label == "" {
			delete(record, "mapLabel")
		} else {
			record["mapLabel"] = label
		}
		row := encode()
		snapshot := libraryPrefix + row + librarySuffix
		if err := a.Save(snapshot); err != nil || !folderAccepts(row) {
			t.Fatal("could not rename or clear a locked note", err)
		}
		if string(stored(t, path)) != snapshot || strings.Contains(snapshot, "PRIVATE-TITLE") {
			t.Fatal("changing the map label modified the protected title or ciphertext")
		}
	}
	for _, invalid := range []any{nil, 17, []string{"x"}, "", " name", "name\u00a0", "\ufeffname",
		"a\tb", "a\u0000b", "a\nb", "a\u007fb", "a\u009fb", "a\u2028b", "a\u2029b", strings.Repeat("🌳", 121)} {
		record["mapLabel"] = invalid
		row := encode()
		if err := a.Save(libraryPrefix + row + librarySuffix); !errors.Is(err, errInvalid) || folderAccepts(row) {
			t.Fatalf("accepted invalid map label %#v", invalid)
		}
	}
}

// The files in testdata were written by the tagged v0.47.0 source
// (b504ad93f1205488c1771fd7e8a58c74fac18a30), using ProtectNote, ProtectProject
// and CreateFolderSpace with the synthetic note and passwords below. Keep the
// original bytes so future readers are always tested against the released writer.
func TestOpenV047EncryptedWorkspaceAndNote(t *testing.T) {
	const spacePassword = "workspace-fixture-only"
	const notePassword = "document-fixture-only"
	const id = "compat-note"
	const original = `{"id":"compat-note","title":"Release 0.47","plain":"Meeting notes","body":[{"type":"paragraph","runs":[{"text":"Meeting notes"}]}],"tags":[],"links":[]}`
	app, catalogPath := testStore(t)
	folder := t.TempDir()
	fixtures := filepath.Join("internal", "vault", "testdata", "v0.47.0")
	if err := os.MkdirAll(filepath.Dir(catalogPath), 0700); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{"library.json": catalogPath, "Videron.space": filepath.Join(folder, folderSpaceFilename)} {
		if err := os.WriteFile(path, stored(t, filepath.Join(fixtures, name)), 0600); err != nil {
			t.Fatal(err)
		}
	}

	openCopies := func(app *App) (catalog, space, sealed string) {
		t.Helper()
		if _, err := app.Load(); !errors.Is(err, errLocked) {
			t.Fatal("expected a protected library", err)
		}
		catalog, err := app.UnlockProject(spacePassword)
		if err != nil {
			t.Fatal(err)
		}
		space, err = app.OpenFolderSpace(folder, spacePassword)
		if err != nil {
			t.Fatal(err)
		}
		var library struct{ Spaces map[string]json.RawMessage }
		if err = json.Unmarshal([]byte(catalog), &library); err != nil {
			t.Fatal(err)
		}
		sameTestJSON(t, library.Spaces["personal"], []byte(space))
		var doc struct{ Notes []struct{ ID, Sealed string } }
		if err = json.Unmarshal([]byte(space), &doc); err != nil {
			t.Fatal(err)
		}
		if len(doc.Notes) != 1 || doc.Notes[0].ID != id || doc.Notes[0].Sealed == "" {
			t.Fatal("protected note missing")
		}
		return catalog, space, doc.Notes[0].Sealed
	}
	catalog, space, sealed := openCopies(app)
	got, err := app.UnlockNote(id, sealed, notePassword)
	if err != nil || got != original {
		t.Fatal("v0.47 note body did not round-trip", err)
	}
	edited := strings.ReplaceAll(original, "Meeting notes", "Meeting notes, updated")
	updated, err := app.SealNote(id, edited)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(sealed)
	after, _ := json.Marshal(updated)
	if err = app.Save(strings.Replace(catalog, string(before), string(after), 1)); err != nil {
		t.Fatal(err)
	}
	if err = app.SaveFolderSpace(folder, strings.Replace(space, string(before), string(after), 1)); err != nil {
		t.Fatal(err)
	}
	app.FinishClose()

	fresh := new(App)
	_, _, sealed = openCopies(fresh)
	got, err = fresh.UnlockNote(id, sealed, notePassword)
	if err != nil || got != edited {
		t.Fatal("could not reopen the saved edit", err)
	}
	fresh.FinishClose()
}
