package syncclient

import (
	"encoding/json"
	"strings"
)

const namedProjectFormat = "videron.named-server-project.v1"

type namedProjectProfile struct {
	Format  string  `json:"format"`
	Profile Profile `json:"profile"`
}

// EncodeProfile prepares the local credential for protected storage.
func EncodeProfile(p Profile) ([]byte, error) {
	var stored any = p
	if p.ProjectID != "" {
		// Older clients ignore unknown fields such as ProjectID. Without an
		// envelope, a downgrade could reconnect to the default project of
		// the same server if that project shares this copy's lineage.
		stored = namedProjectProfile{Format: namedProjectFormat, Profile: p}
	}
	return json.Marshal(stored)
}

// DecodeProfile reads both the original single-project profile and named projects.
func DecodeProfile(data []byte) (*Profile, error) {
	var envelope namedProjectProfile
	if json.Unmarshal(data, &envelope) != nil {
		return nil, ErrCode
	}
	var p Profile
	if envelope.Format != "" {
		if envelope.Format != namedProjectFormat || envelope.Profile.ProjectID == "" {
			return nil, ErrCode
		}
		p = envelope.Profile
	} else if json.Unmarshal(data, &p) != nil {
		return nil, ErrCode
	}
	if !ValidID(p.Lineage) ||
		(p.ProjectID != "" && !ValidID(p.ProjectID)) {
		return nil, ErrCode
	}
	parsed, err := ParsePairCode(strings.Replace(p.Address, "https://", "videron-sync://", 1) + "#" + p.Pin + "." + p.Token)
	if err != nil || parsed.Address != p.Address || (p.Transport != "" && p.Transport != TransportDirect && p.Transport != TransportTunnel) {
		return nil, ErrCode
	}
	return &p, nil
}
