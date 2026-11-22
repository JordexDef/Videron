package main

import "testing"

// Independent v1 fixture made with argon2-cffi and Python cryptography's AESGCM.
// Its fixed salt and nonce belong only to this compatibility test.
func TestReadIndependentV1Note(t *testing.T) {
	const sealed = `{"vault":"videron.note","version":1,"kdf":"argon2id","memoryKiB":65536,"iterations":3,"parallelism":4,"cipher":"aes-256-gcm","salt":"AAECAwQFBgcICQoLDA0ODw==","data":"AAECAwQFBgcICQoLjmlTll8OC5svFSIpM1hf2a5SGcGSVZGMvyC0N12u2tnLOB3aWVHNnuvVHpFF89mnXNWsmmsDZa2ZW1hpheSy"}`
	app, _ := testStore(t)
	got, err := app.UnlockNote("format-note", sealed, "format-test-only")
	if err != nil {
		t.Fatal(err)
	}
	if got != `{"id":"format-note","title":"Interoperability"}` {
		t.Fatal("unexpected note contents")
	}
	app.LockNote("format-note")
}
