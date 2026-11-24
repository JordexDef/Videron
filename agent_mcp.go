package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	wails "github.com/wailsapp/wails/v2/pkg/runtime"
)

const agentRequestLimit = 384 << 10
const agentReplyLimit = 4 << 20

type agentAnswer struct {
	text   string
	failed bool
}

type noteGrant struct {
	id, token, endpoint string
	write               bool
	ctx                 context.Context
	cancel              context.CancelFunc
	server              *http.Server
	emit                func(string, string, string, string)
	mu                  sync.Mutex
	pending             map[string]chan agentAnswer
}

type agentAccess struct {
	sync.Mutex
	current *noteGrant
}

func (g *noteGrant) close() {
	g.cancel()
	_ = g.server.Close()
}

func (s *agentAccess) revoke(id string) {
	s.Lock()
	defer s.Unlock()
	if g := s.current; g != nil && (id == "" || id == g.id) {
		s.current = nil
		g.close()
	}
}

func startNoteGrant(write bool, emit func(string, string, string, string)) (*noteGrant, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	g := &noteGrant{id: rand.Text(), token: rand.Text() + rand.Text(), endpoint: "http://" + listener.Addr().String() + "/mcp",
		write: write, ctx: ctx, cancel: cancel, emit: emit, pending: make(map[string]chan agentAnswer)}
	g.server = &http.Server{Handler: g, ReadHeaderTimeout: 4 * time.Second, ReadTimeout: 12 * time.Second, WriteTimeout: 55 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	go func() { _ = g.server.Serve(listener) }()
	return g, nil
}

func (a *App) OpenAgentAccess(write bool) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	s := &a.noteAccess
	s.Lock()
	defer s.Unlock()
	if s.current != nil {
		return "", errors.New("VD_AGENT_BUSY")
	}
	if a.sessionLockPending.Load() || a.revokingFolderKeys.Load() {
		return "", errors.New("VD_LOCKED")
	}
	g, err := startNoteGrant(write, func(grant, request, tool, params string) {
		wails.EventsEmit(a.ctx, "videron:agent-call", grant, request, tool, params)
	})
	if err != nil {
		return "", err
	}
	s.current = g
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
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": "videron", "command": exe, "args": []string{"--agent-mcp"},
		"env": []map[string]string{{"name": "VIDERON_AGENT_ENDPOINT", "value": g.endpoint}, {"name": "VIDERON_AGENT_TOKEN", "value": g.token}}}, nil
}

func (a *App) acpGrant(id string) (*noteGrant, error) {
	s := &a.noteAccess
	s.Lock()
	defer s.Unlock()
	if s.current == nil || s.current.id != id {
		return nil, errors.New("VD_AGENT_REVOKED")
	}
	return s.current, nil
}

func (a *App) CloseAgentAccess(id string) {
	if id != "" {
		a.noteAccess.revoke(id)
	}
}
func (a *App) ResetAgentConnections() { a.noteAccess.revoke(""); a.agentRuns.reset() }

func (a *App) ResolveAgentCall(grant, request, result string, failed bool) {
	s := &a.noteAccess
	s.Lock()
	g := s.current
	s.Unlock()
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

type agentRPC struct {
	Version string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func agentTools(write bool) []map[string]any {
	limited := func(limit int) map[string]any { return map[string]any{"type": "string", "maxLength": limit} }
	key := map[string]any{"type": "string", "pattern": "^[a-zA-Z0-9_-]{1,64}$"}
	weight := map[string]any{"type": "number", "exclusiveMinimum": 0, "maximum": 1000}
	offset := map[string]any{"type": "integer", "minimum": 0}
	obj := func(p map[string]any, required ...string) map[string]any {
		s := map[string]any{"type": "object", "properties": p, "additionalProperties": false}
		if len(required) > 0 {
			s["required"] = required
		}
		return s
	}
	tool := func(name, desc string, schema any) map[string]any {
		return map[string]any{"name": name, "description": desc, "inputSchema": schema}
	}
	out := []map[string]any{
		tool("read_idea", "Read the selected idea as Markdown including tables and drawing geometry. Pass the returned nextOffset for further pages.", obj(map[string]any{"offset": offset})),
		tool("list_tasks", "Read this idea's task keys, weights, states and results. Pass nextOffset for more tasks.", obj(map[string]any{"offset": offset})),
	}
	if write {
		task := obj(map[string]any{"key": key, "title": limited(256), "description": limited(16000), "weight": weight}, "key", "title")
		out = append(out, tool("create_tasks", "Add linked task notes to the selected idea (up to 256 total). Reuse each task's stable key on retries.", obj(map[string]any{"tasks": map[string]any{"type": "array", "items": task, "minItems": 1, "maxItems": 64}}, "tasks")),
			tool("update_task", "Report actual progress on one linked task. Include the result or evidence on completion.", obj(map[string]any{"key": key, "status": map[string]any{"enum": []string{"pending", "working", "blocked", "done", "cancelled"}}, "result": limited(32000), "weight": weight}, "key")))
	}
	return out
}

func (g *noteGrant) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path != "/mcp" || r.Host != strings.TrimSuffix(strings.TrimPrefix(g.endpoint, "http://"), "/mcp") {
		http.NotFound(w, r)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+g.token)) != 1 || g.ctx.Err() != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var req agentRPC
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, agentRequestLimit))
	if err != nil {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		return
	}
	if json.Unmarshal(body, &req) != nil || req.Version != "2.0" || req.Method == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if len(req.ID) == 0 {
		if !strings.HasPrefix(req.Method, "notifications/") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		return
	}
	result, code, message := g.dispatch(r.Context(), req)
	reply := map[string]any{"jsonrpc": "2.0", "id": req.ID}
	if code != 0 {
		reply["error"] = map[string]any{"code": code, "message": message}
	} else {
		reply["result"] = result
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(reply)
}

