package workspacemerge

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"
)

func mergeTestNote(id, title string) mergeObject {
	return mergeObject{"id": id, "title": title, "body": []any{}, "tags": []any{}, "links": []any{}}
}
func mergeTestSpace(notes ...mergeObject) mergeObject {
	rows := make([]any, len(notes))
	for i, n := range notes {
		rows[i] = n
	}
	return mergeObject{"name": "test space", "notes": rows, "areas": []any{}}
}
func mergeTestJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func prepareTestMerge(t *testing.T, base, local, remote mergeObject) *Plan {
	t.Helper()
	plan, err := Prepare(base, local, remote)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestNativeMergeUsesSelectedVersionsAndRepairsReferences(t *testing.T) {
	base := mergeTestSpace(mergeTestNote("hub", "Hub"), mergeTestNote("a", "A"), mergeTestNote("b", "B"), mergeTestNote("gone", "G"))
	hub := mergeMap(mergeArray(base["notes"])[0])
	hub["links"] = []any{"a", "b", "gone", "unknown"}
	l, r := cloneMergeWorkspace(base), cloneMergeWorkspace(base)
	local, remote := mergeArray(l["notes"]), mergeArray(r["notes"])
	mergeMap(local[0])["links"] = []any{"b", "unknown"}
	mergeMap(remote[0])["links"] = []any{"a", "unknown"}
	l["notes"] = []any{local[0], local[2]}
	r["notes"] = []any{remote[0], remote[1]}
	mergeMap(local[2])["title"] = "keep b"
	mergeMap(remote[1])["title"] = "keep a"
	l["name"] = "Local"
	r["name"] = "Remote"
	p := prepareTestMerge(t, base, l, r)
	if len(p.Conflicts()) != 3 {
		t.Fatalf("unexpected conflicts %+v", p.Conflicts())
	}
	if _, _, err := p.Resolve(map[string]string{"note:a": "remote"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("accepted incomplete choices", err)
	}
	result, _, err := p.Resolve(map[string]string{"note:a": "remote", "note:b": "local", "setting:name": "remote"})
	if err != nil {
		t.Fatal(err)
	}
	idx, _ := indexMergeList(result["notes"])
	if !slices.Equal(idx.ids, []string{"hub", "a", "b"}) || result["name"] != "Remote" {
		t.Fatal(result)
	}
	if !mergeEqual(mergeMap(idx.records["hub"])["links"], []any{"unknown", "a", "b"}) {
		t.Fatal(idx.records["hub"])
	}
	other, _, err := p.Resolve(map[string]string{"note:a": "local", "note:b": "remote", "setting:name": "local"})
	if err != nil || len(mergeArray(other["notes"])) != 1 {
		t.Fatal(other, err)
	}
}
func TestNativeMergeNormalizesConcurrentGridSeatsAndSealedRoutes(t *testing.T) {
	base := mergeTestSpace()
	base["areas"] = []any{mergeObject{"id": "p", "name": "Parent", "color": "#abcdef"}, mergeObject{"id": "g", "parentId": "p", "name": "Grid", "color": "#123456", "grid": mergeObject{"rows": float64(1), "cols": float64(1), "x": float64(10), "y": float64(15)}}}
	l, r := cloneMergeWorkspace(base), cloneMergeWorkspace(base)
	a, b := mergeTestNote("a", ""), mergeTestNote("b", "title")
	a["sealed"] = "opaque"
	a["slot"] = float64(0)
	a["areaId"] = "g"
	b["slot"] = float64(0)
	b["areaId"] = "g"
	l["notes"] = []any{b}
	r["notes"] = []any{a}
	l["routes"] = []any{mergeObject{"id": "route", "stops": []any{mergeObject{"noteId": "a", "fragment": "secret"}}}}
	for _, pair := range [][2]mergeObject{{l, r}, {r, l}} {
		pl := prepareTestMerge(t, base, pair[0], pair[1])
		merged, _, err := pl.Resolve(nil)
		if err != nil {
			t.Fatal(err)
		}
		idx, _ := indexMergeList(merged["notes"])
		if !slices.Equal(idx.ids, []string{"a", "b"}) || mergeMap(idx.records["a"])["x"] != float64(10) || mergeMap(idx.records["b"])["areaId"] != "p" || mergeMap(idx.records["b"])["slot"] != nil {
			t.Fatal(merged)
		}
		if strings.Contains(mergeTestJSON(t, merged["routes"]), "secret") {
			t.Fatal("leaked sealed passage")
		}
	}
	if !strings.Contains(mergeTestJSON(t, l["routes"]), "secret") || b["areaId"] != "g" {
		t.Fatal("mutated a snapshot while preparing choices")
	}
}
func TestNativeMergeMetadataFieldsAndNoteDrift(t *testing.T) {
	base := mergeTestSpace(mergeTestNote("n", "hello"))
	base["areas"] = []any{mergeObject{"id": "f", "parentId": nil, "name": "old", "color": "#abcdef"}}
	base["routes"] = []any{mergeObject{"id": "r", "name": "one", "stops": []any{}}}
	left, right := cloneMergeWorkspace(base), cloneMergeWorkspace(base)
	mergeMap(mergeArray(left["areas"])[0])["name"] = "local"
	mergeMap(mergeArray(right["areas"])[0])["color"] = "#123456"
	mergeMap(mergeArray(left["routes"])[0])["name"] = "two"
	mergeMap(mergeArray(right["routes"])[0])["stops"] = []any{mergeObject{"noteId": "n"}}
	l, r := mergeMap(mergeArray(left["notes"])[0]), mergeMap(mergeArray(right["notes"])[0])
	l["x"] = float64(10)
	l["opens"] = float64(7)
	r["x"] = float64(11)
	r["title"] = "edited"
	l["links"] = []any{"a"}
	r["links"] = []any{"z"}
	merged, _, err := prepareTestMerge(t, base, left, right).Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	n := mergeMap(mergeArray(merged["notes"])[0])
	area := mergeMap(mergeArray(merged["areas"])[0])
	route := mergeMap(mergeArray(merged["routes"])[0])
	if n["title"] != "edited" || n["x"] != float64(11) || n["opens"] != float64(7) || !mergeEqual(n["links"], []any{"a", "z"}) || area["name"] != "local" || area["color"] != "#123456" || route["name"] != "two" || len(mergeArray(route["stops"])) != 1 {
		t.Fatal(merged)
	}
	l["pinned"] = true
	r["pinned"] = true
	if p := prepareTestMerge(t, base, left, right); len(p.Conflicts()) != 1 || p.Conflicts()[0].Key != "note:n" {
		t.Fatal(p.Conflicts())
	}
}

func TestRestyledEncryptedNoteMergesWithRemoteCiphertext(t *testing.T) {
	base := mergeTestNote("n", "")
	base["sealed"] = "original"
	local, remote := maps.Clone(base), maps.Clone(base)
	style := mergeObject{"shape": "square", "color": "#abcdef", "icon": "phosphor/house"}
	local["appearance"], remote["sealed"] = style, "updated"
	result, ok := mergedNote(base, local, remote)
	if !ok || mergeMap(result)["sealed"] != "updated" || !mergeEqual(mergeMap(result)["appearance"], style) {
		t.Fatal(result)
	}
	remote["appearance"] = mergeObject{"shape": "triangle"}
	if _, ok := mergedNote(base, local, remote); ok {
		t.Fatal("divergent explicit map styles must be resolved")
	}
}

func TestGroupMovesKeepCoordinatesTogether(t *testing.T) {
	base := mergeTestNote("n", "")
	base["sealed"] = "old"
	local, remote := maps.Clone(base), maps.Clone(base)
	local["mapGroupId"] = "bca45bba-a128-4a37-8065-ea3fe72d8a3e"
	remote["sealed"], remote["x"] = "new", float64(150)
	result, ok := mergedNote(base, local, remote)
	if !ok || !mergeEqual(mergeMap(result)["x"], local["x"]) || mergeMap(result)["sealed"] != "new" {
		t.Fatal("free drift moved a newly grouped member", result)
	}
	grouped := mergeMap(result)
	left, right := maps.Clone(grouped), maps.Clone(grouped)
	left["x"], right["y"] = float64(99), float64(200)
	if _, ok := mergedNote(grouped, left, right); ok || compatibleInkMove(grouped, left, right) {
		t.Fatal("concurrent transforms must not combine their horizontal and vertical components")
	}
}

func TestEncryptedMapLabelMergesIndependently(t *testing.T) {
	base := mergeTestNote("n", "")
	base["sealed"] = "original"
	base["mapLabel"] = "One"
	local, remote := maps.Clone(base), maps.Clone(base)
	style := mergeObject{"shape": "square"}
	remote["appearance"], remote["sealed"] = style, "updated"
	for _, label := range []string{"Two", ""} {
		if label == "" {
			delete(local, "mapLabel")
		} else {
			local["mapLabel"] = label
		}
		result, ok := mergedNote(base, local, remote)
		note := mergeMap(result)
		if !ok || note["sealed"] != "updated" || note["title"] != "" || !mergeEqual(note["appearance"], style) ||
			mergeField(note, "mapLabel") != mergeField(local, "mapLabel") {
			t.Fatal(result)
		}
	}
	local["mapLabel"], remote["mapLabel"] = "Two", "Three"
	if _, ok := mergedNote(base, local, remote); ok {
		t.Fatal("two different renames require a choice")
	}
	delete(remote, "sealed")
	delete(remote, "mapLabel")
	remote["title"] = "Private title"
	if _, ok := mergedNote(base, local, remote); ok {
		t.Fatal("removing protection must travel with its note content")
	}
}
func TestMergePatchPreservesNullAndUnknownFields(t *testing.T) {
	l := mergeTestSpace(mergeTestNote("a", "A"))
	l["obsolete"] = true
	r := maps.Clone(l)
	delete(r, "obsolete")
	r["extension"] = nil
	r["routes"] = []any{}
	p := Diff(l, r)
	if !slices.Equal(p.Unset, []string{"obsolete"}) || len(p.Set) != 2 || p.Set["extension"] != nil {
		t.Fatal(p)
	}
}

func TestConcurrentFirstMapDrawingsMergePerStroke(t *testing.T) {
	base := mergeTestSpace()
	left, right := maps.Clone(base), maps.Clone(base)
	left["mapInk"] = []any{mergeObject{"id": "a", "type": "pen"}}
	right["mapInk"] = []any{mergeObject{"id": "b", "type": "rect"}}
	merged, patch, err := prepareTestMerge(t, base, left, right).Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(mergeArray(merged["mapInk"])) != 2 || len(patch.Lists["mapInk"].Upsert) != 1 {
		t.Fatal(patch)
	}
}
