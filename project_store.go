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
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	"videron/internal/syncclient"
	"videron/internal/vault"
)

// Keep the desktop storage errors stable across the Wails bridge.
var (
	errChanged  = syncclient.ErrChanged
	errInvalid  = vault.ErrInvalid
	errCorrupt  = vault.ErrCorrupt
	errLocked   = vault.ErrLocked
	errPassword = vault.ErrPassword
	errWeak     = vault.ErrWeak
	errVersion  = vault.ErrVersion
)

// Read IDs from the same shipped icon packs as the picker. Only a catalog ID,
// never free-form text or SVG supplied by a note, can leave its envelope.
var publicMapIcons = sync.OnceValue(func() map[string]bool {
	icons := make(map[string]bool)
	entry := regexp.MustCompile(`\[\s*"((?:lucide|phosphor)/[a-z0-9-]+)"\s*,`)
	for _, pack := range []string{"vectors", "lucide-extra", "phosphor-extra"} {
		data, _ := files.ReadFile("frontend/icons/" + pack + ".js")
		for _, match := range entry.FindAllSubmatch(data, -1) {
			icons[string(match[1])] = true
		}
	}
	return icons
})

var storedNotes = vault.NewNoteValidator(func(icon string) bool { return publicMapIcons()[icon] })

// storedNote applies the vault's policy when storage decodes a workspace.
type storedNote struct{}

func (*storedNote) UnmarshalJSON(data []byte) error {
	return storedNotes.Validate(data)
}

type libraryHeader struct {
	Vault   string                   `json:"vault"`
	Version int                      `json:"version"`
	Active  string                   `json:"active"`
	Spaces  map[string]*catalogSpace `json:"spaces"`
}

// Folder contents have a separate save path. Reject accidental attempts to
// persist decrypted notes alongside their location, even in an older catalog.
type catalogSpace struct {
	folder bool
}

