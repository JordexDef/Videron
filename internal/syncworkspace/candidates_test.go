package syncworkspace

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"videron/internal/syncclient"
	"videron/internal/workspacestore"
)

func TestMatchingFoldersUsesMarkersAndProjectIdentity(t *testing.T) {
	useTestProfileDirectory(t)
	selected := syncclient.Profile{
		Address:   "https://test.invalid:443",
		Pin:       strings.Repeat("a", 64),
		Token:     strings.Repeat("b", 64),
		Lineage:   strings.Repeat("c", 64),
		ProjectID: strings.Repeat("d", 64),
	}
	copyFolder := func(withHistory bool) string {
		t.Helper()
		dir, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		// Only joining should open the main file. Suggestions work even when
		// the cloud provider has not supplied the document's bytes yet.
		if err := os.WriteFile(filepath.Join(dir, workspacestore.Filename), nil, 0600); err != nil {
			t.Fatal(err)
		}
		if withHistory {
			if _, err := syncclient.HistoryDir(dir, selected.Lineage, "revisions", true); err != nil {
				t.Fatal(err)
			}
		}
		return dir
	}

	detached := copyFolder(true)
	connected := copyFolder(false)
	foreign := copyFolder(true)
	if err := StoreProfile(connected, selected); err != nil {
		t.Fatal(err)
	}
	other := selected
	other.ProjectID = strings.Repeat("e", 64)
	if err := StoreProfile(foreign, other); err != nil {
		t.Fatal(err)
	}
	open := copyFolder(false)
	replaced := copyFolder(true)
	lineages := map[string]string{
		workspacestore.SessionID(open):     selected.Lineage,
		workspacestore.SessionID(replaced): strings.Repeat("f", 64),
	}
	folders := []string{foreign, replaced, detached, detached + string(os.PathSeparator) + ".", connected, open}
	got := matchingFolders(selected, folders, lineages, filepath.EvalSymlinks)
	if !slices.Equal(got, []string{detached, connected, open}) {
		t.Fatalf("unexpected working copies %v", got)
	}
}
