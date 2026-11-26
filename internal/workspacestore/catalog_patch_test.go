package workspacestore

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"videron/internal/vault"
)

func sameTestJSON(t *testing.T, a, b []byte) {
	t.Helper()
	var actual, want any
	for _, item := range []struct {
		data  []byte
		value *any
	}{{a, &actual}, {b, &want}} {
		d := json.NewDecoder(bytes.NewReader(item.data))
		d.UseNumber()
		if err := d.Decode(item.value); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(actual, want) {
		t.Fatal("unexpected JSON document", string(a))
	}
}

func TestEditedFieldsPreserveUnknownDataAndRejectInvalidBoundaries(t *testing.T) {
	store := New[fixtureNote]()
	initial := []byte(`{"name":"data","notes":[{"id":"n","ID":"legacy","dataText":"я😀猫Z","plugin":{"n":9007199254740993},"drop":0}],"areas":[]}`)
	raw := `{"notes":{"edit":[{"id":"n","textSplice":{"start":1,"remove":2,"insert":"😇ß"},"unset":["drop","ID"],"set":{"title":"renamed"}}]}}`
	next, err := store.applyWorkspacePatch(initial, raw)
	if err != nil {
		t.Fatal(err)
	}
	sameTestJSON(t, next, []byte(`{"name":"data","notes":[{"id":"n","dataText":"я😇ß猫Z","title":"renamed","plugin":{"n":9007199254740993}}],"areas":[]}`))
	for _, bad := range []string{
		`{"notes":{"edit":[{"id":"n","textSplice":{"start":2,"remove":0}}]}}`,
		`{"notes":{"edit":[{"id":"n","textSplice":{"start":0,"remove":2}}]}}`,
		`{"notes":{"edit":[{"id":"n","textSplice":{"start":9}}]}}`,
		`{"notes":{"edit":[{"id":"n","textSplice":{"start":-1}}]}}`,
		`{"notes":{"edit":[{"id":"n","textSplice":{},"set":{"dataText":"different"}}]}}`,
		`{"notes":{"edit":[{"id":"n","set":{"id":"other"}}]}}`,
		`{"notes":{"edit":[{"id":"n","set":{"sealed":"ciphertext"}}]}}`,
		`{"notes":{"edit":[{"id":"n","set":{"title":"first"}}],"remove":["n"]}}`,
		`{"notes":{"edit":[{"id":"other","set":{"title":"missing"}}]}}`,
	} {
		if _, err := store.applyWorkspacePatch(initial, bad); !errors.Is(err, errInvalid) {
			t.Errorf("invalid edit accepted: %s (%v)", bad, err)
		}
	}
}

func TestFolderAndLibraryPatchHaveSameRecordSemantics(t *testing.T) {
	store := New[fixtureNote]()
	initial := []byte(`{"name":"A","notes":[{"id":"a"},{"id":"b"}],"areas":[],"routes":[1]}`)
	out, err := store.applyWorkspacePatch(initial, `{"set":{"routes":[2]},"notes":{"put":[{"id":"b","v":3}],"order":["b","a"]}}`)
	if err != nil {
		t.Fatal(err)
	}
	sameTestJSON(t, out, []byte(`{"name":"A","notes":[{"id":"b","v":3},{"id":"a"}],"areas":[],"routes":[2]}`))
	for _, invalid := range []string{`{"set":{"_videronSync":"head"}}`, `{"unset":["notes"]}`, `{"set":{"folder":"outside"}}`} {
		if _, err := store.applyWorkspacePatch(initial, invalid); !errors.Is(err, errInvalid) {
			t.Fatal(err)
		}
	}
}

func TestMapInkPatchesOnLegacyWorkspace(t *testing.T) {
	store := New[fixtureNote]()
	initial := []byte(`{"notes":[],"areas":[]}`)
	created, err := store.applyWorkspacePatch(initial, `{"mapInk":{"put":[{"id":"pen","type":"pen","points":[[1,2]]},{"id":"box","type":"rect"}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	edited, err := store.applyWorkspacePatch(created, `{"mapInk":{"edit":[{"id":"pen","set":{"glow":true}}],"remove":["box"]}}`)
	if err != nil {
		t.Fatal(err)
	}
	sameTestJSON(t, edited, []byte(`{"notes":[],"areas":[],"mapInk":[{"id":"pen","type":"pen","points":[[1,2]],"glow":true}]}`))
}

func TestCatalogClearIndexWipesRetiredNoteBytes(t *testing.T) {
	store := historyStore(t)
	catalog := new(Catalog)
	key, err := vault.NewKey(historyPassword)
	if err != nil {
		t.Fatal(err)
	}
	defer key.Forget()
	const initial = `{"version":1,"active":"personal","spaces":{"personal":{"notes":[{"id":"private","plain":"Initial content"},{"id":"untouched","plain":"Retained note"}],"areas":[]}}}`
	if err := catalog.SaveSnapshot(store, initial, key); err != nil {
		t.Fatal(err)
	}
	const patch = `{"spaces":{"personal":{"notes":{"edit":[{"id":"private","set":{"plain":"First edited content"}}]}}}}`
	rev, err := catalog.SavePatch(store, key, catalog.Revision(), patch)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := catalog.SavePatch(store, nil, rev, patch); !errors.Is(err, errLocked) || catalog.Revision() != rev {
		t.Fatal("a cached index must still require a key for saving", err)
	}
	index := catalog.index.spaces["personal"].notes.items
	first, untouched := index["private"], index["untouched"]
	if !bytes.Contains(first, []byte("First edited content")) || !bytes.Contains(untouched, []byte("Retained note")) {
		t.Fatal("missing indexed notes")
	}
	rev, err = catalog.SavePatch(store, key, rev, strings.Replace(patch, "First edited content", "Latest edited content", 1))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, make([]byte, len(first))) {
		t.Fatal("retired note bytes were not cleared")
	}
	latest := catalog.index.spaces["personal"].notes.items["private"]
	if !bytes.Contains(latest, []byte("Latest edited content")) || !bytes.Contains(untouched, []byte("Retained note")) {
		t.Fatal("replacement cleared current notes")
	}

	catalog.ClearIndex()
	if catalog.index != nil ||
		!bytes.Equal(latest, make([]byte, len(latest))) ||
		!bytes.Equal(untouched, make([]byte, len(untouched))) {
		t.Fatal("plaintext survived clearing the index")
	}
	if catalog.Revision() != rev {
		t.Fatal("clearing the index changed the on-disk revision")
	}
	// The next save must rebuild the index from the encrypted catalog.
	if _, err := catalog.SavePatch(store, key, rev, patch); err != nil {
		t.Fatal(err)
	}
}
