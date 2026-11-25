package syncclient

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"videron/internal/vault"
)

const maxSyncBlob int64 = 1 << 30

// ReadRecord transfers ownership of a record the unlocked working copy has
// authorized for upload. The uploader clears the returned bytes after use.
// An empty kind and id request the main document.
type ReadRecord func(dir, lineage, kind, id string) ([]byte, error)

// PublishFile publishes a synced temporary file atomically without replacement.
// An existing destination is reported by an error matching os.ErrExist.
type PublishFile func(temp, path string) error

// HistoryDir resolves the working copy's record directory, checking each component.
func HistoryDir(dir, lineage, kind string, create bool) (string, error) {
	if !ValidID(lineage) || kind != "objects" && kind != "revisions" {
		return "", vault.ErrInvalid
	}
	path := dir
	for _, name := range []string{".videron-sync", lineage, kind} {
		path = filepath.Join(path, name)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) && create {
			if err = os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return "", err
			}
			info, err = os.Lstat(path)
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", vault.ErrInvalid
		}
	}
	return path, nil
}

func (p *Profile) upload(c *http.Client, route string, raw []byte) error {
	res, err := p.request(c, "PUT", route, bytes.NewReader(raw))
	if err == nil {
		res.Body.Close()
	}
	return err
}

func (p *Profile) download(c *http.Client, route, path, expected string, publish PublishFile) error {
	resp, err := p.request(c, "GET", route, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	tmp, err := os.CreateTemp(filepath.Dir(path), ".videron-download-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, maxSyncBlob+1))
	if err != nil {
		return err
	}
	if n > maxSyncBlob || hex.EncodeToString(h.Sum(nil)) != expected {
		return vault.ErrCorrupt
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return publish(tmp.Name(), path)
}

// Exchange transfers missing immutable records between a working copy and a server snapshot.
// A nil reader is used only when downloading into a newly created staging directory.
func (p *Profile) Exchange(c *http.Client, dir string, m Manifest, read ReadRecord, publish PublishFile) error {
	if m.Lineage != p.Lineage {
		return ErrSpace
	}
	type batch struct {
		kind, parent string
		entries      []os.DirEntry
	}
	// Writers publish a revision only after all of its objects. Snapshot the
	// revision list first so a save during transfer belongs to the next pass.
	var batches []batch
	for _, kind := range []string{"revisions", "objects"} {
		parent, err := HistoryDir(dir, p.Lineage, kind, true)
		if err != nil {
			return err
		}
		entries, err := os.ReadDir(parent)
		if err != nil {
			return err
		}
		batches = append(batches, batch{kind, parent, entries})
	}
	// Transfer the object batch before exposing the captured revisions.
	for i := len(batches) - 1; i >= 0; i-- {
		b := batches[i]
		prefix := ".videron-sync/" + p.Lineage + "/" + b.kind + "/"
		local := make(map[string]bool, len(b.entries))
		for _, entry := range b.entries {
			path := prefix + entry.Name()
			if !validBlobPath(path, p.Lineage) {
				continue
			}
			local[path] = true
			if _, present := m.Files[path]; present {
				continue
			}
			if read == nil {
				return ErrFolder
			}
			raw, err := read(dir, p.Lineage, b.kind, strings.TrimSuffix(entry.Name(), ".json"))
			if err != nil {
				return err
			}
			err = p.upload(c, "/v1/file?path="+url.QueryEscape(path), raw)
			clear(raw)
			if err != nil && !errors.Is(err, ErrChanged) {
				return err
			}
		}
		var missing []string
		for path := range m.Files {
			if strings.HasPrefix(path, prefix) && !local[path] {
				missing = append(missing, path)
			}
		}
		sort.Strings(missing)
		for _, path := range missing {
			err := p.download(c, "/v1/file?path="+url.QueryEscape(path), filepath.Join(b.parent, filepath.Base(path)), m.Files[path], publish)
			if err != nil && !errors.Is(err, os.ErrExist) {
				return err
			}
		}
	}
	return nil
}

// UploadMain creates the initial document without replacing an existing one.
func (p *Profile) UploadMain(c *http.Client, raw []byte) error {
	return p.upload(c, "/v1/main", raw)
}

// DownloadMain verifies the document digest before publishing it to path.
func (p *Profile) DownloadMain(c *http.Client, path, expected string, publish PublishFile) error {
	return p.download(c, "/v1/main", path, expected, publish)
}

// Enroll reconciles the working copy with the selected remote project. If this is
// the first writer, publish its initial document before exchanging the records.
func (p *Profile) Enroll(c *http.Client, dir, lineage string, read ReadRecord, publish PublishFile) (Manifest, error) {
	if !ValidID(lineage) || p.Lineage != "" && p.Lineage != lineage {
		return Manifest{}, ErrSpace
	}
	m, err := p.Manifest(c)
	if err != nil {
		return Manifest{}, err
	}
	if p.Lineage != "" && m.Lineage != p.Lineage {
		return Manifest{}, ErrSpace
	}
	p.Lineage = lineage
	if m.Main == "" {
		raw, err := read(dir, lineage, "", "")
		if err != nil {
			return Manifest{}, err
		}
		err = p.UploadMain(c, raw)
		clear(raw)
		if err != nil && !errors.Is(err, ErrChanged) {
			return Manifest{}, err
		}
		m, err = p.Manifest(c)
		if err != nil {
			return Manifest{}, err
		}
	}
	if err := p.Exchange(c, dir, m, read, publish); err != nil {
		return Manifest{}, err
	}
	return m, nil
}
