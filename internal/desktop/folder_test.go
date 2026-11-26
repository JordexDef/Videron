package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestFolderLinkDestinations(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Рабочие заметки & фото (2026)")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if got, err := ExistingFolder(dir + string(filepath.Separator)); err != nil || got != dir {
		t.Fatalf("directory %q, %v", got, err)
	}
	file := filepath.Join(dir, "document.txt")
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	invalid := []string{"", ".", "../notes", "file:///tmp", "https://example.org", "shell:Downloads", dir + "\x00", file}
	if runtime.GOOS == "windows" {
		invalid = append(invalid, `C:relative`, `\relative`, `\\server`, `\\.\C:\`, `//?/C:/test`, `\??\C:\test`, dir+":stream")
	}
	for _, name := range invalid {
		if err := OpenFolder(name); !errors.Is(err, ErrFolderInvalid) {
			t.Errorf("invalid destination %q: %v", name, err)
		}
	}
	if err := OpenFolder(filepath.Join(dir, "moved")); !errors.Is(err, ErrFolderMissing) {
		t.Fatal("moved directory", err)
	}
}
