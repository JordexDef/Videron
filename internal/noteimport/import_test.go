package noteimport

import (
	"archive/zip"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const pngHeader = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"

func writeFixture(t *testing.T, dir, relative, contents string) {
	t.Helper()
	name := filepath.Join(dir, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadFolderKeepsPathsAndIgnoresAppConfiguration(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Old notebook")
	writeFixture(t, root, "daily/Черновик.MD", "\xef\xbb\xbf# Привет\r\n")
	writeFixture(t, root, "tables/list.csv", "x,y\n1,2\n")
	writeFixture(t, root, "tables/list.tsv", "x\ty\n1\t2\n")
	writeFixture(t, root, "daily/.private.md", "should not appear")
	writeFixture(t, root, ".obsidian/config.md", "should not appear")
	writeFixture(t, root, "__MACOSX/metadata.md", "should not appear")
	writeFixture(t, root, "assets/test.png", pngHeader)
	writeFixture(t, root, "assets/mismatch.png", "<svg/>")
	writeFixture(t, root, "assets/vector.svg", "<svg/>")
	writeFixture(t, root, "invalid.md", "binary\x00note")

	bundle, err := ReadFolder(root)
	if err != nil {
		t.Fatal(err)
	}
	want := []Document{{"daily/Черновик.MD", "# Привет\r\n"}, {"tables/list.csv", "x,y\n1,2\n"}, {"tables/list.tsv", "x\ty\n1\t2\n"}}
	if bundle.Name != "Old notebook" || !reflect.DeepEqual(bundle.Files, want) || bundle.Skipped != 2 {
		t.Fatalf("unexpected import %#v", bundle)
	}
	if len(bundle.Images) != 1 || bundle.Images[0].Path != "assets/test.png" || !strings.HasPrefix(bundle.Images[0].Src, "data:image/png;base64,") {
		t.Fatalf("unexpected images %#v", bundle.Images)
	}
}

func TestReadFolderDoesNotFollowSymlinks(t *testing.T) {
	root, neighbor := t.TempDir(), t.TempDir()
	writeFixture(t, root, "keep.md", "inside")
	writeFixture(t, neighbor, "hidden.md", "outside")
	outside := filepath.Join(neighbor, "hidden.md")
	if err := os.Symlink(outside, filepath.Join(root, "shortcut.md")); err != nil {
		t.Skipf("creating a test symlink: %v", err)
	}
	if err := os.Symlink(neighbor, filepath.Join(root, "shortcut")); err != nil {
		t.Fatal(err)
	}
	bundle, err := ReadFolder(root)
	if err != nil || !reflect.DeepEqual(bundle.Files, []Document{{"keep.md", "inside"}}) || bundle.Skipped != 1 {
		t.Fatalf("unexpected import %#v: %v", bundle, err)
	}
	if _, err := ReadFile(filepath.Join(root, "shortcut.md")); !errors.Is(err, ErrFormat) {
		t.Fatalf("direct symlink returned %v", err)
	}
}

type zipFixtureEntry struct {
	name string
	data string
	mode fs.FileMode
}

func writeZip(t *testing.T, contents ...zipFixtureEntry) string {
	t.Helper()
	file, err := os.Create(filepath.Join(t.TempDir(), "Workspace Export.zip"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	archive := zip.NewWriter(file)
	for _, entry := range contents {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
		if entry.mode != 0 {
			header.SetMode(entry.mode)
		}
		writer, err := archive.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(entry.data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return file.Name()
}

func TestReadZipAcceptsExportFoldersAndData(t *testing.T) {
	source := writeZip(t,
		zipFixtureEntry{"Export/Notes/Idea.markdown", "Obsidian export", 0},
		zipFixtureEntry{"Export/Notes/", "", 0},
		zipFixtureEntry{"Export/Database.csv", "x,y\n1,2\n", 0},
		zipFixtureEntry{"Export/Notes/Picture.png", pngHeader, 0},
		zipFixtureEntry{"Export/Shortcut.md", "/private/secret.md", fs.ModeSymlink | 0o777},
		zipFixtureEntry{"Export/.obsidian/preferences.md", "hidden", 0},
		zipFixtureEntry{"__MACOSX/Export/Notes/Idea.markdown", "duplicate", 0},
	)
	bundle, err := ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	want := []Document{{"Export/Notes/Idea.markdown", "Obsidian export"}, {"Export/Database.csv", "x,y\n1,2\n"}}
	if bundle.Name != "Workspace Export" || !reflect.DeepEqual(bundle.Files, want) || bundle.Skipped != 1 {
		t.Fatalf("unexpected import %#v", bundle)
	}
	if len(bundle.Images) != 1 || bundle.Images[0].Path != "Export/Notes/Picture.png" {
		t.Fatalf("unexpected images %#v", bundle.Images)
	}
}

func TestReadZipRejectsAmbiguousOrUnsafeEntries(t *testing.T) {
	for _, names := range [][]string{
		{"../note.md"}, {"/note.md"}, {"dir/../note.md"}, {"dir\\note.md"}, {"C:/note.md"},
		{"dir//note.md"}, {"note.md:stream"}, {"dir/a.md", "dir/A.md"}, {"dir/a.md", "DIR/b.md"},
		{"dir", "dir/a.md"}, {"other/a.md", "other"}, {"note.md", "note.md"},
	} {
		t.Run(strings.Join(names, ","), func(t *testing.T) {
			var files []zipFixtureEntry
			for _, name := range names {
				files = append(files, zipFixtureEntry{name: name, data: "contents"})
			}
			if _, err := ReadFile(writeZip(t, files...)); !errors.Is(err, ErrFormat) {
				t.Fatalf("expected invalid export: %v", err)
			}
		})
	}
}

func TestReadSingleDocumentAndLimits(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "Пример.Markdown", "# Привет")
	writeFixture(t, root, "sibling.md", "ignore me")
	writeFixture(t, root, "bogus.zip", "not a ZIP")
	writeFixture(t, root, "huge.md", "")
	if err := os.Truncate(filepath.Join(root, "huge.md"), maxDocument+1); err != nil {
		t.Fatal(err)
	}
	bundle, err := ReadFile(filepath.Join(root, "Пример.Markdown"))
	if err != nil || bundle.Name != "Пример" || !reflect.DeepEqual(bundle.Files, []Document{{"Пример.Markdown", "# Привет"}}) {
		t.Fatalf("unexpected import %#v: %v", bundle, err)
	}
	if _, err = ReadFile(filepath.Join(root, "bogus.zip")); !errors.Is(err, ErrFormat) {
		t.Fatalf("malformed ZIP: %v", err)
	}
	if _, err = ReadFile(filepath.Join(root, "huge.md")); !errors.Is(err, ErrLimit) {
		t.Fatalf("oversized document: %v", err)
	}
	if _, err = ReadFolder(t.TempDir()); !errors.Is(err, ErrEmpty) {
		t.Fatalf("empty folder: %v", err)
	}
	deep := strings.Repeat("d/", maxDepth) + "note.md"
	if _, err = ReadFile(writeZip(t, zipFixtureEntry{name: deep, data: "text"})); !errors.Is(err, ErrLimit) {
		t.Fatalf("deep archive path: %v", err)
	}
}
