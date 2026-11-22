package main

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strconv"
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
	p := newWorkspaceMergePlan("", base, l, r)
	if len(p.conflicts) != 3 {
		t.Fatalf("unexpected conflicts %+v", p.conflicts)
	}
	if _, err := p.resolve(map[string]string{"note:a": "remote"}); !errors.Is(err, errInvalid) {
		t.Fatal("accepted incomplete choices", err)
	}
	result, err := p.resolve(map[string]string{"note:a": "remote", "note:b": "local", "setting:name": "remote"})
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
	other, err := p.resolve(map[string]string{"note:a": "local", "note:b": "remote", "setting:name": "local"})
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
		pl := newWorkspaceMergePlan("", base, pair[0], pair[1])
		merged, err := pl.resolve(nil)
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
	merged, err := newWorkspaceMergePlan("", base, left, right).resolve(nil)
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
	if p := newWorkspaceMergePlan("", base, left, right); len(p.conflicts) != 1 || p.conflicts[0].Key != "note:n" {
		t.Fatal(p.conflicts)
	}
}
func TestFolderNativeMergeAcrossDevices(t *testing.T) {
	for _, pw := range []string{"", testPass} {
		t.Run(map[bool]string{false: "plain", true: "encrypted"}[pw != ""], func(t *testing.T) {
			a, _ := testStore(t)
			b := new(App)
			_, _ = b.Load()
			one, two := t.TempDir(), t.TempDir()
			base := mergeTestSpace(mergeTestNote("a", "A"), mergeTestNote("b", "B"), mergeTestNote("large", strings.Repeat("known only to peers", 6000)))
			if err := a.CreateFolderSpace(one, mergeTestJSON(t, base), pw); err != nil {
				t.Fatal(err)
			}
			if _, err := a.FolderSpaceLineage(one); err != nil {
				t.Fatal(err)
			}
			deliver(t, one, two, true)
			if _, err := b.OpenFolderSpace(two, pw); err != nil {
				t.Fatal(err)
			}
			l, r := cloneMergeWorkspace(base), cloneMergeWorkspace(base)
			mergeMap(mergeArray(l["notes"])[0])["title"] = "A locally"
			mergeMap(mergeArray(r["notes"])[1])["title"] = "B remotely"
			if err := a.SaveFolderBranch(one, mergeTestJSON(t, l)); err != nil {
				t.Fatal(err)
			}
			if err := b.SaveFolderBranch(two, mergeTestJSON(t, r)); err != nil {
				t.Fatal(err)
			}
			deliver(t, two, one, false)
			proposal, err := a.PrepareFolderMerge(one, true, "")
			if err != nil {
				t.Fatal(err)
			}
			if !proposal.Prepared || len(proposal.Conflicts) != 0 || !slices.Equal(proposal.ChangedNotes, []string{"b"}) || len(mergeTestJSON(t, proposal)) > 512 {
				t.Fatalf("unexpected proposal %s", mergeTestJSON(t, proposal))
			}
			known, err := a.PrepareFolderMerge(one, false, proposal.Token)
			if err != nil || known.Prepared || known.Token != proposal.Token {
				t.Fatal(known, err)
			}
			first := proposal.Token
			mergeMap(mergeArray(l["notes"])[0])["title"] = "A typed while preparing"
			if err := a.SaveFolderBranch(one, mergeTestJSON(t, l)); err != nil {
				t.Fatal(err)
			}
			if _, err = a.CommitFolderMergeChoices(one, first, nil); !errors.Is(err, errChanged) {
				t.Fatal("accepted stale proposal", err)
			}
			proposal, err = a.PrepareFolderMerge(one, true, "")
			if err != nil {
				t.Fatal(err)
			}
			patch, err := a.CommitFolderMergeChoices(one, proposal.Token, nil)
			if err != nil {
				t.Fatal(err)
			}
			if !validSyncID(patch.Head) || len(patch.Lists["notes"].Upsert) != 1 || len(mergeTestJSON(t, patch)) > 512 {
				t.Fatalf("unexpected patch %s", mergeTestJSON(t, patch))
			}
			if n := mergeMap(patch.Lists["notes"].Upsert[0]); n["id"] != "b" || n["title"] != "B remotely" {
				t.Fatal(n)
			}
			a.CloseFolderSpace(one)
			opened, err := a.OpenFolderSpace(one, pw)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(opened, "A typed while preparing") || !strings.Contains(opened, "B remotely") {
				t.Fatal("lost concurrent editing")
			}
			deliver(t, one, two, false)
			proposal, err = b.PrepareFolderMerge(two, true, "")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = b.CommitFolderMergeChoices(two, proposal.Token, nil); err != nil {
				t.Fatal(err)
			}
			doc, err := decodeMergeJSON(opened)
			if err != nil {
				t.Fatal(err)
			}
			l, r = cloneMergeWorkspace(mergeMap(doc)), cloneMergeWorkspace(mergeMap(doc))
			mergeMap(mergeArray(l["notes"])[0])["title"] = "choose local"
			mergeMap(mergeArray(r["notes"])[0])["title"] = "choose remote"
			if err = a.SaveFolderBranch(one, mergeTestJSON(t, l)); err != nil {
				t.Fatal(err)
			}
			if err = b.SaveFolderBranch(two, mergeTestJSON(t, r)); err != nil {
				t.Fatal(err)
			}
			deliver(t, two, one, false)
			proposal, err = a.PrepareFolderMerge(one, true, "")
			if err != nil {
				t.Fatal(err)
			}
			if len(proposal.Conflicts) != 1 || proposal.Conflicts[0].Key != "note:a" || strings.Contains(mergeTestJSON(t, proposal), "known only to peers") {
				t.Fatal("missing conflict or unrelated data crossed the bridge")
			}
			if _, err = a.CommitFolderMergeChoices(one, proposal.Token, nil); !errors.Is(err, errInvalid) {
				t.Fatal("accepted unresolved", err)
			}
			choices := map[string]string{"note:a": "remote"}
			firstReply, err := a.CommitFolderMergeChoices(one, proposal.Token, choices)
			if err != nil {
				t.Fatal(err)
			}
			replay, err := a.CommitFolderMergeChoices(one, proposal.Token, choices)
			if err != nil || mergeTestJSON(t, replay) != mergeTestJSON(t, firstReply) {
				t.Fatal("lost commit reply was not recoverable", err)
			}
			if _, err = a.CommitFolderMergeChoices(one, proposal.Token, map[string]string{"note:a": "local"}); !errors.Is(err, errChanged) {
				t.Fatal("accepted a different choice after committing", err)
			}
			a.CloseFolderSpace(one)
			got, err := a.OpenFolderSpace(one, pw)
			if err != nil || !strings.Contains(got, "choose remote") {
				t.Fatal("choice not persisted", err)
			}
		})
	}
}
func TestMergePatchPreservesNullAndUnknownFields(t *testing.T) {
	l := mergeTestSpace(mergeTestNote("a", "A"))
	l["obsolete"] = true
	r := maps.Clone(l)
	delete(r, "obsolete")
	r["extension"] = nil
	r["routes"] = []any{}
	p := buildMergePatch(l, r)
	if !slices.Equal(p.Unset, []string{"obsolete"}) || len(p.Set) != 2 || p.Set["extension"] != nil {
		t.Fatal(p)
	}
}
func TestNativeMergeWireVolume(t *testing.T) {
	notes := make([]mergeObject, 5000)
	for i := range notes {
		notes[i] = mergeTestNote(strconv.Itoa(i), "Sample")
		content := strings.Repeat("x", 1024)
		notes[i]["plain"] = content
		notes[i]["body"] = []any{mergeObject{"type": "paragraph", "runs": []any{mergeObject{"text": content}}}}
	}
	base := mergeTestSpace(notes...)
	local, remote := cloneMergeWorkspace(base), cloneMergeWorkspace(base)
	mergeMap(mergeArray(local["notes"])[4])["title"] = "Mine"
	mergeMap(mergeArray(remote["notes"])[6])["title"] = "Other device"
	p := newWorkspaceMergePlan("heads", base, local, remote)
	result, err := p.resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	patch := buildMergePatch(local, result)
	patch.Head = strings.Repeat("b", 64)
	proposal := FolderMergeProposal{Prepared: true, Token: strings.Repeat("a", 64) + ":" + strings.Repeat("b", 64), ChangedNotes: []string{"6"}}
	old := FolderSpaceUpdate{Token: proposal.Token, Base: mergeTestJSON(t, base), Remote: mergeTestJSON(t, remote)}
	oldBytes := len(mergeTestJSON(t, old))
	offerBytes := len(mergeTestJSON(t, proposal))
	patchBytes := len(mergeTestJSON(t, patch))
	t.Logf("5000 notes / 1 KiB each repeated in body and plain: old prepare %d bytes, native prepare %d bytes, native commit result %d bytes", oldBytes, offerBytes, patchBytes)
	if len(patch.Lists["notes"].Upsert) != 1 || patchBytes > 4096 || offerBytes > 256 {
		t.Fatal("unrelated notes leaked into native wire payload")
	}
}
