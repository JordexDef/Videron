package vault

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

const (
	ProjectScope = "videron.project"
	NoteScope    = "videron.note"
	kdfName      = "argon2id"
	cipherName   = "aes-256-gcm"
	memoryKiB    = 64 * 1024
	passes       = 3
	lanes        = 4
	saltSize     = 16
)

var (
	ErrPassword = errors.New("VD_PASSWORD")
	ErrWeak     = errors.New("VD_WEAK_PASSWORD")
	ErrLocked   = errors.New("VD_LOCKED")
	ErrInvalid  = errors.New("VD_INVALID")
	ErrCorrupt  = errors.New("VD_CORRUPT")
	ErrVersion  = errors.New("VD_VERSION")
)

// Version 1 fixes the algorithm profile. File-supplied KDF parameters are
// checked before deriving a key so a damaged file cannot demand more memory.
type Envelope struct {
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

// Security records have a closed schema. Reject duplicate and differently
// cased fields rather than letting different JSON readers pick a different
// value. The callback consumes exactly one field value.
func readVaultObject(data []byte, field func(string, *json.Decoder) error) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return ErrCorrupt
	}
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || seen[name] {
			return ErrCorrupt
		}
		seen[name] = true
		if err := field(name, decoder); err != nil {
			return err
		}
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return ErrCorrupt
	}
	if _, err := decoder.Token(); err != io.EOF {
		return ErrCorrupt
	}
	return nil
}

// ParseEnvelope validates the entire envelope and its fixed algorithm profile.
func ParseEnvelope(data []byte, scope string) (*Envelope, error) {
	var env Envelope
	fields := map[string]any{
		"vault": &env.Vault, "version": &env.Version, "kdf": &env.KDF, "memoryKiB": &env.MemoryKiB,
		"iterations": &env.Iterations, "parallelism": &env.Parallelism, "cipher": &env.Cipher,
		"salt": &env.Salt, "data": &env.Data,
	}
	err := readVaultObject(data, func(name string, decoder *json.Decoder) error {
		value, ok := fields[name]
		if !ok {
			return ErrCorrupt
		}
		return decoder.Decode(value)
	})
	if err != nil || env.Vault != scope {
		return nil, ErrCorrupt
	}
	if env.Version != 1 || env.KDF != kdfName || env.MemoryKiB != memoryKiB || env.Iterations != passes || env.Parallelism != lanes || env.Cipher != cipherName {
		return nil, ErrVersion
	}
	if len(env.Salt) != saltSize || len(env.Data) < 12+16 {
		return nil, ErrCorrupt
	}
	return &env, nil
}

// Seal encrypts plaintext and encodes it using the v1 JSON envelope.
func (k *Key) Seal(scope, id string, plaintext []byte) ([]byte, error) {
	data, err := k.SealBytes(scope, id, plaintext)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Envelope{
		Vault: scope, Version: 1, KDF: kdfName, MemoryKiB: memoryKiB, Iterations: passes, Parallelism: lanes,
		Cipher: cipherName, Salt: k.salt, Data: data,
	})
}

// Open decrypts a parsed envelope for the expected record identifier.
func (k *Key) Open(env *Envelope, id string) ([]byte, error) {
	if !k.MatchesSalt(env.Salt) {
		return nil, ErrPassword
	}
	return k.OpenBytes(env.Vault, id, env.Data)
}