func (s *catalogSpace) UnmarshalJSON(data []byte) error {
	var header struct {
		Folder json.RawMessage `json:"folder"`
		Notes  []storedNote    `json:"notes"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return err
	}
	s.folder = header.Folder != nil
	if s.folder {
		var link struct {
			Name      string `json:"name"`
			Folder    string `json:"folder"`
			Encrypted bool   `json:"encrypted"`
		}
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&link); err != nil || strings.TrimSpace(link.Name) == "" || strings.TrimSpace(link.Folder) == "" {
			return errInvalid
		}
	}
	return nil
}

func (h libraryHeader) validLibrary() bool {
	if h.Vault != "" || h.Spaces == nil || (h.Active != "" && h.Spaces[h.Active] == nil) {
		return false
	}
	if h.Version == 3 {
		for _, s := range h.Spaces {
			if s == nil {
				return false
			}
		}
		return true
	}
	if (h.Version != 1 && h.Version != 2) || h.Active == "" || h.Spaces["personal"] == nil {
		return false
	}
	for _, s := range h.Spaces {
		if s != nil && s.folder {
			return false
		}
	}
	return true
}

func validWorkspace(data []byte) bool {
	var h libraryHeader
	return utf8.Valid(data) && json.Unmarshal(data, &h) == nil && h.validLibrary()
}

// Read both data and identity through the same open handle.
func readWorkspace() ([]byte, os.FileInfo, error) {
	path, err := workspacePath()
	if err != nil {
		return nil, nil, err
	}
	file, info, err := openSpaceFile(path)
	if errors.Is(err, errSpaceMissing) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, nil, fmt.Errorf("VD_READ|%w", err)
	}
	return data, info, nil
}

func sameFileState(old, now os.FileInfo) bool {
	if old == nil || now == nil {
		return old == nil && now == nil
	}
	return old.Size() == now.Size() && old.ModTime().Equal(now.ModTime()) && os.SameFile(old, now)
}

// Previous releases used this exact os.CreateTemp pattern for atomic saves.
// A process killed mid-save can leave an orphan containing unencrypted data.
// Only clear the application's numeric temporary files in its own storage directory.
func workspaceTemps(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, entry := range entries {
		name := entry.Name()
		suffix, ok := strings.CutPrefix(name, ".workspace-")
		if !ok {
			continue
		}
		digits, ok := strings.CutSuffix(suffix, ".tmp")
		if !ok || digits == "" || strings.Trim(digits, "0123456789") != "" || !entry.Type().IsRegular() {
			continue
		}
		paths = append(paths, filepath.Join(dir, name))
	}
	return paths, nil
}

func cleanWorkspaceTemps(path string, lock bool) error {
	paths, err := workspaceTemps(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("VD_READ|%w", err)
	}
	if len(paths) == 0 {
		return nil
	}
	remove := func() error {
		for _, temp := range paths {
			if err := os.Remove(temp); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("VD_WRITE|%w", err)
			}
		}
		return nil
	}
	if lock {
		// A live writer owns its temporary file until publication.
		if err := withSpaceWriteLock(path, remove); !errors.Is(err, errChanged) {
			return err
		}
		return nil
	}
	return remove()
}

func (a *App) Load() (payload string, loadErr error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	// A failed refresh must not leave a previous folder or note session usable
	// after a later successful load of a different catalog.
	defer func() {
		if loadErr != nil {
			a.loaded = false
			a.dropKeys()
		}
	}()
	data, info, err := readWorkspace()
	if err != nil {
		return "", err
	}
	if info == nil && a.disk != nil {
		return "", errChanged
	}
	digest := sha256.Sum256(data)
	if a.loaded && (!sameFileState(a.disk, info) || a.diskDigest != digest) {
		// Drop a prior session when an external backup or sync replaced its data.
		a.dropKeys()
	}
	a.loaded = false
	a.disk = info
	a.diskDigest = digest
	if info == nil {
		a.dropKeys()
		a.protected = false
		a.loaded = true
		return "", nil
	}
	var h libraryHeader
	if !utf8.Valid(data) || json.Unmarshal(data, &h) != nil {
		return "", errCorrupt
	}
	a.protected = h.Vault == vault.ProjectScope
	if h.Vault != "" {
		env, err := vault.ParseEnvelope(data, vault.ProjectScope)
		if err != nil {
			return "", err
		}
		// Removing a password stages plaintext before replacing the envelope.
		// Recover leftovers from an interrupted write even at the password prompt.
		path, err := workspacePath()
		if err != nil {
			return "", err
		}
		if err = cleanWorkspaceTemps(path, true); err != nil {
			return "", err
		}
		if a.projectKey == nil || !a.projectKey.MatchesSalt(env.Salt) {
			return "", errLocked
		}
		plain, err := a.projectKey.Open(env, "")
		if err != nil {
			return "", err
		}
		defer clear(plain)
		if !validWorkspace(plain) {
			return "", errCorrupt
		}
		a.loaded = true
		return string(plain), nil
	}
	if !h.validLibrary() {
		return "", errCorrupt
	}
	a.projectKey.Forget()
	a.projectKey = nil
	a.loaded = true
	return string(data), nil
}

func (a *App) IsProjectProtected() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.protected
}

func (a *App) UnlockProject(password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	data, info, err := readWorkspace()
	if err != nil {
		return "", err
	}
	env, err := vault.ParseEnvelope(data, vault.ProjectScope)
	if err != nil {
		return "", err
	}
	key := vault.DeriveKey(password, env.Salt)
	plain, err := key.Open(env, "")
	if err != nil {
		key.Forget()
		return "", err
	}
	defer clear(plain)
	if !validWorkspace(plain) {
		key.Forget()
		return "", errCorrupt
	}
	a.dropKeys()
	a.projectKey = key
	a.disk = info
	a.diskDigest = sha256.Sum256(data)
	a.loaded = true
	a.protected = true
	return string(plain), nil
}

func (a *App) LockProject() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.protected {
		return errInvalid
	}
	a.dropKeys()
	a.loaded = false
	return nil
}

// Called after the editor and storage queue have committed. Keep the resume
// target and session undo checkpoints in memory and revoke their unlock keys.
func (a *App) LockSession(noteID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.dropKeys()
	a.loaded = false
	a.resumeNote = noteID
}

func (a *App) TakeResumeNote() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return ""
	}
	id := a.resumeNote
	a.resumeNote = ""
	return id
}

// Metadata alone misses an in-place edit when a backup/sync tool preserves
// size and modification time. Read through the checked handle; stream the old
// bytes so saving a library with large attachments needs no extra full copy.
func (a *App) verifyCatalog(path string) error {
	file, info, err := openSpaceFile(path)
	if errors.Is(err, errSpaceMissing) {
		if a.disk == nil {
			return nil
		}
		return errChanged
	}
	if err != nil {
		return err
	}
	defer file.Close()
	if !sameFileState(a.disk, info) {
		return errChanged
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return fmt.Errorf("VD_READ|%w", err)
	}
	if !bytes.Equal(a.diskDigest[:], digest.Sum(nil)) {
		return errChanged
	}
	return nil
}

// All saves and policy changes share the mutex and the same atomic replacement.
// A new key or plaintext policy is committed only after the file is replaced.
func (a *App) writeSnapshot(payload string, key *vault.Key) error {
	if !a.loaded {
		return errLocked
	}
	data := []byte(payload)
	defer clear(data)
	if !validWorkspace(data) {
		return errInvalid
	}
	if err := a.writeCatalogBytes(data, key); err != nil {
		return err
	}
	a.clearCatalogIndex()
	return nil
}

func (a *App) writeCatalogBytes(data []byte, key *vault.Key) error {
	path, err := workspacePath()
	if err != nil {
		return err
	}
	if key != nil {
		data, err = key.Seal(vault.ProjectScope, "", data)
		if err != nil {
			return err
		}
	}
	dir := filepath.Dir(path)
	write := func() error {
		if err := a.verifyCatalog(path); err != nil {
			return err
		}
		if err := cleanWorkspaceTemps(path, false); err != nil {
			return err
		}
		publish := os.Rename
		if a.disk == nil {
			publish = publishNewSpaceFile
		}
		written, err := writeAtomicInDir(path, data, ".workspace-*.tmp", publish)
		if errors.Is(err, os.ErrExist) {
			return errChanged
		}
		if err != nil {
			return fmt.Errorf("VD_WRITE|%w", err)
		}
		a.disk = written
		a.diskDigest = sha256.Sum256(data)
		return nil
	}
	if a.disk != nil {
		return withSpaceWriteLock(path, write)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	return write()
}

func (a *App) Save(payload string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.writeSnapshot(payload, a.projectKey)
}

func (a *App) projectPassword(payload, password string) error {
	key, err := vault.NewKey(password)
	if err != nil {
		return err
	}
	if err := a.writeSnapshot(payload, key); err != nil {
		key.Forget()
		return err
	}
	a.projectKey.Forget()
	a.projectKey = key
	a.protected = true
	return nil
}

func (a *App) ProtectProject(payload, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return errLocked
	}
	if a.protected {
		return errInvalid
	}
	return a.projectPassword(payload, password)
}

func (a *App) ChangeProjectPassword(payload, currentPassword, newPassword string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded || a.projectKey == nil {
		return errLocked
	}
	if !a.projectKey.Verify(currentPassword) {
		return errPassword
	}
	return a.projectPassword(payload, newPassword)
}

func (a *App) RemoveProjectPassword(payload, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded || a.projectKey == nil {
		return errLocked
	}
	if !a.projectKey.Verify(password) {
		return errPassword
	}
	if err := a.writeSnapshot(payload, nil); err != nil {
		return err
	}
	a.projectKey.Forget()
	a.projectKey = nil
	a.protected = false
	return nil
}
