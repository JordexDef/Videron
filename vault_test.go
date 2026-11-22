package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	path, err := workspacePath()
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

func TestProjectVaultTransitions(t *testing.T) {
	a, path := testStore(t)
	snapshot := libraryPrefix + originalNote + librarySuffix
	if err := a.Save(snapshot); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(path)
	orphan := filepath.Join(dir, ".workspace-123456.tmp")
	unrelated := filepath.Join(dir, ".workspace-manual.tmp")
	for _, name := range []string{orphan, unrelated} {
		if err := os.WriteFile(name, []byte("test"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.ProtectProject(snapshot, "short"); !errors.Is(err, errWeak) {
		t.Fatal(err)
	}
	if saved := string(stored(t, path)); saved != snapshot {
		t.Fatal("invalid password changed stored bytes")
	}
	if err := a.ProtectProject(snapshot, testPass); err != nil {
		t.Fatal(err)
	}
	if !a.IsProjectProtected() {
		t.Fatal("missing project protection")
	}
	one := stored(t, path)
	if bytes.Contains(one, []byte("PRIVATE")) || bytes.Contains(one, []byte("personal")) || bytes.Contains(one, []byte(testPass)) {
		t.Fatal("plaintext in project file")
	}
	if _, err := os.Stat(orphan); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old plaintext temp survived", err)
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatal(err)
	}
	if err := a.Save(snapshot); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(one, stored(t, path)) {
		t.Fatal("nonce was reused")
	}
	if plain, err := a.Load(); err != nil || plain != snapshot {
		t.Fatal("reloading unlocked project", err)
	}

	// Start with a fresh process. A save attempted before successful unlock
	// must not overwrite the envelope, including after a canceled password prompt.
	other := new(App)
	if _, err := other.Load(); !errors.Is(err, errLocked) || !other.IsProjectProtected() {
		t.Fatal("expected locked project", err)
	}
	before := stored(t, path)
	if err := other.Save(snapshot); !errors.Is(err, errLocked) {
		t.Fatal(err)
	}
	if _, err := other.UnlockProject("incorrect"); !errors.Is(err, errPassword) {
		t.Fatal(err)
	}
	if !bytes.Equal(before, stored(t, path)) {
		t.Fatal("locked project changed")
	}
	if plain, err := other.UnlockProject(testPass); err != nil || plain != snapshot {
		t.Fatal("unlock", err)
	}
	if err := other.ChangeProjectPassword(snapshot, "invalid", nextPass); !errors.Is(err, errPassword) {
		t.Fatal(err)
	}
	if err := other.ChangeProjectPassword(snapshot, testPass, "short"); !errors.Is(err, errWeak) {
		t.Fatal(err)
	}
	if !bytes.Equal(before, stored(t, path)) {
		t.Fatal("failed password change altered the file")
	}
	if err := other.ChangeProjectPassword(snapshot, testPass, nextPass); err != nil {
		t.Fatal(err)
	}
	if err := other.LockProject(); err != nil {
		t.Fatal(err)
	}
	if _, err := other.UnlockProject(testPass); !errors.Is(err, errPassword) {
		t.Fatal(err)
	}
	if plain, err := other.UnlockProject(nextPass); err != nil || plain != snapshot {
		t.Fatal("password change", err)
	}
	if err := other.RemoveProjectPassword(snapshot, "bad"); !errors.Is(err, errPassword) {
		t.Fatal(err)
	}
	if err := other.RemoveProjectPassword(snapshot, nextPass); err != nil {
		t.Fatal(err)
	}
	if other.IsProjectProtected() || string(stored(t, path)) != snapshot {
		t.Fatal("removing password failed")
	}
	if err := a.Save(snapshot); !errors.Is(err, errChanged) {
		t.Fatal("stale writer", err)
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

func TestVaultRejectsDamageAndWrongProfile(t *testing.T) {
	a, path := testStore(t)
	const library = libraryPrefix + originalNote + librarySuffix
	if err := a.Save(strings.Replace(library, `"version":1`, `"version":4`, 1)); !errors.Is(err, errInvalid) {
		t.Fatal("unknown plaintext schema", err)
	}
	if err := a.ProtectProject(library, testPass); err != nil {
		t.Fatal(err)
	}
	if err := a.LockProject(); err != nil {
		t.Fatal(err)
	}
	env, err := parseEnvelope(stored(t, path), projectVault)
	if err != nil {
		t.Fatal(err)
	}
	env.Data[len(env.Data)-1] ^= 1
	data, _ := json.Marshal(env)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.UnlockProject(testPass); !errors.Is(err, errPassword) {
		t.Fatal("tampering undetected", err)
	}
	if err := a.Save(library); !errors.Is(err, errLocked) {
		t.Fatal(err)
	}
	env.MemoryKiB = 1_000_000_000
	data, _ = json.Marshal(env)
	if _, err := parseEnvelope(data, projectVault); !errors.Is(err, errVersion) {
		t.Fatal("untrusted KDF parameters", err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"data":"broken"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Load(); !errors.Is(err, errCorrupt) {
		t.Fatal("corrupt envelope treated as plaintext", err)
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
	noteKey := a.noteKeys["note-a"]
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Load(); !errors.Is(err, errChanged) {
		t.Fatal("missing existing library returned as a new one", err)
	}
	if a.loaded || len(a.noteKeys) != 0 || !bytes.Equal(noteKey.key, make([]byte, 32)) {
		t.Fatal("failed refresh retained access to old note")
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
	oldTime := a.disk.ModTime()
	if err := os.WriteFile(path, []byte(updated), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || !sameFileState(a.disk, info) {
		t.Fatal("expected equal size, timestamp and identity", err)
	}
	if err := a.Save(original); !errors.Is(err, errChanged) {
		t.Fatal("missed external in-place edit", err)
	}
	if got := string(stored(t, path)); got != updated {
		t.Fatal("external content overwritten")
	}
	if got, err := a.Load(); err != nil || got != updated || len(a.noteKeys) != 0 {
		t.Fatal("catalog reload failed to reset old keys", err)
	}
}

func TestMixedProtectedRecordsCannotReachStorage(t *testing.T) {
	a, path := testStore(t)
	encoded, err := a.ProtectNote("note-a", originalNote, testPass)
	if err != nil {
		t.Fatal(err)
	}
	ok := map[string]any{"id": "note-a", "sealed": encoded, "pinned": true, "links": []string{"b"}, "slot": nil, "x": 3, "title": "", "plain": "", "body": []any{}, "weight": 0, "tags": []string{}}
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
			if validSpacePayload([]byte(`{"name":"Notes","notes":[` + string(record) + `],"areas":[]}`)) {
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

func TestVaultEnvelopeHasUnambiguousFieldNames(t *testing.T) {
	a, _ := testStore(t)
	raw, err := a.ProtectNote("note-a", originalNote, testPass)
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		strings.Replace(raw, `"version":1`, `"version":1,"version":1`, 1),
		strings.Replace(raw, `"data":`, `"Data":`, 1),
		raw + ` {}`,
	} {
		if _, err := parseEnvelope([]byte(invalid), noteVault); !errors.Is(err, errCorrupt) {
			t.Fatal("accepted ambiguous envelope", err)
		}
	}
}

func TestLargeStoredEnvelopeAndLegacyLayouts(t *testing.T) {
	key := deriveVaultKey(testPass, make([]byte, saltSize))
	defer key.forget()
	body := []byte(`{"id":"large","body":"` + strings.Repeat("Z", 500<<10) + `"}`)
	blob, err := key.seal(noteVault, "large", body)
	if err != nil {
		t.Fatal(err)
	}
	for _, pretty := range []bool{false, true} {
		envelopeText := blob
		if pretty {
			var formatted bytes.Buffer
			if err := json.Indent(&formatted, blob, "", "  "); err != nil {
				t.Fatal(err)
			}
			envelopeText = formatted.Bytes()
		}
		stub, _ := json.Marshal(map[string]string{"id": "large", "sealed": string(envelopeText)})
		if !validWorkspace([]byte(libraryPrefix + string(stub) + librarySuffix)) {
			t.Fatal("rejected compatible note layout", pretty)
		}
	}
	// All normal storage paths still authenticate/decrypt the original, full ciphertext.
	snapshot, _ := json.Marshal(map[string]any{"sealed": string(blob), "id": "large", "title": "PRIVATE-TITLE"})
	if validWorkspace([]byte(libraryPrefix + string(snapshot) + librarySuffix)) {
		t.Fatal("large ciphertext masked a cleartext field")
	}
	broken := bytes.Replace(blob, []byte(`"data":"`), []byte(`"data":"#`), 1)
	stub, _ := json.Marshal(map[string]string{"id": "large", "sealed": string(broken)})
	if validWorkspace([]byte(libraryPrefix + string(stub) + librarySuffix)) {
		t.Fatal("invalid base64 accepted")
	}
}
