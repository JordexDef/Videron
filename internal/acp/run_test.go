package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Run as an isolated ACP executable by the parent tests.
func TestACPFixture(t *testing.T) {
	mode := os.Getenv("VIDERON_TEST_ACP")
	if mode == "" {
		return
	}
	in := bufio.NewScanner(os.Stdin)
	out := json.NewEncoder(os.Stdout)
	send := func(v map[string]any) {
		if err := out.Encode(v); err != nil {
			os.Exit(3)
		}
	}
	next := func() acpMessage {
		if !in.Scan() {
			os.Exit(2)
		}
		var m acpMessage
		if json.Unmarshal(in.Bytes(), &m) != nil {
			os.Exit(3)
		}
		return m
	}
	require := func(ok bool) {
		if !ok {
			os.Exit(4)
		}
	}
	reply := func(id json.RawMessage, result any) {
		send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	init := next()
	require(init.Method == "initialize")
	reply(init.ID, map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true}})
	session := next()
	var setup struct {
		CWD, SessionID string
		Servers        []struct {
			Name, Command string
			Env           []map[string]string
		} `json:"mcpServers"`
	}
	require(json.Unmarshal(session.Params, &setup) == nil && filepath.IsAbs(setup.CWD) && len(setup.Servers) == 1 && setup.Servers[0].Name == "videron" && setup.Servers[0].Command != "" && len(setup.Servers[0].Env) == 2)
	if mode == "resume" {
		require(session.Method == "session/load" && setup.SessionID == "s")
		reply(session.ID, map[string]any{})
	} else {
		require(session.Method == "session/new")
		reply(session.ID, map[string]any{"sessionId": "s"})
	}
	prompt := next()
	require(prompt.Method == "session/prompt" && strings.Contains(string(prompt.Params), "fixture idea") && !strings.Contains(strings.Join(os.Args, " "), "fixture idea"))
	update := func(kind, text string) {
		send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "s", "update": map[string]any{"sessionUpdate": kind, "content": map[string]string{"type": "text", "text": text}}}})
	}
	update("agent_thought_chunk", "private reasoning")
	update("agent_message_chunk", "Processing. ")
	if mode == "redact" {
		var token string
		for _, v := range setup.Servers[0].Env {
			if v["name"] == "VIDERON_AGENT_TOKEN" {
				token = v["value"]
			}
		}
		require(len(token) > 20)
		update("agent_message_chunk", "Credential="+token[:20])
		update("agent_message_chunk", token[20:]+".")
		send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "s", "update": map[string]string{"sessionUpdate": "tool_call", "title": "Config " + token}}})
		send(map[string]any{"jsonrpc": "2.0", "id": "ask", "method": "session/request_permission", "params": map[string]any{"sessionId": "s", "toolCall": map[string]string{"title": "Inspect " + token}, "options": []map[string]string{{"optionId": "no", "kind": "reject_once", "name": token}}}})
		next()
		send(map[string]any{"jsonrpc": "2.0", "id": prompt.ID, "error": map[string]any{"code": -32500, "message": "invalid config: " + token}})
		os.Exit(0)
	}
	send(map[string]any{"jsonrpc": "2.0", "id": "fs", "method": "fs/read_text_file", "params": map[string]string{"sessionId": "s", "path": "unavailable"}})
	denied := next()
	require(denied.Error != nil && denied.Error.Code == -32601)
	if mode == "permission" || mode == "decline" || mode == "cancel_permission" {
		send(map[string]any{"jsonrpc": "2.0", "id": "p", "method": "session/request_permission", "params": map[string]any{"sessionId": "s", "toolCall": map[string]string{"title": "Run the fixture test"}, "options": []map[string]string{{"optionId": "once", "kind": "allow_once", "name": "Allow once"}, {"optionId": "forever", "kind": "allow_always", "name": "Always allow"}}}})
		expected := `{"outcome":{"outcome":"cancelled"}}`
		if mode == "permission" {
			expected = `{"outcome":{"optionId":"once","outcome":"selected"}}`
		}
		permission := next()
		require(string(permission.ID) == `"p"` && string(permission.Result) == expected)
	}
	if mode == "cancel" || mode == "revoke" || mode == "cancel_permission" {
		if mode != "cancel_permission" {
			send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "s", "update": map[string]any{"sessionUpdate": "tool_call", "title": "Waiting for cancellation"}}})
		}
		cancel := next()
		require(cancel.Method == "session/cancel")
		require(os.WriteFile(filepath.Join(setup.CWD, "did-cancel"), []byte("yes"), 0600) == nil)
		os.Exit(0)
	}
	if mode == "failure" {
		send(map[string]any{"jsonrpc": "2.0", "id": prompt.ID, "error": map[string]any{"code": -32001, "message": "Sign in first"}})
		os.Exit(0)
	}
	update("agent_message_chunk", "Complete.")
	reply(prompt.ID, map[string]string{"stopReason": "end_turn"})
	os.Exit(0)
}

