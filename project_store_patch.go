package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"videron/internal/vault"
	"videron/internal/workspacestore"
)

// Patches describe changes to JSON objects and to the ordered record lists in
// a workspace. Content remains opaque so older clients and extensions can keep
// fields unknown to this version.
type objectEdits struct {
	Set   map[string]json.RawMessage `json:"set"`
	Unset []string                   `json:"unset"`
}
type recordEdits struct {
	Put    []json.RawMessage `json:"put"`
	Edit   []rowEdit         `json:"edit"`
	Remove []string          `json:"remove"`
	Order  []string          `json:"order"`
}
type rowEdit struct {
	objectEdits
	ID         string      `json:"id"`
	TextSplice *textSplice `json:"textSplice"`
}

// The web editor addresses text in UTF-16 code units. Only accept offsets at
// code point boundaries; the revision precondition identifies the source text.
type textSplice struct {
	Start  int    `json:"start"`
	Remove int    `json:"remove"`
	Insert string `json:"insert"`
}

func (s textSplice) apply(raw json.RawMessage) (json.RawMessage, error) {
	var source string
	if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &source) != nil ||
		s.Start < 0 || s.Start > len(source) || s.Remove < 0 || s.Remove > len(source)-s.Start {
		return nil, errInvalid
	}
	start, end, units := -1, -1, 0
	for index := 0; ; {
		if units == s.Start {
			start = index
		}
		if units == s.Start+s.Remove {
			end = index
			break
		}
		if index == len(source) || units > s.Start+s.Remove {
			break
		}
		r, width := utf8.DecodeRuneInString(source[index:])
		units += utf16.RuneLen(r)
		index += width
	}
	if start < 0 || end < 0 {
		return nil, errInvalid
	}
	return json.Marshal(source[:start] + s.Insert + source[end:])
}

func (e rowEdit) apply(raw json.RawMessage, note bool) (json.RawMessage, error) {
	var fields jsonFields
	if json.Unmarshal(raw, &fields) != nil {
		return nil, errInvalid
	}
	// The row index uses the exact JSON key "id". Legacy extension fields
	// such as "ID" are independent and may need removal when sealing a note.
	if e.Set["id"] != nil || slices.Contains(e.Unset, "id") {
		return nil, errInvalid
	}
	updated, err := e.objectEdits.apply(fields)
	if err != nil {
		return nil, err
	}
	if e.TextSplice != nil {
		if !note || e.Set["dataText"] != nil || slices.Contains(e.Unset, "dataText") {
			return nil, errInvalid
		}
		updated["dataText"], err = e.TextSplice.apply(fields["dataText"])
		if err != nil {
			return nil, err
		}
	}
	var dst bytes.Buffer
	beginObject(&dst, updated)
	dst.WriteByte('}')
	result := dst.Bytes()
	if note && storedNotes.Validate(result) != nil {
		return nil, errInvalid
	}
	return result, nil
}

type spaceEdits struct {
	objectEdits
	Notes  *recordEdits `json:"notes"`
	Areas  *recordEdits `json:"areas"`
	MapInk *recordEdits `json:"mapInk"`
}
type catalogSpaceEdits struct {
	spaceEdits
	Replace json.RawMessage `json:"replace"`
	Remove  bool            `json:"remove"`
}
type catalogEdits struct {
	objectEdits
	Spaces map[string]catalogSpaceEdits `json:"spaces"`
}

// Receipts allow an exact retry after a lost IPC response without keeping
// the patch (which can include private note content) in memory.
type savePatchReceipt struct {
	from, to string
	digest   [sha256.Size]byte
}

type jsonFields map[string]json.RawMessage

type recordList struct {
	items map[string]json.RawMessage
	order []string
}

type indexedSpace struct {
	fields               jsonFields
	notes, areas, mapInk *recordList
	folder               bool
}

type indexedCatalog struct {
	fields jsonFields
	spaces map[string]*indexedSpace
}

func decodeEdits(s string, target any) error {
	if !utf8.ValidString(s) || !json.Valid([]byte(s)) || !strings.HasPrefix(strings.TrimSpace(s), "{") {
		return errInvalid
	}
	d := json.NewDecoder(strings.NewReader(s))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return errInvalid
	}
	return nil
}

