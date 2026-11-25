package vault

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

type jsonPresence struct{}

func (*jsonPresence) UnmarshalJSON([]byte) error { return nil }

// Skip ordinary notes without decoding their attachment data or large text
// documents. Unicode escapes can also spell the reserved type in JSON.
func mayContainCredentialType(raw []byte) bool {
	return bytes.Contains(raw, []byte("\"credentials\"")) || bytes.Contains(raw, []byte("\\u"))
}

type publicNoteBlock struct{}

func (*publicNoteBlock) UnmarshalJSON(raw []byte) error {
	if raw[0] != '{' || !mayContainCredentialType(raw) {
		return nil
	}
	return readVaultObject(raw, func(field string, d *json.Decoder) error {
		if field == "type" {
			var value json.RawMessage
			if err := d.Decode(&value); err != nil {
				return err
			}
			// Even if every letter is escaped as \uXXXX, the name is short.
			if len(value) <= 2+6*len("credentials") && value[0] == '"' {
				var name string
				if json.Unmarshal(value, &name) == nil && name == "credentials" {
					return ErrInvalid
				}
			}
			return nil
		}
		return d.Decode(&jsonPresence{})
	})
}

type publicNoteBody struct{}

func (*publicNoteBody) UnmarshalJSON(raw []byte) error {
	if raw[0] != '[' || !mayContainCredentialType(raw) {
		return nil
	}
	var blocks []publicNoteBlock
	return json.Unmarshal(raw, &blocks)
}

func validSealedMapLabel(label string) bool {
	if label == "" || utf8.RuneCountInString(label) > 120 {
		return false
	}
	// Match the editor's trim(), which also strips the byte order mark.
	if strings.TrimFunc(label, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' }) != label {
		return false
	}
	return strings.IndexFunc(label, func(r rune) bool {
		return unicode.IsControl(r) || r == '\u2028' || r == '\u2029'
	}) < 0
}

var mapGroupUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// NoteValidator enforces the public fields allowed beside an encrypted note.
// Its cache of validated record digests belongs to a single icon policy.
type NoteValidator struct {
	allowedIcon func(string) bool
	mu          sync.Mutex
	slots       [256]struct {
		digest  [sha256.Size]byte
		present bool
	}
}

// NewNoteValidator uses an immutable catalog predicate for public map icons.
// A nil predicate permits no named icons.
func NewNoteValidator(allowedIcon func(string) bool) *NoteValidator {
	return &NoteValidator{allowedIcon: allowedIcon}
}

// Validate checks a note as stored in a folder, catalog, or sync revision.
// Ordinary documents retain their extension fields.
func (v *NoteValidator) Validate(data []byte) error {
	if len(data) == 0 || data[0] != '{' {
		return ErrInvalid
	}
	// Object keys in editor documents are case-sensitive. An extension's
	// "Sealed" or a nested field of that name is not Videron's wrapper.
	var fields map[string]jsonPresence
	if err := json.Unmarshal(data, &fields); err != nil {
		return ErrInvalid
	}
	if _, sealed := fields["sealed"]; !sealed {
		if _, body := fields["body"]; body && mayContainCredentialType(data) {
			err := readVaultObject(data, func(field string, d *json.Decoder) error {
				if field == "body" {
					return d.Decode(&publicNoteBody{})
				}
				return d.Decode(&jsonPresence{})
			})
			if err != nil {
				return ErrInvalid
			}
		}
		return nil
	}
	digest := sha256.Sum256(data)
	v.mu.Lock()
	cached := v.slots[digest[0]]
	v.mu.Unlock()
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
		case "mapGroupId":
			var group string
			if err := d.Decode(&group); err != nil || !mapGroupUUID.MatchString(group) {
				return ErrInvalid
			}
		case "links":
			var links []string
			return d.Decode(&links)
		case "mapLabel":
			var label string
			if err := d.Decode(&label); err != nil || !validSealedMapLabel(label) {
				return ErrInvalid
			}
		case "appearance":
			var raw json.RawMessage
			if err := d.Decode(&raw); err != nil {
				return err
			}
			return v.validateSealedAppearance(raw)
		case "x", "y", "slot", "opens", "created", "modified":
			var number float64
			return d.Decode(&number)
		case "pinned":
			var pinned bool
			return d.Decode(&pinned)
		case "title", "plain":
			var text string
			if err := d.Decode(&text); err != nil || text != "" {
				return ErrInvalid
			}
		case "body", "tags":
			var list []struct{}
			if err := d.Decode(&list); err != nil || len(list) != 0 {
				return ErrInvalid
			}
		case "weight":
			var weight float64
			if err := d.Decode(&weight); err != nil || weight != 0 {
				return ErrInvalid
			}
		default:
			return ErrInvalid
		}
		return nil
	})
	if err != nil || id == "" {
		return ErrInvalid
	}
	if _, err := ParseEnvelope([]byte(sealed), NoteScope); err != nil {
		return ErrInvalid
	}
	v.mu.Lock()
	slot := &v.slots[digest[0]]
	slot.digest = digest
	slot.present = true
	v.mu.Unlock()
	return nil
}
