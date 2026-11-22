package syncserver

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func listenTunnelWeb(address string) (net.Listener, error) {
	addr, err := netip.ParseAddrPort(address)
	if err != nil || !addr.Addr().IsLoopback() || addr.Port() == 0 {
		return nil, errors.New("-web-listen requires a loopback IP and port")
	}
	return net.Listen("tcp", addr.String())
}

func serveTunnelAndNative(native *http.Server, listener, webListener net.Listener, landing landingMode) error {
	// Connect back to the same socket that serves direct native clients.
	address := *listener.Addr().(*net.TCPAddr)
	if address.IP.IsUnspecified() {
		if address.IP.To4() == nil {
			address.IP = net.IPv6loopback
		} else {
			address.IP = net.IPv4(127, 0, 0, 1)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	web := http.Server{
		Handler:           tunnelWeb{nativeAddr: address.String(), landing: landing},
		BaseContext:       func(net.Listener) context.Context { return ctx },
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		WriteTimeout:      30 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	done := make(chan error, 2)
	go func() { done <- native.ServeTLS(listener, "", "") }()
	go func() { done <- web.Serve(webListener) }()
	err := <-done
	cancel() // Also release hijacked WebSockets, which http.Server.Close skips.
	web.Close()
	native.Close()
	<-done
	return err
}

// Videron sets an HTTPS Origin including the port. The edge may omit :443
// from the Host that it forwards to the HTTP origin.
func sameTunnelOrigin(r *http.Request) bool {
	raw := r.Header.Get("Origin")
	if raw == "" {
		return true
	}
	origin, err := url.Parse(raw)
	return err == nil && origin.Scheme == "https" && origin.User == nil &&
		strings.EqualFold(strings.TrimSuffix(origin.Host, ":443"), strings.TrimSuffix(r.Host, ":443"))
}

type tunnelWeb struct {
	nativeAddr string
	landing    landingMode
}

func (h tunnelWeb) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !websocket.IsWebSocketUpgrade(r) {
		h.landing.ServeHTTP(w, r)
		return
	}
	if r.URL.EscapedPath() != "/" {
		http.NotFound(w, r)
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: sameTunnelOrigin, HandshakeTimeout: 10 * time.Second}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	dialer := net.Dialer{Timeout: 5 * time.Second}
	conn, err := dialer.DialContext(r.Context(), "tcp", h.nativeAddr)
	if err != nil {
		return
	}
	closeBoth := func() {
		conn.Close()
		ws.Close()
	}
	stop := context.AfterFunc(r.Context(), closeBoth)
	defer stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer closeBoth()
		buf := make([]byte, 32<<10)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				ws.SetWriteDeadline(time.Now().Add(90 * time.Second))
				if ws.WriteMessage(websocket.BinaryMessage, buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		kind, payload, err := ws.NextReader()
		if err != nil {
			break
		}
		if kind != websocket.BinaryMessage {
			ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseUnsupportedData, "binary messages required"), time.Now().Add(time.Second))
			break
		}
		if _, err := io.Copy(conn, payload); err != nil {
			break
		}
	}
	closeBoth()
	<-done
}