func (e objectEdits) apply(fields jsonFields, reserved ...string) (jsonFields, error) {
	if len(e.Set) == 0 && len(e.Unset) == 0 {
		return fields, nil
	}
	blocked := func(key string) bool {
		for _, field := range reserved {
			if strings.EqualFold(key, field) {
				return true
			}
		}
		return false
	}
	result := maps.Clone(fields)
	for _, k := range e.Unset {
		if blocked(k) || e.Set[k] != nil {
			return nil, errInvalid
		}
		delete(result, k)
	}
	for k, v := range e.Set {
		if blocked(k) {
			return nil, errInvalid
		}
		result[k] = v
	}
	return result, nil
}

func rowID(raw json.RawMessage) (string, error) {
	var fields jsonFields
	var id *string
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(fields["id"], &id) != nil || id == nil {
		return "", errInvalid
	}
	return *id, nil
}

func indexRecords(raw json.RawMessage) (*recordList, error) {
	var rows []json.RawMessage
	if json.Unmarshal(raw, &rows) != nil || rows == nil {
		return nil, errInvalid
	}
	list := &recordList{items: make(map[string]json.RawMessage, len(rows)), order: make([]string, 0, len(rows))}
	for _, row := range rows {
		id, e := rowID(row)
		if e != nil || list.items[id] != nil {
			return nil, errInvalid
		}
		list.items[id] = row
		list.order = append(list.order, id)
	}
	return list, nil
}

func (e *recordEdits) apply(list *recordList, notes bool) (*recordList, error) {
	if e == nil {
		return list, nil
	}
	if list == nil {
		return nil, errInvalid
	}
	result := &recordList{items: maps.Clone(list.items)}
	touched := make(map[string]bool, len(e.Remove)+len(e.Put)+len(e.Edit))
	for _, id := range e.Remove {
		if result.items[id] == nil || touched[id] {
			return nil, errInvalid
		}
		delete(result.items, id)
		touched[id] = true
	}
	var added []string
	for _, change := range e.Edit {
		current := result.items[change.ID]
		if current == nil || touched[change.ID] {
			return nil, errInvalid
		}
		next, err := change.apply(current, notes)
		if err != nil {
			return nil, err
		}
		result.items[change.ID] = next
		touched[change.ID] = true
	}
	for _, raw := range e.Put {
		id, err := rowID(raw)
		if err != nil || touched[id] {
			return nil, errInvalid
		}
		if notes && storedNotes.Validate(raw) != nil {
			return nil, errInvalid
		}
		if result.items[id] == nil {
			added = append(added, id)
		}
		result.items[id] = raw
		touched[id] = true
	}
	if e.Order != nil {
		if len(e.Order) != len(result.items) {
			return nil, errInvalid
		}
		clear(touched)
		for _, id := range e.Order {
			if result.items[id] == nil || touched[id] {
				return nil, errInvalid
			}
			touched[id] = true
		}
		result.order = e.Order
	} else if len(e.Remove) == 0 && len(added) == 0 {
		result.order = list.order
	} else {
		result.order = make([]string, 0, len(result.items))
		for _, id := range list.order {
			if result.items[id] != nil {
				result.order = append(result.order, id)
			}
		}
		result.order = append(result.order, added...)
	}
	return result, nil
}

func indexSpace(raw json.RawMessage) (*indexedSpace, error) {
	var fields jsonFields
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, errInvalid
	}
	space := &indexedSpace{fields: fields}
	for key := range fields {
		// The legacy Go validator treats folder keys case-insensitively.
		if strings.EqualFold(key, "folder") {
			space.folder = true
			return space, nil
		}
	}
	var err error
	for _, pair := range []struct {
		key  string
		list **recordList
	}{{"notes", &space.notes}, {"areas", &space.areas}, {"mapInk", &space.mapInk}} {
		if fields[pair.key] == nil {
			continue
		}
		*pair.list, err = indexRecords(fields[pair.key])
		if err != nil {
			return nil, err
		}
		delete(fields, pair.key)
	}
	return space, nil
}

func (e spaceEdits) apply(space *indexedSpace) (*indexedSpace, error) {
	if space == nil || space.folder {
		return nil, errInvalid
	}
	next := *space
	var err error
	next.fields, err = e.objectEdits.apply(space.fields, "notes", "areas", "mapInk", "folder", workspacestore.SyncProperty)
	if err != nil {
		return nil, err
	}
	next.notes, err = e.Notes.apply(space.notes, true)
	if err != nil {
		return nil, err
	}
	next.areas, err = e.Areas.apply(space.areas, false)
	if err != nil {
		return nil, err
	}
	if e.MapInk != nil {
		if next.mapInk == nil {
			next.mapInk = &recordList{items: make(map[string]json.RawMessage)}
		}
		next.mapInk, err = e.MapInk.apply(next.mapInk, false)
		if err != nil {
			return nil, err
		}
	}
	return &next, nil
}

