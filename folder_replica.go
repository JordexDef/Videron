package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"videron/internal/vault"
	"videron/internal/workspacemerge"
)

const syncFolderName = ".videron-sync"
const syncScope = "videron.space.sync"
const syncProperty = "_videronSync"

var errSyncPending = errors.New("VD_SYNC_PENDING")
var errSpaceIdentity = errors.New("VD_SPACE_IDENTITY")

// An immutable manifest points to one object per note, area, route or other
// top-level value. Autosaving a text note reuses all the untouched objects.
type spaceRevision struct {
	Parents []string            `json:"parents"`
	Values  map[string]string   `json:"values"`
	Lists   map[string][]string `json:"lists"`
}
type spaceSyncMeta struct {
	Lineage string   `json:"lineage"`
	Head    string   `json:"head,omitempty"`
	Parents []string `json:"parents,omitempty"`
}
type spaceReplica struct {
	meta            spaceSyncMeta
	payload         string
	initialized     bool
	diskHead        string
	mainStamped     bool
	imported        [sha256.Size]byte
	parents         map[string][]string
	verifiedObjects map[string]struct{}
	objectDirTime   time.Time
	lastObjectScan  time.Time
	scanTime        time.Time
	lastScan        time.Time
	fullRead        time.Time
	settledHead     string
	settledCount    int
	mergePlan       *preparedFolderMerge
	lastMerge       savePatchReceipt
}
type FolderSpaceUpdate struct {
	Token  string `json:"token"`
	Base   string `json:"base,omitempty"`
	Remote string `json:"remote,omitempty"`
}

