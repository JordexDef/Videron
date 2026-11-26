package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"videron/internal/foldersession"
)

const spaceFixture = `{"name":"PRIVATE-CLOUD","notes":[` + originalNote + `],"areas":[],"routes":[{"title":"PRIVATE-ROUTE"}]}`

// Profiles, catalog links and session keys use the folder resolved by the desktop API.
// t.TempDir can contain an alias (for example /var on macOS).
func canonicalTestFolder(t *testing.T, folder string) string {
	t.Helper()
	dir, err := foldersession.CanonicalFolder(folder)
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
	if _, err = a.Load(); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveFolderSpace(source, spaceFixture); !errors.Is(err, errLocked) {
		t.Fatal("folder key survived close", err)
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
	notified := a.sessionLockPending.Load()
	a.mu.Unlock()
	<-done
	if !notified {
		t.Fatal("OS lock notification waited for a pending storage operation")
	}
	if !a.ConsumeSessionLock() || a.ConsumeSessionLock() {
		t.Fatal("OS lock notification must be delivered exactly once")
	}
	if _, err := a.ResumeFolderSpace(away); !errors.Is(err, errLocked) {
		t.Fatal("key survived OS lock", err)
	}
	updated := strings.Replace(spaceFixture, "PRIVATE-CLOUD", "Final saved edit", 1)
	if err := a.SaveFolderSpace(active, updated); err != nil {
		t.Fatal("final encrypted save could not complete", err)
	}
	if a.SuspendFolderSpace(active) {
		t.Fatal("late workspace switch recached key after OS lock")
	}
	if _, err := a.ResumeFolderSpace(active); !errors.Is(err, errLocked) {
		t.Fatal("active folder resumed without a password after lock", err)
	}
	if got, err := a.OpenFolderSpace(active, testPass); err != nil || got != updated {
		t.Fatal("could not recover final encrypted save after password entry", err)
	}
	if !a.SuspendFolderSpace(active) {
		t.Fatal("fresh authentication should start another session")
	}
	a.LockSession("")
	if _, err := a.Load(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ResumeFolderSpace(active); !errors.Is(err, errLocked) {
		t.Fatal("key survived session lock", err)
	}
	if _, err := a.OpenFolderSpace(active, testPass); err != nil {
		t.Fatal(err)
	}
	a.SuspendFolderSpace(active)
	a.FinishClose()
	if _, err := a.Load(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ResumeFolderSpace(active); !errors.Is(err, errLocked) {
		t.Fatal("key survived application close", err)
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
