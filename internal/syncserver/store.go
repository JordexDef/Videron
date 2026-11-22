package syncserver

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"strings"
	"sync"
)

var (
	hexID    = regexp.MustCompile("^[a-f0-9]{64}$")
	apiBlob  = regexp.MustCompile("^\\.videron-sync/([a-f0-9]{64})/(revisions|objects)/([a-f0-9]{64})\\.json$")
	diskBlob = regexp.MustCompile("^(revisions|objects)-([a-f0-9]{64})\\.json$")
)

type store struct {
	root        *os.Root
	mu          sync.RWMutex
	gone        bool
	projectName string
	lineage     string
	main        string
	files       map[string]string // public path -> hash of the actual bytes on this server
	indexJSON   []byte            // immutable snapshot, invalidated on every successful publication
	cursor      string
	changed     chan struct{}
}

func (s *store) index() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gone {
		return nil, errProjectGone
	}
	if s.indexJSON == nil {
		data, err := json.Marshal(struct {
			Lineage     string            `json:"lineage"`
			Main        string            `json:"main"`
			Files       map[string]string `json:"files"`
			Cursor      string            `json:"cursor"`
			ProjectName string            `json:"projectName"`
		}{s.lineage, s.main, s.files, s.cursor, s.projectName})
		if err != nil {
			return nil, err
		}
		s.indexJSON = data
	}
	return s.indexJSON, nil
}

func regularFile(root *os.Root, name string) (*os.File, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("unexpected file type: %s", name)
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	opened, err := f.Stat()
	if err == nil && !os.SameFile(info, opened) {
		err = errors.New("file changed while opening")
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func fileHash(root *os.Root, name string) (string, error) {
	f, err := regularFile(root, name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func openStore(data *os.Root) (s *store, err error) {
	if err = data.Mkdir("space", 0700); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	return openStoreDirectory(data, "space")
}

func openStoreDirectory(parent *os.Root, dir string) (s *store, err error) {
	info, err := parent.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("invalid space directory")
	}
	root, err := parent.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			root.Close()
		}
	}()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil, err
	}
	s = &store{root: root, files: make(map[string]string), cursor: rand.Text(), changed: make(chan struct{})}
	// The filename publishes the bound lineage and its bootstrap payload together.
	for _, entry := range entries {
		if id, found := strings.CutPrefix(entry.Name(), "main-"); found {
			if !hexID.MatchString(id) || s.lineage != "" {
				return nil, errors.New("invalid or ambiguous space bootstrap")
			}
			s.lineage = id
			if s.main, err = fileHash(root, entry.Name()); err != nil {
				return nil, err
			}
		}
	}
	for _, entry := range entries {
		m := diskBlob.FindStringSubmatch(entry.Name())
		if m == nil {
			continue
		}
		if s.lineage == "" {
			return nil, errors.New("space bootstrap is missing")
		}
		hash, err := fileHash(root, entry.Name())
		if err != nil {
			return nil, err
		}
		s.files[".videron-sync/"+s.lineage+"/"+m[1]+"/"+m[2]+".json"] = hash
	}
	return s, nil
}

// Call with mu held after publishing a revision. Its objects have already
// been published. Rotating both values under the index lock avoids lost wakes.
func (s *store) announce() {
	s.cursor = rand.Text()
	close(s.changed)
	s.changed = make(chan struct{})
}

// A temporary file in the destination directory can be renamed atomically.
// Never buffer an entire space or attachment just to hash it.
func stageFile(root *os.Root, source io.Reader) (name, digest string, err error) {
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return "", "", err
	}
	name = ".upload-" + hex.EncodeToString(nonce[:])
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", "", err
	}
	hash := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, hash), source)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		root.Remove(name)
		return "", "", err
	}
	return name, hex.EncodeToString(hash.Sum(nil)), nil
}
