// Package vault encrypts and authenticates Videron's version 1 storage records.
package vault

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Key holds a derived key for the lifetime of an unlocked session.
type Key struct {
	salt []byte
	key  []byte
}

// DeriveKey uses the salt from a validated v1 envelope to unlock its contents.
func DeriveKey(password string, salt []byte) *Key {
	secret := []byte(password)
	defer clear(secret)
	return &Key{salt: bytes.Clone(salt), key: argon2.IDKey(secret, salt, passes, memoryKiB, lanes, 32)}
}

// NewKey derives a key with a fresh random salt.
func NewKey(password string) (*Key, error) {
	if utf8.RuneCountInString(password) < 8 {
		return nil, ErrWeak
	}
	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	return DeriveKey(password, salt), nil
}

// Clone creates a second key with an independent lifetime.
func (k *Key) Clone() *Key {
	return &Key{salt: bytes.Clone(k.salt), key: bytes.Clone(k.key)}
}

// Forget wipes this copy of the derived key.
func (k *Key) Forget() {
	if k != nil {
		clear(k.key)
		k.key = nil
	}
}

func (k *Key) MatchesSalt(salt []byte) bool {
	return k != nil && bytes.Equal(k.salt, salt)
}

func (k *Key) Verify(password string) bool {
	if k == nil || len(k.key) == 0 {
		return false
	}
	candidate := DeriveKey(password, k.salt)
	defer candidate.Forget()
	return subtle.ConstantTimeCompare(k.key, candidate.key) == 1
}

func (k *Key) aead() (cipher.AEAD, error) {
	if k == nil || len(k.key) == 0 {
		return nil, ErrLocked
	}
	block, err := aes.NewCipher(k.key)
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

// SealBytes encrypts a record with its scope and identifier authenticated as v1 data.
func (k *Key) SealBytes(scope, id string, plaintext []byte) ([]byte, error) {
	gcm, err := k.aead()
	if err != nil {
		return nil, err
	}
	return gcm.Seal(nil, nil, plaintext, associatedData(scope, id)), nil
}

// OpenBytes authenticates and decrypts the bytes produced by SealBytes.
func (k *Key) OpenBytes(scope, id string, sealed []byte) ([]byte, error) {
	gcm, err := k.aead()
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nil, sealed, associatedData(scope, id))
	if err != nil {
		return nil, ErrPassword
	}
	return plain, nil
}

// RecordMAC authenticates the archive's literal lineage/kind/ prefix and record
// bytes in that order. The result is the binary digest used for the record ID.
func (k *Key) RecordMAC(prefix string, data []byte) []byte {
	if k == nil || len(k.key) == 0 {
		return nil
	}
	mac := hmac.New(sha256.New, k.key)
	mac.Write([]byte(prefix))
	mac.Write(data)
	return mac.Sum(nil)
}
