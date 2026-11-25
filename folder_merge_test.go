package main

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strconv"
	"strings"
	"testing"

	"videron/internal/workspacemerge"
)

type mergeObject = map[string]any

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
func withTestNoteTitle(doc mergeObject, index int, title string) mergeObject {
	changed := maps.Clone(doc)
	rows := slices.Clone(doc["notes"].([]any))
	note := maps.Clone(rows[index].(mergeObject))
	note["title"] = title
	rows[index] = note
	changed["notes"] = rows
	return changed
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
			l := withTestNoteTitle(base, 0, "A locally")
			r := withTestNoteTitle(base, 1, "B remotely")
			l["mapInk"] = []any{mergeObject{"id": "left-frame", "type": "rect", "glow": true}}
			r["mapInk"] = []any{mergeObject{"id": "right-pen", "type": "pen"}}
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
			l = withTestNoteTitle(l, 0, "A typed while preparing")
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
			if n := patch.Lists["notes"].Upsert[0].(mergeObject); n["id"] != "b" || n["title"] != "B remotely" {
				t.Fatal(n)
			}
			ink := patch.Lists["mapInk"]
			if len(ink.Upsert) != 1 || ink.Upsert[0].(mergeObject)["id"] != "right-pen" {
				t.Fatal(ink)
			}
			a.CloseFolderSpace(one)
			opened, err := a.OpenFolderSpace(one, pw)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(opened, "A typed while preparing") || !strings.Contains(opened, "B remotely") {
				t.Fatal("lost concurrent editing")
			}
			if !strings.Contains(opened, "left-frame") || !strings.Contains(opened, "right-pen") {
				t.Fatal("lost a map drawing")
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
			l = withTestNoteTitle(doc.(mergeObject), 0, "choose local")
			r = withTestNoteTitle(doc.(mergeObject), 0, "choose remote")
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
func TestNativeMergeWireVolume(t *testing.T) {
	notes := make([]mergeObject, 5000)
	for i := range notes {
		notes[i] = mergeTestNote(strconv.Itoa(i), "Sample")
		content := strings.Repeat("x", 1024)
		notes[i]["plain"] = content
		notes[i]["body"] = []any{mergeObject{"type": "paragraph", "runs": []any{mergeObject{"text": content}}}}
	}
	base := mergeTestSpace(notes...)
	local := withTestNoteTitle(base, 4, "Mine")
	remote := withTestNoteTitle(base, 6, "Other device")
	plan, err := workspacemerge.Prepare(base, local, remote)
	if err != nil {
		t.Fatal(err)
	}
	_, patch, err := plan.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	patch.Head = strings.Repeat("b", 64)
	token := strings.Repeat("a", 64) + ":" + strings.Repeat("b", 64)
	proposal := (preparedFolderMerge{token: token, plan: plan}).proposal()
	if !slices.Equal(proposal.ChangedNotes, []string{"6"}) {
		t.Fatalf("unexpected changed notes: %v", proposal.ChangedNotes)
	}
	old := FolderSpaceUpdate{Token: proposal.Token, Base: mergeTestJSON(t, base), Remote: mergeTestJSON(t, remote)}
	oldBytes := len(mergeTestJSON(t, old))
	offerBytes := len(mergeTestJSON(t, proposal))
	patchBytes := len(mergeTestJSON(t, FolderMergePatch(patch)))
	t.Logf("5000 notes / 1 KiB each repeated in body and plain: old prepare %d bytes, native prepare %d bytes, native commit result %d bytes", oldBytes, offerBytes, patchBytes)
	if len(patch.Lists["notes"].Upsert) != 1 || patchBytes > 4096 || offerBytes > 256 {
		t.Fatal("unrelated notes leaked into native wire payload")
	}
}
