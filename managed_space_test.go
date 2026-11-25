package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"videron/internal/syncclient"
)

func movedCatalog(t *testing.T, dir string, encrypted bool) string {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"version": 3, "active": "moving", "spaces": map[string]any{"moving": map[string]any{"name": "Move", "folder": canonicalTestFolder(t, dir), "encrypted": encrypted}}})
	return string(raw)
}

func TestMoveWorkingCopyPreservesStorageAndHistory(t *testing.T) {
	a, _ := testStore(t)
	from := t.TempDir()
	p := syncclient.Profile{Pin: strings.Repeat("0", 64), Address: "https://sync.example.org:443", Token: strings.Repeat("1", 64)}
	pathFor := func(profile syncclient.Profile) string {
		t.Helper()
		_, generation, err := a.ticketContext()
		if err != nil {
			t.Fatal(err)
		}
		verified, err := a.issueServerTicket(profile, generation)
		if err != nil {
			t.Fatal(err)
		}
		defer a.DiscardSyncServerTicket(verified.Ticket)
		path, err := a.ManagedServerFolder(verified.Ticket)
		if err != nil {
			t.Fatal(err)
		}
		return path
	}
	to := pathFor(p)
	if pathFor(p) != to {
		t.Fatal("ticket renewal changed automatic folder")
	}
	other := p
	other.ProjectID = strings.Repeat("e", 64)
	if pathFor(other) == to {
		t.Fatal("independent projects shared an automatic folder")
	}
	err := a.CreateFolderSpace(from, spaceFixture, testPass)
	if err != nil {
		t.Fatal(err)
	}
	edit := strings.Replace(spaceFixture, "PRIVATE-CLOUD", "New name", 1)
	if err = a.SaveFolderBranch(from, edit); err != nil {
		t.Fatal(err)
	}
	before, err := a.FolderSpaceLineage(from)
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(from, "other.txt")
	if err = os.WriteFile(marker, []byte("mine"), 0600); err != nil {
		t.Fatal(err)
	}
	p.Lineage = before
	profileDir := canonicalTestFolder(t, from)
	if err = storeProfile(profileDir, p); err != nil {
		t.Fatal(err)
	}
	main := stored(t, filepath.Join(from, folderSpaceFilename))
	if _, err = a.MoveFolderSpace(from, to, "invalid"); err == nil {
		t.Fatal("invalid catalog accepted")
	}
	// Fail after staging both data and credentials. The source remains usable,
	// and a retry can use the same destination without deleting anything.
	bad := strings.Replace(movedCatalog(t, to, true), `"version":3`, `"version":999`, 1)
	if _, err = a.MoveFolderSpace(from, to, bad); err == nil {
		t.Fatal("failed catalog commit reported success")
	}
	if entries, err := os.ReadDir(to); err != nil || len(entries) != 0 {
		t.Fatalf("incomplete rollback: %v %v", entries, err)
	}
	if _, err = os.Stat(filepath.Join(from, folderSpaceFilename)); err != nil {
		t.Fatal(err)
	}
	result, err := a.MoveFolderSpace(from, to, movedCatalog(t, to, true))
	if err != nil || result.KeptSource {
		t.Fatal(result, err)
	}
	if !bytes.Equal(main, stored(t, filepath.Join(to, folderSpaceFilename))) {
		t.Fatal("encrypted main changed")
	}
	if p2, err := loadProfile(canonicalTestFolder(t, to)); err != nil || p2 == nil || *p2 != p {
		t.Fatal("profile missing", err)
	}
	if p2, err := loadProfile(profileDir); err != nil || p2 != nil {
		t.Fatal("old profile retained", err)
	}
	if _, err = os.Stat(filepath.Join(from, folderSpaceFilename)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old main still present", err)
	}
	if string(stored(t, marker)) != "mine" {
		t.Fatal("unrelated file changed")
	}
	if after, err := a.FolderSpaceLineage(to); err != nil || after != before {
		t.Fatal("lineage changed", err)
	}
	a.CloseFolderSpace(to)
	if raw, err := a.OpenFolderSpace(to, testPass); err != nil || !strings.Contains(raw, "New name") {
		t.Fatal("latest revision lost", err)
	}
}
