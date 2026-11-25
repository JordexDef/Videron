package workspacestore

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"videron/internal/syncclient"
)

// Only records belonging to this space travel with it. User files, including
// other histories in a shared folder, keep their original locations.
func projectRecords(s *Session) ([]string, error) {
	var records []string
	for _, kind := range []string{"objects", "revisions"} {
		dir, err := syncclient.HistoryDir(filepath.Dir(s.path), s.sync.meta.Lineage, kind, false)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			id, ok := strings.CutSuffix(entry.Name(), ".json")
			if ok && validSyncID(id) {
				records = append(records, filepath.Join(kind, entry.Name()))
			}
		}
	}
	return records, nil
}

// A cloud drive can deliver a revision before the records it references.
// Inspect each distinct value envelope once, without rebuilding the contents
// of every historical note or repeatedly loading a shared image attachment.
func verifyMovedHistory(s *Session, records []string) error {
	available := make(map[string]bool, len(records))
	for _, record := range records {
		available[record] = true
	}
	require := func(kind, id string) error {
		if !validSyncID(id) {
			return errCorrupt
		}
		if !available[filepath.Join(kind, id+".json")] {
			return ErrSyncPending
		}
		return nil
	}
	for _, head := range []string{s.sync.meta.Head, s.sync.diskHead} {
		if head != "" {
			if err := require("revisions", head); err != nil {
				return err
			}
		}
	}
	values := make(map[string]bool)
	for _, record := range records {
		if filepath.Dir(record) != "revisions" {
			continue
		}
		r, err := s.readRevision(strings.TrimSuffix(filepath.Base(record), ".json"))
		if err != nil {
			return err
		}
		for _, parent := range r.Parents {
			if err = require("revisions", parent); err != nil {
				return err
			}
		}
		for _, id := range r.Values {
			values[id] = true
		}
		for _, list := range r.Lists {
			for _, id := range list {
				values[id] = true
			}
		}
	}
	for id := range values {
		if err := require("objects", id); err != nil {
			return err
		}
		raw, err := s.readRecord("objects", id)
		if err != nil {
			return err
		}
		var value struct {
			Refs []string `json:"refs"`
		}
		err = json.Unmarshal(raw, &value)
		clear(raw)
		if err != nil {
			return errCorrupt
		}
		for _, ref := range value.Refs {
			if err = require("objects", ref); err != nil {
				return err
			}
		}
	}
	return nil
}

func removeEmptyHistory(s *Session) {
	graph := s.graphPath()
	for _, dir := range []string{filepath.Join(graph, "objects"), filepath.Join(graph, "revisions"), graph, filepath.Dir(graph)} {
		if info, err := os.Lstat(dir); err == nil && info.IsDir() {
			_ = os.Remove(dir) // Never recurse into unrelated files.
		}
	}
}

type movedFile struct{ from, to Session }

// Stage on the destination volume and hash the same bytes that are written.
// Both identities are retained for checked rollback and source retirement.
func copyMoveFile(from, to string, buffer []byte) (movedFile, error) {
	var copied movedFile
	source, info, err := OpenFile(from)
	if err != nil {
		return copied, err
	}
	defer source.Close()
	temp, err := os.CreateTemp(filepath.Dir(to), ".videron-moving-*.tmp")
	if err != nil {
		return copied, err
	}
	defer os.Remove(temp.Name())
	h := sha256.New()
	// Limit the read to the size observed when the source was opened. A
	// later growth or replacement is caught by the pre-commit verification.
	n, err := io.CopyBuffer(io.MultiWriter(temp, h), io.LimitReader(source, info.Size()), buffer)
	if err == nil && n != info.Size() {
		err = errChanged
	}
	if err == nil {
		err = temp.Sync()
	}
	var written os.FileInfo
	if err == nil {
		written, err = temp.Stat()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return copied, err
	}
	if err = PublishNewFile(temp.Name(), to); err != nil {
		return copied, err
	}
	var digest [sha256.Size]byte
	h.Sum(digest[:0])
	copied.from = Session{path: from, info: info, digest: digest}
	copied.to = Session{path: to, info: written, digest: digest}
	return copied, nil
}

