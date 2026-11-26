package syncworkspace

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"videron/internal/syncclient"
	"videron/internal/workspacestore"
)

// JoinSession keeps file checks and final publication bound to the same
// unlocked desktop session while the network exchange runs outside its lock.
type JoinSession interface {
	WithFolder(dir string, check func(*workspacestore.Session) error) error
	MountFolder(dir string, prepare func(*workspacestore.Session) (*workspacestore.Session, error)) (release func(), err error)
	TransferRecord(dir, lineage, kind, id string) ([]byte, error)
}

// Join downloads into an empty folder or reuses a matching working copy.
func Join(store *workspacestore.Store, p syncclient.Profile, dir string, session JoinSession) error {
	if p.ProjectDeleted {
		return syncclient.ErrProjectDeleted
	}
	if err := BindWorkingCopy(&p, dir); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	m, err := p.Manifest(c)
	if err != nil {
		return err
	}
	if m.Main == "" {
		return syncclient.ErrEmpty
	}
	if p.Lineage != "" && m.Lineage != p.Lineage {
		return syncclient.ErrSpace
	}
	p.Lineage = m.Lineage
	if len(entries) != 0 {
		return rejoin(store, &p, c, dir, m, session)
	}
	unopened := func(current *workspacestore.Session) error {
		if current != nil {
			return syncclient.ErrChanged
		}
		return nil
	}
	if err := session.WithFolder(dir, unopened); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(dir, ".videron-join-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	file := filepath.Join(stage, workspacestore.Filename)
	if err = p.DownloadMain(c, file, m.Main, workspacestore.PublishNewFile); err != nil {
		return err
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	_, _, err = store.ParseFile(raw)
	clear(raw)
	if err != nil {
		return err
	}
	if err = p.Exchange(c, stage, m, nil, workspacestore.PublishNewFile); err != nil {
		return err
	}
	return session.WithFolder(dir, func(current *workspacestore.Session) error {
		if err := unopened(current); err != nil {
			return err
		}
		if err := workspacestore.PublishDownload(dir, stage, m.Lineage); err != nil {
			return err
		}
		return SaveSuccessfulSync(dir, &p)
	})
}

func rejoin(store *workspacestore.Store, p *syncclient.Profile, c *http.Client, dir string, m syncclient.Manifest, session JoinSession) error {
	path := filepath.Join(dir, workspacestore.Filename)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return syncclient.ErrFolder
	} else if err != nil {
		return err
	}
	release, err := session.MountFolder(dir, func(current *workspacestore.Session) (*workspacestore.Session, error) {
		return store.PrepareRejoin(dir, m.Lineage, current)
	})
	if err != nil {
		return err
	}
	defer release()
	if err := p.Exchange(c, dir, m, session.TransferRecord, workspacestore.PublishNewFile); err != nil {
		return err
	}
	return session.WithFolder(dir, func(current *workspacestore.Session) error {
		// Check again in case the file was replaced or the open session changed.
		if _, err := store.MatchFolder(dir, m.Lineage, current); err != nil {
			return err
		}
		return SaveSuccessfulSync(dir, p)
	})
}
