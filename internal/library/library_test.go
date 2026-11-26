package library

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"videron/internal/syncclient"
	"videron/internal/vault"
	"videron/internal/workspacestore"
)

const testPass = "пароль из четырёх слов"
const nextPass = "новая длинная фраза"
const libraryPrefix = `{"version":1,"active":"personal","spaces":{"personal":{"areas":[],"notes":[`
const librarySuffix = `]}},"plugins":[],"view":{}}`
const originalNote = `{"id":"note-a","title":"PRIVATE-TITLE","plain":"PRIVATE-INDEX","body":[{"type":"image","src":"PRIVATE-IMAGE"},{"type":"code","text":"PRIVATE-CODE"}],"tags":["PRIVATE-TAG"],"links":[]}`

var testStorage = workspacestore.New[testNote]()
var testValidator = vault.NewNoteValidator(nil)

type testNote struct{}

func (*testNote) UnmarshalJSON(data []byte) error { return testValidator.Validate(data) }

func testLibrary(t testing.TB) (*Library, string) {
	t.Helper()
	dir := t.TempDir()
	for _, env := range []string{"AppData", "XDG_CONFIG_HOME", "HOME"} {
		t.Setenv(env, dir)
	}
	path, err := workspacestore.CatalogPath()
	if err != nil {
		t.Fatal(err)
	}
	l := new(Library)
	t.Cleanup(l.Close)
	if raw, err := l.Load(testStorage, nil); err != nil || raw != "" {
		t.Fatal("initial load", err)
	}
	return l, path
}

func stored(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func seedCatalog(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyPlaintextLibrariesRoundTrip(t *testing.T) {
	for _, version := range []string{"1", "2"} {
		t.Run("v"+version, func(t *testing.T) {
			l, path := testLibrary(t)
			original := strings.Replace(libraryPrefix+originalNote+librarySuffix, `"version":1`, `"version":`+version, 1)
			seedCatalog(t, path, []byte(original))
			opened, err := l.Load(testStorage, nil)
			if err != nil || opened != original || l.IsProjectProtected() {
				t.Fatal("could not open the legacy plaintext library", err)
			}
			edited := strings.Replace(original, "PRIVATE-TITLE", "Updated title", 1)
			if err := l.Save(testStorage, edited); err != nil {
				t.Fatal(err)
			}
			revision, err := l.CatalogRevision()
			if err != nil {
				t.Fatal(err)
			}
			const patch = `{"spaces":{"personal":{"notes":{"edit":[{"id":"note-a","set":{"plain":"Новое содержимое"}}]}}}}`
			if _, err := l.SaveCatalogPatch(testStorage, revision, patch); err != nil {
				t.Fatal(err)
			}
			l.Close()
			fresh := new(Library)
			t.Cleanup(fresh.Close)
			reopened, err := fresh.Load(testStorage, nil)
			if err != nil || fresh.IsProjectProtected() {
				t.Fatal("could not reopen the edited library", err)
			}
			want := strings.Replace(edited, "PRIVATE-INDEX", "Новое содержимое", 1)
			sameTestJSON(t, []byte(reopened), []byte(want))
		})
	}
}

func TestRelease047EncryptedLibraryPatchRoundTrip(t *testing.T) {
	const password = "workspace-fixture-only"
	const addedNote = `{"id":"new-note","title":"New private note","plain":"PRIVATE-047-EDIT"}`
	l, path := testLibrary(t)
	seedCatalog(t, path, stored(t, filepath.Join("..", "vault", "testdata", "v0.47.0", "library.json")))
	if payload, err := l.Load(testStorage, nil); !errors.Is(err, vault.ErrLocked) || payload != "" || !l.IsProjectProtected() {
		t.Fatal("legacy library did not request a password", err)
	}
	var before, after struct {
		Spaces map[string]struct{ Notes []json.RawMessage }
	}
	opened, err := l.UnlockProject(testStorage, password, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(opened), &before); err != nil || len(before.Spaces["personal"].Notes) != 1 {
		t.Fatal("legacy notes missing", err)
	}
	revision, err := l.CatalogRevision()
	if err != nil {
		t.Fatal(err)
	}
	const patch = `{"spaces":{"personal":{"notes":{"put":[` + addedNote + `]}}}}`
	if _, err := l.SaveCatalogPatch(testStorage, revision, patch); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored(t, path), []byte("PRIVATE-047-EDIT")) {
		t.Fatal("edit leaked into the encrypted file")
	}
	l.Close()
	fresh := new(Library)
	t.Cleanup(fresh.Close)
	if _, err := fresh.Load(testStorage, nil); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("edited library did not remain protected", err)
	}
	reopened, err := fresh.UnlockProject(testStorage, password, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(reopened), &after); err != nil || len(after.Spaces["personal"].Notes) != 2 {
		t.Fatal("saved notes missing", err)
	}
	notes := after.Spaces["personal"].Notes
	sameTestJSON(t, notes[0], before.Spaces["personal"].Notes[0])
	sameTestJSON(t, notes[1], []byte(addedNote))
}

