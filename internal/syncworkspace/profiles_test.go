package syncworkspace

import (
	"errors"
	"strings"
	"testing"

	"videron/internal/syncclient"
)

func useTestProfileDirectory(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("AppData", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
}

func TestProjectDeletionPreservesReboundFolder(t *testing.T) {
	original := syncclient.Profile{Address: "https://test.invalid:443", ProjectID: strings.Repeat("a", 64), Pin: strings.Repeat("b", 64), Lineage: strings.Repeat("c", 64), Token: strings.Repeat("d", 64)}
	useTestProfileDirectory(t)
	folder := t.TempDir()
	other := original
	other.ProjectID = strings.Repeat("f", 64)
	if err := StoreProfile(folder, other); err != nil {
		t.Fatal(err)
	}
	if err := DetachDeletedProject(folder, &original, syncclient.ErrProjectDeleted); !errors.Is(err, syncclient.ErrChanged) {
		t.Fatal(err)
	}
	if p, err := LoadProfile(folder); err != nil || p == nil || p.ProjectID != other.ProjectID {
		t.Fatal("newly rebound folder lost its connection", err)
	}
}
