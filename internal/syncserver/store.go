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
	"net/url"
	"os"
	"regexp"
	"strconv"
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
	durability  directoryBarrier
	mu          sync.RWMutex
	retirement  error // outcome for requests that acquired this store before deletion
	projectName string
	lineage     string
	main        string
	files       map[string]string // public path -> hash of the actual bytes on this server
	indexJSON   []byte            // immutable snapshot, invalidated on every successful publication
	indexEpoch  string            // new on every open; a restart invalidates client cursors
	paths       []string          // append-only; reuses map keys for stable snapshot pagination
	cursor      string
	changed     chan struct{}
}

const maxIndexPage = 2048

var errIndexChanged = errors.New("index snapshot expired")
var errIndexPage = errors.New("invalid index page")

// Objects may appear before their revision is complete. Track each new path
// independently of the event cursor, which only wakes peers for complete revisions.
func (s *store) addIndexFile(path, hash string) {
	s.files[path] = hash
	s.paths = append(s.paths, path)
}

func (s *store) indexPosition(cursor string) (int, bool) {
	epoch, position, ok := strings.Cut(cursor, ".")
	n, err := strconv.Atoi(position)
	return n, ok && epoch == s.indexEpoch && err == nil && n >= 0 && n <= len(s.paths)
}

func (s *store) indexFiles(start, end int) map[string]string {
	files := make(map[string]string, end-start)
	for _, path := range s.paths[start:end] {
		files[path] = s.files[path]
	}
	return files
}

func (s *store) publicationError() error {
	if s.retirement != nil {
		return s.retirement
	}
	return s.durability.retry(s.root)
}

func (s *store) index(q url.Values) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.publicationError(); err != nil {
		return nil, err
	}
	result := struct {
		Lineage     string            `json:"lineage"`
		Main        string            `json:"main"`
		Files       map[string]string `json:"files"`
		Cursor      string            `json:"cursor"`
		ProjectName string            `json:"projectName"`
		IndexCursor string            `json:"indexCursor"`
		Base        string            `json:"base,omitempty"`
		Summary     bool              `json:"summary,omitempty"`
		PageTotal   int               `json:"pageTotal,omitempty"`
		Offset      int               `json:"offset,omitempty"`
	}{Lineage: s.lineage, Main: s.main, Cursor: s.cursor, ProjectName: s.projectName,
		IndexCursor: s.indexEpoch + "." + strconv.Itoa(len(s.paths)), Files: s.files}
	if q.Get("view") == "summary" {
		result.Summary, result.Files = true, map[string]string{}
		return json.Marshal(result)
	}
	// The first page fixes an immutable prefix of the append-only path list.
	// New PUTs may proceed between pages and remain visible in the next delta.
	end := len(s.paths)
	if snapshot := q.Get("snapshot"); snapshot != "" {
		var ok bool
		if end, ok = s.indexPosition(snapshot); !ok {
			return nil, errIndexChanged
		}
		if !q.Has("limit") {
			return nil, errIndexPage
		}
		result.IndexCursor = snapshot
	}
	begin := 0
	since := q.Get("since")
	if n, ok := s.indexPosition(since); ok && n <= end && (q.Has("limit") || end-n <= maxIndexPage) {
		begin, result.Base = n, since
	}
	if q.Has("limit") {
		limit, err := strconv.Atoi(q.Get("limit"))
		if err != nil || limit < 1 || limit > maxIndexPage {
			return nil, errIndexPage
		}
		offset, total := 0, end-begin
		if q.Has("snapshot") {
			offset, err = strconv.Atoi(q.Get("offset"))
			if err != nil || offset < 1 || offset >= total {
				return nil, errIndexPage
			}
		}
		if offset != 0 || total > limit {
			result.Offset, result.PageTotal = offset, total
			start := begin + offset
			result.Files = s.indexFiles(start, start+min(end-start, limit))
			return json.Marshal(result)
		}
	}
	if result.Base != "" {
		result.Files = s.indexFiles(begin, end)
		return json.Marshal(result)
	}
	if s.indexJSON != nil {
		return s.indexJSON, nil
	}
	data, err := json.Marshal(result)
	if err == nil {
		s.indexJSON = data
	}
	return data, err
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
	if err = syncDirectory(data, "."); err != nil {
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
	entries, err := recoverStorageDirectory(root)
	if err != nil {
		return nil, err
	}
	if err := syncDirectory(root, "."); err != nil {
		return nil, err
	}
	s = &store{root: root, files: make(map[string]string), cursor: rand.Text(), changed: make(chan struct{})}
	s.indexEpoch = s.cursor
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
		s.addIndexFile(".videron-sync/"+s.lineage+"/"+m[1]+"/"+m[2]+".json", hash)
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
