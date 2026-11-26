package agentmcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"videron/internal/syncclient"
)

func pairedTestAccess(t *testing.T) *Access {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("LocalAppData", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	a := &Access{}
	t.Cleanup(a.Reset)
	return a
}

func registeredClient(t *testing.T, a *Access, name string) agentClient {
	t.Helper()
	config, err := a.RegisterClient(name)
	if err != nil {
		t.Fatal(err)
	}
	var entry struct{ ID string }
	if err := json.Unmarshal([]byte(config), &entry); err != nil {
		t.Fatal(err)
	}
	client, err := findAgentClient(entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	return client
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
	a := pairedTestAccess(t)
	client := registeredClient(t, a, "Client")
	other := registeredClient(t, a, "Other")
	in, send := io.Pipe()
	read, out := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := ServePairedStdio(in, out, client.ID, client.Key)
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
	open := func(access *Access, c agentClient, write bool, text string) {
		t.Helper()
		_, err := access.Open(c.ID, write, func(grant, id, tool, args string) {
			result, _ := json.Marshal(map[string]any{"text": text, "nextOffset": nil})
			access.Resolve(grant, id, string(result), false)
		}, nil)
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
	if _, err := a.Open(client.ID, true, nil, nil); err == nil {
		t.Fatal("allowed two grants")
	}
	a.Reset()
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
	a.Reset()
	call("read_idea", empty, true)
	if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("revoke left a locator")
	}
	a = &Access{}
	t.Cleanup(a.Reset)
	open(a, client, false, "Second")
	call("list_tasks", map[string]any{"scope": listScope, "offset": 2}, true)
	call("read_idea", map[string]any{"scope": first, "offset": 1}, true)
	second := page("read_idea", empty, "Second", "read")
	call("update_task", map[string]any{"scope": second}, true)
	a.Reset()
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
	transport := agentHTTPClient(&http.Transport{TLSClientConfig: syncclient.PinnedTLS(current.Pin), DisableKeepAlives: true})
	if _, err = forwardAgentRPC(transport, current.Endpoint, previousRoute.bearer(client.Key), []byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`)); err == nil {
		t.Fatal("old bearer authenticated to new grant")
	}
	if err = a.ForgetClient(client.ID); err != nil {
		t.Fatal(err)
	}
	call("read_idea", empty, true)
	if a.current != nil {
		t.Fatal("forget left an active grant")
	}
}

func TestPairedAgentRejectsTamperedOrNonlocalLocator(t *testing.T) {
	a := pairedTestAccess(t)
	c := registeredClient(t, a, "Client")
	if _, err := a.Open(c.ID, false, nil, nil); err != nil {
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
