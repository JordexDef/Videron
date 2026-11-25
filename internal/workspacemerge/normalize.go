package workspacemerge

import (
	"maps"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
)

var mergeAreaColor = regexp.MustCompile("^(?i:#[a-f0-9]{6})$")

// NormalizedCopy validates a revision and repairs grid placement, area nesting
// and route fragments on a copy. Immutable note bodies are shared.
func NormalizedCopy(doc map[string]any) (map[string]any, error) {
	normalized := cloneMergeWorkspace(doc)
	if err := normalizeMergeWorkspace(normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

// Merging can repair map placement, incoming links and route fragments.
// Only these containers need new ownership; large note bodies stay immutable.
func cloneMergeWorkspace(doc mergeObject) mergeObject {
	out := maps.Clone(doc)
	for _, key := range []string{"notes", "areas", "routes"} {
		items, ok := doc[key].([]any)
		if !ok {
			continue
		}
		records := make([]any, len(items))
		for i, value := range items {
			obj := mergeMap(value)
			if obj == nil {
				records[i] = value
				continue
			}
			obj = maps.Clone(obj)
			records[i] = obj
			if key == "areas" {
				if grid := mergeMap(obj["grid"]); grid != nil {
					obj["grid"] = maps.Clone(grid)
				}
			}
			if key == "routes" {
				if stops, ok := obj["stops"].([]any); ok {
					owned := make([]any, len(stops))
					for j, stop := range stops {
						if record := mergeMap(stop); record != nil {
							owned[j] = maps.Clone(record)
						} else {
							owned[j] = stop
						}
					}
					obj["stops"] = owned
				}
			}
		}
		out[key] = records
	}
	return out
}
func mergeInt(v any, min, max int) (int, bool) {
	f, ok := mergeNumber(v)
	if !ok || math.Trunc(f) != f || f < float64(min) || f > float64(max) {
		return 0, false
	}
	return int(f), true
}
func validMergeBoard(v any) bool {
	board := mergeMap(v)
	_, versionOK := mergeInt(board["version"], 1, 2)
	_, elementsOK := board["elements"].([]any)
	return versionOK && elementsOK
}
func validateMergeNote(n mergeObject) bool {
	_, id := n["id"].(string)
	title, titleOK := n["title"].(string)
	body, bodyOK := n["body"].([]any)
	_, links := n["links"].([]any)
	tags, tagsOK := n["tags"].([]any)
	if !id || !titleOK || !bodyOK || !links || !tagsOK {
		return false
	}
	if v, protected := n["sealed"]; protected {
		sealed, ok := v.(string)
		if !ok || sealed == "" || title != "" || mergeTruthy(n["plain"]) || len(body) != 0 || len(tags) != 0 || mergeTruthy(n["board"]) {
			return false
		}
		for _, k := range []string{"dataText", "dataLanguage", "dataHasHeader", "agentTask"} {
			if _, ex := n[k]; ex {
				return false
			}
		}
	}
	switch n["type"] {
	case "data":
		if _, ok := n["dataText"].(string); !ok {
			return false
		}
		if v, ex := n["dataLanguage"]; ex {
			if _, ok := v.(string); !ok {
				return false
			}
		}
		if v, ex := n["dataHasHeader"]; ex {
			if _, ok := v.(bool); !ok {
				return false
			}
		}
	case "canvas":
		if !validMergeBoard(n["board"]) {
			return false
		}
	}
	for _, v := range body {
		block := mergeMap(v)
		if block["type"] == "drawing" && mergeTruthy(block["board"]) && !validMergeBoard(block["board"]) {
			return false
		}
	}
	return true
}

type mergeGrid struct {
	rows, cols   int
	x, y, dx, dy float64
	used         map[int]bool
	next         int
}

func readMergeGrid(area mergeObject) *mergeGrid {
	obj := mergeMap(area["grid"])
	if obj == nil {
		if mergeTruthy(area["grid"]) {
			delete(area, "grid")
		}
		return nil
	}
	rows, rok := mergeInt(obj["rows"], 1, 100)
	cols, cok := mergeInt(obj["cols"], 1, 100)
	if !rok || !cok {
		delete(area, "grid")
		return nil
	}
	stages, valid := obj["stages"].([]any)
	valid = valid && len(stages) == cols
	for _, name := range stages {
		v := mergeString(name)
		if strings.TrimSpace(v) == "" || len(utf16.Encode([]rune(v))) > 80 {
			valid = false
			break
		}
	}
	if !valid {
		delete(obj, "stages")
	}
	dx, ok := mergeInt(obj["spacing"], 24, 320)
	if !ok {
		delete(obj, "spacing")
		dx = 184
	}
	dy, ok := mergeInt(obj["rowSpacing"], 24, 320)
	if !ok {
		delete(obj, "rowSpacing")
		dy = dx
	}
	x, ok := mergeNumber(obj["x"])
	if !ok {
		obj["x"] = float64(0)
	}
	y, ok := mergeNumber(obj["y"])
	if !ok {
		obj["y"] = float64(0)
	}
	return &mergeGrid{rows: rows, cols: cols, x: x, y: y, dx: float64(dx), dy: float64(dy), used: map[int]bool{}}
}
func (g *mergeGrid) setPoint(note mergeObject, slot int) {
	note["x"] = g.x + float64(slot%g.cols)*g.dx
	note["y"] = g.y + float64(slot/g.cols)*g.dy
}
func normalizeMergeWorkspace(doc mergeObject) error {
	if _, folder := doc["folder"]; folder {
		return ErrInvalid
	}
	name := mergeString(doc["name"])
	if strings.TrimSpace(name) == "" || len([]rune(name)) > 80 {
		return ErrInvalid
	}
	notes, ok := doc["notes"].([]any)
	if !ok {
		return ErrInvalid
	}
	areas, ok := doc["areas"].([]any)
	if !ok {
		return ErrInvalid
	}
	byID := map[string]mergeObject{}
	grids := map[string]*mergeGrid{}
	for _, v := range areas {
		a := mergeMap(v)
		id := mergeString(a["id"])
		_, named := a["name"].(string)
		if id == "" || byID[id] != nil || !named || !mergeAreaColor.MatchString(mergeString(a["color"])) {
			return ErrInvalid
		}
		byID[id] = a
		if g := readMergeGrid(a); g != nil {
			grids[id] = g
		}
	}
	resolved := map[string]bool{}
	for _, v := range areas {
		chain := map[string]bool{}
		for a := mergeMap(v); a != nil; {
			id := mergeString(a["id"])
			if resolved[id] {
				break
			}
			chain[id] = true
			parent := mergeString(a["parentId"])
			if byID[parent] == nil || chain[parent] {
				a["parentId"] = nil
				break
			}
			a = byID[parent]
		}
		for id := range chain {
			resolved[id] = true
		}
	}
	ids := map[string]bool{}
	sealed := map[string]bool{}
	pending := map[string][]mergeObject{}
	var repairOrder []string
	for _, v := range notes {
		n := mergeMap(v)
		id := mergeString(n["id"])
		if !validateMergeNote(n) || ids[id] {
			return ErrInvalid
		}
		ids[id] = true
		if _, protected := n["sealed"]; protected {
			sealed[id] = true
		}
		area := mergeString(n["areaId"])
		if n["areaId"] != nil && byID[area] == nil {
			n["areaId"] = nil
		}
		g := grids[area]
		if g == nil {
			if n["slot"] != nil {
				n["slot"] = nil
			}
			continue
		}
		if s, ok := mergeInt(n["slot"], 0, g.cols*g.rows-1); ok && !g.used[s] {
			g.used[s] = true
			g.setPoint(n, s)
			continue
		}
		if _, exists := pending[area]; !exists {
			repairOrder = append(repairOrder, area)
		}
		pending[area] = append(pending[area], n)
	}
	for _, from := range repairOrder {
		id := from
		waiting := pending[from]
		for len(waiting) > 0 {
			g := grids[id]
			if g == nil {
				for _, n := range waiting {
					if id != "" {
						n["areaId"] = id
					} else {
						n["areaId"] = nil
					}
					if n["slot"] != nil {
						n["slot"] = nil
					}
				}
				break
			}
			for len(waiting) > 0 {
				for g.used[g.next] {
					g.next++
				}
				if g.next >= g.rows*g.cols {
					break
				}
				n := waiting[0]
				waiting = waiting[1:]
				n["areaId"] = id
				n["slot"] = float64(g.next)
				g.setPoint(n, g.next)
				g.used[g.next] = true
				g.next++
			}
			id = mergeString(byID[id]["parentId"])
		}
	}
	if len(sealed) > 0 {
		for _, r := range mergeArray(doc["routes"]) {
			for _, v := range mergeArray(mergeMap(r)["stops"]) {
				stop := mergeMap(v)
				if sealed[mergeString(stop["noteId"])] && mergeTruthy(stop["fragment"]) {
					stop["fragment"] = nil
				}
			}
		}
	}
	return nil
}
