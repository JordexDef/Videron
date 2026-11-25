package workspacestore

import (
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"

	"videron/internal/syncclient"
	"videron/internal/vault"
)

// TransferRecord verifies that the exact bytes being uploaded belong to this
// working copy, including their authenticated identity when it is encrypted.
func (s *Session) TransferRecord(lineage, kind, id string) ([]byte, error) {
	if s.sync.meta.Lineage != lineage {
		return nil, syncclient.ErrSpace
	}
	if kind == "" {
		raw, _, err := ReadFile(s.path)
		if err != nil {
			return nil, err
		}
		m, _, err := s.mainPayload(raw)
		if err != nil || m.Lineage != lineage {
			clear(raw)
			return nil, syncclient.ErrSpace
		}
		return raw, nil
	}
	if (kind != "objects" && kind != "revisions") || !validSyncID(id) {
		return nil, errInvalid
	}
	raw, _, err := ReadFile(filepath.Join(s.graphPath(), kind, id+".json"))
	if err != nil {
		return nil, err
	}
	plain := raw
	if s.key != nil {
		env, err := vault.ParseEnvelope(raw, SyncScope)
		if err != nil {
			clear(raw)
			return nil, err
		}
		plain, err = s.key.Open(env, lineage+"/"+kind+"/"+id)
		if err != nil {
			clear(raw)
			return nil, err
		}
		defer clear(plain)
	}
	if s.recordID(kind, plain) != id {
		clear(raw)
		return nil, errCorrupt
	}
	return raw, nil
}

// MatchFolder verifies the identity of the current file. A saved connection or
// a matching history directory alone cannot establish the identity of the main.
func (store *Store) MatchFolder(dir, lineage string, current *Session) (*Session, error) {
	path := filepath.Join(dir, Filename)
	raw, info, err := ReadFile(path)
	if errors.Is(err, ErrMissing) {
		return nil, syncclient.ErrFolder
	}
	if err != nil {
		return nil, err
	}
	defer clear(raw)
	if current != nil {
		if current.sync.meta.Lineage != lineage {
			return nil, syncclient.ErrSpace
		}
		m, _, err := current.mainPayload(raw)
		if errors.Is(err, ErrSpaceIdentity) || errors.Is(err, vault.ErrPassword) {
			return nil, syncclient.ErrSpace
		}
		if err != nil {
			return nil, err
		}
		// openReplica identifies an unstamped legacy document by its exact
		// bytes. Apply that same check when the document is already open.
		if m.Lineage != lineage && !(m.Lineage == "" && hexID(raw) == lineage) {
			return nil, syncclient.ErrSpace
		}
		return current, nil
	}
	plain, env, err := store.ParseFile(raw)
	if err != nil {
		return nil, err
	}
	if env != nil {
		return nil, vault.ErrLocked
	}
	session := &Session{store: store, path: path, info: info, digest: sha256.Sum256(raw)}
	if _, err = session.openReplica(plain); err != nil {
		return nil, err
	}
	if session.sync.meta.Lineage != lineage {
		return nil, syncclient.ErrSpace
	}
	return session, nil
}

// PrepareRejoin captures local changes, including edits made to the main file
// while disconnected, before the client begins exchanging history.
func (store *Store) PrepareRejoin(dir, lineage string, current *Session) (*Session, error) {
	var s *Session
	err := WithWriteLock(filepath.Join(dir, Filename), func() error {
		var err error
		s, err = store.MatchFolder(dir, lineage, current)
		if err != nil {
			return err
		}
		if err := s.initReplica(); err != nil {
			return err
		}
		return s.importMain(true)
	})
	return s, err
}

// PublishDownload installs a staged download only while its destination is still empty.
func PublishDownload(dir, stage, lineage string) error {
	if filepath.Dir(stage) != dir || !validSyncID(lineage) {
		return errInvalid
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(stage) {
		return syncclient.ErrFolder
	}
	// Publish the main without replacement first. A concurrent document wins
	// without acquiring our history. Once our main exists, a retry can always
	// identify the replica and fill in missing history.
	if err = PublishNewFile(filepath.Join(stage, Filename), filepath.Join(dir, Filename)); err != nil {
		return err
	}
	history := filepath.Join(dir, HistoryDirName)
	if err = os.Mkdir(history, 0700); err != nil {
		return err
	}
	if err = os.Rename(filepath.Join(stage, HistoryDirName, lineage), filepath.Join(history, lineage)); err != nil {
		return err
	}
	return nil
}
