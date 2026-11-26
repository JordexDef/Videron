package client

import (
	"encoding/json"
	"os"
	"testing"
)

func TestAgentMCPRejectLockedWorkspace(t *testing.T) {
	a, _ := testStore(t)
	a.LockSession("")
	defer a.ResetAgentConnections()
	if _, err := a.OpenAgentAccess(true); err == nil {
		t.Fatal("locked workspace issued an access grant")
	}
	if _, err := a.Load(); err != nil {
		t.Fatal(err)
	}
	a.sessionLockPending.Store(true)
	if _, err := a.OpenAgentAccess(true); err == nil {
		t.Fatal("pending session lock issued an access grant")
	}
}

func TestACPBridgeRejectsRevokedGrant(t *testing.T) {
	a, _ := testStore(t)
	t.Cleanup(a.ResetAgentConnections)
	access, err := a.OpenAgentAccess(true)
	if err != nil {
		t.Fatal(err)
	}
	var grant struct{ ID string }
	if err := json.Unmarshal([]byte(access), &grant); err != nil || grant.ID == "" {
		t.Fatal("missing access grant", err)
	}
	a.CloseAgentAccess(grant.ID)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	config, err := json.Marshal(map[string]string{"command": exe, "grantId": grant.ID, "prompt": "Fixture only"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.StartAgentRun(string(config)); err == nil || err.Error() != "VD_AGENT_REVOKED" {
		t.Fatal("ACP launch accepted a revoked grant", err)
	}
}
