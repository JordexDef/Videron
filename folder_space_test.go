package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"videron/internal/vault"
	"videron/internal/workspacestore"
)

const spaceFixture = `{"name":"PRIVATE-CLOUD","notes":[` + originalNote + `],"areas":[],"routes":[{"title":"PRIVATE-ROUTE"}]}`

// Profiles, catalog links and session keys use the folder resolved by the desktop API.
// t.TempDir can contain an alias (for example /var on macOS).
func canonicalTestFolder(t *testing.T, folder string) string {
	t.Helper()
	dir, err := spaceDir(folder)
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestFolderSpaceVaultIsPortableAndSeparate(t *testing.T) {
	a, libraryPath := testStore(t)
	source := t.TempDir()
	path := filepath.Join(source, folderSpaceFilename)
	info, err := a.InspectSpaceFolder(source)
	if err != nil || info.Exists || info.Folder == "" {
		t.Fatal(info, err)
	}
	if err = a.CreateFolderSpace(source, spaceFixture, "short"); !errors.Is(err, errWeak) {
		t.Fatal(err)
	}
	if err = a.CreateFolderSpace(source, spaceFixture, testPass); err != nil {
		t.Fatal(err)
	}
	info, err = a.InspectSpaceFolder(source)
	if err != nil || !info.Exists || !info.Encrypted {
		t.Fatal(info, err)
	}
	first := stored(t, path)
	if bytes.Contains(first, []byte("PRIVATE")) || bytes.Contains(first, []byte(testPass)) {
		t.Fatal("plaintext in folder")
	}
	if err = a.CreateFolderSpace(source, spaceFixture, ""); !errors.Is(err, errSpaceExists) {
		t.Fatal(err)
	}
	if err = a.SaveFolderSpace(source, spaceFixture); err != nil || bytes.Equal(first, stored(t, path)) {
		t.Fatal("encrypted save must use a fresh nonce", err)
	}
	catalog := `{"version":3,"active":"linked","spaces":{"linked":{"name":"Cloud","folder":"cloud","encrypted":true}}}`
	if err = a.Save(catalog); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored(t, libraryPath), []byte("PRIVATE")) {
		t.Fatal("folder body in the local catalog")
	}
	for _, leaked := range []string{spaceFixture, `{"arbitrary":"PRIVATE"}`, `[]`} {
		if err = a.Save(strings.Replace(catalog, `"encrypted":true`, `"notes":`+leaked, 1)); !errors.Is(err, errInvalid) {
			t.Fatal("saved folder data alongside link", err)
		}
	}
	other := t.TempDir()
	if err = os.WriteFile(filepath.Join(other, folderSpaceFilename), stored(t, path), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = a.OpenFolderSpace(other, ""); !errors.Is(err, errLocked) {
		t.Fatal(err)
	}
	if _, err = a.OpenFolderSpace(other, "wrong pass"); !errors.Is(err, errPassword) {
		t.Fatal(err)
	}
	if got, err := a.OpenFolderSpace(other, testPass); err != nil || got != spaceFixture {
		t.Fatal("portable unlock", err)
	}
	a.CloseFolderSpace(other)
	if err = a.DeleteFolderSpace(other); !errors.Is(err, errLocked) {
		t.Fatal("deleted a closed folder", err)
	}
	if err = a.SaveFolderSpace(other, spaceFixture); !errors.Is(err, errLocked) {
		t.Fatal(err)
	}
	if err = a.SaveFolderSpace(source, spaceFixture); err != nil {
		t.Fatal("closing one folder locked another", err)
	}
	a.LockSession("")
	if _, err = a.Load(); err != nil {
		t.Fatal(err)
	}
	if err = a.SaveFolderSpace(source, spaceFixture); !errors.Is(err, errLocked) {
		t.Fatal("folder key survived session lock", err)
	}
	if got, err := a.OpenFolderSpace(source, testPass); err != nil || got != spaceFixture {
		t.Fatal(err)
	}
	a.FinishClose()
	if len(a.folderSpaces) != 0 {
		t.Fatal("folder key survived close")
	}
}

func TestSuspendedFolderResumesCurrentFileOnlyForThatFolder(t *testing.T) {
	a, _ := testStore(t)
	dir, other := t.TempDir(), t.TempDir()
	if err := a.CreateFolderSpace(dir, spaceFixture, testPass); err != nil {
		t.Fatal(err)
	}
	raw := stored(t, filepath.Join(dir, folderSpaceFilename))
	if err := os.WriteFile(filepath.Join(other, folderSpaceFilename), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if !a.SuspendFolderSpace(dir) || len(a.folderSpaces) != 0 {
		t.Fatal("suspended folder retained an open session")
	}
	if err := a.SaveFolderSpace(dir, spaceFixture); !errors.Is(err, errLocked) {
		t.Fatal("suspended folder retained write access", err)
	}
	info, err := a.InspectSpaceFolder(dir)
	if err != nil || !info.CanResume {
		t.Fatal(info, err)
	}
	if _, err := a.ResumeFolderSpace(other); !errors.Is(err, errLocked) {
		t.Fatal("same key reused for a different folder", err)
	}
	peer := &App{loaded: true}
	if _, err := peer.OpenFolderSpace(dir, testPass); err != nil {
		t.Fatal(err)
	}
	updated := strings.ReplaceAll(spaceFixture, "PRIVATE-CLOUD", "CHANGED-ON-PEER")
	if err := peer.SaveFolderSpace(dir, updated); err != nil {
		t.Fatal(err)
	}
	peer.CloseFolderSpace(dir)
	got, err := a.ResumeFolderSpace(dir)
	if err != nil || got != updated || len(a.suspendedFolderKeys) != 0 {
		t.Fatal("resume did not read the latest version", err)
	}
	if !a.SuspendFolderSpace(dir) {
		t.Fatal("could not suspend again")
	}
	a.CloseFolderSpace(dir)
	if _, err := a.ResumeFolderSpace(dir); !errors.Is(err, errLocked) {
		t.Fatal("explicit close retained key", err)
	}
}

func TestSuspendedFolderRejectsReplacedOrDamagedEnvelope(t *testing.T) {
	a, _ := testStore(t)
	dir := t.TempDir()
	path := filepath.Join(dir, folderSpaceFilename)
	if err := a.CreateFolderSpace(dir, spaceFixture, testPass); err != nil {
		t.Fatal(err)
	}
	raw := stored(t, path)
	mutate := func(change func(*vault.Envelope)) []byte {
		env, err := vault.ParseEnvelope(raw, folderSpaceFormat)
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
	plain, err := folderStore.EncodeSpace(spaceFixture, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		data []byte
		want error
	}{
		{"different salt", mutate(func(e *vault.Envelope) { e.Salt[0] ^= 1 }), errLocked},
		{"invalid authentication tag", mutate(func(e *vault.Envelope) { e.Data[len(e.Data)-1] ^= 1 }), errPassword},
		{"invalid container", []byte("{"), errCorrupt},
		{"plaintext downgrade", plain, errChanged},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := a.OpenFolderSpace(dir, testPass); err != nil {
				t.Fatal(err)
			}
			if !a.SuspendFolderSpace(dir) {
				t.Fatal("expected suspended key")
			}
			if err := os.WriteFile(path, tc.data, 0600); err != nil {
				t.Fatal(err)
			}
			got, err := a.ResumeFolderSpace(dir)
			if got != "" || !errors.Is(err, tc.want) {
				t.Fatal(got, err)
			}
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := a.ResumeFolderSpace(dir); !errors.Is(err, errLocked) {
				t.Fatal("stale key retained", err)
			}
		})
	}
	if _, err := a.OpenFolderSpace(dir, testPass); err != nil {
		t.Fatal(err)
	}
	a.SuspendFolderSpace(dir)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if info, err := a.InspectSpaceFolder(dir); err != nil || info.Exists || info.CanResume {
		t.Fatal(info, err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ResumeFolderSpace(dir); !errors.Is(err, errLocked) {
		t.Fatal("removed folder retained key", err)
	}
}

func TestSessionLockForgetsSuspendedKeysAndAllowsPendingEncryptedSave(t *testing.T) {
	a, _ := testStore(t)
	away, active := t.TempDir(), t.TempDir()
	for _, dir := range []string{away, active} {
		if err := a.CreateFolderSpace(dir, spaceFixture, testPass); err != nil {
			t.Fatal(err)
		}
	}
	if !a.SuspendFolderSpace(away) {
		t.Fatal("expected suspended key")
	}
	suspended := a.suspendedFolderKeys[workspacestore.SessionID(canonicalTestFolder(t, away))]
	// A slow disk save holds the storage lock. The UI still needs to
	// receive the OS lock immediately while the native cleanup waits.
	a.mu.Lock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.sessionLocked(context.Background())
	}()
	deadline := time.Now().Add(3 * time.Second)
	for !a.sessionLockPending.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	notified := a.ConsumeSessionLock()
	a.mu.Unlock()
	<-done
	if !notified {
		t.Fatal("OS lock notification waited for a pending storage operation")
	}
	if _, err := suspended.Seal(folderSpaceFormat, "", []byte(spaceFixture)); !errors.Is(err, errLocked) {
		t.Fatal("suspended key still usable after OS lock", err)
	}
	if _, err := a.ResumeFolderSpace(away); !errors.Is(err, errLocked) {
		t.Fatal("key survived OS lock", err)
	}
	if err := a.SaveFolderSpace(active, spaceFixture); err != nil {
		t.Fatal("final encrypted save could not complete", err)
	}
	if a.SuspendFolderSpace(active) {
		t.Fatal("late workspace switch recached key after OS lock")
	}
	if _, err := a.OpenFolderSpace(active, testPass); err != nil {
		t.Fatal(err)
	}
	if !a.SuspendFolderSpace(active) {
		t.Fatal("fresh authentication should start another session")
	}
	a.LockSession("")
	if len(a.suspendedFolderKeys) != 0 {
		t.Fatal("key survived session lock")
	}
	if _, err := a.Load(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.OpenFolderSpace(active, testPass); err != nil {
		t.Fatal(err)
	}
	a.SuspendFolderSpace(active)
	a.FinishClose()
	if len(a.suspendedFolderKeys) != 0 {
		t.Fatal("key survived application close")
	}
}

func TestCatalogWithoutAnActiveSpace(t *testing.T) {
	a, _ := testStore(t)
	for _, catalog := range []string{
		`{"version":3,"active":"","spaces":{}}`,
		`{"version":3,"active":"","spaces":{"cloud":{"name":"Cloud","folder":"/elsewhere","encrypted":true}}}`,
	} {
		if err := a.Save(catalog); err != nil {
			t.Fatal(err)
		}
		if raw, err := a.Load(); err != nil || raw != catalog {
			t.Fatal("empty catalog did not round trip", err)
		}
	}
	for _, catalog := range []string{
		`{"version":3,"active":""}`, `{"version":3,"active":"","spaces":null}`,
		`{"version":3,"active":"missing","spaces":{}}`, `{"version":2,"active":"","spaces":{}}`,
	} {
		if err := a.Save(catalog); !errors.Is(err, errInvalid) {
			t.Fatal("invalid catalog accepted", catalog, err)
		}
	}
}