func (g *noteGrant) dispatch(ctx context.Context, req agentRPC) (any, int, string) {
	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		switch params.ProtocolVersion {
		case "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25":
		default:
			params.ProtocolVersion = "2025-11-25"
		}
		return map[string]any{"protocolVersion": params.ProtocolVersion, "serverInfo": map[string]string{"name": "videron", "version": "1"}, "capabilities": map[string]any{"tools": map[string]any{}}}, 0, ""
	case "ping":
		return map[string]any{}, 0, ""
	case "tools/list":
		return map[string]any{"tools": agentTools(g.write)}, 0, ""
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal(req.Params, &p) != nil {
			return nil, -32602, "Invalid tool call"
		}
		switch p.Name {
		case "read_idea", "list_tasks":
		case "create_tasks", "update_task":
			if !g.write {
				return nil, -32602, "Read-only access"
			}
		default:
			return nil, -32602, "Unknown tool"
		}
		if len(p.Arguments) == 0 {
			p.Arguments = json.RawMessage("{}")
		}
		if p.Arguments[0] != '{' {
			return nil, -32602, "Expected an arguments object"
		}
		id := rand.Text()
		ch := make(chan agentAnswer, 1)
		g.mu.Lock()
		if len(g.pending) >= 8 {
			g.mu.Unlock()
			return nil, -32000, "Workspace busy"
		}
		g.pending[id] = ch
		g.mu.Unlock()
		defer func() { g.mu.Lock(); delete(g.pending, id); g.mu.Unlock() }()
		g.emit(g.id, id, p.Name, string(p.Arguments))
		timer := time.NewTimer(45 * time.Second)
		defer timer.Stop()
		select {
		case answer := <-ch:
			return map[string]any{"content": []map[string]string{{"type": "text", "text": answer.text}}, "isError": answer.failed}, 0, ""
		case <-g.ctx.Done():
			return nil, -32000, "Access ended"
		case <-ctx.Done():
			return nil, -32000, "Call cancelled"
		case <-timer.C:
			return nil, -32000, "Videron did not respond"
		}
	default:
		return nil, -32601, "Method not found"
	}
}

// The MCP child never opens the library. It forwards each stdio message to the
// running desktop session using that session's short-lived, loopback-only grant.
func serveAgentStdio(input io.Reader, output io.Writer, endpoint, token string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "/mcp" || u.RawQuery != "" || u.Fragment != "" || token == "" {
		return errors.New("invalid or missing Videron connection")
	}
	client := &http.Client{Timeout: 50 * time.Second, Transport: &http.Transport{}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 4096), agentRequestLimit)
	for scan.Scan() {
		line := bytes.TrimSpace(scan.Bytes())
		if len(line) == 0 {
			continue
		}
		req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(line))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		resp, err := client.Do(req)
		if err != nil {
			return errors.New("Videron connection closed")
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, agentReplyLimit+1))
		resp.Body.Close()
		if err != nil || len(data) > agentReplyLimit || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("Videron connection unavailable (%d)", resp.StatusCode)
		}
		if resp.StatusCode != http.StatusAccepted {
			if !json.Valid(data) {
				return errors.New("invalid Videron response")
			}
			if _, err = fmt.Fprintln(output, string(bytes.TrimSpace(data))); err != nil {
				return err
			}
		}
	}
	return scan.Err()
}
