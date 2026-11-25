package syncclient

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gorilla/websocket"

	"videron/internal/syncclient/synctest"
)

func TestSyncAddressDiscovery(t *testing.T) {
	for _, tc := range []struct {
		input, firstAddr, transport string
		count                       int
	}{
		{"sync.Example.net", "https://sync.example.net:443", TransportTunnel, 3},
		{"https://sync.example.net/", "https://sync.example.net:443", TransportTunnel, 3},
		{"192.168.5.6", "https://192.168.5.6:8743", TransportDirect, 3},
		{"localhost", "https://localhost:8743", TransportDirect, 3},
		{"2001:db8::1", "https://[2001:db8::1]:8743", TransportDirect, 3},
		{"https://[::1]:444/", "https://[::1]:444", TransportDirect, 2},
		{"example.net:443", "https://example.net:443", TransportTunnel, 2},
	} {
		got, err := serverEndpoints(tc.input)
		if err != nil || len(got) != tc.count || got[0] != (serverEndpoint{tc.firstAddr, tc.transport}) {
			t.Errorf("serverEndpoints(%q) = %v, %v", tc.input, got, err)
		}
	}
	for _, invalid := range []string{"", "http://example.net", "https://example.net:0", "example.net:65536", "user@example.net", "example.net:abcd", "example.net:", "example.net/start", "example.net#", "example.net?", "https://::1", "https://%65xample.net", "bad host"} {
		if _, err := serverEndpoints(invalid); !errors.Is(err, ErrAddress) {
			t.Errorf("accepted invalid address %q", invalid)
		}
	}
}

// The relay has a publicly trusted (test CA) HTTPS frontend. It accepts
// binary WebSocket messages and forwards their payload as TCP to the actual
// sync service, just like a Cloudflare published TCP application.
func TestPasswordThroughCloudflareTCP(t *testing.T) {
	const password = "tunnel test server password"
	origin := synctest.NewServer(t, password)
	expected, err := ParsePairCode(origin.Code)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	directProfile, err := VerifyCredentials(ctx, origin.Addr, password)
	if err != nil || directProfile.Pin != expected.Pin {
		t.Fatal("could not verify the native sync listener", err)
	}
	var direct, upgrades, binaryBytes atomic.Int64
	var invalid atomic.Bool
	upgrader := websocket.Upgrader{}
	edge := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			invalid.Store(true)
		}
		if r.URL.Path != "/" || !websocket.IsWebSocketUpgrade(r) {
			body, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
			if bytes.Contains(body, []byte(password)) || bytes.Contains(body, []byte(directProfile.Token)) {
				invalid.Store(true)
			}
			direct.Add(1)
			http.Error(w, "WebSocket upgrade required", http.StatusForbidden)
			return
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		upstream, err := net.Dial("tcp", origin.Addr)
		if err != nil {
			return
		}
		defer upstream.Close()
		upgrades.Add(1)
		go func() {
			defer ws.Close()
			buf := make([]byte, 4096)
			for {
				n, err := upstream.Read(buf)
				if n > 0 && ws.WriteMessage(websocket.BinaryMessage, buf[:n]) != nil {
					return
				}
				if err != nil {
					return
				}
			}
		}()
		for {
			kind, payload, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if kind != websocket.BinaryMessage || bytes.Contains(payload, []byte(password)) || bytes.Contains(payload, []byte(directProfile.Token)) {
				invalid.Store(true)
				return
			}
			binaryBytes.Add(int64(len(payload)))
			if _, err = upstream.Write(payload); err != nil {
				return
			}
		}
	}))
	defer edge.Close()
	roots := x509.NewCertPool()
	roots.AddCert(edge.Certificate())
	endpoints, err := serverEndpoints(edge.URL)
	if err != nil {
		t.Fatal(err)
	}
	tunnel := serverEndpoint{edge.URL, TransportTunnel}
	if _, err = verifyServerEndpoint(ctx, tunnel, password, nil); !errors.Is(err, ErrCert) {
		t.Fatal("accepted untrusted TLS on WebSocket edge", err)
	}
	p, err := discoverServer(ctx, endpoints, password, roots)
	if err != nil {
		t.Fatal(err)
	}
	if p.Transport != TransportTunnel || p.Pin != expected.Pin || p.Token != directProfile.Token || p.Address != edge.URL {
		t.Fatal("tunnel returned incorrect origin identity or transport")
	}
	if direct.Load() == 0 || upgrades.Load() < 2 || binaryBytes.Load() == 0 || invalid.Load() {
		t.Fatal("relay observed unexpected data or discovery skipped a transport")
	}
	pinned := syncHTTPClient(PinnedTLS(p.Pin), []string{TransportDirect, TransportTunnel}, roots)
	defer pinned.CloseIdleConnections()
	p.Transport = TransportDirect
	if _, err = p.Manifest(pinned); err != nil {
		t.Fatal("paired client did not retry the tunnel after direct TLS pin mismatch", err)
	}
	if p.Transport != TransportTunnel {
		t.Fatal("Manifest did not record the tunnel used after fallback")
	}
	p.Lineage = strings.Repeat("a", 64)
	payload := bytes.Repeat([]byte("a sync payload spanning multiple TLS records\n"), 8000)
	if err = p.upload(pinned, "/v1/main", payload); err != nil {
		t.Fatal("streaming upload", err)
	}
	resp, err := p.request(pinned, http.MethodGet, "/v1/main", nil)
	if err != nil {
		t.Fatal("streaming download", err)
	}
	got, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatal("streaming download changed the stored data", err)
	}
	wrongPin := syncHTTPClient(PinnedTLS(strings.Repeat("0", 64)), []string{TransportTunnel}, roots)
	defer wrongPin.CloseIdleConnections()
	p.Transport = TransportDirect
	if _, err = p.Manifest(wrongPin); !errors.Is(err, ErrCert) {
		t.Fatal("tunnel accepted incorrect origin pin", err)
	}
	if p.Transport != TransportDirect {
		t.Fatal("failed origin verification changed the last successful transport")
	}
	if invalid.Load() {
		t.Fatal("relay received a plaintext credential or a non-binary frame")
	}
}

func TestSyncServiceProcess(t *testing.T) { synctest.RunServerProcess(t) }
