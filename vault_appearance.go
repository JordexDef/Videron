package main

import (
	"encoding/json"
	"regexp"
	"sync"
)

// Read IDs from the same shipped icon packs as the picker. Only a catalog ID,
// never free-form text or SVG supplied by a note, can leave its envelope.
var publicMapIcons = sync.OnceValue(func() map[string]bool {
	icons := make(map[string]bool)
	entry := regexp.MustCompile(`\[\s*"((?:lucide|phosphor)/[a-z0-9-]+)"\s*,`)
	for _, pack := range []string{"vectors", "lucide-extra", "phosphor-extra"} {
		data, _ := files.ReadFile("frontend/icons/" + pack + ".js")
		for _, match := range entry.FindAllSubmatch(data, -1) {
			icons[string(match[1])] = true
		}
	}
	return icons
})

var mapColor = regexp.MustCompile(`^#[a-fA-F0-9]{6}$`)

func validateSealedAppearance(raw json.RawMessage) error {
	return readVaultObject(raw, func(field string, decoder *json.Decoder) error {
		if field == "radius" {
			var radius int
			if decoder.Decode(&radius) == nil && radius >= 16 && radius <= 78 {
				return nil
			}
			return errInvalid
		}
		var value *string
		if err := decoder.Decode(&value); err != nil {
			return errInvalid
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
			if value == nil || publicMapIcons()[*value] {
				return nil
			}
		case "leftIcon", "rightIcon":
			if value != nil && publicMapIcons()[*value] {
				return nil
			}
		case "color":
			if value == nil || mapColor.MatchString(*value) {
				return nil
			}
		}
		return errInvalid
	})
}
