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

type agentAccess struct {
	sync.Mutex
	current *noteGrant
}

func (g *noteGrant) close() {
	g.cancel()
	_ = g.server.Close()
	if g.pair != nil {
		_ = os.Remove(g.pair.discoveryPath)
	}
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
	return listenNoteGrant(write, emit, nil)
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

func (a *App) OpenAgentAccess(write bool) (string, error) {
	return a.openAgentAccess("", write, a.emitAgentCall)
}

func (a *App) OpenPairedAgentAccess(id string, write bool) (string, error) {
	if id == "" {
		return "", errAgentClientUnknown
	}
	return a.openAgentAccess(id, write, a.emitAgentCall)
}

func (a *App) emitAgentCall(grant, request, tool, params string) {
	wails.EventsEmit(a.ctx, "videron:agent-call", grant, request, tool, params)
}

func (a *App) openAgentAccess(clientID string, write bool, emit func(string, string, string, string)) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := &a.noteAccess
	s.Lock()
	defer s.Unlock()
	if !a.agentWorkspaceReady() {
		return "", errLocked
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

func agentTools(write, paired bool) []map[string]any {
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
	tool := func(name, desc string, schema map[string]any) map[string]any {
		if paired {
			schema["properties"].(map[string]any)["scope"] = map[string]any{"type": "string", "description": "The scope from read_idea for this shared idea, or the preceding page for pagination."}
			switch name {
			case "read_idea", "list_tasks":
				desc += " Include the returned scope on later pages."
			default:
				schema["required"] = append(schema["required"].([]string), "scope")
				desc += " Requires task access and the scope returned by read_idea for this grant."
			}
		}
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
	if r.URL.Path != "/mcp" || r.Host != g.host {
		http.NotFound(w, r)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != strings.TrimSuffix(g.endpoint, "/mcp") {
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
	payload, err := agentReply(req.ID, result, code, message)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(payload)
}

func agentReply(id json.RawMessage, result any, code int, message string) ([]byte, error) {
	reply := map[string]any{"jsonrpc": "2.0", "id": id}
	if code != 0 {
		reply["error"] = map[string]any{"code": code, "message": message}
	} else {
		reply["result"] = result
	}
	return json.Marshal(reply)
}

func agentInfo(req agentRPC, write, paired bool) (any, int, string) {
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
		return map[string]any{"tools": agentTools(write, paired)}, 0, ""
	default:
		return nil, -32601, "Method not found"
	}
}

func agentToolResult(text string, failed bool) any {
	return map[string]any{"content": []map[string]string{{"type": "text", "text": text}}, "isError": failed}
}

func (g *noteGrant) dispatch(ctx context.Context, req agentRPC) (any, int, string) {
	if req.Method != "tools/call" {
		return agentInfo(req, g.write, g.pair != nil)
	}
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
			if g.pair != nil {
				return agentToolResult("This idea is shared for reading only.", true), 0, ""
			}
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
	if g.pair != nil {
		if err := g.checkPairedScope(p.Name, p.Arguments); err != nil {
			return agentToolResult(err.Error(), true), 0, ""
		}
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
		if g.ctx.Err() != nil {
			return nil, -32000, "Access ended"
		}
		if g.pair != nil && !answer.failed && (p.Name == "read_idea" || p.Name == "list_tasks") {
			answer = g.pairedPage(p.Name, answer)
		}
		return agentToolResult(answer.text, answer.failed), 0, ""
	case <-g.ctx.Done():
		return nil, -32000, "Access ended"
	case <-ctx.Done():
		return nil, -32000, "Call cancelled"
	case <-timer.C:
		return nil, -32000, "Videron did not respond"
	}
}

// The MCP child never opens the library. It forwards each stdio message to the
// running desktop session using that session's short-lived, loopback-only grant.
func serveAgentStdio(input io.Reader, output io.Writer, endpoint, token string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "/mcp" || u.RawQuery != "" || u.Fragment != "" || token == "" {
		return errors.New("invalid or missing Videron connection")
	}
	client := agentHTTPClient(&http.Transport{})
	defer client.CloseIdleConnections()
	return scanAgentStdio(input, output, func(line []byte) ([]byte, error) {
		return forwardAgentRPC(client, endpoint, token, line)
	})
}

func agentHTTPClient(transport *http.Transport) *http.Client {
	return &http.Client{Timeout: 50 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func scanAgentStdio(input io.Reader, output io.Writer, handle func([]byte) ([]byte, error)) error {
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 4096), agentRequestLimit)
	for scan.Scan() {
		line := bytes.TrimSpace(scan.Bytes())
		if len(line) == 0 {
			continue
		}
		data, err := handle(line)
		if err != nil {
			return err
		}
		if len(data) > 0 {
			if _, err = fmt.Fprintln(output, string(bytes.TrimSpace(data))); err != nil {
				return err
			}
		}
	}
	return scan.Err()
}

func forwardAgentRPC(client *http.Client, endpoint, token string, line []byte) ([]byte, error) {
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(line))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("Videron connection closed")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, agentReplyLimit+1))
	resp.Body.Close()
	if err != nil || len(data) > agentReplyLimit || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Videron connection unavailable (%d)", resp.StatusCode)
	}
	if resp.StatusCode == http.StatusAccepted {
		return nil, nil
	}
	if !json.Valid(data) {
		return nil, errors.New("invalid Videron response")
	}
	return data, nil
}
