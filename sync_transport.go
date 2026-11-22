package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/idna"
	"golang.org/x/net/websocket"
)

const (
	transportDirect   = "direct"
	transportTunnel   = "cloudflare"
	serverDialTimeout = 7 * time.Second
)

var errServerAddress = errors.New("VD_SERVER_ADDRESS")

type serverEndpoint struct {
	address   string
	transport string
}

// An explicit port applies to both transports. Bare hostnames also discover
// the standard Cloudflare HTTPS port and the native sync listener.
func serverEndpoints(input string) ([]serverEndpoint, error) {
	raw := strings.TrimSpace(input)
	if raw == "" || strings.ContainsAny(raw, "?#@%\\") {
		return nil, errServerAddress
	}
	if !strings.Contains(raw, "://") {
		if ip, err := netip.ParseAddr(raw); err == nil && ip.Is6() {
			raw = "[" + raw + "]"
		}
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || (u.EscapedPath() != "" && u.EscapedPath() != "/") || strings.HasSuffix(u.Host, ":") {
		return nil, errServerAddress
	}
	host := u.Hostname()
	ip, ipErr := netip.ParseAddr(host)
	if ipErr == nil {
		host = ip.String()
	} else {
		host, err = idna.Lookup.ToASCII(host)
		if err != nil || strings.Trim(host, ".") == "" || strings.Contains(host, "..") || strings.HasPrefix(host, ".") || len(host) > 254 {
			return nil, errServerAddress
		}
		host = strings.ToLower(host)
	}
	// IPv6 authorities must be bracketed so a final hextet is never
	// silently interpreted as a port.
	if strings.Contains(u.Hostname(), ":") && !strings.HasPrefix(u.Host, "[") {
		return nil, errServerAddress
	}
	endpoint := func(port, transport string) serverEndpoint {
		return serverEndpoint{"https://" + net.JoinHostPort(host, port), transport}
	}
	port := u.Port()
	if port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return nil, errServerAddress
		}
		port = strconv.Itoa(n)
		modes := []serverEndpoint{endpoint(port, transportDirect), endpoint(port, transportTunnel)}
		if port == "443" {
			modes[0], modes[1] = modes[1], modes[0]
		}
		return modes, nil
	}
	local := ipErr == nil || !strings.Contains(host, ".") || strings.HasSuffix(host, ".local")
	if local {
		return []serverEndpoint{endpoint("8743", transportDirect), endpoint("443", transportTunnel), endpoint("443", transportDirect)}, nil
	}
	return []serverEndpoint{endpoint("443", transportTunnel), endpoint("443", transportDirect), endpoint("8743", transportDirect)}, nil
}

func pinnedServerTLS(pin string) *tls.Config {
	expected, _ := hex.DecodeString(pin)
	// The exact origin certificate is authenticated by a pairing link or by
	// the password exchange. The sync server uses a self-signed certificate.
	return &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, VerifyConnection: func(s tls.ConnectionState) error {
		if len(s.PeerCertificates) > 0 {
			got := sha256.Sum256(s.PeerCertificates[0].Raw)
			if subtle.ConstantTimeCompare(expected, got[:]) == 1 {
				return nil
			}
		}
		return errServerCert
	}}
}

// Dial the same binary WebSocket carrier as cloudflared access tcp. Edge TLS
// uses ordinary hostname and CA verification. Origin TLS runs inside it.
func dialSyncTunnel(ctx context.Context, address string, roots *x509.CertPool) (net.Conn, error) {
	config, err := websocket.NewConfig("wss://"+address+"/", "https://"+address)
	if err != nil {
		return nil, err
	}
	config.TlsConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
	ws, err := config.DialContext(ctx)
	if err != nil {
		var dialErr *websocket.DialError
		if errors.As(err, &dialErr) {
			err = dialErr.Err
		}
		var certErr *tls.CertificateVerificationError
		if errors.As(err, &certErr) {
			return nil, errServerCert
		}
		return nil, err
	}
	ws.PayloadType = websocket.BinaryFrame
	return ws, nil
}

func syncHTTPClient(originTLS *tls.Config, modes []string, roots *x509.CertPool) *http.Client {
	transport := &http.Transport{ResponseHeaderTimeout: 30 * time.Second}
	transport.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		config := originTLS.Clone()
		config.ServerName = host
		var failure error = errServerOffline
		for _, mode := range modes {
			limit, cancel := context.WithTimeout(ctx, serverDialTimeout)
			var conn net.Conn
			if mode == transportTunnel {
				conn, err = dialSyncTunnel(limit, addr, roots)
			} else {
				conn, err = (&net.Dialer{}).DialContext(limit, network, addr)
			}
			if err == nil {
				deadline, _ := limit.Deadline()
				conn.SetDeadline(deadline)
				secured := tls.Client(conn, config)
				err = secured.HandshakeContext(limit)
				if err == nil {
					conn.SetDeadline(time.Time{})
					cancel()
					return secured, nil
				}
				conn.Close()
			}
			cancel()
			if errors.Is(err, errServerCert) {
				failure = errServerCert
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
		}
		return nil, failure
	}
	return &http.Client{Transport: transport, Timeout: 4 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

func (p *serverProfile) client() *http.Client {
	order := []string{transportDirect, transportTunnel}
	if p.Transport == transportTunnel {
		order[0], order[1] = order[1], order[0]
	}
	return syncHTTPClient(pinnedServerTLS(p.Pin), order, nil)
}

// GotConn identifies the connection selected for this request, including
// pooled connections and dials that succeeded on the second transport.
func traceSyncTransport(ctx context.Context, mode *string) context.Context {
	return httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
		if conn, ok := info.Conn.(*tls.Conn); ok {
			switch conn.NetConn().(type) {
			case *net.TCPConn:
				*mode = transportDirect
			case *websocket.Conn:
				*mode = transportTunnel
			}
		}
	}})
}
