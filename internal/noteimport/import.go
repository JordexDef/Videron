// Package noteimport reads user-selected text exports without changing their source.
package noteimport

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

var (
	ErrFormat = errors.New("VD_IMPORT_FORMAT")
	ErrRead   = errors.New("VD_IMPORT_READ")
	ErrLimit  = errors.New("VD_IMPORT_LIMIT")
	ErrEmpty  = errors.New("VD_IMPORT_EMPTY")
)

const (
	maxArchiveBytes = 128 << 20
	maxEntries      = 20000
	maxDepth        = 32
	maxDocuments    = 5000
	maxDocument     = 4 << 20
	maxText         = 32 << 20
	maxImages       = 1000
	maxImage        = 8 << 20
	maxRaster       = 24 << 20
)

type Bundle struct {
	Name    string     `json:"name"`
	Files   []Document `json:"files"`
	Images  []Image    `json:"images,omitempty"`
	Skipped int        `json:"skipped,omitempty"`
}

type Document struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

type Image struct {
	Path string `json:"path"`
	Src  string `json:"src"`
}

type entry struct {
	name string
	size uint64
	open func() (io.ReadCloser, error)
}

type entries struct {
	documents []entry
	images    []entry
	skipped   int
}

func documentPath(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".md", ".markdown", ".csv", ".tsv":
		return true
	}
	return false
}

func imagePath(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif":
		return true
	}
	return false
}

func hiddenPath(name string) bool {
	for part := range strings.SplitSeq(name, "/") {
		if strings.HasPrefix(part, ".") || strings.EqualFold(part, "__MACOSX") {
			return true
		}
	}
	return false
}

func portablePath(name string) bool {
	return name != "." && utf8.ValidString(name) && fs.ValidPath(name) &&
		!strings.ContainsAny(name, "\\:\x00") && len(name) <= 4096
}

func (all *entries) add(item entry) error {
	if documentPath(item.name) {
		if len(all.documents) == maxDocuments || item.size > maxDocument {
			return ErrLimit
		}
		all.documents = append(all.documents, item)
	} else if imagePath(item.name) {
		if len(all.images) == maxImages || item.size > maxImage {
			all.skipped++
		} else {
			all.images = append(all.images, item)
		}
	}
	return nil
}

func rasterMIME(data []byte) string {
	switch mime := http.DetectContentType(data); mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp":
		return mime
	}
	if len(data) >= 16 && string(data[4:8]) == "ftyp" &&
		(string(data[8:12]) == "avif" || string(data[8:12]) == "avis") {
		return "image/avif"
	}
	return ""
}

func (item entry) read(limit int64) ([]byte, error) {
	f, err := item.open()
	if err != nil {
		return nil, ErrRead
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, ErrRead
	}
	if int64(len(data)) > limit {
		return nil, ErrLimit
	}
	return data, nil
}

func (all entries) read(name string) (Bundle, error) {
	bundle := Bundle{Name: name, Skipped: all.skipped}
	remaining := int64(maxText)
	for _, item := range all.documents {
		if item.size > uint64(remaining) {
			return Bundle{}, ErrLimit
		}
		data, err := item.read(min(remaining, maxDocument))
		if err != nil {
			return Bundle{}, err
		}
		remaining -= int64(len(data))
		data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
		if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
			bundle.Skipped++
			continue
		}
		bundle.Files = append(bundle.Files, Document{Path: item.name, Text: string(data)})
	}
	if len(bundle.Files) == 0 {
		return Bundle{}, ErrEmpty
	}
	remaining = maxRaster
	for _, item := range all.images {
		if item.size > uint64(remaining) {
			bundle.Skipped++
			continue
		}
		data, err := item.read(min(remaining, maxImage))
		if err != nil {
			bundle.Skipped++
			continue
		}
		// Charge bytes read even for malformed images.
		remaining -= int64(len(data))
		mime := rasterMIME(data)
		if mime == "" {
			bundle.Skipped++
			continue
		}
		bundle.Images = append(bundle.Images, Image{Path: item.name, Src: "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)})
	}
	return bundle, nil
}

// A checked open still verifies the identity after opening in case a source
// file was replaced while the discovery pass was running.
func openRegular(before fs.FileInfo, open func() (*os.File, error)) (*os.File, error) {
	if !before.Mode().IsRegular() {
		return nil, ErrFormat
	}
	f, err := open()
	if err != nil {
		return nil, ErrRead
	}
	after, err := f.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		f.Close()
		return nil, ErrRead
	}
	return f, nil
}

