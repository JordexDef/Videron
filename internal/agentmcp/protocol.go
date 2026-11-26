package agentmcp

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

const agentRequestLimit = 384 << 10
const agentReplyLimit = 4 << 20

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
