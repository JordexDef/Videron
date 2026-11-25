package workspacestore

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
)

const HistoryDirName = ".videron-sync"
const SyncScope = "videron.space.sync"
const SyncProperty = "_videronSync"

var ErrSyncPending = errors.New("VD_SYNC_PENDING")
var ErrSpaceIdentity = errors.New("VD_SPACE_IDENTITY")

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
type Update struct {
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
	delete(fields, SyncProperty)
	data, err := json.Marshal(fields)
	return m, data, err
}
func (store *Store) encodeTrackedSpace(payload string, meta spaceSyncMeta, key *vault.Key) ([]byte, error) {
	if !store.ValidPayload([]byte(payload)) {
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
	return store.EncodeSpace(clean[:len(clean)-1]+`,"_videronSync":`+string(raw)+"}", key)
}
func (s *Session) graphPath() string {
	return filepath.Join(filepath.Dir(s.path), HistoryDirName, s.sync.meta.Lineage)
}
func (s *Session) cursorPath() (string, error) {
	config, err := CatalogPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(config), "sync-state", hexID([]byte(SessionID(s.path)))+".json"), nil
}
func (s *Session) storedCursor() string {
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
func (s *Session) advance(m spaceSyncMeta, data string) error {
	p, err := s.cursorPath()
	if err != nil {
		return err
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if _, err = WriteAtomic(p, b, ".sync-cursor-*.tmp"); err != nil {
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	s.sync.mergePlan = nil
	s.sync.lastMerge = savePatchReceipt{}
	s.sync.meta = m
	s.sync.payload = data
	return nil
}
func (s *Session) openReplica(plain []byte) (string, error) {
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
				return "", ErrSyncPending
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

// Publish every object before the manifest becomes visible. A cloud client can
// deliver those files in another order; readers retry until the objects arrive.
func (s *Session) initReplica() error {
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
func (s *Session) mainPayload(raw []byte) (spaceSyncMeta, string, error) {
	plain, env, err := s.store.ParseFile(raw)
	if err != nil {
		return spaceSyncMeta{}, "", err
	}
	if (s.key != nil) != (env != nil) {
		return spaceSyncMeta{}, "", ErrSpaceIdentity
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
		return m, "", ErrSpaceIdentity
	}
	return m, string(data), nil
}
func (s *Session) importMain(force bool) error {
	info, err := os.Lstat(s.path)
	if err != nil {
		return err
	}
	if !force && s.sync.diskHead != "" && SameFileState(s.info, info) && time.Since(s.sync.fullRead) < time.Minute {
		return nil
	}
	raw, info, err := ReadFile(s.path)
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
func (s *Session) scan(force bool) error {
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
func (s *Session) candidate() (string, string, error) {
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
		return "", "", ErrSyncPending
	}
	return "", "", nil
}
func (s *Session) publishMain(data string, m spaceSyncMeta) error {
	raw, err := s.store.encodeTrackedSpace(data, m, s.key)
	if err != nil {
		return err
	}
	defer clear(raw)
	info, err := WriteAtomicInDir(s.path, raw, ".videron-space-*.tmp", func(temp, path string) error {
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

// Lineage identifies this workspace without modifying the archive.
func (s *Session) Lineage() string { return s.sync.meta.Lineage }

// Head returns the current local revision ID, or an empty ID before initialization.
func (s *Session) Head() string { return s.sync.meta.Head }

// EnsureLineage publishes the initial revision and stamps older workspaces when needed.
func (s *Session) EnsureLineage() (string, error) {
	err := WithWriteLock(s.path, func() error {
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

// Poll discovers a peer revision. If knownToken still describes both heads,
// the caller can keep the snapshots it already has.
func (s *Session) Poll(force bool, knownToken string) (Update, error) {
	var u Update
	token, tip, base, err := s.pollCandidate(force)
	if err != nil || token == "" {
		return u, err
	}
	if token == knownToken {
		return Update{Token: token}, nil
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
	return Update{token, previous, remote}, nil
}
func (s *Session) pollCandidate(force bool) (token, tip, base string, err error) {
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
				if e := WithWriteLock(s.path, func() error { return s.publishMain(s.sync.payload, s.sync.meta) }); e != nil {
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

func (s *Session) SaveBranch(data string) error {
	return s.commitBranch("", data, false)
}

func (s *Session) CommitMerge(token, data string) error {
	if token == "" {
		return errInvalid
	}
	return s.commitBranch(token, data, false)
}

func (s *Session) commitBranch(token, data string, strict bool) error {
	return WithWriteLock(s.path, func() error {
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

func (s *Session) deleteReplica() error {
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
	var records []Session
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
			raw, info, e := ReadFile(path)
			if e != nil {
				return e
			}
			record := Session{path: path, info: info, digest: sha256.Sum256(raw)}
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
