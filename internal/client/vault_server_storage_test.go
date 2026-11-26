package client

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Exercise the ordinary folder + individually protected note policy. A
// project login or server password alone does not change the folder format.
func TestIndividualNotePrivacyAcrossServerHistory(t *testing.T) {
	app, _ := testStore(t)
	const accessPassword = "Temporary server login passphrase"
	const folderTitle = "PUBLIC-SPACE-TITLE"
	const noteID = "public-map-note-id"
	const prior = "BEFORE-NOTE-PROTECTION"
	const updated = "AFTER-NOTE-PROTECTION"
	const password = "Temporary individual note passphrase"
	server := startPasswordTestService(t, accessPassword)
	folder := t.TempDir()
	marshal := func(v any) string {
		t.Helper()
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	doc := func(note map[string]string) string {
		return marshal(map[string]any{"name": folderTitle, "notes": []any{note}, "areas": []any{}})
	}
	note := map[string]string{"id": noteID, "title": prior}
	if err := app.CreateFolderSpace(folder, doc(note), ""); err != nil {
		t.Fatal(err)
	}
	note["title"] = updated
	sealed, err := app.ProtectNote(noteID, marshal(note), password)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.SaveFolderBranch(folder, doc(map[string]string{"id": noteID, "sealed": sealed})); err != nil {
		t.Fatal(err)
	}
	// Even a server first connected after protection receives earlier history.
	if err := app.ConnectSpaceServer(folder, server.Code); err != nil {
		t.Fatal(err)
	}
	store := filepath.Join(server.Dir, "space")
	entries, err := os.ReadDir(store)
	if err != nil {
		t.Fatal(err)
	}
	var priorOnDisk, sealedOnDisk bool
	for _, entry := range entries {
		data := stored(t, filepath.Join(store, entry.Name()))
		if strings.HasPrefix(entry.Name(), "objects-") {
			priorOnDisk = priorOnDisk || bytes.Contains(data, []byte(prior))
			sealedOnDisk = sealedOnDisk || (bytes.Contains(data, []byte(noteID)) && bytes.Contains(data, []byte("videron.note")))
		}
		for _, secret := range []string{updated, password, accessPassword} {
			if bytes.Contains(data, []byte(secret)) {
				t.Errorf("protected text or password in server file %s", entry.Name())
			}
		}
	}
	if !priorOnDisk || !sealedOnDisk {
		t.Fatalf("server did not store the expected public history and new encrypted note: prior=%t, sealed=%t", priorOnDisk, sealedOnDisk)
	}
	identity := stored(t, filepath.Join(server.Dir, "identity.json"))
	if bytes.Contains(identity, []byte(accessPassword)) || bytes.Contains(identity, []byte(password)) {
		t.Fatal("server identity stored a plaintext password")
	}
}