func TestProjectVaultTransitions(t *testing.T) {
	a, path := testLibrary(t)
	snapshot := libraryPrefix + originalNote + librarySuffix
	if err := a.Save(testStorage, snapshot); err != nil {
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
	if err := a.ProtectProject(testStorage, snapshot, "short"); !errors.Is(err, vault.ErrWeak) {
		t.Fatal(err)
	}
	if saved := string(stored(t, path)); saved != snapshot {
		t.Fatal("invalid password changed stored bytes")
	}
	if err := a.ProtectProject(testStorage, snapshot, testPass); err != nil {
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
	if err := a.Save(testStorage, snapshot); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(one, stored(t, path)) {
		t.Fatal("nonce was reused")
	}
	if plain, err := a.Load(testStorage, nil); err != nil || plain != snapshot {
		t.Fatal("reloading unlocked project", err)
	}

	// Start with a fresh process. A save attempted before successful unlock
	// must not overwrite the envelope, including after a canceled password prompt.
	other := new(Library)
	// A crash while removing the password can strand a plaintext snapshot next
	// to the encrypted catalog. A reader must skip a live writer's file.
	if err := os.WriteFile(orphan, []byte(snapshot), 0600); err != nil {
		t.Fatal(err)
	}
	if err := workspacestore.WithWriteLock(path, func() error {
		if _, err := other.Load(testStorage, nil); !errors.Is(err, vault.ErrLocked) {
			t.Fatalf("locked read during a write: %v", err)
		}
		_, err := os.Stat(orphan)
		return err
	}); err != nil {
		t.Fatal("reader disturbed an active writer", err)
	}
	if _, err := other.Load(testStorage, nil); !errors.Is(err, vault.ErrLocked) || !other.IsProjectProtected() {
		t.Fatal("expected locked project", err)
	}
	if _, err := os.Stat(orphan); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("interrupted password removal left plaintext at the lock screen", err)
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatal("cleanup touched an unrelated file", err)
	}
	before := stored(t, path)
	if err := other.Save(testStorage, snapshot); !errors.Is(err, vault.ErrLocked) {
		t.Fatal(err)
	}
	if _, err := other.UnlockProject(testStorage, "incorrect", nil); !errors.Is(err, vault.ErrPassword) {
		t.Fatal(err)
	}
	if !bytes.Equal(before, stored(t, path)) {
		t.Fatal("locked project changed")
	}
	if plain, err := other.UnlockProject(testStorage, testPass, nil); err != nil || plain != snapshot {
		t.Fatal("unlock", err)
	}
	if err := other.ChangeProjectPassword(testStorage, snapshot, "invalid", nextPass); !errors.Is(err, vault.ErrPassword) {
		t.Fatal(err)
	}
	if err := other.ChangeProjectPassword(testStorage, snapshot, testPass, "short"); !errors.Is(err, vault.ErrWeak) {
		t.Fatal(err)
	}
	if !bytes.Equal(before, stored(t, path)) {
		t.Fatal("failed password change altered the file")
	}
	if err := other.ChangeProjectPassword(testStorage, snapshot, testPass, nextPass); err != nil {
		t.Fatal(err)
	}
	if err := other.LockProject(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := other.UnlockProject(testStorage, testPass, nil); !errors.Is(err, vault.ErrPassword) {
		t.Fatal(err)
	}
	if plain, err := other.UnlockProject(testStorage, nextPass, nil); err != nil || plain != snapshot {
		t.Fatal("password change", err)
	}
	if err := other.RemoveProjectPassword(testStorage, snapshot, "bad"); !errors.Is(err, vault.ErrPassword) {
		t.Fatal(err)
	}
	if err := other.RemoveProjectPassword(testStorage, snapshot, nextPass); err != nil {
		t.Fatal(err)
	}
	if other.IsProjectProtected() || string(stored(t, path)) != snapshot {
		t.Fatal("removing password failed")
	}
	if err := a.Save(testStorage, snapshot); !errors.Is(err, syncclient.ErrChanged) {
		t.Fatal("stale writer", err)
	}
}

func TestVaultRejectsDamageAndWrongProfile(t *testing.T) {
	a, path := testLibrary(t)
	const library = libraryPrefix + originalNote + librarySuffix
	if err := a.Save(testStorage, strings.Replace(library, `"version":1`, `"version":4`, 1)); !errors.Is(err, vault.ErrInvalid) {
		t.Fatal("unknown plaintext schema", err)
	}
	if err := a.ProtectProject(testStorage, library, testPass); err != nil {
		t.Fatal(err)
	}
	if err := a.LockProject(nil); err != nil {
		t.Fatal(err)
	}
	env, err := vault.ParseEnvelope(stored(t, path), vault.ProjectScope)
	if err != nil {
		t.Fatal(err)
	}
	env.Data[len(env.Data)-1] ^= 1
	data, _ := json.Marshal(env)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.UnlockProject(testStorage, testPass, nil); !errors.Is(err, vault.ErrPassword) {
		t.Fatal("tampering undetected", err)
	}
	if err := a.Save(testStorage, library); !errors.Is(err, vault.ErrLocked) {
		t.Fatal(err)
	}
	env.MemoryKiB = 1_000_000_000
	data, _ = json.Marshal(env)
	if _, err := vault.ParseEnvelope(data, vault.ProjectScope); !errors.Is(err, vault.ErrVersion) {
		t.Fatal("untrusted KDF parameters", err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"data":"broken"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Load(testStorage, nil); !errors.Is(err, vault.ErrCorrupt) {
		t.Fatal("corrupt envelope treated as plaintext", err)
	}
}

func TestLargeStoredEnvelopeAndLegacyLayouts(t *testing.T) {
	key, err := vault.NewKey(testPass)
	if err != nil {
		t.Fatal(err)
	}
	defer key.Forget()
	body := []byte(`{"id":"large","body":"` + strings.Repeat("Z", 500<<10) + `"}`)
	blob, err := key.Seal(vault.NoteScope, "large", body)
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
		if !testStorage.ValidCatalog([]byte(libraryPrefix + string(stub) + librarySuffix)) {
			t.Fatal("rejected compatible note layout", pretty)
		}
	}
	// All normal storage paths still authenticate/decrypt the original, full ciphertext.
	snapshot, _ := json.Marshal(map[string]any{"sealed": string(blob), "id": "large", "title": "PRIVATE-TITLE"})
	if testStorage.ValidCatalog([]byte(libraryPrefix + string(snapshot) + librarySuffix)) {
		t.Fatal("large ciphertext masked a cleartext field")
	}
	broken := bytes.Replace(blob, []byte(`"data":"`), []byte(`"data":"#`), 1)
	stub, _ := json.Marshal(map[string]string{"id": "large", "sealed": string(broken)})
	if testStorage.ValidCatalog([]byte(libraryPrefix + string(stub) + librarySuffix)) {
		t.Fatal("invalid base64 accepted")
	}
}
