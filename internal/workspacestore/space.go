package workspacestore

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"

	"videron/internal/syncclient"
	"videron/internal/vault"
)

const Filename = "Videron.space"
const Format = "videron.space"

var (
	ErrMissing  = syncclient.ErrSpaceMissing
	ErrExists   = errors.New("VD_SPACE_EXISTS")
	errChanged  = syncclient.ErrChanged
	errInvalid  = vault.ErrInvalid
	errCorrupt  = vault.ErrCorrupt
	errLocked   = vault.ErrLocked
	errPassword = vault.ErrPassword
	errVersion  = vault.ErrVersion
)

// Store applies one note policy to full documents and to individual revisions.
type Store struct {
	validPayload func([]byte) bool
	validateNote func([]byte) error
}

// New uses the same JSON note type as the local catalog. Decoding its slice
// validates each note in place, including large notes and repeated "notes" fields.
func New[Note any, Decoder interface {
	*Note
	json.Unmarshaler
}]() *Store {
	return &Store{
		validPayload: validPayload[Note],
		validateNote: func(raw []byte) error { return Decoder(new(Note)).UnmarshalJSON(raw) },
	}
}

// Session keeps the open document, its key and its revision cursor. Callers
// serialize operations on a session, including those that refresh its history.
type Session struct {
	store     *Store
	path      string
	info      os.FileInfo
	digest    [sha256.Size]byte
	key       *vault.Key
	sync      spaceReplica
	lastPatch savePatchReceipt
}

func (s *Session) Path() string    { return s.path }
func (s *Session) Key() *vault.Key { return s.key }

type SpaceFolderInfo struct {
	Folder    string `json:"folder"`
	Exists    bool   `json:"exists"`
	Encrypted bool   `json:"encrypted"`
	CanResume bool   `json:"canResume"`
}

type folderSpaceDocument struct {
	Format  string          `json:"format"`
	Version int             `json:"version"`
	Space   json.RawMessage `json:"space"`
}

func (store *Store) ValidPayload(data []byte) bool { return store.validPayload(data) }

func validPayload[Note any](data []byte) bool {
	var shape struct {
		Name   string          `json:"name"`
		Notes  []Note          `json:"notes"`
		Areas  []struct{}      `json:"areas"`
		Folder json.RawMessage `json:"folder"`
	}
	return utf8.Valid(data) && json.Unmarshal(data, &shape) == nil && strings.TrimSpace(shape.Name) != "" && utf8.RuneCountInString(shape.Name) <= 80 && shape.Notes != nil && shape.Areas != nil && shape.Folder == nil
}

func SessionID(folder string) string {
	path := filepath.Clean(folder)
	if runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}

func OpenFile(path string) (*os.File, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, ErrMissing
	}
	if err != nil {
		return nil, nil, fmt.Errorf("VD_READ|%w", err)
	}
	if !SupportedFile(path, info) {
		return nil, nil, errInvalid
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, fmt.Errorf("VD_READ|%w", err)
	}
	opened, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, fmt.Errorf("VD_READ|%w", err)
	}
	if !os.SameFile(info, opened) {
		file.Close()
		return nil, nil, errChanged
	}
	return file, opened, nil
}

