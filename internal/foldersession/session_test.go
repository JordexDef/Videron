package foldersession

import (
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

const folderPassword = "folder fixture passphrase"
const spaceFixture = `{"name":"PRIVATE-CLOUD","notes":[{"id":"note-a","title":"Fixture note"}],"areas":[]}`

func testSessionStore(t *testing.T) *workspacestore.Store {
	t.Helper()
	profile := t.TempDir()
	t.Setenv("APPDATA", profile)
	t.Setenv("XDG_CONFIG_HOME", profile)
	t.Setenv("HOME", profile)
	return workspacestore.New[json.RawMessage]()
}

func readStoredFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestSuspendedFolderResumesCurrentFileOnlyForThatFolder(t *testing.T) {
	store := testSessionStore(t)
	var sessions Manager
	t.Cleanup(sessions.Clear)
	dir, other := t.TempDir(), t.TempDir()
	if err := sessions.Create(store, dir, spaceFixture, folderPassword); err != nil {
		t.Fatal(err)
	}
	raw := readStoredFile(t, filepath.Join(dir, workspacestore.Filename))
	if err := os.WriteFile(filepath.Join(other, workspacestore.Filename), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if !sessions.Suspend(dir) || len(sessions.active) != 0 {
		t.Fatal("suspended folder retained an open session")
	}
	if _, err := sessions.Current(dir); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("suspended folder retained write access", err)
	}
	info, err := sessions.Inspect(store, dir)
	if err != nil || !info.CanResume {
		t.Fatal(info, err)
	}
	if _, err := sessions.Resume(store, other); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("same key reused for a different folder", err)
	}
	var peer Manager
	t.Cleanup(peer.Clear)
	if _, err := peer.Open(store, dir, folderPassword); err != nil {
		t.Fatal(err)
	}
	updated := strings.ReplaceAll(spaceFixture, "PRIVATE-CLOUD", "CHANGED-ON-PEER")
	active, err := peer.Current(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := active.Save(updated); err != nil {
		t.Fatal(err)
	}
	peer.Close(dir)
	got, err := sessions.Resume(store, dir)
	if err != nil || got != updated || len(sessions.suspended) != 0 {
		t.Fatal("resume did not read the latest version", err)
	}
	if !sessions.Suspend(dir) {
		t.Fatal("could not suspend again")
	}
	sessions.Close(dir)
	if _, err := sessions.Resume(store, dir); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("explicit close retained key", err)
	}
}

func TestSuspendedFolderRejectsReplacedOrDamagedEnvelope(t *testing.T) {
	store := testSessionStore(t)
	var sessions Manager
	t.Cleanup(sessions.Clear)
	dir := t.TempDir()
	path := filepath.Join(dir, workspacestore.Filename)
	if err := sessions.Create(store, dir, spaceFixture, folderPassword); err != nil {
		t.Fatal(err)
	}
	raw := readStoredFile(t, path)
	mutate := func(change func(*vault.Envelope)) []byte {
		env, err := vault.ParseEnvelope(raw, workspacestore.Format)
		if err != nil {
			t.Fatal(err)
		}
		change(env)
		data, err := json.Marshal(env)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	plain, err := store.EncodeSpace(spaceFixture, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		data []byte
		want error
	}{
		{"different salt", mutate(func(e *vault.Envelope) { e.Salt[0] ^= 1 }), vault.ErrLocked},
		{"invalid authentication tag", mutate(func(e *vault.Envelope) { e.Data[len(e.Data)-1] ^= 1 }), vault.ErrPassword},
		{"invalid container", []byte("{"), vault.ErrCorrupt},
		{"plaintext downgrade", plain, syncclient.ErrChanged},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := sessions.Open(store, dir, folderPassword); err != nil {
				t.Fatal(err)
			}
			if !sessions.Suspend(dir) {
				t.Fatal("expected suspended key")
			}
			if err := os.WriteFile(path, tc.data, 0600); err != nil {
				t.Fatal(err)
			}
			got, err := sessions.Resume(store, dir)
			if got != "" || !errors.Is(err, tc.want) {
				t.Fatal(got, err)
			}
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := sessions.Resume(store, dir); !errors.Is(err, vault.ErrLocked) {
				t.Fatal("stale key retained", err)
			}
		})
	}
	if _, err := sessions.Open(store, dir, folderPassword); err != nil {
		t.Fatal(err)
	}
	sessions.Suspend(dir)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if info, err := sessions.Inspect(store, dir); err != nil || info.Exists || info.CanResume {
		t.Fatal(info, err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Resume(store, dir); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("removed folder retained key", err)
	}
}

func TestForgetSuspendedRevokesKeysAndAllowsFinalSave(t *testing.T) {
	store := testSessionStore(t)
	var sessions Manager
	t.Cleanup(sessions.Clear)
	away, active := t.TempDir(), t.TempDir()
	for _, dir := range []string{away, active} {
		if err := sessions.Create(store, dir, spaceFixture, folderPassword); err != nil {
			t.Fatal(err)
		}
	}
	if !sessions.Suspend(away) {
		t.Fatal("expected a suspended key")
	}
	awayDir, err := CanonicalFolder(away)
	if err != nil {
		t.Fatal(err)
	}
	cached := sessions.suspended[workspacestore.SessionID(awayDir)]
	if cached == nil {
		t.Fatal("missing cached key")
	}
	sessions.SetRevoking(true)
	if got, err := sessions.Resume(store, away); got != "" || !errors.Is(err, vault.ErrLocked) {
		t.Fatal("resume accepted while keys were being revoked", err)
	}
	sessions.ForgetSuspended()
	sessions.SetRevoking(false)
	if len(sessions.suspended) != 0 {
		t.Fatal("suspended keys survived revocation")
	}
	if _, err := cached.Seal(workspacestore.Format, "", []byte(spaceFixture)); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("discarded key still encrypts data", err)
	}
	editor, err := sessions.Current(active)
	if err != nil {
		t.Fatal(err)
	}
	updated := strings.Replace(spaceFixture, "Fixture note", "Saved during lock", 1)
	if err := editor.Save(updated); err != nil {
		t.Fatal("active editor could not complete a final encrypted save", err)
	}
	if sessions.Suspend(active) {
		t.Fatal("late workspace switch restored a revoked key")
	}
	if _, err := sessions.Resume(store, active); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("revoked workspace resumed without a password", err)
	}
	if got, err := sessions.Open(store, active, folderPassword); err != nil || got != updated {
		t.Fatal("final encrypted save was lost", err)
	}
}
