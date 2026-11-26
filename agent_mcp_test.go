package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Run the same stdio entry point used by an external client in a real child.
func TestAgentMCPChild(t *testing.T) {
	if os.Getenv("VIDERON_TEST_MCP_CHILD") != "1" {
		return
	}
	if err := serveAgentStdio(os.Stdin, os.Stdout, os.Getenv("VIDERON_AGENT_ENDPOINT"), os.Getenv("VIDERON_AGENT_TOKEN")); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

func TestAgentMCPClientRoundTrip(t *testing.T) {
	a := &App{}
	calls := make(chan string, 1)
	g, err := startNoteGrant(false, func(grant, request, tool, params string) {
		calls <- tool + " " + params
		a.ResolveAgentCall(grant, request, "A synthetic idea with a table.", false)
	})
	if err != nil {
		t.Fatal(err)
	}
	a.noteAccess.current = g
	t.Cleanup(a.ResetAgentConnections)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "-test.run=^TestAgentMCPChild$")
	cmd.Env = append(cmd.Environ(), "VIDERON_TEST_MCP_CHILD=1", "VIDERON_AGENT_ENDPOINT="+g.endpoint, "VIDERON_AGENT_TOKEN="+g.token)
	cmd.Stdin = strings.NewReader(strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_idea","arguments":{"offset":12}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"update_task","arguments":{"key":"x"}}}`,
	}, "\n") + "\n")
	stdout, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(stdout))
	for id := 1; id <= 4; id++ {
		var response struct {
			ID     int
			Result struct {
				ProtocolVersion string
				Tools           []struct{ Name string }
				Content         []struct{ Text string }
				IsError         bool
			}
			Error *struct{ Code int }
		}
		if err = dec.Decode(&response); err != nil || response.ID != id {
			t.Fatalf("reply %d: %+v, %v", id, response, err)
		}
		switch id {
		case 1:
			if response.Result.ProtocolVersion != "2025-06-18" {
				t.Fatal("wrong negotiation")
			}
		case 2:
			if len(response.Result.Tools) != 2 || response.Result.Tools[0].Name != "read_idea" || response.Result.Tools[1].Name != "list_tasks" {
				t.Fatalf("unexpected tools: %+v", response.Result.Tools)
			}
		case 3:
			if response.Result.IsError || len(response.Result.Content) != 1 || response.Result.Content[0].Text != "A synthetic idea with a table." {
				t.Fatalf("read failed: %+v", response)
			}
		case 4:
			if response.Error == nil || response.Error.Code != -32602 {
				t.Fatal("read-only grant accepted a write")
			}
		}
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		t.Fatal("unexpected stdio output")
	}
	if call := <-calls; call != `read_idea {"offset":12}` || len(calls) != 0 {
		t.Fatalf("unexpected UI request: %q", call)
	}
}

func TestAgentMCPGrantGuardsAndRevocation(t *testing.T) {
	a := &App{}
	g, err := startNoteGrant(true, func(string, string, string, string) { t.Error("unexpected note operation") })
	if err != nil {
		t.Fatal(err)
	}
	a.noteAccess.current = g
	t.Cleanup(a.ResetAgentConnections)
	for _, tc := range []struct {
		name, host, origin, credential string
		want                           int
	}{
		{"ok", "", "", g.token, 200},
		{"host", "example.invalid", "", "", 404},
		{"origin", "", "https://example.invalid", g.token, 403},
		{"no credential", "", "", "", 401},
		{"invalid credential", "", "", "wrong", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, g.endpoint, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
			if err != nil {
				t.Fatal(err)
			}
			if tc.host != "" {
				req.Host = tc.host
			}
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.credential != "" {
				req.Header.Set("Authorization", "Bearer "+tc.credential)
			}
			resp, err := (&http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}).Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Fatalf("status %d, want %d", resp.StatusCode, tc.want)
			}
		})
	}
	a.CloseAgentAccess("unrelated")
	if _, err = a.acpGrant(g.id); err != nil {
		t.Fatal("unrelated revoke disabled active grant")
	}
	a.CloseAgentAccess(g.id)
	if _, err = a.acpGrant(g.id); err == nil {
		t.Fatal("grant remained available")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	config, err := json.Marshal(map[string]string{"command": exe, "grantId": g.id, "prompt": "Fixture only"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.StartAgentRun(string(config)); err == nil || err.Error() != "VD_AGENT_REVOKED" {
		t.Fatal("ACP launch accepted a revoked grant", err)
	}
	newGrant, err := startNoteGrant(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer newGrant.close()
	req := httptest.NewRequest("POST", newGrant.endpoint, strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"ping"}`))
	req.Header.Set("Authorization", "Bearer "+g.token)
	response := httptest.NewRecorder()
	newGrant.ServeHTTP(response, req)
	if response.Code != 401 {
		t.Fatalf("old credential accepted: %d", response.Code)
	}
}

func TestAgentMCPResetReleasesPending(t *testing.T) {
	a := &App{}
	pending := make(chan string, 1)
	g, err := startNoteGrant(true, func(grant, id, method, args string) { pending <- id })
	if err != nil {
		t.Fatal(err)
	}
	a.noteAccess.current = g
	t.Cleanup(a.ResetAgentConnections)
	result := make(chan int, 1)
	go func() {
		_, code, _ := g.dispatch(context.Background(), agentRPC{Method: "tools/call", Params: json.RawMessage(`{"name":"list_tasks","arguments":{}}`)})
		result <- code
	}()
	var request string
	select {
	case request = <-pending:
	case <-time.After(3 * time.Second):
		t.Fatal("call did not reach UI")
	}
	a.ResolveAgentCall("wrong-grant", request, "unexpected", false)
	a.ResetAgentConnections()
	select {
	case code := <-result:
		if code != -32000 {
			t.Fatalf("stale result: %d", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("pending call remained blocked after reset")
	}
	if !errors.Is(g.ctx.Err(), context.Canceled) {
		t.Fatal("grant stayed active")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.pending) != 0 {
		t.Fatal("request handles retained")
	}
}

func TestAgentMCPRejectLockedWorkspace(t *testing.T) {
	a := &App{}
	defer a.ResetAgentConnections()
	if _, err := a.OpenAgentAccess(true); err == nil {
		t.Fatal("locked workspace issued an access grant")
	}
	a.loaded = true
	a.sessionLockPending.Store(true)
	if _, err := a.OpenAgentAccess(true); err == nil {
		t.Fatal("pending session lock issued an access grant")
	}
}