func ReadFile(path string) ([]byte, os.FileInfo, error) {
	file, info, err := OpenFile(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(file)
	if err != nil {
		return nil, nil, fmt.Errorf("VD_READ|%w", err)
	}
	return raw, info, nil
}

// File location is intentionally absent from the authenticated data: an
// encrypted space must remain portable between folders, machines and OSes.
func (store *Store) ParseFile(raw []byte) (json.RawMessage, *vault.Envelope, error) {
	var header struct {
		Vault string `json:"vault"`
	}
	if !utf8.Valid(raw) || json.Unmarshal(raw, &header) != nil {
		return nil, nil, errCorrupt
	}
	if header.Vault != "" {
		env, err := vault.ParseEnvelope(raw, Format)
		return nil, env, err
	}
	var doc folderSpaceDocument
	if json.Unmarshal(raw, &doc) != nil || doc.Format != Format {
		return nil, nil, errCorrupt
	}
	if doc.Version != 1 {
		return nil, nil, errVersion
	}
	if !store.ValidPayload(doc.Space) {
		return nil, nil, errCorrupt
	}
	return doc.Space, nil, nil
}

// Inspect reads the main file without opening its history or deriving a key.
func (store *Store) Inspect(dir string, key *vault.Key) (SpaceFolderInfo, error) {
	result := SpaceFolderInfo{Folder: dir}
	raw, _, err := ReadFile(filepath.Join(dir, Filename))
	if errors.Is(err, ErrMissing) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	defer clear(raw)
	_, env, err := store.ParseFile(raw)
	if err != nil {
		return result, err
	}
	result.Exists = true
	result.Encrypted = env != nil
	result.CanResume = env != nil && key != nil && key.MatchesSalt(env.Salt)
	return result, nil
}

// Open takes ownership of resumeKey. An unsuccessful open forgets it.
// The directory is the canonical path used by the device's revision cursor.
func (store *Store) Open(dir, password string, resumeKey *vault.Key) (*Session, string, error) {
	key := resumeKey
	resume := key != nil
	// Transfer ownership to the active session only after today's document
	// and replica have both been authenticated and read successfully.
	defer func() { key.Forget() }()
	path := filepath.Join(dir, Filename)
	raw, info, err := ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	defer clear(raw)
	plain, env, err := store.ParseFile(raw)
	if err != nil {
		return nil, "", err
	}
	// The caller expects an encrypted file. A cloud writer may have
	// replaced it since inspection; never continue in plaintext.
	if env == nil && (password != "" || resume) {
		return nil, "", errChanged
	}
	if env != nil {
		switch {
		case resume:
			if !key.MatchesSalt(env.Salt) {
				return nil, "", errLocked
			}
		case password == "":
			return nil, "", errLocked
		default:
			key = vault.DeriveKey(password, env.Salt)
		}
		plain, err = key.Open(env, "")
		if err != nil {
			return nil, "", err
		}
		defer clear(plain)
		if !store.ValidPayload(plain) {
			return nil, "", errCorrupt
		}
	}
	session := &Session{store: store, path: path, info: info, digest: sha256.Sum256(raw), key: key}
	payload, err := session.openReplica(plain)
	if err != nil {
		return nil, "", err
	}

	key = nil
	return session, payload, nil
}

func (store *Store) EncodeSpace(payload string, key *vault.Key) ([]byte, error) {
	data := []byte(payload)
	defer clear(data)
	if !store.ValidPayload(data) {
		return nil, errInvalid
	}
	if key != nil {
		return key.Seal(Format, "", data)
	}
	return json.Marshal(folderSpaceDocument{Format: Format, Version: 1, Space: data})
}

func (store *Store) Create(dir, payload, password string) (*Session, error) {
	path := filepath.Join(dir, Filename)
	if _, err := os.Lstat(path); err == nil {
		return nil, ErrExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("VD_READ|%w", err)
	}
	var key *vault.Key
	var err error
	if password != "" {
		key, err = vault.NewKey(password)
		if err != nil {
			return nil, err
		}
	}
	session := &Session{store: store, path: path, key: key}
	lineage, err := newLineage()
	if err != nil {
		key.Forget()
		return nil, err
	}
	session.sync.meta.Lineage = lineage
	session.sync.payload = payload
	data, err := store.encodeTrackedSpace(payload, session.sync.meta, key)
	if err != nil {
		key.Forget()
		return nil, err
	}
	defer clear(data)
	info, err := WriteAtomicInDir(path, data, ".videron-space-*.tmp", PublishNewFile)
	if err != nil {
		key.Forget()
		if errors.Is(err, os.ErrExist) {
			return nil, ErrExists
		}
		return nil, fmt.Errorf("VD_WRITE|%w", err)
	}
	session.info, session.digest = info, sha256.Sum256(data)
	return session, nil
}

// Cloud clients may change the bytes in place with preserved timestamps,
// or replace the file altogether. Check both identity and content.
func (s *Session) verifyFile(file *os.File, info os.FileInfo) error {
	if !os.SameFile(s.info, info) || s.info.Size() != info.Size() {
		return errChanged
	}
	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return fmt.Errorf("VD_READ|%w", err)
	}
	if !bytes.Equal(h.Sum(nil), s.digest[:]) {
		return errChanged
	}
	return nil
}

func (s *Session) verifyCurrent() error {
	f, info, err := OpenFile(s.path)
	if errors.Is(err, ErrMissing) || errors.Is(err, errInvalid) {
		return errChanged
	}
	if err != nil {
		return err
	}
	defer f.Close()
	return s.verifyFile(f, info)
}

// Serialize compare-and-replace for other Videron writers on the same volume.
func (s *Session) publishEdit(temp, path string) error {
	return WithWriteLock(path, func() error {
		if err := s.verifyCurrent(); err != nil {
			return err
		}
		return os.Rename(temp, path)
	})
}

func (session *Session) Save(payload string) error {
	// Keep the original compare-and-replace contract for existing callers.
	// Once version history is initialized the write must also extend that graph.
	if session.sync.initialized {
		return session.commitBranch("", payload, true)
	}
	meta := spaceSyncMeta{Lineage: session.sync.meta.Lineage}
	data, err := session.store.encodeTrackedSpace(payload, meta, session.key)
	if err != nil {
		return err
	}
	defer clear(data)
	info, err := WriteAtomicInDir(session.path, data, ".videron-space-*.tmp", session.publishEdit)
	if err != nil {
		if errors.Is(err, errChanged) {
			return err
		}
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	session.info, session.digest = info, sha256.Sum256(data)
	session.sync = spaceReplica{payload: payload, meta: meta}
	return nil
}

func (session *Session) Delete() error {
	if err := WithWriteLock(session.path, func() error {
		if err := session.verifyCurrent(); err != nil {
			return err
		}
		if _, statErr := os.Lstat(session.graphPath()); statErr == nil {
			// The cloud may have delivered a branch while the app was closed.
			// Deletion has to see the same history as the first sync poll.
			if err := session.initReplica(); err != nil {
				return err
			}
			if err := session.importMain(true); err != nil {
				return err
			}
			if err := session.scan(true); err != nil {
				return err
			}
			tip, _, err := session.candidate()
			if err != nil {
				return err
			}
			if tip != "" {
				return errChanged
			}
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return statErr
		}
		// Keep the usable main document until all of its archived data can
		// be removed. Failed cleanup can be retried from the same open space.
		if err := session.deleteReplica(); err != nil {
			return err
		}
		return deleteSpaceFile(session)
	}); err != nil {
		session.sync.initialized = false
		session.sync.verifiedObjects = nil
		return err
	}
	session.key.Forget()
	return nil
}

func SameFileState(old, now os.FileInfo) bool {
	if old == nil || now == nil {
		return old == nil && now == nil
	}
	return old.Size() == now.Size() && old.ModTime().Equal(now.ModTime()) && os.SameFile(old, now)
}
