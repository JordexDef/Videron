package vault

import (
	"encoding/json"
	"regexp"
)

var mapColor = regexp.MustCompile(`^#[a-fA-F0-9]{6}$`)

func (v *NoteValidator) validateSealedAppearance(raw json.RawMessage) error {
	return readVaultObject(raw, func(field string, decoder *json.Decoder) error {
		if field == "radius" {
			var radius int
			if decoder.Decode(&radius) == nil && radius >= 16 && radius <= 78 {
				return nil
			}
			return ErrInvalid
		}
		var value *string
		if err := decoder.Decode(&value); err != nil {
			return ErrInvalid
		}
		switch field {
		case "badgeSize":
			if value != nil && (*value == "small" || *value == "large" || *value == "hidden") {
				return nil
			}
		case "shape":
			if value != nil {
				switch *value {
				case "circle", "square", "diamond", "triangle", "pentagon", "hexagon":
					return nil
				}
			}
		case "icon":
			if value == nil || v.allowedIcon != nil && v.allowedIcon(*value) {
				return nil
			}
		case "leftIcon", "rightIcon":
			if value != nil && v.allowedIcon != nil && v.allowedIcon(*value) {
				return nil
			}
		case "color":
			if value == nil || mapColor.MatchString(*value) {
				return nil
			}
		}
		return ErrInvalid
	})
}
