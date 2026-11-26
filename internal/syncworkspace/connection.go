package syncworkspace

import (
	"errors"
	"path/filepath"
	"sync"

	"videron/internal/syncclient"
	"videron/internal/workspacestore"
)

// FolderAccess holds the open workspace and connection state stable for action.
type FolderAccess func(folder string, action func(*workspacestore.Session, *FolderConnection) error) error

// FolderConnection keeps the manifest cache for one open working copy.
// A fresh session starts with an empty cache.
type FolderConnection struct {
	index *syncclient.IndexCache
}

type ServerConnectionInfo struct {
	Address     string `json:"address"`
	Transport   string `json:"transport,omitempty"`
	LastSync    int64  `json:"lastSync,omitempty"`
	ProjectID   string `json:"projectId,omitempty"`
	ProjectName string `json:"projectName,omitempty"`
	AutoConnect bool   `json:"autoConnect"`
}

func ConnectionInfo(dir string, use FolderAccess) (ServerConnectionInfo, error) {
	var info ServerConnectionInfo
	profile, err := LoadProfile(dir)
	if err != nil || profile == nil {
		return info, err
	}
	err = use(dir, func(current *workspacestore.Session, _ *FolderConnection) error {
		if current.Lineage() == profile.Lineage {
			info = ServerConnectionInfo{
				Address: profile.Address, Transport: profile.Transport, LastSync: profile.LastSync,
				ProjectID: profile.ProjectID, ProjectName: profile.ProjectName, AutoConnect: !profile.ManualConnect,
			}
		}
		return nil
	})
	return info, err
}

func SetAutoConnect(folder string, enabled bool, use FolderAccess) error {
	return use(folder, func(current *workspacestore.Session, _ *FolderConnection) error {
		dir := filepath.Dir(current.Path())
		profile, err := LoadProfile(dir)
		if err != nil {
			return err
		}
		if profile == nil || profile.Lineage != current.Lineage() {
			return syncclient.ErrChanged
		}
		manual := !enabled
		if manual == profile.ManualConnect {
			return nil
		}
		profile.ManualConnect = manual
		return StoreProfile(dir, *profile)
	})
}

// WaitForChange leaves the connection lock available for saves and exchanges
// while the server waits to report a new cursor.
func WaitForChange(dir, cursor string, use FolderAccess, connectionLock sync.Locker) (string, error) {
	var lineage string
	err := use(dir, func(current *workspacestore.Session, _ *FolderConnection) error {
		lineage = current.Lineage()
		return nil
	})
	if err != nil {
		return "", err
	}
	profile, err := LoadProfile(dir)
	if err != nil || profile == nil {
		return "", err
	}
	if lineage != profile.Lineage {
		return "", syncclient.ErrSpace
	}
	client := profile.Client()
	defer client.CloseIdleConnections()
	next, err := profile.WaitChange(client, cursor)
	if errors.Is(err, syncclient.ErrProjectDeleted) {
		connectionLock.Lock()
		defer connectionLock.Unlock()
		return "", DetachDeletedProject(dir, profile, err)
	}
	return next, err
}

// Disconnect forgets the manifest and removes the saved credential. A closed
// copy can be disconnected without having a manifest cache.
func Disconnect(dir string, connection *FolderConnection) error {
	if connection != nil {
		connection.index = nil
	}
	return RemoveProfile(dir)
}
