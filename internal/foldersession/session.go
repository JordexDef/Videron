// Package foldersession manages working copies and their in-memory unlock keys.
package foldersession

import (
	"path/filepath"
	"sync/atomic"

	"videron/internal/desktop"
	"videron/internal/syncworkspace"
	"videron/internal/vault"
	"videron/internal/workspacestore"
)

// Session combines an open working copy and its connection cache.
type Session struct {
	*workspacestore.Session
	Connection          syncworkspace.FolderConnection
	discardKeyOnSuspend bool
}

// Manager's zero value is ready to use. The caller serializes all operations
// except SetRevoking and Revoking, which can signal a lock during disk access.
type Manager struct {
	active    map[string]*Session
	suspended map[string]*vault.Key
	revoking  atomic.Bool
}

func CanonicalFolder(folder string) (string, error) {
	dir, err := desktop.ExistingFolder(folder)
	if err != nil {
		return "", err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return "", desktop.ErrFolderAccess
	}
	return dir, nil
}

func (m *Manager) SetRevoking(revoking bool) { m.revoking.Store(revoking) }
func (m *Manager) Revoking() bool            { return m.revoking.Load() }

func (m *Manager) Inspect(store *workspacestore.Store, folder string) (workspacestore.SpaceFolderInfo, error) {
	dir, err := CanonicalFolder(folder)
	if err != nil {
		m.forgetKey(workspacestore.SessionID(folder))
		return workspacestore.SpaceFolderInfo{}, err
	}
	id := workspacestore.SessionID(dir)
	info, err := store.Inspect(dir, m.suspended[id])
	if err != nil || !info.CanResume {
		m.forgetKey(id)
	}
	return info, err
}

func (m *Manager) Open(store *workspacestore.Store, folder, password string) (string, error) {
	return m.open(store, folder, password, false)
}

func (m *Manager) Resume(store *workspacestore.Store, folder string) (string, error) {
	return m.open(store, folder, "", true)
}

func (m *Manager) open(store *workspacestore.Store, folder, password string, resume bool) (string, error) {
	if resume && m.Revoking() {
		return "", vault.ErrLocked
	}
	dir, err := CanonicalFolder(folder)
	if err != nil {
		m.forgetKey(workspacestore.SessionID(folder))
		return "", err
	}
	id := workspacestore.SessionID(dir)
	var key *vault.Key
	if resume {
		key = m.suspended[id]
		if key == nil {
			return "", vault.ErrLocked
		}
		// Store.Open takes ownership and clears the key if opening fails.
		delete(m.suspended, id)
	} else {
		m.forgetKey(id)
	}
	opened, payload, err := store.Open(dir, password, key)
	if err != nil {
		return "", err
	}
	if resume && m.Revoking() {
		opened.Key().Forget()
		return "", vault.ErrLocked
	}
	m.Install(dir, opened)
	return payload, nil
}

func (m *Manager) Create(store *workspacestore.Store, folder, payload, password string) error {
	dir, err := CanonicalFolder(folder)
	if err != nil {
		return err
	}
	opened, err := store.Create(dir, payload, password)
	if err != nil {
		return err
	}
	m.Install(dir, opened)
	return nil
}

// Current validates the folder on disk before returning its open session.
func (m *Manager) Current(folder string) (*Session, error) {
	dir, err := CanonicalFolder(folder)
	if err != nil {
		return nil, err
	}
	session := m.At(dir)
	if session == nil {
		return nil, vault.ErrLocked
	}
	return session, nil
}

// At looks up an already canonical path or its session ID without disk access.
func (m *Manager) At(dir string) *Session { return m.active[workspacestore.SessionID(dir)] }

func (m *Manager) Install(dir string, opened *workspacestore.Session) *Session {
	if m.active == nil {
		m.active = make(map[string]*Session)
	}
	id := workspacestore.SessionID(dir)
	m.forgetKey(id)
	m.closeActive(id)
	session := &Session{Session: opened}
	m.active[id] = session
	return session
}

// CloseIfCurrent removes a temporary mount only if no other session replaced it.
func (m *Manager) CloseIfCurrent(dir string, expected *Session) {
	id := workspacestore.SessionID(dir)
	if m.active[id] == expected {
		m.closeActive(id)
	}
}

func (m *Manager) Lineages() map[string]string {
	open := make(map[string]string, len(m.active))
	for id, session := range m.active {
		open[id] = session.Lineage()
	}
	return open
}

// Relocate publishes a completed move. The source is still active, the
// destination is unoccupied, and next shares the source's live key.
func (m *Manager) Relocate(source, destination string, next *workspacestore.Session) {
	oldID, newID := workspacestore.SessionID(source), workspacestore.SessionID(destination)
	relocated := *m.active[oldID]
	relocated.Session = next
	m.forgetKey(newID)
	delete(m.active, oldID)
	m.active[newID] = &relocated
}

func (m *Manager) keyID(folder string) string {
	// Canonical paths already in the registry still work while offline.
	id := workspacestore.SessionID(folder)
	if m.active[id] == nil && m.suspended[id] == nil {
		if dir, err := CanonicalFolder(folder); err == nil {
			id = workspacestore.SessionID(dir)
		}
	}
	return id
}

func (m *Manager) forgetKey(id string) {
	m.suspended[id].Forget()
	delete(m.suspended, id)
}

func (m *Manager) closeActive(id string) {
	if session := m.active[id]; session != nil {
		session.Key().Forget()
		delete(m.active, id)
	}
}

func (m *Manager) Close(folder string) {
	id := m.keyID(folder)
	m.forgetKey(id)
	m.closeActive(id)
}

// Suspend keeps only the derived key. Returning to the folder reopens the
// working copy from disk.
func (m *Manager) Suspend(folder string) bool {
	id := m.keyID(folder)
	session := m.active[id]
	if session == nil {
		return m.suspended[id] != nil
	}
	defer m.closeActive(id)
	key := session.Key()
	if key == nil || session.discardKeyOnSuspend || m.Revoking() {
		return false
	}
	if m.suspended == nil {
		m.suspended = make(map[string]*vault.Key)
	}
	m.suspended[id] = key.Clone()
	return true
}

func (m *Manager) forgetSuspended() {
	for id := range m.suspended {
		m.forgetKey(id)
	}
}

// ForgetSuspended revokes suspended keys and prevents active sessions from
// caching their keys later. A pending save can still use its live key.
func (m *Manager) ForgetSuspended() {
	m.forgetSuspended()
	for _, session := range m.active {
		session.discardKeyOnSuspend = true
	}
}

func (m *Manager) Clear() {
	m.forgetSuspended()
	for id := range m.active {
		m.closeActive(id)
	}
}
