package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	projectVault = "videron.project"
	noteVault    = "videron.note"
	kdfName      = "argon2id"
	cipherName   = "aes-256-gcm"
	memoryKiB    = 64 * 1024
	passes       = 3
	lanes        = 4
	saltSize     = 16
)

var (
	errPassword = errors.New("VD_PASSWORD")
	errWeak     = errors.New("VD_WEAK_PASSWORD")
	errLocked   = errors.New("VD_LOCKED")
	errInvalid  = errors.New("VD_INVALID")
	errCorrupt  = errors.New("VD_CORRUPT")
	errVersion  = errors.New("VD_VERSION")
)

// Version 1 fixes the algorithm profile. File-supplied KDF parameters are
// checked before deriving a key so a damaged file cannot demand more memory.
type envelope struct {
	Vault       string `json:"vault"`
	Version     int    `json:"version"`
	KDF         string `json:"kdf"`
	MemoryKiB   int    `json:"memoryKiB"`
	Iterations  int    `json:"iterations"`
	Parallelism int    `json:"parallelism"`
	Cipher      string `json:"cipher"`
	Salt        []byte `json:"salt"`
	Data        []byte `json:"data"`
}

type vaultKey struct {
	salt []byte
	key  []byte
}

func deriveVaultKey(password string, salt []byte) *vaultKey {
	secret := []byte(password)
	defer clear(secret)
	return &vaultKey{salt: salt, key: argon2.IDKey(secret, salt, passes, memoryKiB, lanes, 32)}
}

func newVaultKey(password string) (*vaultKey, error) {
	if utf8.RuneCountInString(password) < 8 {
		return nil, errWeak
	}
	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	return deriveVaultKey(password, salt), nil
}

func (key *vaultKey) forget() {
	if key != nil {
		clear(key.key)
	}
}

func (key *vaultKey) verify(password string) bool {
	candidate := deriveVaultKey(password, key.salt)
	defer candidate.forget()
	return subtle.ConstantTimeCompare(key.key, candidate.key) == 1
}

func (key *vaultKey) aead() (cipher.AEAD, error) {
	block, err := aes.NewCipher(key.key)
	if err != nil {
		return nil, err
	}
	// The standard library generates a fresh 96-bit nonce for every Seal
	// and prepends it to the ciphertext and its 128-bit authentication tag.
	return cipher.NewGCMWithRandomNonce(block)
}

func associatedData(scope, id string) []byte {
	return []byte(scope + "\x00v1\x00argon2id:m=65536,t=3,p=4\x00aes-256-gcm\x00" + id)
}

func (key *vaultKey) seal(scope, id string, plaintext []byte) ([]byte, error) {
	gcm, err := key.aead()
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{
		Vault: scope, Version: 1, KDF: kdfName, MemoryKiB: memoryKiB, Iterations: passes, Parallelism: lanes,
		Cipher: cipherName, Salt: key.salt, Data: gcm.Seal(nil, nil, plaintext, associatedData(scope, id)),
	})
}

// Security records have a closed schema. Reject duplicate and differently
// cased fields rather than letting different JSON readers pick a different
// value. The callback consumes exactly one field value.
func readVaultObject(data []byte, field func(string, *json.Decoder) error) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return errCorrupt
	}
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || seen[name] {
			return errCorrupt
		}
		seen[name] = true
		if err := field(name, decoder); err != nil {
			return err
		}
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return errCorrupt
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errCorrupt
	}
	return nil
}

func parseEnvelope(data []byte, scope string) (*envelope, error) {
	var env envelope
	fields := map[string]any{
		"vault": &env.Vault, "version": &env.Version, "kdf": &env.KDF, "memoryKiB": &env.MemoryKiB,
		"iterations": &env.Iterations, "parallelism": &env.Parallelism, "cipher": &env.Cipher,
		"salt": &env.Salt, "data": &env.Data,
	}
	err := readVaultObject(data, func(name string, decoder *json.Decoder) error {
		value, ok := fields[name]
		if !ok {
			return errCorrupt
		}
		return decoder.Decode(value)
	})
	if err != nil || env.Vault != scope {
		return nil, errCorrupt
	}
	if env.Version != 1 || env.KDF != kdfName || env.MemoryKiB != memoryKiB || env.Iterations != passes || env.Parallelism != lanes || env.Cipher != cipherName {
		return nil, errVersion
	}
	if len(env.Salt) != saltSize || len(env.Data) < 12+16 {
		return nil, errCorrupt
	}
	return &env, nil
}

func (key *vaultKey) open(env *envelope, id string) ([]byte, error) {
	if !bytes.Equal(key.salt, env.Salt) {
		return nil, errPassword
	}
	gcm, err := key.aead()
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nil, env.Data, associatedData(env.Vault, id))
	if err != nil {
		return nil, errPassword
	}
	return plain, nil
}

func validNote(id string, payload []byte) bool {
	var identity struct {
		ID string `json:"id"`
	}
	return id != "" && utf8.Valid(payload) && json.Unmarshal(payload, &identity) == nil && identity.ID == id
}