func indexCatalog(raw []byte) (*indexedCatalog, error) {
	var fields jsonFields
	if json.Unmarshal(raw, &fields) != nil {
		return nil, errInvalid
	}
	var rawSpaces map[string]json.RawMessage
	if json.Unmarshal(fields["spaces"], &rawSpaces) != nil || rawSpaces == nil {
		return nil, errInvalid
	}
	delete(fields, "spaces")
	out := &indexedCatalog{fields: fields, spaces: make(map[string]*indexedSpace, len(rawSpaces))}
	for key, raw := range rawSpaces {
		space, e := indexSpace(raw)
		if e != nil {
			return nil, e
		}
		out.spaces[key] = space
	}
	return out, nil
}

func (e catalogEdits) apply(old *indexedCatalog) (*indexedCatalog, error) {
	fields, err := e.objectEdits.apply(old.fields, "spaces", "vault")
	if err != nil {
		return nil, err
	}
	next := &indexedCatalog{fields: fields, spaces: maps.Clone(old.spaces)}
	for key, op := range e.Spaces {
		if key == "" {
			return nil, errInvalid
		}
		if op.Remove || op.Replace != nil {
			if len(op.Set)+len(op.Unset) != 0 || op.Notes != nil || op.Areas != nil || op.MapInk != nil {
				return nil, errInvalid
			}
			if op.Remove {
				if op.Replace != nil || next.spaces[key] == nil {
					return nil, errInvalid
				}
				delete(next.spaces, key)
				continue
			}
			// Applies the same folder-link and encrypted note rules as a full Save.
			if (&catalogSpace{}).UnmarshalJSON(op.Replace) != nil {
				return nil, errInvalid
			}
			next.spaces[key], err = indexSpace(op.Replace)
		} else {
			next.spaces[key], err = op.spaceEdits.apply(next.spaces[key])
		}
		if err != nil {
			return nil, err
		}
	}
	// Only metadata and records in the patch can have changed. Validate the
	// resulting catalog header without walking unchanged note bodies again.
	var h libraryHeader
	for key := range fields {
		for _, reserved := range []string{"active", "version", "spaces", "vault"} {
			if key != reserved && strings.EqualFold(key, reserved) {
				return nil, errInvalid
			}
		}
	}
	if raw := fields["version"]; json.Unmarshal(raw, &h.Version) != nil {
		return nil, errInvalid
	}
	if raw := fields["active"]; raw != nil && json.Unmarshal(raw, &h.Active) != nil {
		return nil, errInvalid
	}
	h.Spaces = make(map[string]*catalogSpace, len(next.spaces))
	for key, space := range next.spaces {
		h.Spaces[key] = &catalogSpace{folder: space.folder}
	}
	if !h.validLibrary() {
		return nil, errInvalid
	}
	return next, nil
}

// The input values have already been decoded as RawMessage. Embed their bytes
// directly, preserving large integers and avoiding another recursive JSON scan
// of every drawing or attachment while assembling the file.
type objectWriter struct {
	dst   *bytes.Buffer
	count int
}

func (w *objectWriter) key(k string) {
	if w.count > 0 {
		w.dst.WriteByte(',')
	}
	w.count++
	b, _ := json.Marshal(k)
	w.dst.Write(b)
	w.dst.WriteByte(':')
}
func beginObject(dst *bytes.Buffer, fields jsonFields) *objectWriter {
	dst.WriteByte('{')
	w := &objectWriter{dst: dst}
	for _, k := range slices.Sorted(maps.Keys(fields)) {
		w.key(k)
		dst.Write(fields[k])
	}
	return w
}
func (s *indexedSpace) write(dst *bytes.Buffer) {
	w := beginObject(dst, s.fields)
	for _, pair := range []struct {
		key  string
		list *recordList
	}{{"notes", s.notes}, {"areas", s.areas}, {"mapInk", s.mapInk}} {
		if pair.list == nil {
			continue
		}
		w.key(pair.key)
		dst.WriteByte('[')
		for i, id := range pair.list.order {
			if i > 0 {
				dst.WriteByte(',')
			}
			dst.Write(pair.list.items[id])
		}
		dst.WriteByte(']')
	}
	dst.WriteByte('}')
}
func (c *indexedCatalog) write(dst *bytes.Buffer) {
	w := beginObject(dst, c.fields)
	w.key("spaces")
	spaces := beginObject(dst, nil)
	for _, key := range slices.Sorted(maps.Keys(c.spaces)) {
		spaces.key(key)
		c.spaces[key].write(dst)
	}
	dst.WriteString("}}")
}

