package noteexport

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

func text(value string) *string { return &value }

func example() Bundle {
	return Bundle{Name: "Проект", Directories: []string{"Пустая/Ещё пустая"}, Files: []File{
		{Path: "Заметка.md", Text: text("# Заметка\n\n[Следующая](Работа/День.md)\n")},
		{Path: "Работа/День.md", Text: text("![Photo](../_attachments/photo.png)\n")},
		{Path: "Работа/Подпапка/Empty.md", Text: text("")},
		{Path: "_attachments/photo.png", Src: "data:image/png;base64," + pixel},
		{Path: "Работа/Таблица.csv", Text: text("имя,число\nтест,2\n")},
	}}
}

func checkExport(t *testing.T, output fs.FS, bundle Bundle) {
	t.Helper()
	for _, dir := range bundle.Directories {
		info, err := fs.Stat(output, dir)
		if err != nil || !info.IsDir() {
			t.Errorf("directory %q = %v, %v", dir, info, err)
		}
	}
	for _, item := range bundle.Files {
		data, err := fs.ReadFile(output, item.Path)
		if err != nil {
			t.Fatal(err)
		}
		if item.Text != nil {
			if got := string(data); got != *item.Text {
				t.Errorf("%s = %q, want %q", item.Path, got, *item.Text)
			}
		} else if got := base64.StdEncoding.EncodeToString(data); got != pixel {
			t.Errorf("image bytes differed: %x", data)
		}
	}
}

func TestWriteMarkdownFolder(t *testing.T) {
	parent := t.TempDir()
	bundle := example()
	existing := filepath.Join(parent, bundle.Name)
	if err := os.Mkdir(existing, 0700); err != nil {
		t.Fatal(err)
	}
	// A no-clobber publish must preserve even an existing empty directory.
	actual, err := WriteFolder(parent, bundle, nil)
	if err != nil || actual != existing+" (2)" {
		t.Fatalf("WriteFolder = %q, %v", actual, err)
	}
	checkExport(t, os.DirFS(actual), bundle)
	entries, err := os.ReadDir(existing)
	if err != nil || len(entries) != 0 {
		t.Fatalf("existing directory = %v, %v", entries, err)
	}
	assertNames(t, parent, bundle.Name, bundle.Name+" (2)")
}

func TestWriteZip(t *testing.T) {
	parent := t.TempDir()
	destination := filepath.Join(parent, "Проект.zip")
	bundle := example()
	if err := WriteZip(destination, bundle, nil); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(destination)
	if err != nil {
		t.Fatal(err)
	}
	checkExport(t, &archive.Reader, bundle)
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	*bundle.Files[0].Text = "Replacement"
	if err := WriteZip(destination, bundle, nil); !errors.Is(err, ErrExists) {
		t.Fatalf("recursive WriteZip = %v", err)
	}
	after, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(original, after) {
		t.Fatalf("original ZIP changed: %v", err)
	}
	assertNames(t, parent, filepath.Base(destination))
}

func assertNames(t *testing.T, parent string, expected ...string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != len(expected) {
		t.Fatalf("output directory = %v, %v, expected %v", entries, err, expected)
	}
	for i, entry := range entries {
		if entry.Name() != expected[i] {
			t.Errorf("output entry = %q, expected %q", entry.Name(), expected[i])
		}
	}
}

