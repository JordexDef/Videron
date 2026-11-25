package workspacestore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"videron/internal/vault"
	"videron/internal/workspacemerge"
)

// An immutable manifest points to one object per note, area, route or other
// top-level value. Autosaving a text note reuses all the untouched objects.
type spaceRevision struct {
	Parents []string            `json:"parents"`
	Values  map[string]string   `json:"values"`
	Lists   map[string][]string `json:"lists"`
}

func replicaDir(path string, create bool) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) && create {
		if e := os.Mkdir(path, 0700); e != nil && !errors.Is(e, os.ErrExist) {
			return e
		}
		info, err = os.Lstat(path)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errInvalid
	}
	return nil
}
func (s *Session) graphDirs(create bool) error {
	graph := s.graphPath()
	for _, d := range []string{filepath.Dir(graph), graph, filepath.Join(graph, "objects"), filepath.Join(graph, "revisions")} {
		if err := replicaDir(d, create); err != nil {
			return err
		}
	}
	return nil
}
func (s *Session) recordID(kind string, data []byte) string {
	prefix := s.sync.meta.Lineage + "/" + kind + "/"
	if s.key != nil {
		return hex.EncodeToString(s.key.RecordMAC(prefix, data))
	}
	h := sha256.New()
	h.Write([]byte(prefix))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}
func (s *Session) readRecord(kind, id string) ([]byte, error) {
	if !validSyncID(id) {
		return nil, errCorrupt
	}
	p := filepath.Join(s.graphPath(), kind, id+".json")
	raw, _, err := ReadFile(p)
	if errors.Is(err, ErrMissing) {
		return nil, ErrSyncPending
	}
	if err != nil {
		return nil, err
	}
	return s.decodeRecord(kind, id, raw)
}
func (s *Session) decodeRecord(kind, id string, raw []byte) ([]byte, error) {
	if s.key != nil {
		env, err := vault.ParseEnvelope(raw, SyncScope)
		clear(raw)
		if err != nil {
			return nil, err
		}
		raw, err = s.key.Open(env, s.sync.meta.Lineage+"/"+kind+"/"+id)
		if err != nil {
			return nil, err
		}
	}
	if s.recordID(kind, raw) != id {
		clear(raw)
		return nil, errCorrupt
	}
	return raw, nil
}
func (s *Session) putRecord(kind string, data []byte) (string, error) {
	id := s.recordID(kind, data)
	if kind == "objects" {
		if _, ok := s.sync.verifiedObjects[id]; ok {
			return id, nil
		}
	}
	p := filepath.Join(s.graphPath(), kind, id+".json")
	_, err := os.Lstat(p)
	if err == nil {
		raw, e := s.readRecord(kind, id)
		clear(raw)
		err = e
	} else if errors.Is(err, os.ErrNotExist) {
		out := data
		if s.key != nil {
			out, err = s.key.Seal(SyncScope, s.sync.meta.Lineage+"/"+kind+"/"+id, data)
			if err != nil {
				return "", err
			}
			defer clear(out)
		}
		_, err = WriteAtomicInDir(p, out, ".sync-*.tmp", PublishNewFile)
		if errors.Is(err, os.ErrExist) {
			var existing []byte
			existing, err = s.readRecord(kind, id)
			clear(existing)
		}
	}
	if err != nil {
		return "", err
	}
	if kind == "objects" {
		if s.sync.verifiedObjects == nil {
			s.sync.verifiedObjects = map[string]struct{}{}
		}
		s.sync.verifiedObjects[id] = struct{}{}
	}
	return id, nil
}

// Refresh cached object presence in one directory pass if a cloud provider
// changed the archive, including providers that preserve directory timestamps.
func (s *Session) refreshObjectCache(dir string) error {
	if len(s.sync.verifiedObjects) == 0 {
		s.sync.lastObjectScan = time.Now()
		return nil
	}
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if s.sync.objectDirTime.Equal(info.ModTime()) && time.Since(s.sync.lastObjectScan) < time.Minute {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	present := make(map[string]struct{}, len(s.sync.verifiedObjects))
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".json")
		if _, known := s.sync.verifiedObjects[id]; ok && known && entry.Type().IsRegular() {
			present[id] = struct{}{}
		}
	}
	s.sync.verifiedObjects = present
	s.sync.lastObjectScan = time.Now()
	return nil
}

func (s *Session) manifest(data string, parents []string) (spaceRevision, error) {
	r := spaceRevision{Parents: parents, Values: map[string]string{}, Lists: map[string][]string{}}
	if !s.store.ValidPayload([]byte(data)) {
		return r, errInvalid
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(data), &fields) != nil || fields[SyncProperty] != nil {
		return r, errInvalid
	}
	dir := filepath.Join(s.graphPath(), "objects")
	if err := s.refreshObjectCache(dir); err != nil {
		return r, err
	}
	for k, v := range fields {
		var cells []json.RawMessage
		if workspacemerge.CollectionKind(k) != "" && json.Unmarshal(v, &cells) == nil && cells != nil {
			ids := make([]string, 0, len(cells))
			for _, cell := range cells {
				id, err := s.storeValue(cell)
				if err != nil {
					return r, err
				}
				ids = append(ids, id)
			}
			r.Lists[k] = ids
		} else {
			id, err := s.storeValue(v)
			if err != nil {
				return r, err
			}
			r.Values[k] = id
		}
	}
	// Remember our own writes so an ordinary edit needn't enumerate all
	// archived objects on the next save.
	info, err := os.Stat(dir)
	if err != nil {
		return r, err
	}
	s.sync.objectDirTime = info.ModTime()
	return r, nil
}
func (s *Session) putRevision(r spaceRevision) (spaceSyncMeta, error) {
	raw, err := json.Marshal(r)
	if err != nil {
		return spaceSyncMeta{}, err
	}
	id, err := s.putRecord("revisions", raw)
	if err != nil {
		return spaceSyncMeta{}, err
	}
	if s.sync.parents == nil {
		s.sync.parents = map[string][]string{}
	}
	s.sync.parents[id] = r.Parents
	return spaceSyncMeta{s.sync.meta.Lineage, id, r.Parents}, nil
}
func (s *Session) readRevision(id string) (spaceRevision, error) {
	var r spaceRevision
	raw, err := s.readRecord("revisions", id)
	if err != nil {
		return r, err
	}
	defer clear(raw)
	if json.Unmarshal(raw, &r) != nil || !validParents(r.Parents) || r.Values == nil || r.Lists == nil {
		return r, errCorrupt
	}
	return r, nil
}
func (s *Session) materialize(r spaceRevision) (string, error) {
	fields := map[string]json.RawMessage{}
	for k, id := range r.Values {
		v, err := s.readValue(id)
		if err != nil {
			return "", err
		}
		fields[k] = v
	}
	for k, ids := range r.Lists {
		if _, ok := fields[k]; ok {
			return "", errCorrupt
		}
		list := make([]json.RawMessage, 0, len(ids))
		for _, id := range ids {
			v, err := s.readValue(id)
			if err != nil {
				return "", err
			}
			list = append(list, v)
		}
		raw, err := json.Marshal(list)
		if err != nil {
			return "", errCorrupt
		}
		fields[k] = raw
	}
	doc, err := json.Marshal(fields)
	if err != nil || !s.store.ValidPayload(doc) {
		return "", errCorrupt
	}
	return string(doc), nil
}
