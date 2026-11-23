package main

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
)

const folderSpaceFilename = "Videron.space"
const folderSpaceFormat = "videron.space"

var errSpaceMissing = errors.New("VD_SPACE_MISSING")
var errSpaceExists = errors.New("VD_SPACE_EXISTS")

type SpaceFolderInfo struct {
	Folder    string `json:"folder"`
	Exists    bool   `json:"exists"`
	Encrypted bool   `json:"encrypted"`
	CanResume bool   `json:"canResume"`
}

type folderSpaceSession struct {
	path                string
	info                os.FileInfo
	digest              [sha256.Size]byte
	key                 *vaultKey
	discardKeyOnSuspend bool
	sync                spaceReplica
	lastPatch           savePatchReceipt
	serverIndex         *serverIndexCache
}

type folderSpaceDocument struct {
	Format  string          `json:"format"`
	Version int             `json:"version"`
	Space   json.RawMessage `json:"space"`
}

func validSpacePayload(data []byte) bool {
	var shape struct {
		Name   string          `json:"name"`
		Notes  []storedNote    `json:"notes"`
		Areas  []struct{}      `json:"areas"`
		Folder json.RawMessage `json:"folder"`
	}
	return utf8.Valid(data) && json.Unmarshal(data, &shape) == nil && strings.TrimSpace(shape.Name) != "" && utf8.RuneCountInString(shape.Name) <= 80 && shape.Notes != nil && shape.Areas != nil && shape.Folder == nil
}

func spaceDir(folder string) (string, error) {
	dir, err := existingFolder(folder)
	if err != nil {
		return "", err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return "", errFolderAccess
	}
	return dir, nil
}

func spaceSessionID(folder string) string {
	path := filepath.Clean(folder)
	if runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}

