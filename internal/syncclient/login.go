package syncclient

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"videron/internal/syncauth"
)

var (
	ErrProtocol = errors.New("VD_SERVER_PROTOCOL")
	ErrRate     = errors.New("VD_SERVER_RATE")
)

type loginMessage struct {
	Session string `json:"session,omitempty"`
	Message []byte `json:"message"`
}

// Only KE1, the blinded OPAQUE request, may use the provisional TLS
// connection. Neither a reusable credential nor raw password is sent there.
func postLogin(ctx context.Context, c *http.Client, address, route string, body loginMessage, result any) (string, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	defer clear(raw)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, address+route, bytes.NewReader(raw))
	if err != nil {
		return "", ErrAddress
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		if errors.Is(err, ErrCert) {
			return "", ErrCert
		}
		return "", ErrOffline
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return "", ErrAuth
	case http.StatusTooManyRequests:
		return "", ErrRate
	default:
		return "", ErrProtocol
	}
	if resp.TLS == nil || len(resp.TLS.PeerCertificates) == 0 {
		return "", ErrCert
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8193))
	defer clear(data)
	if err != nil || len(data) > 8192 || json.Unmarshal(data, result) != nil {
		return "", ErrProtocol
	}
	hash := sha256.Sum256(resp.TLS.PeerCertificates[0].Raw)
	return hex.EncodeToString(hash[:]), nil
}

func verifyServerEndpoint(ctx context.Context, endpoint serverEndpoint, password string, roots *x509.CertPool) (Profile, error) {
	var empty Profile
	client, first, err := syncauth.Begin(password)
	if err != nil {
		return empty, ErrAuth
	}
	defer client.Close()
	defer clear(first)
	mode := []string{endpoint.transport}
	// The response is trusted only after OPAQUE authenticates the certificate
	// fingerprint in its transcript. Do not reuse this transport for KE3.
	probe := syncHTTPClient(&tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}, mode, roots)
	var reply loginMessage
	pin, err := postLogin(ctx, probe, endpoint.address, "/v1/auth/start", loginMessage{Message: first}, &reply)
	probe.CloseIdleConnections()
	if err != nil {
		if errors.Is(err, ErrAuth) {
			// An unrelated HTTPS gateway may protect the same URL. Try the
			// tunnel or native port before reporting an enrollment failure.
			return empty, ErrProtocol
		}
		return empty, err
	}
	defer clear(reply.Message)
	if !serverHex.MatchString(reply.Session) || len(reply.Message) == 0 {
		return empty, ErrProtocol
	}
	last, err := client.Finish(reply.Message, pin)
	if err != nil {
		return empty, ErrAuth
	}
	defer clear(last)
	secured := syncHTTPClient(PinnedTLS(pin), mode, roots)
	defer secured.CloseIdleConnections()
	var credentials struct {
		Token string `json:"token"`
	}
	if _, err = postLogin(ctx, secured, endpoint.address, "/v1/auth/finish", loginMessage{Session: reply.Session, Message: last}, &credentials); err != nil {
		return empty, err
	}
	if !serverHex.MatchString(credentials.Token) {
		return empty, ErrProtocol
	}
	p := Profile{Address: endpoint.address, Pin: pin, Token: credentials.Token, Transport: endpoint.transport}
	manifest, err := p.ManifestSummary(ctx, secured)
	if errors.Is(err, ErrProjectDeleted) {
		// Authentication is valid even when there is no default project. The
		// ticket can list, create, or select the remaining named projects.
		p.ProjectDeleted = true
		return p, nil
	}
	if err != nil {
		return empty, err
	}
	p.Lineage = manifest.Lineage
	return p, nil
}

// VerifyCredentials discovers the server and uses its password exchange to establish a profile.
func VerifyCredentials(ctx context.Context, address, password string) (Profile, error) {
	endpoints, err := serverEndpoints(address)
	if err != nil {
		return Profile{}, err
	}
	return discoverServer(ctx, endpoints, password, nil)
}

func discoverServer(ctx context.Context, endpoints []serverEndpoint, password string, roots *x509.CertPool) (Profile, error) {
	// Prefer an error from a responding server over a failed alternate route.
	best := ErrOffline
	for _, endpoint := range endpoints {
		attempt, cancel := context.WithTimeout(ctx, 12*time.Second)
		p, err := verifyServerEndpoint(attempt, endpoint, password, roots)
		cancel()
		if err == nil {
			return p, nil
		}
		switch {
		case errors.Is(err, ErrRate), errors.Is(err, ErrAuth):
			return Profile{}, err
		case errors.Is(err, ErrProtocol):
			best = err
		case errors.Is(err, ErrCert):
			if best == ErrOffline {
				best = err
			}
		case !errors.Is(err, ErrOffline):
			return Profile{}, err
		}
		if ctx.Err() != nil {
			break
		}
	}
	return Profile{}, best
}
