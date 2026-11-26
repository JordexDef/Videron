package workspacestore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"videron/internal/vault"
)

type libraryHeader[S interface{ isFolder() bool }] struct {
	Vault   string        `json:"vault"`
	Version int           `json:"version"`
	Active  string        `json:"active"`
	Spaces  map[string]*S `json:"spaces"`
}

// Folder contents have a separate save path. Reject accidental attempts to
// persist decrypted notes alongside their location, even in an older catalog.
type catalogSpace struct {
	folder bool
}

func (s catalogSpace) isFolder() bool { return s.folder }

type decodedCatalogSpace[Note any] struct{ catalogSpace }

func (s *decodedCatalogSpace[Note]) UnmarshalJSON(data []byte) error {
	var header struct {
		Folder json.RawMessage `json:"folder"`
		Notes  []Note          `json:"notes"`
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

func (h libraryHeader[S]) validLibrary() bool {
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
		if s != nil && (*s).isFolder() {
			return false
		}
	}
	return true
}

type catalogInspection struct {
	vault string
	valid bool
}

func inspectCatalog[Note any](data []byte) (catalogInspection, error) {
	var h libraryHeader[decodedCatalogSpace[Note]]
	if !utf8.Valid(data) || json.Unmarshal(data, &h) != nil {
		return catalogInspection{}, errCorrupt
	}
	return catalogInspection{vault: h.Vault, valid: h.validLibrary()}, nil
}

func (store *Store) ValidCatalog(data []byte) bool {
	h, err := store.inspectCatalog(data)
	return err == nil && h.valid
}

// Catalog tracks the local workspace file and the index of the last committed
// patch. The zero value represents an unopened catalog. Callers serialize its use.
type Catalog struct {
	disk       os.FileInfo
	diskDigest [sha256.Size]byte
	protected  bool
	index      *indexedCatalog
	lastPatch  savePatchReceipt
}

func (c *Catalog) Protected() bool { return c.protected }

func (c *Catalog) Revision() string {
	if c.disk == nil {
		return ""
	}
	return hex.EncodeToString(c.diskDigest[:])
}

// Load checks whether an active file was replaced before using a retained key.
// The caller revokes other grants tied to the replaced catalog in invalidate.
func (c *Catalog) Load(store *Store, key *vault.Key, active bool, invalidate func()) (string, error) {
	data, info, err := readCatalog()
	if err != nil {
		return "", err
	}
	if info == nil && c.disk != nil {
		return "", errChanged
	}
	digest := sha256.Sum256(data)
	if !SameFileState(c.disk, info) || c.diskDigest != digest {
		c.ClearIndex()
		if active {
			invalidate()
			key = nil
		}
	}
	c.disk, c.diskDigest = info, digest
	if info == nil {
		invalidate()
		c.protected = false
		return "", nil
	}
	h, err := store.inspectCatalog(data)
	if err != nil {
		return "", err
	}
	c.protected = h.vault == vault.ProjectScope
	if h.vault != "" {
		env, err := vault.ParseEnvelope(data, vault.ProjectScope)
		if err != nil {
			return "", err
		}
		// Recover plaintext staging files from an interrupted password removal.
		path, err := CatalogPath()
		if err != nil {
			return "", err
		}
		if err = cleanWorkspaceTemps(path, true); err != nil {
			return "", err
		}
		if key == nil || !key.MatchesSalt(env.Salt) {
			return "", errLocked
		}
		return openCatalogPayload(store, key, env)
	}
	if !h.valid {
		return "", errCorrupt
	}
	return string(data), nil
}

func openCatalogPayload(store *Store, key *vault.Key, env *vault.Envelope) (string, error) {
	plain, err := key.Open(env, "")
	if err != nil {
		return "", err
	}
	defer clear(plain)
	if !store.ValidCatalog(plain) {
		return "", errCorrupt
	}
	return string(plain), nil
}

// Unlock returns a new key only after the catalog has authenticated and decoded.
func (c *Catalog) Unlock(store *Store, password string) (string, *vault.Key, error) {
	data, info, err := readCatalog()
	if err != nil {
		return "", nil, err
	}
	env, err := vault.ParseEnvelope(data, vault.ProjectScope)
	if err != nil {
		return "", nil, err
	}
	key := vault.DeriveKey(password, env.Salt)
	payload, err := openCatalogPayload(store, key, env)
	if err != nil {
		key.Forget()
		return "", nil, err
	}
	c.ClearIndex()
	c.disk, c.diskDigest, c.protected = info, sha256.Sum256(data), true
	return payload, key, nil
}

// Read both data and identity through the same open handle.
func readCatalog() ([]byte, os.FileInfo, error) {
	path, err := CatalogPath()
	if err != nil {
		return nil, nil, err
	}
	data, info, err := ReadFile(path)
	if errors.Is(err, ErrMissing) {
		return nil, nil, nil
	}
	return data, info, err
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
		if err := WithWriteLock(path, remove); !errors.Is(err, errChanged) {
			return err
		}
		return nil
	}
	return remove()
}

// Metadata alone misses an in-place edit when a backup/sync tool preserves
// size and modification time. Read through the checked handle; stream the old
// bytes so saving a library with large attachments needs no extra full copy.
func (c *Catalog) verify(path string) error {
	file, info, err := OpenFile(path)
	if errors.Is(err, ErrMissing) {
		if c.disk == nil {
			return nil
		}
		return errChanged
	}
	if err != nil {
		return err
	}
	defer file.Close()
	if !SameFileState(c.disk, info) {
		return errChanged
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return fmt.Errorf("VD_READ|%w", err)
	}
	if !bytes.Equal(c.diskDigest[:], digest.Sum(nil)) {
		return errChanged
	}
	return nil
}

// All saves and policy changes share the mutex and the same atomic replacement.
// A new key or plaintext policy is committed only after the file is replaced.
func (c *Catalog) SaveSnapshot(store *Store, payload string, key *vault.Key) error {
	data := []byte(payload)
	defer clear(data)
	if !store.ValidCatalog(data) {
		return errInvalid
	}
	if err := c.write(data, key); err != nil {
		return err
	}
	c.ClearIndex()
	c.protected = key != nil
	return nil
}

func (c *Catalog) write(data []byte, key *vault.Key) error {
	path, err := CatalogPath()
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
		if err := c.verify(path); err != nil {
			return err
		}
		if err := cleanWorkspaceTemps(path, false); err != nil {
			return err
		}
		publish := os.Rename
		if c.disk == nil {
			publish = PublishNewFile
		}
		written, err := WriteAtomicInDir(path, data, ".workspace-*.tmp", publish)
		if errors.Is(err, os.ErrExist) {
			return errChanged
		}
		if err != nil {
			return fmt.Errorf("VD_WRITE|%w", err)
		}
		c.disk = written
		c.diskDigest = sha256.Sum256(data)
		return nil
	}
	if c.disk != nil {
		return WithWriteLock(path, write)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	return write()
}
