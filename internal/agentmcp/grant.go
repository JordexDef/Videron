package agentmcp

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

type agentAnswer struct {
	text   string
	failed bool
}

type noteGrant struct {
	id, token, endpoint string
	host                string
	pair                *pairedNoteGrant
	write               bool
	ctx                 context.Context
	cancel              context.CancelFunc
	server              *http.Server
	emit                func(string, string, string, string)
	mu                  sync.Mutex
	pending             map[string]chan agentAnswer
}

// Access owns the single active grant for a desktop session.
type Access struct {
	mu      sync.Mutex
	current *noteGrant
}

func (g *noteGrant) close() {
	g.cancel()
	_ = g.server.Close()
	if g.pair != nil {
		_ = os.Remove(g.pair.discoveryPath)
	}
}

func (s *Access) revoke(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if g := s.current; g != nil && (id == "" || id == g.id) {
		s.current = nil
		g.close()
	}
}

func listenNoteGrant(write bool, emit func(string, string, string, string), client *agentClient) (*noteGrant, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	g := &noteGrant{id: rand.Text(), token: rand.Text() + rand.Text(), endpoint: "http://" + listener.Addr().String() + "/mcp",
		host: listener.Addr().String(), write: write, ctx: ctx, cancel: cancel, emit: emit, pending: make(map[string]chan agentAnswer)}
	if client != nil {
		secured, err := g.preparePairedListener(listener, *client)
		if err != nil {
			cancel()
			listener.Close()
			return nil, err
		}
		listener = secured
	}
	g.server = &http.Server{Handler: g, ReadHeaderTimeout: 4 * time.Second, ReadTimeout: 12 * time.Second, WriteTimeout: 55 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	go func() { _ = g.server.Serve(listener) }()
	return g, nil
}

// Open checks workspace readiness under the same lock used to revoke grants.
// A lock event either prevents opening the grant or revokes the newly opened one.
func (s *Access) Open(clientID string, write bool, emit func(string, string, string, string), checkReady func() error) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if checkReady != nil {
		if err := checkReady(); err != nil {
			return "", err
		}
	}
	if s.current != nil {
		return "", errors.New("VD_AGENT_BUSY")
	}
	var client *agentClient
	if clientID != "" {
		c, err := findAgentClient(clientID)
		if err != nil {
			return "", err
		}
		client = &c
	}
	g, err := listenNoteGrant(write, emit, client)
	if err != nil {
		return "", err
	}
	s.current = g
	if client != nil {
		out, err := json.Marshal(map[string]string{"id": g.id})
		return string(out), err
	}
	config, err := g.mcpConfig()
	if err != nil {
		s.current = nil
		g.close()
		return "", err
	}
	// The copyable stdio config is scoped to this grant. Never persist its token.
	out, err := json.Marshal(map[string]any{"id": g.id, "config": map[string]any{"mcpServers": map[string]any{"videron": map[string]any{
		"command": config["command"], "args": config["args"], "env": map[string]string{"VIDERON_AGENT_ENDPOINT": g.endpoint, "VIDERON_AGENT_TOKEN": g.token},
	}}}})
	return string(out), err
}

func (g *noteGrant) mcpConfig() (map[string]any, error) {
	if g.pair != nil {
		return nil, errors.New("VD_AGENT_CONFIG")
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": "videron", "command": exe, "args": []string{"--agent-mcp"},
		"env": []map[string]string{{"name": "VIDERON_AGENT_ENDPOINT", "value": g.endpoint}, {"name": "VIDERON_AGENT_TOKEN", "value": g.token}}}, nil
}

// Grant carries the short-lived connection negotiated by an ACP adapter.
type Grant struct {
	Context   context.Context
	Token     string
	MCPServer map[string]any
}

func (s *Access) ACPGrant(id string) (Grant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.current
	if g == nil || g.id != id {
		return Grant{}, errors.New("VD_AGENT_REVOKED")
	}
	config, err := g.mcpConfig()
	if err != nil {
		return Grant{}, err
	}
	return Grant{Context: g.ctx, Token: g.token, MCPServer: config}, nil
}

func (s *Access) Close(id string) {
	if id != "" {
		s.revoke(id)
	}
}

func (s *Access) Reset() { s.revoke("") }

func (s *Access) Resolve(grant, request, result string, failed bool) {
	s.mu.Lock()
	g := s.current
	s.mu.Unlock()
	if g == nil || g.id != grant {
		return
	}
	if len(result) > agentReplyLimit/2 {
		result = "Response too large. Request a smaller page."
		failed = true
	}
	g.mu.Lock()
	ch := g.pending[request]
	delete(g.pending, request)
	g.mu.Unlock()
	if ch != nil {
		ch <- agentAnswer{result, failed}
	}
}
