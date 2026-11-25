package vault

import (
	"bytes"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

// Independent v1 fixture made with argon2-cffi and Python cryptography's AESGCM.
// Its fixed salt and nonce belong only to this compatibility test.
const independentV1Note = `{"vault":"videron.note","version":1,"kdf":"argon2id","memoryKiB":65536,"iterations":3,"parallelism":4,"cipher":"aes-256-gcm","salt":"AAECAwQFBgcICQoLDA0ODw==","data":"AAECAwQFBgcICQoLjmlTll8OC5svFSIpM1hf2a5SGcGSVZGMvyC0N12u2tnLOB3aWVHNnuvVHpFF89mnXNWsmmsDZa2ZW1hpheSy"}`

func TestReadIndependentV1Note(t *testing.T) {
	env, err := ParseEnvelope([]byte(independentV1Note), NoteScope)
	if err != nil {
		t.Fatal(err)
	}
	key := DeriveKey("format-test-only", env.Salt)
	defer key.Forget()
	got, err := key.Open(env, "format-note")
	if err != nil || string(got) != `{"id":"format-note","title":"Interoperability"}` {
		t.Fatal("independently encoded v1 note", err)
	}
	if _, err := key.Open(env, "other-note"); !errors.Is(err, ErrPassword) {
		t.Fatal("ciphertext accepted for a different note", err)
	}
	if _, err := key.OpenBytes(ProjectScope, "format-note", env.Data); !errors.Is(err, ErrPassword) {
		t.Fatal("ciphertext accepted for a different scope", err)
	}
}

func TestVaultEnvelopeHasUnambiguousFieldNames(t *testing.T) {
	for _, invalid := range []string{
		strings.Replace(independentV1Note, `"version":1`, `"version":1,"version":1`, 1),
		strings.Replace(independentV1Note, `"data":`, `"Data":`, 1),
		independentV1Note + ` {}`,
	} {
		if _, err := ParseEnvelope([]byte(invalid), NoteScope); !errors.Is(err, ErrCorrupt) {
			t.Fatal("accepted ambiguous envelope", err)
		}
	}
}

func TestClonedKeysOwnAndEraseTheirBytes(t *testing.T) {
	key, err := NewKey("session password")
	if err != nil {
		t.Fatal(err)
	}
	defer key.Forget()
	copy := key.Clone()
	defer copy.Forget()
	originalBytes, copyBytes := key.key, copy.key
	sealed, err := key.SealBytes("videron.editor-history", "note-key", []byte("draft"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := key.SealBytes("videron.editor-history", "note-key", []byte("draft"))
	if err != nil || bytes.Equal(sealed, second) {
		t.Fatal("reused a nonce across successive saves", err)
	}
	key.Forget()
	if !bytes.Equal(originalBytes, make([]byte, 32)) || bytes.Equal(originalBytes, copyBytes) {
		t.Fatal("forgetting one key should zero only its own storage")
	}
	if _, err := key.OpenBytes("videron.editor-history", "note-key", sealed); !errors.Is(err, ErrLocked) {
		t.Fatal("forgotten key continued to decrypt", err)
	}
	plaintext, err := copy.OpenBytes("videron.editor-history", "note-key", sealed)
	if err != nil || string(plaintext) != "draft" {
		t.Fatal("clone did not retain access", err)
	}
	copy.Forget()
	if !bytes.Equal(copyBytes, make([]byte, 32)) {
		t.Fatal("clone's original storage still contains key material")
	}
}

func TestArchiveRecordMACPreservesLegacyIDs(t *testing.T) {
	material := make([]byte, 32)
	for i := range material {
		material[i] = byte(i)
	}
	key := &Key{key: material}
	defer key.Forget()
	got := hex.EncodeToString(key.RecordMAC("lineage/objects/", []byte("payload")))
	// HMAC-SHA256 over the existing lineage/kind/ prefix followed by the bytes.
	if got != "32d350ed28077e4417d004cab533508f28bfad499198bed3c7e987a7d428f2b0" {
		t.Fatal("v1 archive record ID changed", got)
	}
}
