package syncserver

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	xws "golang.org/x/net/websocket"
)

func TestTunnelWebRouting(t *testing.T) {
	for _, address := range []string{":8744", "0.0.0.0:8744", "[::]:8744", "192.0.2.1:8744", "example.com:8744", "127.0.0.1:0"} {
		if ln, err := listenTunnelWeb(address); err == nil {
			ln.Close()
			t.Errorf("accepted -web-listen %q", address)
		}
	}
	for _, tc := range []struct {
		method, path string
		code         int
	}{
		{"GET", "/", 200}, {"HEAD", "/", 200}, {"POST", "/", 405},
		{"GET", "/landing.js", 200}, {"HEAD", "/landing.js", 200}, {"POST", "/landing.js", 405},
		{"GET", "/land%69ng.js", 404}, {"GET", "/./", 404},
		{"GET", "/v1/index", 404}, {"POST", "/v1/auth/start", 404}, {"GET", "/identity.json", 404},
	} {
		w := httptest.NewRecorder()
		tunnelWeb{}.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.code || (tc.method == "HEAD" && w.Body.Len() > 0) ||
			(tc.method == "GET" && tc.path == "/" && !bytes.Equal(w.Body.Bytes(), landingPage)) ||
			(tc.method == "GET" && tc.path == "/landing.js" && !bytes.Equal(w.Body.Bytes(), landingScript)) {
			t.Errorf("%s %s returned %d and %d bytes", tc.method, tc.path, w.Code, w.Body.Len())
		}
	}
	r := httptest.NewRequest("GET", "http://sync.example.net/", nil)
	r.Header.Set("Origin", "https://sync.example.net:443")
	if !sameTunnelOrigin(r) {
		t.Fatal("rejected the desktop client's standard HTTPS port")
	}
	r.Header.Set("Origin", "https://example.net")
	if sameTunnelOrigin(r) {
		t.Fatal("accepted a cross-origin handshake")
	}
}

func TestTunnelWebNativeTLS(t *testing.T) {
	id, err := newIdentity()
	if err != nil {
		t.Fatal(err)
	}
	cert, err := id.certificate()
	if err != nil {
		t.Fatal(err)
	}
	listen := func() net.Listener {
		t.Helper()
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		return ln
	}
	native, web := listen(), listen()
	server := http.Server{
		Handler:   &service{store: openTestStore(t, testRoot(t)), token: id.Token, landing: landingOff},
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}},
	}
	done := make(chan error, 1)
	go func() { done <- serveTunnelAndNative(&server, native, web, landingOff) }()
	t.Cleanup(func() {
		web.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("native listener still running after web listener stopped")
		}
	})
	wsURL := "ws://" + web.Addr().String()
	transport := &http.Transport{
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			config, err := xws.NewConfig(wsURL+"/", "https://"+web.Addr().String())
			if err != nil {
				return nil, err
			}
			wire, err := config.DialContext(ctx)
			if err != nil {
				return nil, err
			}
			wire.PayloadType = xws.BinaryFrame
			client := tls.Client(wire, &tls.Config{InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error {
				if !bytes.Equal(cs.PeerCertificates[0].Raw, id.Cert) {
					return errors.New("incorrect native certificate")
				}
				return nil
			}})
			if err := client.HandshakeContext(ctx); err != nil {
				wire.Close()
				return nil, err
			}
			return client, nil
		},
	}
	t.Cleanup(transport.CloseIdleConnections)
	client := http.Client{Transport: transport, Timeout: 5 * time.Second}
	for _, tc := range []struct {
		token string
		code  int
	}{{"", 401}, {id.Token, 200}} {
		req, err := http.NewRequest("GET", "https://sync.example.net/v1/index", nil)
		if err != nil {
			t.Fatal(err)
		}
		if tc.token != "" {
			req.Header.Set("Authorization", "Bearer "+tc.token)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != tc.code {
			t.Fatalf("native index through tunnel: %d, %v", resp.StatusCode, err)
		}
	}
	bad, resp, err := websocket.DefaultDialer.Dial(wsURL+"/v1/index", nil)
	if err == nil {
		bad.Close()
		t.Fatal("upgraded a protected path on the outer HTTP listener")
	}
	if resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong response for a protected path: %v", err)
	}
	resp.Body.Close()
	textWS, _, err := websocket.DefaultDialer.Dial(wsURL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer textWS.Close()
	textWS.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := textWS.WriteMessage(websocket.TextMessage, []byte("text")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := textWS.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseUnsupportedData) {
		t.Fatalf("expected binary-only transport: %v", err)
	}
}