func openSpaceFile(path string) (*os.File, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, errSpaceMissing
	}
	if err != nil {
		return nil, nil, fmt.Errorf("VD_READ|%w", err)
	}
	if !supportedSpaceFile(path, info) {
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

func readSpaceFile(path string) ([]byte, os.FileInfo, error) {
	file, info, err := openSpaceFile(path)
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
func parseSpaceFile(raw []byte) (json.RawMessage, *envelope, error) {
	var header struct {
		Vault string `json:"vault"`
	}
	if !utf8.Valid(raw) || json.Unmarshal(raw, &header) != nil {
		return nil, nil, errCorrupt
	}
	if header.Vault != "" {
		env, err := parseEnvelope(raw, folderSpaceFormat)
		return nil, env, err
	}
	var doc folderSpaceDocument
	if json.Unmarshal(raw, &doc) != nil || doc.Format != folderSpaceFormat {
		return nil, nil, errCorrupt
	}
	if doc.Version != 1 {
		return nil, nil, errVersion
	}
	if !validSpacePayload(doc.Space) {
		return nil, nil, errCorrupt
	}
	return doc.Space, nil, nil
}

func (a *App) InspectSpaceFolder(folder string) (SpaceFolderInfo, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var result SpaceFolderInfo
	if !a.loaded {
		return result, errLocked
	}
	dir, err := spaceDir(folder)
	if err != nil {
		a.forgetSuspendedFolder(spaceSessionID(folder))
		return result, err
	}
	result.Folder = dir
	id := spaceSessionID(dir)
	raw, _, err := readSpaceFile(filepath.Join(dir, folderSpaceFilename))
	if err != nil {
		a.forgetSuspendedFolder(id)
		if errors.Is(err, errSpaceMissing) {
			return result, nil
		}
		return result, err
	}
	defer clear(raw)
	_, env, err := parseSpaceFile(raw)
	if err != nil {
		a.forgetSuspendedFolder(id)
		return result, err
	}
	result.Exists = true
	result.Encrypted = env != nil
	if key := a.suspendedFolderKeys[id]; key != nil {
		result.CanResume = env != nil && bytes.Equal(env.Salt, key.salt)
		if !result.CanResume {
			a.forgetSuspendedFolder(id)
		}
	}
	return result, nil
}

func (a *App) setSpaceSession(dir string, session *folderSpaceSession) {
	if a.folderSpaces == nil {
		a.folderSpaces = make(map[string]*folderSpaceSession)
	}
	id := spaceSessionID(dir)
	a.forgetSuspendedFolder(id)
	if old := a.folderSpaces[id]; old != nil {
		old.key.forget()
	}
	a.folderSpaces[id] = session
}

func (a *App) OpenFolderSpace(folder, password string) (string, error) {
	return a.openFolderSpace(folder, password, false)
}

func (a *App) ResumeFolderSpace(folder string) (string, error) {
	return a.openFolderSpace(folder, "", true)
}

func (a *App) openFolderSpace(folder, password string, resume bool) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded || (resume && a.revokingFolderKeys.Load()) {
		return "", errLocked
	}
	dir, err := spaceDir(folder)
	if err != nil {
		a.forgetSuspendedFolder(spaceSessionID(folder))
		return "", err
	}
	id := spaceSessionID(dir)
	var key *vaultKey
	if resume {
		key = a.suspendedFolderKeys[id]
		if key == nil {
			return "", errLocked
		}
		delete(a.suspendedFolderKeys, id)
	} else {
		a.forgetSuspendedFolder(id)
	}
	// Transfer ownership to the active session only after today's document
	// and replica have both been authenticated and read successfully.
	defer func() { key.forget() }()
	path := filepath.Join(dir, folderSpaceFilename)
	raw, info, err := readSpaceFile(path)
	if err != nil {
		return "", err
	}
	defer clear(raw)
	plain, env, err := parseSpaceFile(raw)
	if err != nil {
		return "", err
	}
	// The caller expects an encrypted file. A cloud writer may have
	// replaced it since inspection; never continue in plaintext.
	if env == nil && (password != "" || resume) {
		return "", errChanged
	}
	if env != nil {
		switch {
		case resume:
			if !bytes.Equal(key.salt, env.Salt) {
				return "", errLocked
			}
		case password == "":
			return "", errLocked
		default:
			key = deriveVaultKey(password, env.Salt)
		}
		plain, err = key.open(env, "")
		if err != nil {
			return "", err
		}
		defer clear(plain)
		if !validSpacePayload(plain) {
			return "", errCorrupt
		}
	}
	session := &folderSpaceSession{path: path, info: info, digest: sha256.Sum256(raw), key: key}
	payload, err := session.openReplica(plain)
	if err != nil {
		return "", err
	}
	if resume && a.revokingFolderKeys.Load() {
		return "", errLocked
	}
	a.setSpaceSession(dir, session)
	key = nil
	return payload, nil
}

func encodeSpace(payload string, key *vaultKey) ([]byte, error) {
	data := []byte(payload)
	defer clear(data)
	if !validSpacePayload(data) {
		return nil, errInvalid
	}
	if key != nil {
		return key.seal(folderSpaceFormat, "", data)
	}
	return json.Marshal(folderSpaceDocument{Format: folderSpaceFormat, Version: 1, Space: data})
}

func (a *App) CreateFolderSpace(folder, payload, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return errLocked
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, folderSpaceFilename)
	if _, err = os.Lstat(path); err == nil {
		return errSpaceExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("VD_READ|%w", err)
	}
	var key *vaultKey
	if password != "" {
		key, err = newVaultKey(password)
		if err != nil {
			return err
		}
	}
	session := &folderSpaceSession{path: path, key: key}
	lineage, err := newLineage()
	if err != nil {
		key.forget()
		return err
	}
	session.sync.meta.Lineage = lineage
	session.sync.payload = payload
	data, err := encodeTrackedSpace(payload, session.sync.meta, key)
	if err != nil {
		key.forget()
		return err
	}
	defer clear(data)
	info, err := writeAtomicInDir(path, data, ".videron-space-*.tmp", publishNewSpaceFile)
	if err != nil {
		key.forget()
		if errors.Is(err, os.ErrExist) {
			return errSpaceExists
		}
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	session.info, session.digest = info, sha256.Sum256(data)
	a.setSpaceSession(dir, session)
	return nil
}

func (a *App) currentSpaceSession(folder string) (*folderSpaceSession, error) {
	if !a.loaded {
		return nil, errLocked
	}
	dir, err := spaceDir(folder)
	if err != nil {
		return nil, err
	}
	session := a.folderSpaces[spaceSessionID(dir)]
	if session == nil {
		return nil, errLocked
	}
	return session, nil
}

// Cloud clients may change the bytes in place with preserved timestamps,
// or replace the file altogether. Check both identity and content.
func (s *folderSpaceSession) verifyFile(file *os.File, info os.FileInfo) error {
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

func (s *folderSpaceSession) verifyCurrent() error {
	f, info, err := openSpaceFile(s.path)
	if errors.Is(err, errSpaceMissing) || errors.Is(err, errInvalid) {
		return errChanged
	}
	if err != nil {
		return err
	}
	defer f.Close()
	return s.verifyFile(f, info)
}

// Serialize compare-and-replace for other Videron writers on the same volume.
func (s *folderSpaceSession) publishEdit(temp, path string) error {
	return withSpaceWriteLock(path, func() error {
		if err := s.verifyCurrent(); err != nil {
			return err
		}
		return os.Rename(temp, path)
	})
}

func (a *App) SaveFolderSpace(folder, payload string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	session, err := a.currentSpaceSession(folder)
	if err != nil {
		return err
	}
	// Keep the original compare-and-replace contract for existing callers.
	// Once version history is initialized the write must also extend that graph.
	if session.sync.initialized {
		return session.commitBranch("", payload, true)
	}
	meta := spaceSyncMeta{Lineage: session.sync.meta.Lineage}
	data, err := encodeTrackedSpace(payload, meta, session.key)
	if err != nil {
		return err
	}
	defer clear(data)
	info, err := writeAtomicInDir(session.path, data, ".videron-space-*.tmp", session.publishEdit)
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

func (a *App) folderKeyID(folder string) string {
	// The canonical path returned by InspectSpaceFolder also works offline.
	id := spaceSessionID(folder)
	if a.folderSpaces[id] == nil && a.suspendedFolderKeys[id] == nil {
		if dir, err := spaceDir(folder); err == nil {
			id = spaceSessionID(dir)
		}
	}
	return id
}

func (a *App) forgetSuspendedFolder(id string) {
	a.suspendedFolderKeys[id].forget()
	delete(a.suspendedFolderKeys, id)
}

func (a *App) forgetSuspendedFolderKeys() {
	for id := range a.suspendedFolderKeys {
		a.forgetSuspendedFolder(id)
	}
}

func (a *App) ForgetSuspendedFolderKeys() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.forgetSuspendedFolderKeys()
	// A pending save still needs its live key. A concurrent workspace
	// switch may finish after the lock event; never cache that key again.
	for _, s := range a.folderSpaces {
		s.discardKeyOnSuspend = true
	}
}

// Keep only the derived key. Closed spaces cannot be edited or synced through
// their old session; returning to one reopens the file from disk.
func (a *App) SuspendFolderSpace(folder string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := a.folderKeyID(folder)
	session := a.folderSpaces[id]
	if session == nil {
		return a.suspendedFolderKeys[id] != nil
	}
	delete(a.folderSpaces, id)
	if session.key == nil || session.discardKeyOnSuspend || a.revokingFolderKeys.Load() {
		session.key.forget()
		return false
	}
	if a.suspendedFolderKeys == nil {
		a.suspendedFolderKeys = make(map[string]*vaultKey)
	}
	a.suspendedFolderKeys[id] = &vaultKey{salt: session.key.salt, key: bytes.Clone(session.key.key)}
	session.key.forget()
	return true
}

func (a *App) CloseFolderSpace(folder string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := a.folderKeyID(folder)
	a.forgetSuspendedFolder(id)
	if session := a.folderSpaces[id]; session != nil {
		session.key.forget()
		delete(a.folderSpaces, id)
	}
}

func (a *App) DeleteFolderSpace(folder string) error {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	session, err := a.currentSpaceSession(folder)
	if err != nil {
		return err
	}
	if err = withSpaceWriteLock(session.path, func() error {
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
	session.key.forget()
	id := spaceSessionID(filepath.Dir(session.path))
	a.forgetSuspendedFolder(id)
	delete(a.folderSpaces, id)
	if path, e := profilePath(filepath.Dir(session.path)); e == nil {
		// The document is already deleted. A credentials cleanup failure cannot roll back the file deletion.
		_ = os.Remove(path)
	}
	return nil
}
