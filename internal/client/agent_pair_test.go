package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"videron/internal/agentmcp"
	"videron/internal/workspacestore"
)

func pairedTestDirectory(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("LocalAppData", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	base, err := os.UserConfigDir()
	if runtime.GOOS == "windows" {
		base, err = os.UserCacheDir()
	}
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(base, "Videron", "agents")
}

type pairedTestClient struct{ ID, Name, Key string }

func registeredClient(t *testing.T, a *App, name string) (pairedTestClient, string) {
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
	return pairedTestClient{ID: entry.ID, Name: entry.Name, Key: bridge.Env["VIDERON_AGENT_KEY"]}, config
}

func TestPairedAgentRegistration(t *testing.T) {
	dir := pairedTestDirectory(t)
	t.Setenv("AppData", t.TempDir())
	a := new(App)
	if _, err := a.Load(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.ResetAgentConnections)
	routePath := filepath.Join(dir, "active.json")
	client, config := registeredClient(t, a, "  Тестовый агент  ")
	if _, err := os.Stat(routePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("registering opened a grant")
	}
	if _, err := a.RegisterAgentClient("тестовый агент"); !errors.Is(err, agentmcp.ErrClientDuplicate) {
		t.Fatal("accepted duplicate", err)
	}
	for _, name := range []string{"", "\t", "two\nlines", strings.Repeat("я", 65)} {
		if _, err := a.RegisterAgentClient(name); !errors.Is(err, agentmcp.ErrClientName) {
			t.Fatal("accepted invalid name", err)
		}
	}
	reopened := new(App)
	if _, err := reopened.Load(); err != nil {
		t.Fatal(err)
	}
	list, err := reopened.ListAgentClients()
	var names []map[string]string
	if err != nil || json.Unmarshal([]byte(list), &names) != nil || len(names) != 1 || len(names[0]) != 2 || names[0]["id"] != client.ID || names[0]["name"] != client.Name {
		t.Fatal("registration did not survive restart or list exposed credentials")
	}
	if copied, err := reopened.AgentClientConfig(client.ID); err != nil || copied != config {
		t.Fatal("copy returned different installation", err)
	}
	path := filepath.Join(dir, "clients.key")
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
	if _, err := a.OpenPairedAgentAccess(client.ID, false); !errors.Is(err, agentmcp.ErrClientUnknown) {
		t.Fatal("forgotten client opened a grant", err)
	}
	if got, err := a.ListAgentClients(); err != nil || got != "[]" {
		t.Fatal("forgotten client remained", err)
	}
}

func TestPairedAgentRevokedByFailedCatalogReload(t *testing.T) {
	a, workspace := testStore(t)
	dir := pairedTestDirectory(t)
	client, _ := registeredClient(t, a, "Client")
	pending := make(chan struct{}, 1)
	if _, err := a.openAgentAccess(client.ID, false, func(string, string, string, string) {
		pending <- struct{}{}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.ResetAgentConnections)

	// An external helper already has a request in flight when the catalog fails
	// to reopen. It must get a terminal response without any note content.
	const request = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_idea","arguments":{}}}`
	type reply struct {
		ID     int
		Result struct {
			IsError bool
		}
		Error *struct{ Code int }
	}
	type readResult struct {
		body reply
		err  error
	}
	readIdea := func() readResult {
		var out bytes.Buffer
		err := agentmcp.ServePairedStdio(strings.NewReader(request+"\n"), &out, client.ID, client.Key)
		var result readResult
		if err == nil {
			err = json.Unmarshal(out.Bytes(), &result.body)
		}
		result.err = err
		return result
	}
	done := make(chan readResult, 1)
	go func() { done <- readIdea() }()
	select {
	case <-pending:
	case result := <-done:
		t.Fatalf("paired request ended before reaching the desktop: %+v", result)
	case <-time.After(3 * time.Second):
		t.Fatal("paired request did not reach the desktop")
	}
	if _, err := workspacestore.WriteAtomic(workspace, []byte("invalid catalog"), ".test-*.tmp"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Load(); err == nil {
		t.Fatal("unexpected successful reload")
	}
	select {
	case result := <-done:
		if result.err != nil || result.body.ID != 1 || !(result.body.Result.IsError || result.body.Error != nil && result.body.Error.Code == -32000) {
			t.Fatalf("failed reload did not cancel the pending request: %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("failed reload retained old access")
	}
	if _, err := os.Stat(filepath.Join(dir, "active.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed reload retained discovery", err)
	}
	if result := readIdea(); result.err != nil || !result.body.Result.IsError {
		t.Fatalf("old helper acquired access after reload: %+v", result)
	}
}
