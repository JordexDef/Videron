// Package library manages the personal library and its active vault session.
package library

import (
	"videron/internal/vault"
	"videron/internal/workspacestore"
)

// Library owns the catalog, its revision and the active encryption key. Its
// zero value represents an unopened library. Callers serialize access.
type Library struct {
	catalog    workspacestore.Catalog
	key        *vault.Key
	loaded     bool
	resumeNote string
}

func (l *Library) Loaded() bool { return l.loaded }

func (l *Library) IsProjectProtected() bool { return l.catalog.Protected() }

// Key returns the active key for editor history. Use it only while holding the
// same lock that protects the library.
func (l *Library) Key() *vault.Key { return l.key }

// Load revokes the current key and other grants whenever the previously opened
// catalog is replaced or cannot be read. invalidate releases the other grants.
func (l *Library) Load(store *workspacestore.Store, invalidate func()) (string, error) {
	payload, err := l.catalog.Load(store, l.key, l.loaded, func() { l.revoke(invalidate) })
	l.loaded = err == nil
	if err != nil {
		l.revoke(invalidate)
		return "", err
	}
	if !l.catalog.Protected() {
		l.key.Forget()
		l.key = nil
	}
	return payload, nil
}

func (l *Library) UnlockProject(store *workspacestore.Store, password string, invalidate func()) (string, error) {
	payload, key, err := l.catalog.Unlock(store, password)
	if err != nil {
		return "", err
	}
	l.revoke(invalidate)
	l.key = key
	l.loaded = true
	return payload, nil
}

func (l *Library) Save(store *workspacestore.Store, payload string) error {
	if !l.loaded {
		return vault.ErrLocked
	}
	return l.catalog.SaveSnapshot(store, payload, l.key)
}

func (l *Library) CatalogRevision() (string, error) {
	if !l.loaded {
		return "", vault.ErrLocked
	}
	return l.catalog.Revision(), nil
}

func (l *Library) SaveCatalogPatch(store *workspacestore.Store, expectedRev, delta string) (string, error) {
	if !l.loaded {
		return "", vault.ErrLocked
	}
	return l.catalog.SavePatch(store, l.key, expectedRev, delta)
}

func (l *Library) revoke(invalidate func()) {
	if invalidate != nil {
		invalidate()
	}
	l.catalog.ClearIndex()
	l.key.Forget()
	l.key = nil
}

func (l *Library) Close() {
	l.revoke(nil)
	l.loaded = false
}

func (l *Library) LockProject(invalidate func()) error {
	if !l.catalog.Protected() {
		return vault.ErrInvalid
	}
	l.revoke(invalidate)
	l.loaded = false
	return nil
}

// LockSession remembers the last open note across a lock, until the first
// successful request for the resume target after the library opens again.
func (l *Library) LockSession(noteID string) {
	l.Close()
	l.resumeNote = noteID
}

func (l *Library) TakeResumeNote() string {
	if !l.loaded {
		return ""
	}
	id := l.resumeNote
	l.resumeNote = ""
	return id
}

func (l *Library) writePassword(store *workspacestore.Store, payload, password string) error {
	key, err := vault.NewKey(password)
	if err != nil {
		return err
	}
	if err = l.catalog.SaveSnapshot(store, payload, key); err != nil {
		key.Forget()
		return err
	}
	l.key.Forget()
	l.key = key
	return nil
}

func (l *Library) ProtectProject(store *workspacestore.Store, payload, password string) error {
	if !l.loaded {
		return vault.ErrLocked
	}
	if l.catalog.Protected() {
		return vault.ErrInvalid
	}
	return l.writePassword(store, payload, password)
}

func (l *Library) ChangeProjectPassword(store *workspacestore.Store, payload, currentPassword, newPassword string) error {
	if !l.loaded || l.key == nil {
		return vault.ErrLocked
	}
	if !l.key.Verify(currentPassword) {
		return vault.ErrPassword
	}
	return l.writePassword(store, payload, newPassword)
}

func (l *Library) RemoveProjectPassword(store *workspacestore.Store, payload, password string) error {
	if !l.loaded || l.key == nil {
		return vault.ErrLocked
	}
	if !l.key.Verify(password) {
		return vault.ErrPassword
	}
	if err := l.catalog.SaveSnapshot(store, payload, nil); err != nil {
		return err
	}
	l.key.Forget()
	l.key = nil
	return nil
}