// ReadFolder walks the selected tree and never follows directory symlinks.
func ReadFolder(source string) (Bundle, error) {
	info, err := os.Lstat(source)
	if err != nil {
		return Bundle{}, ErrRead
	}
	if !info.IsDir() {
		return Bundle{}, ErrFormat
	}
	root, err := os.OpenRoot(source)
	if err != nil {
		return Bundle{}, ErrRead
	}
	defer root.Close()
	var all entries
	count := 0
	err = fs.WalkDir(root.FS(), ".", func(name string, d fs.DirEntry, discoveryErr error) error {
		if discoveryErr != nil {
			return ErrRead
		}
		if name == "." {
			return nil
		}
		count++
		if count > maxEntries || strings.Count(name, "/") >= maxDepth {
			return ErrLimit
		}
		if hiddenPath(name) || !portablePath(name) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !documentPath(name) && !imagePath(name) {
			return nil
		}
		if !d.Type().IsRegular() {
			if !d.IsDir() {
				all.skipped++
			}
			return nil
		}
		before, err := d.Info()
		if err != nil {
			return ErrRead
		}
		return all.add(entry{name: name, size: uint64(before.Size()), open: func() (io.ReadCloser, error) {
			return openRegular(before, func() (*os.File, error) { return root.Open(filepath.FromSlash(name)) })
		}})
	})
	if err != nil {
		return Bundle{}, err
	}
	return all.read(info.Name())
}

// ReadFile accepts a single document or a saved ZIP export.
func ReadFile(source string) (Bundle, error) {
	filename := filepath.Base(source)
	ext := filepath.Ext(filename)
	if !portablePath(filename) || (!documentPath(filename) && !strings.EqualFold(ext, ".zip")) {
		return Bundle{}, ErrFormat
	}
	info, err := os.Lstat(source)
	if err != nil {
		return Bundle{}, ErrRead
	}
	open := func() (*os.File, error) {
		return openRegular(info, func() (*os.File, error) { return os.Open(source) })
	}
	name := strings.TrimSuffix(filename, ext)
	if strings.EqualFold(ext, ".zip") {
		file, err := open()
		if err != nil {
			return Bundle{}, err
		}
		defer file.Close()
		return readArchive(file, info.Size(), name)
	}
	if !info.Mode().IsRegular() {
		return Bundle{}, ErrFormat
	}
	var all entries
	if err := all.add(entry{name: filename, size: uint64(info.Size()), open: func() (io.ReadCloser, error) {
		return open()
	}}); err != nil {
		return Bundle{}, err
	}
	return all.read(name)
}

func readArchive(file io.ReaderAt, size int64, name string) (Bundle, error) {
	if size > maxArchiveBytes {
		return Bundle{}, ErrLimit
	}
	archive, err := zip.NewReader(file, size)
	if err != nil {
		return Bundle{}, ErrFormat
	}
	if len(archive.File) > maxEntries {
		return Bundle{}, ErrLimit
	}
	var all entries
	seen := make(map[string]archivePath)
	for _, f := range archive.File {
		info := f.FileInfo()
		dir := info.IsDir()
		n := f.Name
		if dir {
			n = strings.TrimSuffix(n, "/")
		}
		if !portablePath(n) {
			return Bundle{}, ErrFormat
		}
		if hiddenPath(n) {
			continue
		}
		if strings.Count(n, "/") >= maxDepth {
			return Bundle{}, ErrLimit
		}
		if !claimArchivePath(seen, n, dir) {
			return Bundle{}, ErrFormat
		}
		if dir || (!documentPath(n) && !imagePath(n)) {
			continue
		}
		if !info.Mode().IsRegular() {
			all.skipped++
			continue
		}
		if err := all.add(entry{name: n, size: f.UncompressedSize64, open: f.Open}); err != nil {
			return Bundle{}, err
		}
	}
	return all.read(name)
}

type archivePath struct {
	name string
	dir  bool
}

// Include implicit directories when detecting case-insensitive selections and
// conflicting paths, even though the archive is never extracted to disk.
func claimArchivePath(seen map[string]archivePath, n string, dir bool) bool {
	for n != "." {
		key := strings.ToLower(n)
		if previous, ok := seen[key]; ok {
			return dir && previous.dir && previous.name == n
		}
		seen[key] = archivePath{name: n, dir: dir}
		n, dir = path.Dir(n), true
	}
	return true
}