// Folder sessions use the same ID and ordering semantics as library spaces.
func applyWorkspacePatch(current []byte, delta string) ([]byte, error) {
	var e spaceEdits
	if err := decodeEdits(delta, &e); err != nil {
		return nil, err
	}
	base, err := indexSpace(current)
	if err != nil {
		return nil, err
	}
	next, err := e.apply(base)
	if err != nil {
		return nil, err
	}
	var dst bytes.Buffer
	dst.Grow(len(current))
	next.write(&dst)
	return dst.Bytes(), nil
}

func (a *App) catalogRevision() string {
	if a.disk == nil {
		return ""
	}
	return hex.EncodeToString(a.diskDigest[:])
}

func (a *App) CatalogRevision() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	return a.catalogRevision(), nil
}

func (a *App) SaveCatalogPatch(expectedRev, delta string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	if expectedRev == "" {
		return "", errChanged
	}
	current := a.catalogRevision()
	digest := sha256.Sum256([]byte(delta))
	if expectedRev != current {
		if a.lastCatalogPatch != (savePatchReceipt{from: expectedRev, to: current, digest: digest}) {
			return "", errChanged
		}
		path, err := workspacestore.CatalogPath()
		if err != nil {
			return "", err
		}
		if err = a.verifyCatalog(path); err != nil {
			return "", err
		}
		return current, nil
	}
	var edits catalogEdits
	if err := decodeEdits(delta, &edits); err != nil {
		return "", err
	}
	base := a.catalogIndex
	if base == nil {
		raw, info, err := readWorkspace()
		if err != nil {
			return "", err
		}
		defer clear(raw)
		if !workspacestore.SameFileState(a.disk, info) || sha256.Sum256(raw) != a.diskDigest {
			return "", errChanged
		}
		if a.projectKey != nil {
			env, err := vault.ParseEnvelope(raw, vault.ProjectScope)
			if err != nil {
				return "", err
			}
			raw, err = a.projectKey.Open(env, "")
			if err != nil {
				return "", err
			}
			defer clear(raw)
		}
		base, err = indexCatalog(raw)
		if err != nil {
			return "", err
		}
	}
	next, err := edits.apply(base)
	if err != nil {
		return "", err
	}
	var dst bytes.Buffer
	if a.disk.Size() > 0 && a.disk.Size() <= int64(^uint(0)>>1) {
		dst.Grow(int(a.disk.Size()))
	}
	next.write(&dst)
	defer clear(dst.Bytes())
	if err := a.writeCatalogBytes(dst.Bytes(), a.projectKey); err != nil {
		return "", err
	}
	base.discardSuperseded(next)
	a.catalogIndex = next
	current = a.catalogRevision()
	a.lastCatalogPatch = savePatchReceipt{from: expectedRev, to: current, digest: digest}
	return current, nil
}

// Clear only the retired buffers. Copy-on-write indexes share the untouched
// RawMessages, while replacing or sealing a note should release its old text.
func wipeRetired(old, keep jsonFields) {
	for k, raw := range old {
		next := keep[k]
		if len(next) == 0 || &next[0] != &raw[0] {
			clear(raw)
		}
	}
}

func (old *indexedCatalog) discardSuperseded(keep *indexedCatalog) {
	if old == nil {
		return
	}
	if keep == nil {
		keep = &indexedCatalog{}
	}
	wipeRetired(old.fields, keep.fields)
	for id, space := range old.spaces {
		next := keep.spaces[id]
		if next == space {
			continue
		}
		if next == nil {
			next = &indexedSpace{}
		}
		wipeRetired(space.fields, next.fields)
		for _, lists := range [][2]*recordList{{space.notes, next.notes}, {space.areas, next.areas}, {space.mapInk, next.mapInk}} {
			if lists[0] == nil || lists[0] == lists[1] {
				continue
			}
			var kept jsonFields
			if lists[1] != nil {
				kept = lists[1].items
			}
			wipeRetired(lists[0].items, kept)
		}
	}
}

func (a *App) clearCatalogIndex() {
	a.lastCatalogPatch = savePatchReceipt{}
	a.catalogIndex.discardSuperseded(nil)
	a.catalogIndex = nil
}
