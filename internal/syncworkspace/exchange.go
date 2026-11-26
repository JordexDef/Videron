package syncworkspace

import (
	"videron/internal/syncclient"
	"videron/internal/workspacestore"
)

func (c *FolderConnection) indexCache() *syncclient.IndexCache {
	if c.index == nil {
		c.index = new(syncclient.IndexCache)
	}
	return c.index
}

// Connect enrolls a local working copy. commit checks that the vault session
// which started enrollment still owns the connection before saving it.
func Connect(dir string, p syncclient.Profile, use, commit FolderAccess, read syncclient.ReadRecord) error {
	if p.ProjectDeleted {
		return syncclient.ErrProjectDeleted
	}
	if err := BindWorkingCopy(&p, dir); err != nil {
		return err
	}
	var lineage string
	var index *syncclient.IndexCache
	if err := use(dir, func(s *workspacestore.Session, c *FolderConnection) error {
		var err error
		lineage, err = s.EnsureLineage()
		if err != nil {
			return err
		}
		if p.Lineage != "" && p.Lineage != lineage {
			return syncclient.ErrSpace
		}
		index = c.indexCache()
		return nil
	}); err != nil {
		return err
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	m, err := p.Enroll(c, dir, lineage, read, workspacestore.PublishNewFile)
	if err != nil {
		return err
	}
	return commit(dir, func(_ *workspacestore.Session, c *FolderConnection) error {
		if c.index != index {
			return syncclient.ErrChanged
		}
		// First background sync starts from the enrollment index. Any uploads
		// during the exchange are later than this cursor and appear in its delta.
		index.Remember(&p, m)
		return SaveSuccessfulSync(dir, &p)
	})
}

// Sync exchanges missing history and returns the cursor covered by the download.
func Sync(dir string, use FolderAccess, read syncclient.ReadRecord) (string, error) {
	p, err := LoadProfile(dir)
	if err != nil || p == nil {
		return "", err
	}
	var index *syncclient.IndexCache
	if err := use(dir, func(s *workspacestore.Session, c *FolderConnection) error {
		if s.Lineage() != p.Lineage {
			return syncclient.ErrSpace
		}
		index = c.indexCache()
		return nil
	}); err != nil {
		return "", err
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	m, err := p.SyncManifest(c, index)
	if err != nil {
		return "", DetachDeletedProject(dir, p, err)
	}
	// A server write after this manifest must still wake the next subscription.
	if err := p.Exchange(c, dir, m, read, workspacestore.PublishNewFile); err != nil {
		return m.Cursor, DetachDeletedProject(dir, p, err)
	}
	// A failed status write cannot undo the exchange. The next success refreshes it.
	_ = SaveSuccessfulSync(dir, p)
	return m.Cursor, nil
}