// Move stages the space and its history on the destination volume. commit switches
// the desktop catalog to the verified copy before the old files can be retired.
// The returned session takes over the original session's key and history.
func (s *Session) Move(dir, oldProfile, newProfile string, commit func() error) (*Session, bool, error) {
	oldID, newID := SessionID(filepath.Dir(s.path)), SessionID(dir)
	rel, err := filepath.Rel(oldID, newID)
	if err == nil && (rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))) {
		return nil, false, syncclient.ErrFolder
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, false, err
	}
	if len(entries) != 0 {
		return nil, false, syncclient.ErrFolder
	}
	var keptSource bool
	next := *s
	next.path = filepath.Join(dir, Filename)
	err = WithWriteLock(s.path, func() error {
		if err := s.verifyCurrent(); err != nil {
			return err
		}
		records, err := projectRecords(s)
		if err != nil {
			return err
		}
		var copied []movedFile
		committed := false
		defer func() {
			if committed {
				return
			}
			for i := len(copied) - 1; i >= 0; i-- {
				_ = deleteSpaceFile(&copied[i].to)
			}
			if len(records) > 0 {
				removeEmptyHistory(&next)
			}
		}()
		buffer := make([]byte, 64<<10)
		defer clear(buffer)
		copyFile := func(from, to string) error {
			file, err := copyMoveFile(from, to, buffer)
			if err != nil {
				return err
			}
			copied = append(copied, file)
			return nil
		}
		if len(records) > 0 {
			if err := next.graphDirs(true); err != nil {
				return err
			}
			for _, record := range records {
				if err := copyFile(filepath.Join(s.graphPath(), record), filepath.Join(next.graphPath(), record)); err != nil {
					return err
				}
			}
		}
		oldCursor, err := s.cursorPath()
		if err != nil {
			return err
		}
		newCursor, err := next.cursorPath()
		if err != nil {
			return err
		}
		for _, pair := range [][2]string{{oldProfile, newProfile}, {oldCursor, newCursor}} {
			if _, err := os.Lstat(pair[1]); err == nil {
				return ErrExists
			} else if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if _, err := os.Lstat(pair[0]); errors.Is(err, os.ErrNotExist) {
				continue
			} else if err != nil {
				return err
			}
			if err := copyFile(pair[0], pair[1]); err != nil {
				return err
			}
		}
		if err := copyFile(s.path, next.path); err != nil {
			return err
		}
		main := copied[len(copied)-1]
		if main.from.digest != s.digest {
			return errChanged
		}
		next.info = main.to.info
		if err := verifyMovedHistory(&next, records); err != nil {
			return err
		}
		latest, err := projectRecords(s)
		if err != nil {
			return err
		}
		if !slices.Equal(records, latest) {
			return errChanged
		}
		for i := range copied {
			if err := copied[i].from.verifyCurrent(); err != nil {
				return err
			}
			if err := copied[i].to.verifyCurrent(); err != nil {
				return err
			}
		}
		if err := commit(); err != nil {
			return err
		}
		committed = true
		// Retire the old main before its history. If the drive introduced a
		// branch or replaced the main during the commit, retain the old copy
		// intact: a later delivery may still need its ancestors and objects.
		latest, err = projectRecords(s)
		if err != nil || !slices.Equal(records, latest) || deleteSpaceFile(&main.from) != nil {
			keptSource = true
			return nil
		}
		for i := range copied[:len(copied)-1] {
			if err := deleteSpaceFile(&copied[i].from); err != nil {
				keptSource = true
				break
			}
		}
		if len(records) > 0 {
			removeEmptyHistory(s)
		}
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return &next, keptSource, nil
}
