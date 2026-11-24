package main

import (
	"cmp"
	"encoding/json"
	"maps"
	"math"
	"math/big"
	"reflect"
	"slices"
	"strings"
	"unicode/utf16"
)

// Missing is distinct from an explicitly stored JSON null, including in future fields.
type mergeAbsent struct{}

var absentField = mergeAbsent{}

type mergeObject = map[string]any

func mergeField(obj mergeObject, key string) any {
	if value, exists := obj[key]; exists {
		return value
	}
	return absentField
}
func mergeMap(v any) mergeObject { m, _ := v.(map[string]any); return m }
func mergeArray(v any) []any     { a, _ := v.([]any); return a }
func mergeString(v any) string   { s, _ := v.(string); return s }
func mergeNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, e := n.Float64()
		return f, e == nil && !math.IsInf(f, 0)
	case float64:
		return n, true
	default:
		return 0, false
	}
}
func mergeTruthy(v any) bool {
	switch n := v.(type) {
	case nil, mergeAbsent:
		return false
	case string:
		return n != ""
	case bool:
		return n
	case float64:
		return n != 0
	case json.Number:
		f, _ := n.Float64()
		return f != 0
	default:
		return true
	}
}
func mergeEqual(a, b any) bool {
	switch l := a.(type) {
	case map[string]any:
		r, ok := b.(map[string]any)
		if !ok || len(l) != len(r) {
			return false
		}
		if reflect.ValueOf(l).Pointer() == reflect.ValueOf(r).Pointer() {
			return true
		}
		for key, v := range l {
			other, exists := r[key]
			if !exists || !mergeEqual(v, other) {
				return false
			}
		}
		return true
	case []any:
		r, ok := b.([]any)
		if !ok || len(l) != len(r) {
			return false
		}
		if len(l) > 0 && &l[0] == &r[0] {
			return true
		}
		for i, v := range l {
			if !mergeEqual(v, r[i]) {
				return false
			}
		}
		return true
	case json.Number, float64:
		if a == b {
			return true
		}
		x, ok := mergeNumber(a)
		y, other := mergeNumber(b)
		if !ok || !other || x != y {
			return false
		}
		// Preserve large integer/decimal metadata even when its two spellings
		// round to the same float64. Most fields exit on exact equality above.
		if x, ok := a.(json.Number); ok {
			if y, ok := b.(json.Number); ok {
				l, validL := new(big.Rat).SetString(string(x))
				r, validR := new(big.Rat).SetString(string(y))
				return validL && validR && l.Cmp(r) == 0
			}
		}
		return true
	default:
		return a == b
	}
}

func threeWayValue(base, local, remote any) (any, bool) {
	if mergeEqual(local, remote) || mergeEqual(remote, base) {
		return local, true
	}
	if mergeEqual(local, base) {
		return remote, true
	}
	return nil, false
}
func sortedMergeKeys(objects ...mergeObject) []string {
	keys := map[string]bool{}
	for _, obj := range objects {
		for k := range obj {
			keys[k] = true
		}
	}
	return slices.SortedFunc(maps.Keys(keys), compareMergeIDs)
}

// Match JavaScript's UTF-16 sort for IDs supplied by older clients and plugins.
func compareMergeIDs(a, b string) int {
	if strings.IndexFunc(a, func(r rune) bool { return r > 0xffff }) < 0 && strings.IndexFunc(b, func(r rune) bool { return r > 0xffff }) < 0 {
		return cmp.Compare(a, b)
	}
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}
func mergeRecordFields(base, local, remote mergeObject) (any, bool) {
	out := mergeObject{}
	for _, k := range sortedMergeKeys(base, local, remote) {
		val, ok := threeWayValue(mergeField(base, k), mergeField(local, k), mergeField(remote, k))
		if !ok {
			return nil, false
		}
		if val != absentField {
			out[k] = val
		}
	}
	return out, true
}

