package workspacestore

import (
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"strings"
	"testing"

	"videron/internal/workspacemerge"
)

func TestNativeMergeWireVolume(t *testing.T) {
	notes := make([]any, 5000)
	content := strings.Repeat("x", 1024)
	for i := range notes {
		notes[i] = map[string]any{
			"id": strconv.Itoa(i), "title": "Sample", "plain": content,
			"body": []any{map[string]any{"type": "paragraph", "runs": []any{map[string]any{"text": content}}}},
			"tags": []any{}, "links": []any{},
		}
	}
	document := func(rows []any) map[string]any {
		return map[string]any{"name": "test space", "notes": rows, "areas": []any{}}
	}
	rename := func(index int, title string) map[string]any {
		rows := slices.Clone(notes)
		note := maps.Clone(notes[index].(map[string]any))
		note["title"] = title
		rows[index] = note
		return document(rows)
	}
	base, local, remote := document(notes), rename(4, "Mine"), rename(6, "Other device")
	plan, err := workspacemerge.Prepare(base, local, remote)
	if err != nil {
		t.Fatal(err)
	}
	_, patch, err := plan.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	patch.Head = strings.Repeat("b", 64)
	token := strings.Repeat("a", 64) + ":" + patch.Head
	proposal := (preparedFolderMerge{token: token, plan: plan}).proposal()
	if !slices.Equal(proposal.ChangedNotes, []string{"6"}) {
		t.Fatalf("unexpected changed notes: %v", proposal.ChangedNotes)
	}
	encode := func(value any) string {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	old := Update{Token: token, Base: encode(base), Remote: encode(remote)}
	offerBytes, patchBytes := len(encode(proposal)), len(encode(patch))
	t.Logf("5000 notes / 1 KiB each repeated in body and plain: old prepare %d bytes, native prepare %d bytes, native commit result %d bytes", len(encode(old)), offerBytes, patchBytes)
	if len(patch.Lists["notes"].Upsert) != 1 || patchBytes > 4096 || offerBytes > 256 {
		t.Fatal("unrelated notes leaked into native wire payload")
	}
}
