package vault

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestCredentialBlockDiscriminatorIsScopedToNoteBody(t *testing.T) {
	validator := NewNoteValidator(nil)
	for _, row := range []string{
		`{"body":[{"type":"paragraph","text":"credentials","custom":{"type":"credentials"}}]}`,
		`{"Body":[{"type":"credentials"}],"body":[{"Type":"credentials"},{"type":"Credentials"}]}`,
		`{"body":[null,["credentials"],{"type":"extension"}],"future":[{"type":"credentials"}]}`,
		`{"type":"data","dataText":"example \"credentials\"","body":[]}`,
	} {
		if err := validator.Validate([]byte(row)); err != nil {
			t.Fatalf("ordinary extension or note content rejected: %v", err)
		}
	}
	const encoded = `{"bo\u0064y":[{"t\u0079pe":"\u0063redentials"}]}`
	if err := validator.Validate([]byte(encoded)); !errors.Is(err, ErrInvalid) {
		t.Fatal("accepted escaped credential field", err)
	}
}

func TestSealedMapAppearanceAcceptsOnlyPublicStyles(t *testing.T) {
	allowed := map[string]bool{"phosphor/lock-key": true, "lucide/briefcase-business": true, "lucide/bookmark": true, "phosphor/house": true}
	validator := NewNoteValidator(func(icon string) bool { return allowed[icon] })
	for _, raw := range []string{
		`{"shape":"circle","color":null,"icon":null}`,
		`{"shape":"hexagon","color":"#ab12FF","icon":"phosphor/lock-key"}`,
		`{"radius":16,"badgeSize":"small"}`, `{"radius":78,"badgeSize":"hidden"}`, `{"badgeSize":"large"}`,
		`{"icon":"lucide/briefcase-business"}`, `{"icon":"lucide/bookmark"}`,
		`{"leftIcon":"lucide/bookmark","rightIcon":"phosphor/house"}`,
	} {
		if err := validator.validateSealedAppearance([]byte(raw)); err != nil {
			t.Fatal(raw, err)
		}
	}
	for _, raw := range []string{
		`null`, `[]`, `{"shape":"PRIVATE"}`, `{"icon":"lucide/unpublished-title"}`,
		`{"color":"private"}`, `{"color":"#abcdef","Color":"private"}`,
		`{"shape":"square","shape":"circle"}`, `{"icon":{"svg":"private"}}`,
		`{"radius":15}`, `{"radius":79}`, `{"radius":17.5}`, `{"radius":"18"}`, `{"radius":null}`,
		`{"badgeSize":"private"}`, `{"badgeSize":null}`,
		`{"leftIcon":"private"}`, `{"rightIcon":"lucide/private"}`, `{"leftIcon":null}`,
	} {
		if validator.validateSealedAppearance([]byte(raw)) == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestCachedNoteFollowsValidatorIconPolicy(t *testing.T) {
	key, err := NewKey("note validator test")
	if err != nil {
		t.Fatal(err)
	}
	defer key.Forget()
	envelope, err := key.Seal(NoteScope, "n", []byte(`{"id":"n"}`))
	if err != nil {
		t.Fatal(err)
	}
	record, err := json.Marshal(map[string]any{"id": "n", "sealed": string(envelope), "appearance": map[string]string{"icon": "lucide/bookmark"}})
	if err != nil {
		t.Fatal(err)
	}
	permitted := NewNoteValidator(func(name string) bool { return name == "lucide/bookmark" })
	for range 2 {
		if err := permitted.Validate(record); err != nil {
			t.Fatal(err)
		}
	}
	if err := NewNoteValidator(nil).Validate(record); !errors.Is(err, ErrInvalid) {
		t.Fatal("another validator accepted a cached icon outside its catalog", err)
	}
}