func mergeLocationKey(k string) bool {
	return k == "slot" || k == "areaId" || k == "pinned" || k == "mapGroupId"
}
func mergeTransientKey(k string) bool { return k == "x" || k == "y" || k == "opens" || k == "modified" }
func mergePointKey(k string) bool     { return k == "x" || k == "y" }
func mergeContentKey(k string) bool {
	return !mergeLocationKey(k) && !mergeTransientKey(k) && k != "links"
}
func mergeSubset(record mergeObject, keep func(string) bool) any {
	if record == nil {
		return absentField
	}
	m := mergeObject{}
	for k, v := range record {
		if keep(k) {
			m[k] = v
		}
	}
	return m
}
func stableNoteFields(note mergeObject) any {
	return mergeSubset(note, func(k string) bool {
		return !mergeTransientKey(k) || mergePointKey(k) && (mergeTruthy(note["pinned"]) || note["mapGroupId"] != nil)
	})
}
func stringEntries(v any) map[string]bool {
	out := map[string]bool{}
	for _, id := range mergeArray(v) {
		if s, ok := id.(string); ok {
			out[s] = true
		}
	}
	return out
}
func mergeLinks(base, local, remote any) any {
	if val, ok := threeWayValue(base, local, remote); ok {
		return val
	}
	b, l, r := stringEntries(base), stringEntries(local), stringEntries(remote)
	out := []any{}
	added := map[string]bool{}
	seen := map[string]bool{}
	for _, value := range mergeArray(base) {
		id, ok := value.(string)
		if ok && l[id] && r[id] && !seen[id] {
			out = append(out, id)
			seen[id] = true
		}
	}
	for _, side := range []map[string]bool{l, r} {
		for id := range side {
			if !b[id] {
				added[id] = true
			}
		}
	}
	for _, id := range slices.SortedFunc(maps.Keys(added), compareMergeIDs) {
		out = append(out, id)
	}
	return out
}
func mergedNote(base, local, remote mergeObject) (any, bool) {
	// Merge each public map field independently of the ciphertext while sealed.
	// On a change of protection they travel with the note's content.
	separateMapFields := base["sealed"] != nil && local["sealed"] != nil && remote["sealed"] != nil
	mapFields := []string{"appearance", "mapLabel"}
	contentKey := func(k string) bool {
		return mergeContentKey(k) && !(separateMapFields && slices.Contains(mapFields, k))
	}
	content, ok := threeWayValue(mergeSubset(base, contentKey), mergeSubset(local, contentKey), mergeSubset(remote, contentKey))
	if !ok {
		return nil, false
	}
	leftLoc, rightLoc := mergeSubset(local, mergeLocationKey), mergeSubset(remote, mergeLocationKey)
	loc, ok := threeWayValue(mergeSubset(base, mergeLocationKey), leftLoc, rightLoc)
	if !ok {
		return nil, false
	}
	left, right := mergeSubset(local, mergePointKey), mergeSubset(remote, mergePointKey)
	point, ok := threeWayValue(mergeSubset(base, mergePointKey), left, right)
	group := mergeMap(loc)["mapGroupId"]
	if group != nil && !mergeEqual(local["mapGroupId"], remote["mapGroupId"]) {
		point, ok = right, true
		if mergeEqual(group, local["mapGroupId"]) {
			point = left
		}
	}
	if !ok {
		if (mergeTruthy(mergeMap(loc)["pinned"]) || group != nil) && mergeMap(loc)["slot"] == nil {
			return nil, false
		}
		point = right
		if !mergeEqual(leftLoc, rightLoc) {
			if mergeEqual(loc, leftLoc) {
				point = left
			}
		} else {
			lx, _ := mergeNumber(local["x"])
			rx, _ := mergeNumber(remote["x"])
			ly, _ := mergeNumber(local["y"])
			ry, _ := mergeNumber(remote["y"])
			if lx > rx || mergeEqual(mergeField(local, "x"), mergeField(remote, "x")) && ly > ry {
				point = left
			}
		}
	}
	result := maps.Clone(mergeMap(content))
	if separateMapFields {
		for _, field := range mapFields {
			value, ok := threeWayValue(mergeField(base, field), mergeField(local, field), mergeField(remote, field))
			if !ok {
				return nil, false
			}
			if value != absentField {
				result[field] = value
			}
		}
	}
	maps.Copy(result, mergeMap(loc))
	maps.Copy(result, mergeMap(point))
	if links := mergeLinks(mergeField(base, "links"), local["links"], remote["links"]); links != absentField {
		result["links"] = links
	}
	for _, k := range []string{"opens", "modified"} {
		l, hasL := mergeNumber(local[k])
		r, hasR := mergeNumber(remote[k])
		if hasL && (!hasR || l >= r) {
			result[k] = local[k]
		} else if hasR {
			result[k] = remote[k]
		}
	}
	return result, true
}

