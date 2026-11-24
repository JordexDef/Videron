package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"testing"
)

func pairedTestStore(t *testing.T) *App {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("LocalAppData", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	a := &App{loaded: true}
	t.Cleanup(a.ResetAgentConnections)
	return a
}

func registeredClient(t *testing.T, a *App, name string) (agentClient, string) {
	t.Helper()
	config, err := a.RegisterAgentClient(name)
	if err != nil {
		t.Fatal(err)
	}
	var entry struct {
		ID, Name string
		Config   struct {
			MCPServers struct {
				Videron struct {
					Command string
					Args    []string
					Env     map[string]string
				}
			}
		}
	}
	if err = json.Unmarshal([]byte(config), &entry); err != nil {
		t.Fatal(err)
	}
	bridge := entry.Config.MCPServers.Videron
	exe, _ := os.Executable()
	if bridge.Command != exe || len(bridge.Args) != 1 || bridge.Args[0] != "--agent-mcp-paired" || entry.ID == "" || entry.Name != strings.TrimSpace(name) || len(bridge.Env) != 2 || bridge.Env["VIDERON_AGENT_CLIENT"] != entry.ID || len(bridge.Env["VIDERON_AGENT_KEY"]) < 32 {
		t.Fatal("incorrect paired installation")
	}
	return agentClient{agentClientInfo: agentClientInfo{ID: entry.ID, Name: entry.Name}, Key: bridge.Env["VIDERON_AGENT_KEY"]}, config
}

func TestPairedAgentRegistration(t *testing.T) {
	a := pairedTestStore(t)
	routePath, _ := agentFile("active.json")
	client, config := registeredClient(t, a, "  Тестовый агент  ")
	if _, err := os.Stat(routePath); !errors.Is(err, os.ErrNotExist) || a.noteAccess.current != nil {
		t.Fatal("registering opened a grant")
	}
	if _, err := a.RegisterAgentClient("тестовый агент"); !errors.Is(err, errAgentClientDuplicate) {
		t.Fatal("accepted duplicate", err)
	}
	for _, name := range []string{"", "\t", "two\nlines", strings.Repeat("я", 65)} {
		if _, err := a.RegisterAgentClient(name); !errors.Is(err, errAgentClientName) {
			t.Fatal("accepted invalid name", err)
		}
	}
	reopened := &App{loaded: true}
	list, err := reopened.ListAgentClients()
	var names []map[string]string
	if err != nil || json.Unmarshal([]byte(list), &names) != nil || len(names) != 1 || len(names[0]) != 2 || names[0]["id"] != client.ID || names[0]["name"] != client.Name {
		t.Fatal("registration did not survive restart or list exposed credentials")
	}
	if copied, err := reopened.AgentClientConfig(client.ID); err != nil || copied != config {
		t.Fatal("copy returned different installation", err)
	}
	path, _ := agentFile("clients.key")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if bytes.Contains(data, []byte(client.Key)) {
			t.Fatal("stored a plaintext key on Windows")
		}
	} else if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0600 {
		t.Fatal("pair file permissions", err)
	}
	reopened.sessionLockPending.Store(true)
	if _, err := reopened.AgentClientConfig(client.ID); !errors.Is(err, errLocked) {
		t.Fatal("returned credentials while locked")
	}
	reopened.sessionLockPending.Store(false)
	if err := reopened.ForgetAgentClient(client.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.OpenPairedAgentAccess(client.ID, false); !errors.Is(err, errAgentClientUnknown) {
		t.Fatal("forgotten client opened a grant", err)
	}
	if got, err := a.ListAgentClients(); err != nil || got != "[]" {
		t.Fatal("forgotten client remained", err)
	}
}

type agentTestReply struct {
	ID     int
	Result struct {
		ProtocolVersion string
		Tools           []struct {
			Name        string
			InputSchema struct{ Required []string }
		}
		IsError bool
		Content []struct{ Text string }
	}
	Error *struct{ Code int }
}

// The same pair of pipes and helper stays alive throughout revocation, a desktop
// restart, a different client's grant, a changed idea, and forgetting the pair.
func TestPairedAgentStdioLifetimeAndScopes(t *testing.T) {
	a := pairedTestStore(t)
	client, _ := registeredClient(t, a, "Client")
	other, _ := registeredClient(t, a, "Other")
	in, send := io.Pipe()
	read, out := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := servePairedAgentStdio(in, out, client)
		out.CloseWithError(err)
		done <- err
	}()
	t.Cleanup(func() {
		send.Close()
		read.Close()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	decoder, encoder := json.NewDecoder(read), json.NewEncoder(send)
	id := 0
	rpc := func(method string, params any) agentTestReply {
		t.Helper()
		id++
		if err := encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
		var reply agentTestReply
		if err := decoder.Decode(&reply); err != nil || reply.ID != id || reply.Error != nil {
			t.Fatalf("unexpected %s response id=%d or error: %v", method, reply.ID, err)
		}
		return reply
	}
	call := func(name string, args map[string]any, wantError bool) string {
		t.Helper()
		reply := rpc("tools/call", map[string]any{"name": name, "arguments": args})
		if reply.Result.IsError != wantError || len(reply.Result.Content) != 1 {
			t.Fatalf("unexpected %s response: %+v", name, reply.Result)
		}
		return reply.Result.Content[0].Text
	}
	page := func(tool string, args map[string]any, text, access string) string {
		t.Helper()
		data := call(tool, args, false)
		var p struct{ Text, Scope, Access string }
		if err := json.Unmarshal([]byte(data), &p); err != nil || p.Text != text || p.Access != access || p.Scope == "" {
			t.Fatalf("unexpected %s page", tool)
		}
		return p.Scope
	}
	open := func(app *App, c agentClient, write bool, text string) {
		t.Helper()
		_, err := app.openAgentAccess(c.ID, write, func(grant, id, tool, args string) {
			result, _ := json.Marshal(map[string]any{"text": text, "nextOffset": nil})
			app.ResolveAgentCall(grant, id, string(result), false)
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if reply := rpc("initialize", map[string]string{"protocolVersion": "2025-06-18"}); reply.Result.ProtocolVersion != "2025-06-18" {
		t.Fatal("offline handshake failed")
	}
	if err := encoder.Encode(map[string]string{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
		t.Fatal(err)
	}
	if reply := rpc("tools/list", nil); len(reply.Result.Tools) != 4 || !strings.Contains(strings.Join(reply.Result.Tools[3].InputSchema.Required, ","), "scope") {
		t.Fatal("incomplete offline discovery")
	}
	empty := map[string]any{}
	call("read_idea", empty, true)
	open(a, other, true, "Other idea")
	call("read_idea", empty, true)
	if _, err := a.OpenPairedAgentAccess(client.ID, true); err == nil {
		t.Fatal("allowed two grants")
	}
	a.ResetAgentConnections()
	open(a, client, true, "First")
	// A list can be paged, but reading a list does not allow writing.
	listScope := page("list_tasks", empty, "First", "tasks")
	page("list_tasks", map[string]any{"scope": listScope, "offset": 1}, "First", "tasks")
	call("update_task", map[string]any{"scope": listScope, "key": "t"}, true)
	call("create_tasks", empty, true)
	call("read_idea", map[string]any{"offset": 1}, true)
	call("read_idea", map[string]any{"offset": 1, "Offset": 0}, true)
	first := page("read_idea", empty, "First", "tasks")
	page("read_idea", map[string]any{"scope": first, "offset": 1}, "First", "tasks")
	call("create_tasks", map[string]any{"scope": first}, false)
	call("update_task", map[string]any{"scope": first, "key": "t"}, false)
	previousRoute, err := client.currentRoute()
	if err != nil {
		t.Fatal(err)
	}
	path, _ := agentFile("active.json")
	raw, err := os.ReadFile(path)
	if err != nil || bytes.Contains(raw, []byte(first)) || bytes.Contains(raw, []byte(client.Key)) || bytes.Contains(raw, []byte(previousRoute.bearer(client.Key))) || bytes.Contains(raw, []byte("First")) {
		t.Fatal("discovery exposed private data")
	}
	a.ResetAgentConnections()
	call("read_idea", empty, true)
	if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("revoke left a locator")
	}
	a = &App{loaded: true}
	t.Cleanup(a.ResetAgentConnections)
	open(a, client, false, "Second")
	call("list_tasks", map[string]any{"scope": listScope, "offset": 2}, true)
	call("read_idea", map[string]any{"scope": first, "offset": 1}, true)
	second := page("read_idea", empty, "Second", "read")
	call("update_task", map[string]any{"scope": second}, true)
	a.ResetAgentConnections()
	open(a, client, true, "Third")
	call("update_task", map[string]any{"scope": first}, true)
	call("create_tasks", map[string]any{"scope": second}, true)
	third := page("read_idea", empty, "Third", "tasks")
	call("update_task", map[string]any{"scope": third}, false)
	// A valid route for the previous grant cannot authenticate to the new one.
	current, err := client.currentRoute()
	if err != nil || current.Grant == previousRoute.Grant || current.Pin == previousRoute.Pin {
		t.Fatal("grant identities reused")
	}
	transport := agentHTTPClient(&http.Transport{TLSClientConfig: pinnedServerTLS(current.Pin), DisableKeepAlives: true})
	if _, err = forwardAgentRPC(transport, current.Endpoint, previousRoute.bearer(client.Key), []byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`)); err == nil {
		t.Fatal("old bearer authenticated to new grant")
	}
	if err = a.ForgetAgentClient(client.ID); err != nil {
		t.Fatal(err)
	}
	call("read_idea", empty, true)
	if a.noteAccess.current != nil {
		t.Fatal("forget left an active grant")
	}
}

func TestPairedAgentRejectsTamperedOrNonlocalLocator(t *testing.T) {
	a := pairedTestStore(t)
	c, _ := registeredClient(t, a, "Client")
	if _, err := a.OpenPairedAgentAccess(c.ID, false); err != nil {
		t.Fatal(err)
	}
	route, err := c.currentRoute()
	if err != nil {
		t.Fatal(err)
	}
	path, _ := agentFile("active.json")
	cases := []struct {
		endpoint string
		sign     bool
	}{
		{"https://127.0.0.1:4455/mcp", false},
		{"https://example.invalid:4455/mcp", true},
		{"https://user@127.0.0.1:4455/mcp", true},
		{"https://127.0.0.1:4455/elsewhere", true},
		{"http://127.0.0.1:4455/mcp", true},
	}
	for _, tc := range cases {
		r := route
		r.Endpoint = tc.endpoint
		if tc.sign {
			r.Signature = r.signature(c.Key)
		}
		data, _ := json.Marshal(r)
		if err = os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = c.currentRoute(); err == nil {
			t.Fatal("accepted invalid discovery record")
		}
	}
}

func TestPairedAgentRevokedByFailedCatalogReload(t *testing.T) {
	a, workspace := testStore(t)
	t.Setenv("LocalAppData", t.TempDir())
	client, _ := registeredClient(t, a, "Client")
	if _, err := a.OpenPairedAgentAccess(client.ID, false); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.ResetAgentConnections)
	grant := a.noteAccess.current
	if _, err := writeAtomic(workspace, []byte("invalid catalog"), ".test-*.tmp"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Load(); err == nil {
		t.Fatal("unexpected successful reload")
	}
	if a.noteAccess.current != nil || grant.ctx.Err() == nil {
		t.Fatal("failed reload retained old access")
	}
	if _, err := client.currentRoute(); err == nil {
		t.Fatal("failed reload retained discovery")
	}
}