func hexID(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func newLineage() (string, error) {
	var id [32]byte
	_, err := rand.Read(id[:])
	return hex.EncodeToString(id[:]), err
}
func validSyncID(id string) bool {
	if len(id) != 64 {
		return false
	}
	for _, r := range id {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
func validParents(ids []string) bool {
	return len(ids) <= 2 && slices.IsSorted(ids) && (len(ids) != 2 || ids[0] != ids[1]) && !slices.ContainsFunc(ids, func(id string) bool { return !validSyncID(id) })
}

// Keep the note payload readable by older desktop versions. They preserve
// additional JSON fields. Current frontends never receive the reserved field.
func splitSpaceMeta(payload []byte) (spaceSyncMeta, []byte, error) {
	var marker struct {
		Meta *spaceSyncMeta `json:"_videronSync"`
	}
	if err := json.Unmarshal(payload, &marker); err != nil {
		return spaceSyncMeta{}, nil, errCorrupt
	}
	if marker.Meta == nil {
		return spaceSyncMeta{}, payload, nil
	}
	m := *marker.Meta
	if !validSyncID(m.Lineage) || m.Head != "" && !validSyncID(m.Head) || !validParents(m.Parents) {
		return m, nil, errCorrupt
	}
	payload = bytes.TrimSpace(payload)
	idx := bytes.LastIndex(payload, []byte(`,"_videronSync":`))
	if idx > 0 {
		var tail spaceSyncMeta
		if json.Unmarshal(payload[idx+len(`,"_videronSync":`):len(payload)-1], &tail) == nil {
			data := make([]byte, idx+1)
			copy(data, payload[:idx])
			data[idx] = '}'
			return m, data, nil
		}
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return m, nil, errCorrupt
	}
	delete(fields, syncProperty)
	data, err := json.Marshal(fields)
	return m, data, err
}
func encodeTrackedSpace(payload string, meta spaceSyncMeta, key *vault.Key) ([]byte, error) {
	if !validSpacePayload([]byte(payload)) {
		return nil, errInvalid
	}
	m, _, err := splitSpaceMeta([]byte(payload))
	if err != nil || m.Lineage != "" {
		return nil, errInvalid
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	clean := strings.TrimSpace(payload)
	return encodeSpace(clean[:len(clean)-1]+`,"_videronSync":`+string(raw)+"}", key)
}
func (s *folderSpaceSession) graphPath() string {
	return filepath.Join(filepath.Dir(s.path), syncFolderName, s.sync.meta.Lineage)
}
func (s *folderSpaceSession) cursorPath() (string, error) {
	config, err := workspacePath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(config), "sync-state", hexID([]byte(spaceSessionID(s.path)))+".json"), nil
}
func (s *folderSpaceSession) storedCursor() string {
	p, err := s.cursorPath()
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(p)
	var meta spaceSyncMeta
	if err != nil || json.Unmarshal(b, &meta) != nil || meta.Lineage != s.sync.meta.Lineage || !validSyncID(meta.Head) {
		return ""
	}
	return meta.Head
}
func (s *folderSpaceSession) advance(m spaceSyncMeta, data string) error {
	p, err := s.cursorPath()
	if err != nil {
		return err
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if _, err = writeAtomic(p, b, ".sync-cursor-*.tmp"); err != nil {
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	s.sync.mergePlan = nil
	s.sync.lastMerge = savePatchReceipt{}
	s.sync.meta = m
	s.sync.payload = data
	return nil
}
func (s *folderSpaceSession) openReplica(plain []byte) (string, error) {
	m, payload, err := splitSpaceMeta(plain)
	if err != nil {
		return "", err
	}
	if m.Lineage == "" {
		m.Lineage = hex.EncodeToString(s.digest[:])
	}
	s.sync = spaceReplica{meta: m, payload: string(payload)}
	cursor := s.storedCursor()
	if cursor != "" && cursor != m.Head {
		// A cloud folder can deliver an older canonical file before this
		// device's saved branch. Opening it would replace our cursor on init.
		if err = s.graphDirs(false); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return "", errSyncPending
			}
			return "", err
		}
		r, err := s.readRevision(cursor)
		if err != nil {
			return "", err
		}
		data, err := s.materialize(r)
		if err != nil {
			return "", err
		}
		s.sync.meta.Head = cursor
		s.sync.meta.Parents = r.Parents
		s.sync.payload = data
	}
	return s.sync.payload, nil
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
func (s *folderSpaceSession) graphDirs(create bool) error {
	graph := s.graphPath()
	for _, d := range []string{filepath.Dir(graph), graph, filepath.Join(graph, "objects"), filepath.Join(graph, "revisions")} {
		if err := replicaDir(d, create); err != nil {
			return err
		}
	}
	return nil
}
func (s *folderSpaceSession) recordID(kind string, data []byte) string {
	prefix := s.sync.meta.Lineage + "/" + kind + "/"
	if s.key != nil {
		return hex.EncodeToString(s.key.RecordMAC(prefix, data))
	}
	h := sha256.New()
	h.Write([]byte(prefix))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}
func (s *folderSpaceSession) readRecord(kind, id string) ([]byte, error) {
	if !validSyncID(id) {
		return nil, errCorrupt
	}
	p := filepath.Join(s.graphPath(), kind, id+".json")
	raw, _, err := readSpaceFile(p)
	if errors.Is(err, errSpaceMissing) {
		return nil, errSyncPending
	}
	if err != nil {
		return nil, err
	}
	return s.decodeRecord(kind, id, raw)
}
func (s *folderSpaceSession) decodeRecord(kind, id string, raw []byte) ([]byte, error) {
	if s.key != nil {
		env, err := vault.ParseEnvelope(raw, syncScope)
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
func (s *folderSpaceSession) putRecord(kind string, data []byte) (string, error) {
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
			out, err = s.key.Seal(syncScope, s.sync.meta.Lineage+"/"+kind+"/"+id, data)
			if err != nil {
				return "", err
			}
			defer clear(out)
		}
		_, err = writeAtomicInDir(p, out, ".sync-*.tmp", publishNewSpaceFile)
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
func (s *folderSpaceSession) refreshObjectCache(dir string) error {
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

func (s *folderSpaceSession) manifest(data string, parents []string) (spaceRevision, error) {
	r := spaceRevision{Parents: parents, Values: map[string]string{}, Lists: map[string][]string{}}
	if !validSpacePayload([]byte(data)) {
		return r, errInvalid
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(data), &fields) != nil || fields[syncProperty] != nil {
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
func (s *folderSpaceSession) putRevision(r spaceRevision) (spaceSyncMeta, error) {
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
func (s *folderSpaceSession) readRevision(id string) (spaceRevision, error) {
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
func (s *folderSpaceSession) materialize(r spaceRevision) (string, error) {
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
	if err != nil || !validSpacePayload(doc) {
		return "", errCorrupt
	}
	return string(doc), nil
}

// Publish every object before the manifest becomes visible. A cloud client can
// deliver those files in another order; readers retry until the objects arrive.
func (s *folderSpaceSession) initReplica() error {
	if err := s.graphDirs(true); err != nil {
		return err
	}
	if s.sync.initialized {
		return nil
	}
	r, err := s.manifest(s.sync.payload, s.sync.meta.Parents)
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(r)
	if head := s.sync.meta.Head; head != "" && s.recordID("revisions", raw) != head {
		r.Parents = []string{head}
	}
	m, err := s.putRevision(r)
	if err != nil {
		return err
	}
	if err = s.advance(m, s.sync.payload); err != nil {
		return err
	}
	s.sync.initialized = true
	return nil
}
func (s *folderSpaceSession) mainPayload(raw []byte) (spaceSyncMeta, string, error) {
	plain, env, err := parseSpaceFile(raw)
	if err != nil {
		return spaceSyncMeta{}, "", err
	}
	if (s.key != nil) != (env != nil) {
		return spaceSyncMeta{}, "", errSpaceIdentity
	}
	if env != nil {
		plain, err = s.key.Open(env, "")
		if err != nil {
			return spaceSyncMeta{}, "", err
		}
		defer clear(plain)
	}
	m, data, err := splitSpaceMeta(plain)
	if err != nil {
		return m, "", err
	}
	if m.Lineage != "" && m.Lineage != s.sync.meta.Lineage {
		return m, "", errSpaceIdentity
	}
	return m, string(data), nil
}
func (s *folderSpaceSession) importMain(force bool) error {
	info, err := os.Lstat(s.path)
	if err != nil {
		return err
	}
	if !force && s.sync.diskHead != "" && sameFileState(s.info, info) && time.Since(s.sync.fullRead) < time.Minute {
		return nil
	}
	raw, info, err := readSpaceFile(s.path)
	if err != nil {
		return err
	}
	defer clear(raw)
	digest := sha256.Sum256(raw)
	if digest != s.sync.imported || s.sync.diskHead == "" {
		m, data, err := s.mainPayload(raw)
		if err != nil {
			return err
		}
		s.sync.mainStamped = m.Lineage != "" && m.Head != ""
		parents := m.Parents
		// A reader from before versioned folders may replace the file without
		// carrying its head. Its last observed main is the only known base.
		if m.Head == "" && m.Lineage == "" && s.sync.diskHead != "" {
			parents = []string{s.sync.diskHead}
		}
		r, err := s.manifest(data, parents)
		if err != nil {
			return err
		}
		encoded, _ := json.Marshal(r)
		if m.Head != "" && m.Head != s.recordID("revisions", encoded) {
			r.Parents = []string{m.Head}
		}
		m, err = s.putRevision(r)
		if err != nil {
			return err
		}
		s.sync.diskHead = m.Head
		s.sync.imported = digest
	}
	s.info = info
	s.digest = digest
	s.sync.fullRead = time.Now()
	return nil
}
func (s *folderSpaceSession) scan(force bool) error {
	dir := filepath.Join(s.graphPath(), "revisions")
	st, err := os.Stat(dir)
	if err != nil {
		return err
	}
	// Some cloud providers preserve the directory timestamp when adding files.
	if !force && s.sync.scanTime.Equal(st.ModTime()) && time.Since(s.sync.lastScan) < time.Minute {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || !validSyncID(id) {
			continue
		}
		if _, known := s.sync.parents[id]; known {
			continue
		}
		r, err := s.readRevision(id)
		if err != nil {
			return err
		}
		s.sync.parents[id] = r.Parents
	}
	s.sync.scanTime = st.ModTime()
	s.sync.lastScan = time.Now()
	return nil
}
func ancestors(start string, graph map[string][]string) map[string]bool {
	seen := map[string]bool{start: true}
	queue := []string{start}
	for i := 0; i < len(queue); i++ {
		for _, parent := range graph[queue[i]] {
			if !seen[parent] {
				seen[parent] = true
				queue = append(queue, parent)
			}
		}
	}
	return seen
}
func commonBase(ours, theirs map[string]bool, graph map[string][]string) string {
	// A delayed merge parent may carry a newer common ancestor than the
	// already delivered branch. A shared missing ancestor is harmless when
	// both devices branched from the same shallow copy of a workspace.
	shared := map[string]bool{}
	for id := range ours {
		if theirs[id] {
			shared[id] = true
		} else if _, available := graph[id]; !available {
			return ""
		}
	}
	for id := range theirs {
		if _, available := graph[id]; !available && !ours[id] {
			return ""
		}
	}
	for len(shared) > 0 {
		tips := map[string]bool{}
		for key := range shared {
			tips[key] = true
		}
		for key := range shared {
			for _, p := range graph[key] {
				delete(tips, p)
			}
		}
		if len(tips) == 1 {
			for key := range tips {
				return key
			}
		}
		if len(tips) == 0 {
			return ""
		}
		// Opposite decisions made on both computers can produce two independent
		// merges with the same two parents. Choosing either parent as the base
		// would silently discard the other decision. Retreat to their shared fork.
		for tip := range tips {
			delete(shared, tip)
			before := ancestors(tip, graph)
			for key := range shared {
				if !before[key] {
					delete(shared, key)
				}
			}
		}
	}
	return ""
}
func (s *folderSpaceSession) candidate() (string, string, error) {
	// Only compare branch tips. A remote tip that already includes our current
	// head is a fast-forward. Merges retain both parents, so no tip repeats.
	tips := make(map[string]bool, len(s.sync.parents))
	for k := range s.sync.parents {
		tips[k] = true
	}
	for _, ps := range s.sync.parents {
		for _, p := range ps {
			delete(tips, p)
		}
	}
	var pending []string
	ours := ancestors(s.sync.meta.Head, s.sync.parents)
	for tip := range tips {
		if _, known := ours[tip]; !known {
			pending = append(pending, tip)
		}
	}
	slices.Sort(pending)
	for _, tip := range pending {
		theirs := ancestors(tip, s.sync.parents)
		if _, fast := theirs[s.sync.meta.Head]; fast {
			return tip, s.sync.meta.Head, nil
		}
		ancestor := commonBase(ours, theirs, s.sync.parents)
		if ancestor != "" {
			return tip, ancestor, nil
		}
	}
	if len(pending) > 0 {
		return "", "", errSyncPending
	}
	return "", "", nil
}
func (s *folderSpaceSession) publishMain(data string, m spaceSyncMeta) error {
	raw, err := encodeTrackedSpace(data, m, s.key)
	if err != nil {
		return err
	}
	defer clear(raw)
	info, err := writeAtomicInDir(s.path, raw, ".videron-space-*.tmp", func(temp, path string) error {
		if err := s.verifyCurrent(); err != nil {
			return err
		}
		return os.Rename(temp, path)
	})
	if err != nil {
		return err
	}
	s.info = info
	s.digest = sha256.Sum256(raw)
	s.sync.imported = s.digest
	s.sync.diskHead = m.Head
	s.sync.mainStamped = true
	return nil
}
func (a *App) FolderSpaceLineage(folder string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return "", err
	}
	err = withSpaceWriteLock(s.path, func() error {
		if err := s.initReplica(); err != nil {
			return err
		}
		if err := s.importMain(true); err != nil {
			return err
		}
		if !s.sync.mainStamped && s.sync.diskHead == s.sync.meta.Head {
			return s.publishMain(s.sync.payload, s.sync.meta)
		}
		return nil
	})
	return s.sync.meta.Lineage, err
}
func (a *App) PollFolderSpace(folder string, force bool) (FolderSpaceUpdate, error) {
	return a.pollFolderSpace(folder, force, "")
}

// CheckFolderSpace omits the snapshots when the caller already has both heads.
func (a *App) CheckFolderSpace(folder, knownToken string) (FolderSpaceUpdate, error) {
	return a.pollFolderSpace(folder, false, knownToken)
}

func (a *App) pollFolderSpace(folder string, force bool, knownToken string) (FolderSpaceUpdate, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var u FolderSpaceUpdate
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return u, err
	}
	token, tip, base, err := s.pollCandidate(force)
	if err != nil || token == "" {
		return u, err
	}
	if token == knownToken {
		return FolderSpaceUpdate{Token: token}, nil
	}
	r, err := s.readRevision(tip)
	if err != nil {
		return u, err
	}
	remote, err := s.materialize(r)
	if err != nil {
		return u, err
	}
	var previous string
	if base == s.sync.meta.Head {
		previous = s.sync.payload
	} else {
		b, err := s.readRevision(base)
		if err != nil {
			return u, err
		}
		previous, err = s.materialize(b)
		if err != nil {
			return u, err
		}
	}
	return FolderSpaceUpdate{token, previous, remote}, nil
}
func (s *folderSpaceSession) pollCandidate(force bool) (token, tip, base string, err error) {
	if err := s.initReplica(); err != nil {
		return "", "", "", err
	}
	if err := s.importMain(force); err != nil {
		return "", "", "", err
	}
	if err := s.scan(force); err != nil {
		return "", "", "", err
	}
	if !force && s.sync.diskHead == s.sync.meta.Head && s.sync.settledHead == s.sync.meta.Head && s.sync.settledCount == len(s.sync.parents) {
		return "", "", "", nil
	}
	tip, base, err = s.candidate()
	if err != nil || tip == "" {
		if err == nil {
			// Recover the canonical snapshot after a crash between publishing
			// its immutable branch and atomically replacing Videron.space, or
			// after a sync client re-delivers an older ancestor.
			if s.sync.diskHead != s.sync.meta.Head && ancestorOf(s.sync.diskHead, s.sync.meta.Head, s.sync.parents) {
				if e := withSpaceWriteLock(s.path, func() error { return s.publishMain(s.sync.payload, s.sync.meta) }); e != nil {
					return "", "", "", e
				}
			}
			s.sync.settledHead = s.sync.meta.Head
			s.sync.settledCount = len(s.sync.parents)
		}
		return "", "", "", err
	}
	return s.sync.meta.Head + ":" + tip, tip, base, nil
}
func (a *App) SaveFolderBranch(folder, payload string) error {
	return a.commitFolderBranch(folder, "", payload)
}
func (a *App) CommitFolderMerge(folder, token, payload string) error {
	if token == "" {
		return errInvalid
	}
	return a.commitFolderBranch(folder, token, payload)
}
func (a *App) commitFolderBranch(folder, token, data string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return err
	}
	return s.commitBranch(token, data, false)
}
func (s *folderSpaceSession) commitBranch(token, data string, strict bool) error {
	return withSpaceWriteLock(s.path, func() error {
		if strict {
			if err := s.verifyCurrent(); err != nil {
				return err
			}
		}
		if err := s.initReplica(); err != nil {
			return err
		}
		if err := s.importMain(true); err != nil {
			return err
		}
		old := s.sync.meta.Head
		parents := []string{old}
		if token != "" {
			if err := s.scan(true); err != nil {
				return err
			}
			tip, _, err := s.candidate()
			if err != nil {
				return err
			}
			if tip == "" || token != old+":"+tip {
				return errChanged
			}
			if ancestorOf(old, tip, s.sync.parents) {
				parents = []string{tip}
			} else {
				parents = append(parents, tip)
				slices.Sort(parents)
			}
		}
		r, err := s.manifest(data, parents)
		if err != nil {
			return err
		}
		m := s.sync.meta
		if len(parents) == 1 {
			p, readErr := s.readRevision(parents[0])
			if readErr != nil {
				return readErr
			}
			r.Parents = p.Parents
			raw, _ := json.Marshal(r)
			if s.recordID("revisions", raw) == parents[0] {
				m = spaceSyncMeta{m.Lineage, parents[0], p.Parents}
			} else {
				r.Parents = parents
				m, err = s.putRevision(r)
			}
		} else {
			m, err = s.putRevision(r)
		}
		if err != nil {
			return err
		}
		if err = s.advance(m, data); err != nil {
			return err
		}
		if m.Head != s.sync.diskHead && ancestorOf(s.sync.diskHead, m.Head, s.sync.parents) {
			return s.publishMain(data, m)
		}
		return nil
	})
}
func ancestorOf(older, newer string, parents map[string][]string) bool {
	// An ordinary save extends the current head by exactly one revision.
	return older == newer || slices.Contains(parents[newer], older) || ancestors(newer, parents)[older]
}

func (s *folderSpaceSession) deleteReplica() error {
	if s.sync.meta.Lineage == "" {
		return nil
	}
	graph := s.graphPath()
	if err := s.graphDirs(false); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	// Verify the entire archive before deleting anything. Do not truncate a
	// healthy history just because an unrelated or damaged file was found later.
	var records []folderSpaceSession
	for _, kind := range []string{"revisions", "objects"} {
		dir := filepath.Join(graph, kind)
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			id, ok := strings.CutSuffix(entry.Name(), ".json")
			if !ok || !validSyncID(id) {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			raw, info, e := readSpaceFile(path)
			if e != nil {
				return e
			}
			record := folderSpaceSession{path: path, info: info, digest: sha256.Sum256(raw)}
			plain, e := s.decodeRecord(kind, id, raw)
			clear(plain)
			clear(raw)
			if e != nil {
				return e
			}
			records = append(records, record)
		}
	}
	for i := range records {
		if err := deleteSpaceFile(&records[i]); err != nil {
			return err
		}
	}
	for _, kind := range []string{"revisions", "objects"} {
		dir := filepath.Join(graph, kind)
		if empty, err := os.ReadDir(dir); err == nil && len(empty) == 0 {
			if err = os.Remove(dir); err != nil {
				return err
			}
		}
	}
	for _, dir := range []string{graph, filepath.Dir(graph)} {
		if empty, err := os.ReadDir(dir); err == nil && len(empty) == 0 {
			if err = os.Remove(dir); err != nil {
				return err
			}
		}
	}
	if p, err := s.cursorPath(); err == nil {
		_ = os.Remove(p)
	}
	return nil
}