type mergeIndex struct {
	ids     []string
	records map[string]any
}

func indexMergeList(value any) (mergeIndex, bool) {
	index := mergeIndex{ids: []string{}, records: map[string]any{}}
	if value == absentField {
		return index, true
	}
	list, valid := value.([]any)
	if !valid {
		return index, false
	}
	for _, item := range list {
		id, ok := mergeMap(item)["id"].(string)
		if !ok {
			return index, false
		}
		if _, exists := index.records[id]; exists {
			return index, false
		}
		index.ids = append(index.ids, id)
		index.records[id] = item
	}
	return index, true
}

type FolderMergeConflict struct {
	Key    string `json:"key"`
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Local  any    `json:"local"`
	Remote any    `json:"remote"`
}
type mergeDecision struct {
	key           string
	local, remote any
}
type mergeListTemplate []any
type workspaceMergePlan struct {
	token     string
	local     mergeObject
	sources   [3]mergeObject
	template  mergeObject
	conflicts []FolderMergeConflict
	ready     mergeObject
	patch     FolderMergePatch
}

func displayMergeValue(v any) any {
	if v == absentField {
		return nil
	}
	return v
}
func (p *workspaceMergePlan) choose(kind, id string, local, remote any) any {
	key := kind + ":" + id
	p.conflicts = append(p.conflicts, FolderMergeConflict{key, kind, id, displayMergeValue(local), displayMergeValue(remote)})
	return mergeDecision{key, local, remote}
}
func (p *workspaceMergePlan) mergeCollection(kind string, b, l, r mergeIndex) any {
	order := b.ids
	if slices.Equal(l.ids, r.ids) || slices.Equal(r.ids, b.ids) {
		order = l.ids
	} else if slices.Equal(l.ids, b.ids) {
		order = r.ids
	}
	added := map[string]bool{}
	for _, i := range []mergeIndex{l, r} {
		for _, id := range i.ids {
			if _, exists := b.records[id]; !exists {
				added[id] = true
			}
		}
	}
	ids := slices.Concat(order, b.ids, slices.SortedFunc(maps.Keys(added), compareMergeIDs))
	out := mergeListTemplate{}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		bv, lv, rv := mergeField(b.records, id), mergeField(l.records, id), mergeField(r.records, id)
		item, ok := threeWayValue(bv, lv, rv)
		if !ok {
			before, left, right := mergeMap(bv), mergeMap(lv), mergeMap(rv)
			if left != nil && right != nil {
				if kind == "note" {
					item, ok = mergedNote(before, left, right)
				} else if before != nil && (kind != "ink" || compatibleInkMove(before, left, right)) {
					item, ok = mergeRecordFields(before, left, right)
				}
			} else if kind == "note" && before != nil {
				remaining := left
				if remaining == nil {
					remaining = right
				}
				if mergeEqual(stableNoteFields(before), stableNoteFields(remaining)) {
					continue
				}
			}
			if !ok {
				item = p.choose(kind, id, lv, rv)
			}
		}
		if item != absentField {
			out = append(out, item)
		}
	}
	return out
}