func TestInvalidPathsLeaveNoOutput(t *testing.T) {
	parent := t.TempDir()
	for _, path := range []string{
		"../note.md", "Directory/../note.md", "/note.md", "D:/note.md", "Directory\\note.md",
		"Directory/./note.md", "Directory//note.md", "NUL.md", "valid/COM¹.md", "bad. /note.md",
		"bad\x00.md", "\xff.md", "no:stream.md", "note.html", strings.Repeat("a", 121) + ".md",
	} {
		bundle := Bundle{Name: "Vault", Files: []File{{Path: path, Text: text("ignored")}}}
		if _, err := WriteFolder(parent, bundle, nil); !errors.Is(err, ErrFormat) {
			t.Errorf("WriteFolder with %q = %v", path, err)
		}
		if err := WriteZip(filepath.Join(parent, "Vault.zip"), bundle, nil); !errors.Is(err, ErrFormat) {
			t.Errorf("WriteZip with %q = %v", path, err)
		}
	}
	for _, pair := range [][2]string{
		{"File.md", "FILE.MD"}, {"Abc/A.md", "ABC/B.md"}, {"A.md", "A.md/B.md"},
		{"café/A.md", "cafe\u0301/B.md"},
	} {
		bundle := Bundle{Name: "Vault", Files: []File{{Path: pair[0], Text: text("A")}, {Path: pair[1], Text: text("B")}}}
		if _, err := WriteFolder(parent, bundle, nil); !errors.Is(err, ErrFormat) {
			t.Errorf("WriteFolder conflict %q = %v", pair, err)
		}
	}
	assertNames(t, parent)
}

func TestWriteZipPreservesDestinationCreatedDuringExport(t *testing.T) {
	parent := t.TempDir()
	destination := filepath.Join(parent, "Vault.zip")
	bundle := Bundle{Files: []File{{Path: "Note.md", Text: text("Latest version")}}}
	checks := 0
	allowed := func() bool {
		checks++
		if checks == 4 { // A different process could create this name just before publication.
			if err := os.WriteFile(destination, []byte("Keep me"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		return true
	}
	if err := WriteZip(destination, bundle, allowed); !errors.Is(err, ErrExists) {
		t.Fatalf("WriteZip = %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "Keep me" {
		t.Fatalf("concurrent destination changed: %q, %v", data, err)
	}
	assertNames(t, parent, "Vault.zip")
}

func TestFailedImageAndCancellationLeaveNoExport(t *testing.T) {
	tests := []struct {
		name     string
		expected error
		change   func(*Bundle)
		allowed  func(int) bool
	}{
		{"invalid image", ErrFormat, func(b *Bundle) {
			b.Files[3].Src = "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("not an image"))
		}, nil},
		{"invalid base64", ErrFormat, func(b *Bundle) { b.Files[3].Src = "data:image/png;base64," + strings.ReplaceAll(pixel, "iV", "*V") }, nil},
		{"cancel mid-write", ErrCancelled, nil, func(check int) bool { return check <= 7 }},
		{"cancel on final publish", ErrCancelled, nil, func(check int) bool { return check <= 12 }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			parent := t.TempDir()
			bundle := example()
			if tc.change != nil {
				tc.change(&bundle)
			}
			checks := 0
			allowed := func() bool {
				checks++
				return tc.allowed == nil || tc.allowed(checks)
			}
			if _, err := WriteFolder(parent, bundle, allowed); !errors.Is(err, tc.expected) {
				t.Fatalf("folder = %v, want %v, checks %d", err, tc.expected, checks)
			}
			assertNames(t, parent)
			checks = 0
			if err := WriteZip(filepath.Join(parent, "Vault.zip"), bundle, allowed); !errors.Is(err, tc.expected) {
				t.Fatalf("zip = %v, want %v, checks %d", err, tc.expected, checks)
			}
			assertNames(t, parent)
		})
	}
}

func TestConcurrentFolderExportsDoNotClobber(t *testing.T) {
	parent := t.TempDir()
	var pending sync.WaitGroup
	for range 3 {
		pending.Go(func() {
			if _, err := WriteFolder(parent, example(), nil); err != nil {
				t.Error(err)
			}
		})
	}
	pending.Wait()
	assertNames(t, parent, "Проект", "Проект (2)", "Проект (3)")
}

func TestSafeName(t *testing.T) {
	for title, expected := range map[string]string{" vol/ume:  ": "vol-ume-", "CON": "_CON", "LPT¹.foo": "_LPT¹.foo", "...": "Videron"} {
		if got := SafeName(title); got != expected {
			t.Errorf("SafeName(%q) = %q, want %q", title, got, expected)
		}
	}
	name := SafeName(strings.Repeat("🙂", 50)) + " (10000).zip"
	if !validPath(name) || !utf8.ValidString(name) {
		t.Fatalf("invalid generated name %q", name)
	}
}
