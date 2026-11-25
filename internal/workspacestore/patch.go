package workspacestore

import (
	"crypto/sha256"
	"strings"
)

// Remember an acknowledged update without retaining its potentially sensitive content.
type savePatchReceipt struct {
	from, to string
	digest   [sha256.Size]byte
}

func (s *Session) PatchRevision() string {
	if !s.sync.initialized {
		// Reading a space (including read-only folders) must not create history.
		// The first background poll can initialize its head without changing the payload.
		return "snapshot:" + hexID([]byte(s.sync.payload))
	}
	return s.sync.meta.Head
}

// SavePatch applies an editor delta to the expected baseline and publishes the resulting revision.
// A retry of an acknowledged delta returns the same head without applying it twice.
func (s *Session) SavePatch(expectedHead, patch string, apply func([]byte, string) ([]byte, error)) (string, error) {
	initial, bootstrap := strings.CutPrefix(expectedHead, "snapshot:")
	if !validSyncID(initial) {
		return "", errChanged
	}
	digest := sha256.Sum256([]byte(patch))
	head := s.sync.meta.Head
	data := s.sync.payload
	if head == expectedHead || (bootstrap && initial == hexID([]byte(data))) {
		next, err := apply([]byte(data), patch)
		if err != nil {
			return "", err
		}
		if !s.store.ValidPayload(next) {
			return "", errInvalid
		}
		data = string(next)
	} else if s.lastPatch != (savePatchReceipt{from: expectedHead, to: head, digest: digest}) {
		return "", errChanged
	}
	err := s.commitBranch("", data, false)
	if s.sync.meta.Head != expectedHead && s.sync.payload == data {
		s.lastPatch = savePatchReceipt{from: expectedHead, to: s.sync.meta.Head, digest: digest}
	}
	if err != nil {
		return "", err
	}
	return s.sync.meta.Head, nil
}