// A rigid translation is one coordinate pair, even when one peer only moved
// the group horizontally and another only moved it vertically.
func compatibleInkMove(before, left, right mergeObject) bool {
	if left["mapGroupId"] == nil && right["mapGroupId"] == nil {
		return true
	}
	_, ok := threeWayValue(mergeSubset(before, mergePointKey), mergeSubset(left, mergePointKey), mergeSubset(right, mergePointKey))
	return ok
}
func mergeCollectionKind(key string) string {
	switch key {
	case "notes":
		return "note"
	case "areas":
		return "area"
	case "routes":
		return "route"
	case "mapInk":
		return "ink"
	}
	return ""
}
func newWorkspaceMergePlan(token string, b, l, r mergeObject) *workspaceMergePlan {
	p := &workspaceMergePlan{token: token, local: l, sources: [3]mergeObject{b, l, r}, template: mergeObject{}}
	for _, key := range sortedMergeKeys(b, l, r) {
		base, local, remote := mergeField(b, key), mergeField(l, key), mergeField(r, key)
		value, ok := threeWayValue(base, local, remote)
		if !ok {
			if kind := mergeCollectionKind(key); kind != "" {
				old, bok := indexMergeList(base)
				left, lok := indexMergeList(local)
				right, rok := indexMergeList(remote)
				if bok && lok && rok {
					value = p.mergeCollection(kind, old, left, right)
					ok = true
				}
			}
			if !ok {
				value = p.choose("setting", key, local, remote)
			}
		}
		if value != absentField {
			p.template[key] = value
		}
	}
	return p
}
func resolveMergeDecision(v any, choices map[string]string) any {
	if decision, ok := v.(mergeDecision); ok {
		if choices[decision.key] == "remote" {
			return decision.remote
		}
		return decision.local
	}
	return v
}
func (p *workspaceMergePlan) resolve(choices map[string]string) (mergeObject, error) {
	if len(choices) != len(p.conflicts) {
		return nil, errInvalid
	}
	for _, c := range p.conflicts {
		if side := choices[c.Key]; side != "remote" && side != "local" {
			return nil, errInvalid
		}
	}
	out := mergeObject{}
	for key, v := range p.template {
		if list, ok := v.(mergeListTemplate); ok {
			entries := make([]any, 0, len(list))
			for _, item := range list {
				if selected := resolveMergeDecision(item, choices); selected != absentField {
					entries = append(entries, selected)
				}
			}
			out[key] = entries
		} else if selected := resolveMergeDecision(v, choices); selected != absentField {
			out[key] = selected
		}
	}
	// Copy only the mutable map fields, leaving document bodies and large values shared.
	out = cloneMergeWorkspace(out)
	repairMergeLinks(out, p.sources)
	if err := normalizeMergeWorkspace(out); err != nil {
		return nil, err
	}
	return out, nil
}
func repairMergeLinks(doc mergeObject, sources [3]mergeObject) {
	result, _ := indexMergeList(doc["notes"])
	n := [3]mergeIndex{}
	for i, s := range sources {
		n[i], _ = indexMergeList(s["notes"])
	}
	if slices.Equal(result.ids, n[0].ids) && slices.Equal(result.ids, n[1].ids) && slices.Equal(result.ids, n[2].ids) {
		return
	}
	removed := map[string]bool{}
	survivors := map[string]int{}
	for i, index := range n {
		for _, id := range index.ids {
			if _, keep := result.records[id]; !keep {
				removed[id] = true
				continue
			}
			if i == 0 {
				if _, ok := n[1].records[id]; !ok {
					survivors[id] = 2
				} else if _, ok := n[2].records[id]; !ok {
					survivors[id] = 1
				}
			}
		}
	}
	if len(removed) == 0 && len(survivors) == 0 {
		return
	}
	for id, v := range result.records {
		note := mergeMap(v)
		existing := map[string]bool{}
		original := mergeArray(note["links"])
		links := make([]any, 0, len(original))
		for _, target := range original {
			t, ok := target.(string)
			if !ok || !removed[t] {
				links = append(links, target)
				if ok {
					existing[t] = true
				}
			}
		}
		var sideLinks [3]map[string]bool
		for _, target := range mergeArray(mergeMap(n[0].records[id])["links"]) {
			t := mergeString(target)
			side, kept := survivors[t]
			if !kept || existing[t] {
				continue
			}
			if sideLinks[side] == nil {
				sideLinks[side] = stringEntries(mergeMap(n[side].records[id])["links"])
			}
			if sideLinks[side][t] {
				links = append(links, t)
				existing[t] = true
			}
		}
		note["links"] = links
	}
}
