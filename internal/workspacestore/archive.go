package workspacestore

import (
	"bytes"
	"encoding/json"
)

// A record containing image data keeps a short list of literal JSON fragments
// and references. Changing its caption reuses the entire original image. The
// two object shapes are separate from user JSON and require no reserved keys.
type archivedValue struct {
	Value json.RawMessage `json:"value,omitempty"`
	Text  []string        `json:"text,omitempty"`
	Refs  []string        `json:"refs,omitempty"`
	Size  int             `json:"size,omitempty"`
}

const separateStringBytes = 32 * 1024
const maxArchivedValueBytes = 1 << 30

func (s *Session) storeValue(input []byte) (string, error) {
	// Sort object keys and normalize escaping so JS and the native JSON encoder
	// produce the same ID even after writing and reopening a plaintext space.
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	var v any
	if decoder.Decode(&v) != nil {
		return "", errCorrupt
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	var item archivedValue
	from := 0
	if len(raw) >= separateStringBytes {
		for i := 0; i < len(raw); i++ {
			if raw[i] != '"' {
				continue
			}
			start := i
			i++
			for i < len(raw) && raw[i] != '"' {
				if raw[i] == '\\' {
					i++
				}
				i++
			}
			if i-start < separateStringBytes {
				continue
			}
			id, e := s.putRecord("objects", raw[start:i+1])
			if e != nil {
				return "", e
			}
			item.Text = append(item.Text, string(raw[from:start]))
			item.Refs = append(item.Refs, id)
			from = i + 1
		}
	}
	if len(item.Refs) == 0 {
		item.Value = raw
	} else {
		if len(raw) > maxArchivedValueBytes {
			return "", errInvalid
		}
		item.Size = len(raw)
		item.Text = append(item.Text, string(raw[from:]))
	}
	data, err := json.Marshal(item)
	if err != nil {
		return "", err
	}
	return s.putRecord("objects", data)
}

func (s *Session) readValue(id string) (json.RawMessage, error) {
	raw, err := s.readRecord("objects", id)
	if err != nil {
		return nil, err
	}
	defer clear(raw)
	var item archivedValue
	if json.Unmarshal(raw, &item) != nil {
		return nil, errCorrupt
	}
	if item.Value != nil && item.Text == nil && item.Refs == nil {
		return item.Value, nil
	}
	if len(item.Refs) == 0 || len(item.Refs)+1 != len(item.Text) || item.Size <= 0 || item.Size > maxArchivedValueBytes {
		return nil, errCorrupt
	}
	var result bytes.Buffer
	for i, text := range item.Text {
		if len(text) > item.Size-result.Len() {
			return nil, errCorrupt
		}
		result.WriteString(text)
		if i < len(item.Refs) {
			part, err := s.readRecord("objects", item.Refs[i])
			if err != nil {
				return nil, err
			}
			if len(part) < 2 || part[0] != '"' || part[len(part)-1] != '"' || len(part) > item.Size-result.Len() {
				clear(part)
				return nil, errCorrupt
			}
			result.Write(part)
			clear(part)
		}
	}
	if result.Len() != item.Size || !json.Valid(result.Bytes()) {
		return nil, errCorrupt
	}
	return result.Bytes(), nil
}
