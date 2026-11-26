package syncworkspace

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"videron/internal/localprotect"
	"videron/internal/syncclient"
	"videron/internal/workspacestore"
)

// ProfilePath maps the canonical folder to the existing device-local credential.
func ProfilePath(folder string) (string, error) {
	p, err := workspacestore.CatalogPath()
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(workspacestore.SessionID(folder)))
	return filepath.Join(filepath.Dir(p), "connections", fmt.Sprintf("%x.key", h)), nil
}

// StoreProfile protects the credential with the device's existing format.
func StoreProfile(folder string, p syncclient.Profile) error {
	path, err := ProfilePath(folder)
	if err != nil {
		return err
	}
	raw, err := syncclient.EncodeProfile(p)
	if err != nil {
		return err
	}
	defer clear(raw)
	data, err := localprotect.Protect(raw)
	if err != nil {
		return err
	}
	defer clear(data)
	_, err = workspacestore.WriteAtomic(path, data, ".connection-*.tmp")
	return err
}

// LoadProfile reads the connection tied to folder, or nil when it is detached.
func LoadProfile(folder string) (*syncclient.Profile, error) {
	path, err := ProfilePath(folder)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer clear(raw)
	data, err := localprotect.Unprotect(raw)
	if err != nil {
		return nil, err
	}
	defer clear(data)
	return syncclient.DecodeProfile(data)
}

// BindWorkingCopy verifies the selected project and keeps the local copy's
// connection preference. Other copies of the same project can differ.
func BindWorkingCopy(p *syncclient.Profile, dir string) error {
	existing, err := LoadProfile(dir)
	if err != nil {
		return err
	}
	if existing == nil {
		p.ManualConnect = false
		return nil
	}
	if !p.SameProject(existing) {
		if p.Address == existing.Address && p.Pin != existing.Pin {
			return syncclient.ErrCert
		}
		return syncclient.ErrSpace
	}
	p.ManualConnect = existing.ManualConnect
	return nil
}

// SaveSuccessfulSync records the time of a successful exchange.
func SaveSuccessfulSync(dir string, p *syncclient.Profile) error {
	p.LastSync = time.Now().UnixMilli()
	return StoreProfile(dir, *p)
}

// DetachDeletedProject removes the connection for a matching project tombstone.
// The caller holds the connection lock so a stale long-poll reply cannot
// detach a folder the user has connected to a different project.
func DetachDeletedProject(dir string, observed *syncclient.Profile, reason error) error {
	if !errors.Is(reason, syncclient.ErrProjectDeleted) {
		return reason
	}
	current, err := LoadProfile(dir)
	if err != nil {
		return err
	}
	if current == nil {
		return reason
	}
	if current.Pin != observed.Pin || current.ProjectID != observed.ProjectID || current.Lineage != observed.Lineage {
		return syncclient.ErrChanged
	}
	if err := RemoveProfile(dir); err != nil {
		return err
	}
	return reason
}

// RemoveProfile detaches a working copy without altering its files or history.
func RemoveProfile(dir string) error {
	path, err := ProfilePath(dir)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// ManagedFolder uses the server identity and project ID to reuse a previously
// downloaded copy even if it was unlisted or its first unlock was cancelled.
func ManagedFolder(profile syncclient.Profile) (string, error) {
	catalog, err := workspacestore.CatalogPath()
	if err != nil {
		return "", err
	}
	id := sha256.Sum256([]byte(profile.Pin + "/" + profile.ProjectID))
	dir := filepath.Join(filepath.Dir(catalog), "spaces", fmt.Sprintf("sync-%x", id))
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}
