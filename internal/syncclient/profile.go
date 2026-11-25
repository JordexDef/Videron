// Package syncclient implements the Videron sync protocol and authenticated transports.
package syncclient

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var (
	ErrCode    = errors.New("VD_SERVER_CODE")
	ErrCert    = errors.New("VD_SERVER_CERT")
	ErrAuth    = errors.New("VD_SERVER_AUTH")
	ErrOffline = errors.New("VD_SERVER_OFFLINE")
	ErrSpace   = errors.New("VD_SERVER_SPACE")
	ErrEmpty   = errors.New("VD_SERVER_EMPTY")
	ErrFolder  = errors.New("VD_SERVER_FOLDER")
	serverHex  = regexp.MustCompile("^[0-9a-f]{64}$")
)

// ValidID checks the canonical wire format for hashes and identifiers.
func ValidID(s string) bool { return serverHex.MatchString(s) }

// Profile carries a server origin, its pinned identity and the credential for one
// working copy. Only a redacted connection summary may cross the desktop UI boundary.
type Profile struct {
	Address, Pin, Token, Lineage string
	Transport                    string `json:",omitempty"`
	LastSync                     int64  `json:",omitempty"`
	ProjectID                    string `json:",omitempty"`
	ProjectName                  string `json:",omitempty"`
	ManualConnect                bool   `json:",omitempty"` // Absent in older profiles, which reconnect automatically.
	ProjectDeleted               bool   `json:"-"`          // Only a verified ticket can refer to a deleted project.
}

// ParsePairCode decodes the server identity and credential in a pairing link.
func ParsePairCode(code string) (Profile, error) {
	var p Profile
	u, e := url.Parse(strings.TrimSpace(code))
	if e != nil || u.Scheme != "videron-sync" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || (u.Path != "" && u.Path != "/") {
		return p, ErrCode
	}
	port, e := strconv.Atoi(u.Port())
	if e != nil || port < 1 || port > 65535 {
		return p, ErrCode
	}
	pin, token, ok := strings.Cut(u.Fragment, ".")
	if !ok || !serverHex.MatchString(pin) || !serverHex.MatchString(token) {
		return p, ErrCode
	}
	return Profile{Address: "https://" + u.Host, Pin: pin, Token: token}, nil
}