// A sealed note may keep its map coordinates and links beside the envelope.
// Apply this second check where snapshots, folder revisions and sync all
// enter storage. Ordinary note types and extension fields remain opaque.
type storedNote struct{}
type jsonPresence struct{}

func (*jsonPresence) UnmarshalJSON([]byte) error { return nil }

// The autosaver may validate the same attachment in many snapshots. Cache only
// hashes of fully validated sealed records. A single changed byte forces the
// ordinary JSON/base64 validation path again. Slot collisions only cause misses.
var checkedSealedNotes struct {
	sync.Mutex
	slots [256]struct {
		digest  [sha256.Size]byte
		present bool
	}
}

func (*storedNote) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || data[0] != '{' {
		return errInvalid
	}
	// Object keys in editor documents are case-sensitive. An extension's
	// "Sealed" or a nested field of that name is not Videron's wrapper.
	var fields map[string]jsonPresence
	if err := json.Unmarshal(data, &fields); err != nil {
		return errInvalid
	}
	if _, sealed := fields["sealed"]; !sealed {
		return nil
	}
	digest := sha256.Sum256(data)
	checkedSealedNotes.Lock()
	cached := checkedSealedNotes.slots[digest[0]]
	checkedSealedNotes.Unlock()
	if cached.present && cached.digest == digest {
		return nil
	}
	var id, sealed string
	err := readVaultObject(data, func(name string, d *json.Decoder) error {
		switch name {
		case "id":
			return d.Decode(&id)
		case "sealed":
			return d.Decode(&sealed)
		case "areaId":
			var area string
			return d.Decode(&area)
		case "links":
			var links []string
			return d.Decode(&links)
		case "x", "y", "slot", "opens", "created", "modified":
			var number float64
			return d.Decode(&number)
		case "pinned":
			var pinned bool
			return d.Decode(&pinned)
		case "title", "plain":
			var text string
			if err := d.Decode(&text); err != nil || text != "" {
				return errInvalid
			}
		case "body", "tags":
			var list []struct{}
			if err := d.Decode(&list); err != nil || len(list) != 0 {
				return errInvalid
			}
		case "weight":
			var weight float64
			if err := d.Decode(&weight); err != nil || weight != 0 {
				return errInvalid
			}
		default:
			return errInvalid
		}
		return nil
	})
	if err != nil || id == "" {
		return errInvalid
	}
	if _, err := parseEnvelope([]byte(sealed), noteVault); err != nil {
		return errInvalid
	}
	checkedSealedNotes.Lock()
	slot := &checkedSealedNotes.slots[digest[0]]
	slot.digest = digest
	slot.present = true
	checkedSealedNotes.Unlock()
	return nil
}

func (a *App) cacheNoteKey(id string, key *vaultKey) {
	if a.noteKeys == nil {
		a.noteKeys = make(map[string]*vaultKey)
	}
	a.noteKeys[id].forget()
	a.noteKeys[id] = key
}

func (a *App) dropKeys() {
	a.clearCatalogIndex()
	// A pending connection carries a verified server credential. Expire it
	// together with the vault session, including verifications still in flight.
	a.serverTickets.reset()
	a.projectKey.forget()
	a.projectKey = nil
	for _, key := range a.noteKeys {
		key.forget()
	}
	clear(a.noteKeys)
	for _, session := range a.folderSpaces {
		session.key.forget()
	}
	clear(a.folderSpaces)
}

func (a *App) ProtectNote(id, payload, password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	data := []byte(payload)
	defer clear(data)
	if !validNote(id, data) {
		return "", errInvalid
	}
	key, err := newVaultKey(password)
	if err != nil {
		return "", err
	}
	sealed, err := key.seal(noteVault, id, data)
	if err != nil {
		key.forget()
		return "", err
	}
	a.cacheNoteKey(id, key)
	return string(sealed), nil
}

func (a *App) UnlockNote(id, sealed, password string) (string, error) {
	return a.readSealedNote(id, sealed, password, true)
}

// Comparison reads a historical copy without granting an editor session access
// or replacing the key used to save another version of the same note.
func (a *App) PreviewSealedNote(id, sealed, password string) (string, error) {
	return a.readSealedNote(id, sealed, password, false)
}

func (a *App) readSealedNote(id, sealed, password string, keepKey bool) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	if id == "" {
		return "", errInvalid
	}
	env, err := parseEnvelope([]byte(sealed), noteVault)
	if err != nil {
		return "", err
	}
	key := deriveVaultKey(password, env.Salt)
	plain, err := key.open(env, id)
	if err != nil {
		key.forget()
		return "", err
	}
	defer clear(plain)
	if !validNote(id, plain) {
		key.forget()
		return "", errCorrupt
	}
	if keepKey {
		a.cacheNoteKey(id, key)
	} else {
		key.forget()
	}
	return string(plain), nil
}

func (a *App) SealNote(id, payload string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	key := a.noteKeys[id]
	if !a.loaded || key == nil {
		return "", errLocked
	}
	data := []byte(payload)
	defer clear(data)
	if !validNote(id, data) {
		return "", errInvalid
	}
	sealed, err := key.seal(noteVault, id, data)
	return string(sealed), err
}

func (a *App) LockNote(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.noteKeys[id].forget()
	delete(a.noteKeys, id)
}