func startACPFixture(t *testing.T, mode string) (*Runs, string, string, context.CancelFunc) {
	t.Helper()
	t.Setenv("VIDERON_TEST_ACP", mode)
	manager := new(Runs)
	t.Cleanup(manager.Reset)
	ctx, revoke := context.WithCancel(context.Background())
	t.Cleanup(revoke)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	const grantID = "fixture-grant"
	config := acpConfig{Command: exe, Args: []string{"-test.run=^TestACPFixture$"}, CWD: dir, Prompt: "fixture idea", GrantID: grantID}
	if mode == "resume" {
		config.Resume = "s"
	}
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	id, err := manager.Start(string(data), func(id string) (Grant, error) {
		if id != grantID {
			return Grant{}, errors.New("invalid fixture grant")
		}
		const token = "example-only-fixture-acp-token"
		return Grant{
			Context: ctx,
			Token:   token,
			MCPServer: map[string]any{
				"name":    "videron",
				"command": exe,
				"env": []map[string]string{
					{"name": "VIDERON_AGENT_ENDPOINT", "value": "http://127.0.0.1:1"},
					{"name": "VIDERON_AGENT_TOKEN", "value": token},
				},
			},
		}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.Close(id) })
	return manager, id, dir, revoke
}

func waitACP(t *testing.T, manager *Runs, id string, predicate func(State) bool) State {
	t.Helper()
	timeout := time.Now().Add(12 * time.Second)
	var state State
	for time.Now().Before(timeout) {
		var err error
		state, err = manager.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if predicate(state) {
			return state
		}
		if state.Status == "failed" {
			t.Fatalf("unexpected failure: %+v", state)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out: %+v", state)
	return state
}

func TestACPScopedRunWithPermissionAndResume(t *testing.T) {
	for _, mode := range []string{"permission", "decline", "resume", "failure", "cancel", "cancel_permission", "revoke", "redact"} {
		t.Run(mode, func(t *testing.T) {
			manager, id, dir, revoke := startACPFixture(t, mode)
			switch mode {
			case "permission", "decline":
				s := waitACP(t, manager, id, func(s State) bool { return s.Status == "permission" })
				if len(s.Permission.Options) != 1 || s.Permission.Options[0].ID != "once" {
					t.Fatalf("permission: %+v", s.Permission)
				}
				if err := manager.AnswerPermission(id, s.Permission.ID, "forever"); err == nil {
					t.Fatal("unexpected grant")
				}
				option := "once"
				if mode == "decline" {
					option = ""
				}
				if err := manager.AnswerPermission(id, s.Permission.ID, option); err != nil {
					t.Fatal(err)
				}
				if err := manager.AnswerPermission(id, s.Permission.ID, option); err == nil {
					t.Fatal("reused permission")
				}
			case "cancel", "cancel_permission", "revoke":
				var permissionID string
				if mode == "cancel_permission" {
					state := waitACP(t, manager, id, func(s State) bool { return s.Status == "permission" })
					permissionID = state.Permission.ID
				} else {
					waitACP(t, manager, id, func(s State) bool { return s.Activity == "Waiting for cancellation" })
				}
				if mode == "revoke" {
					revoke()
				} else if err := manager.Stop(id); err != nil {
					t.Fatal(err)
				}
				state := waitACP(t, manager, id, func(s State) bool { return s.Status == "cancelled" })
				if state.Permission != nil {
					t.Fatal("permission still visible after cancellation")
				}
				if permissionID != "" && manager.AnswerPermission(id, permissionID, "once") == nil {
					t.Fatal("answered a cancelled permission")
				}
				if _, err := os.Stat(filepath.Join(dir, "did-cancel")); err != nil {
					t.Fatal("missing session/cancel", err)
				}
				return
			case "redact":
				state := waitACP(t, manager, id, func(s State) bool { return s.Status == "permission" })
				if state.Text != "Processing. Credential=[redacted]." || state.Activity != "Config [redacted]" || state.Permission.Title != "Inspect [redacted]" || state.Permission.Options[0].Name != "[redacted]" {
					t.Fatal("credential was visible in run snapshot")
				}
				if err := manager.AnswerPermission(id, state.Permission.ID, "no"); err != nil {
					t.Fatal(err)
				}
				state = waitACP(t, manager, id, func(s State) bool { return s.Status == "failed" })
				if !strings.Contains(state.Error, "invalid config: [redacted]") {
					t.Fatal("credential was visible in error")
				}
				return
			case "failure":
				s := waitACP(t, manager, id, func(s State) bool { return s.Status == "failed" })
				if !strings.Contains(s.Error, "Sign in first") {
					t.Fatal(s.Error)
				}
				return
			}
			s := waitACP(t, manager, id, func(s State) bool { return s.Status == "completed" })
			if s.Text != "Processing. Complete." || s.SessionID != "s" || !s.Resumable {
				t.Fatalf("%+v", s)
			}
			manager.Close(id)
			if _, err := manager.Get(id); err == nil {
				t.Fatal("closed run still accessible")
			}
		})
	}
}
func TestACPRequiresLiveGrantAndValidCommand(t *testing.T) {
	manager := new(Runs)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	missingGrant := errors.New("missing fixture grant")
	payload, _ := json.Marshal(acpConfig{Command: exe, GrantID: "unknown", Prompt: "fixture idea"})
	if _, err := manager.Start(string(payload), func(string) (Grant, error) { return Grant{}, missingGrant }); !errors.Is(err, missingGrant) {
		t.Fatalf("missing grant: %v", err)
	}
	for _, cmd := range []string{"", "./someScript", "cmd\nname"} {
		payload, _ = json.Marshal(acpConfig{Command: cmd, GrantID: "none", Prompt: "fixture idea"})
		if _, err := manager.Start(string(payload), func(string) (Grant, error) {
			t.Fatal("invalid command reached the grant binder")
			return Grant{}, nil
		}); err == nil {
			t.Fatalf("invalid command %q", cmd)
		}
	}
}
