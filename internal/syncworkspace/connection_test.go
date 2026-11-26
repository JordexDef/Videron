package syncworkspace

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"videron/internal/syncclient"
	"videron/internal/vault"
	"videron/internal/workspacestore"
)

func connectionFixture(t *testing.T) (string, *workspacestore.Session, syncclient.Profile) {
	t.Helper()
	useTestProfileDirectory(t)
	dir := t.TempDir()
	store := workspacestore.New[json.RawMessage]()
	session, err := store.Create(dir, `{"name":"Fixture","notes":[],"areas":[]}`, "")
	if err != nil {
		t.Fatal(err)
	}
	return dir, session, syncclient.Profile{
		Address: "https://test.invalid:443", Pin: strings.Repeat("a", 64), Token: strings.Repeat("b", 64),
		Lineage: session.Lineage(), ProjectID: strings.Repeat("c", 64), ProjectName: "Shared fixture",
		LastSync: 42, Transport: syncclient.TransportDirect,
	}
}

func TestConnectionPreferencePersistsAndAppliesOnlyToMatchingFolder(t *testing.T) {
	dir, session, profile := connectionFixture(t)
	connection := &FolderConnection{index: new(syncclient.IndexCache)}
	use := func(_ string, action func(*workspacestore.Session, *FolderConnection) error) error {
		return action(session, connection)
	}
	locked := func(string, func(*workspacestore.Session, *FolderConnection) error) error {
		return vault.ErrLocked
	}
	if info, err := ConnectionInfo(dir, locked); err != nil || info != (ServerConnectionInfo{}) {
		t.Fatalf("disconnected folder has a connection: %+v, %v", info, err)
	}
	if _, err := WaitForChange(dir, "", locked, new(sync.Mutex)); !errors.Is(err, vault.ErrLocked) {
		t.Fatalf("watch did not check the open workspace before loading its profile: %v", err)
	}
	if err := StoreProfile(dir, profile); err != nil {
		t.Fatal(err)
	}
	want := ServerConnectionInfo{
		Address: profile.Address, Transport: profile.Transport, LastSync: profile.LastSync,
		ProjectID: profile.ProjectID, ProjectName: profile.ProjectName, AutoConnect: true,
	}
	if info, err := ConnectionInfo(dir, use); err != nil || info != want {
		t.Fatalf("incorrect connection status: %+v, %v", info, err)
	}
	// The App can receive an alias. The setting belongs to the open copy's
	// canonical path, even when the connection cache is recreated on restart.
	if err := SetAutoConnect("folder alias", false, use); err != nil {
		t.Fatal(err)
	}
	connection = new(FolderConnection)
	want.AutoConnect = false
	if info, err := ConnectionInfo(dir, use); err != nil || info != want {
		t.Fatalf("lost the saved preference or connection details: %+v, %v", info, err)
	}
	conflicting := profile
	conflicting.Lineage = strings.Repeat("d", 64)
	if err := StoreProfile(dir, conflicting); err != nil {
		t.Fatal(err)
	}
	if info, err := ConnectionInfo(dir, use); err != nil || info != (ServerConnectionInfo{}) {
		t.Fatalf("status from a replaced working copy was exposed: %+v, %v", info, err)
	}
	if err := SetAutoConnect(dir, false, use); !errors.Is(err, syncclient.ErrChanged) {
		t.Fatalf("setting accepted for a replaced working copy: %v", err)
	}
	connection.index = new(syncclient.IndexCache)
	if err := Disconnect(dir, connection); err != nil || connection.index != nil {
		t.Fatalf("disconnect failed to clear the connection cache: %v", err)
	}
	if err := Disconnect(dir, nil); err != nil {
		t.Fatal("disconnection must be repeatable:", err)
	}
	if got, err := LoadProfile(dir); err != nil || got != nil {
		t.Fatalf("disconnect retained a profile: %+v, %v", got, err)
	}
	if err := SetAutoConnect(dir, true, use); !errors.Is(err, syncclient.ErrChanged) {
		t.Fatalf("changing the preference recreated a detached profile: %v", err)
	}
}

func TestWatchKeepsWorkingCopyReboundDuringLongPoll(t *testing.T) {
	dir, session, profile := connectionFixture(t)
	request := make(chan struct{})
	respond := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/projects/"+profile.ProjectID+"/events" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Videron-Project", profile.ProjectID)
		if r.URL.Query().Get("since") == "first + cursor" {
			fmt.Fprint(w, `{"cursor":"next"}`)
			return
		}
		close(request)
		<-respond
		w.Header().Set("X-Videron-Project-Deleted", "1")
		w.WriteHeader(http.StatusGone)
	}))
	defer server.Close()
	var replyOnce sync.Once
	finishReply := func() { replyOnce.Do(func() { close(respond) }) }
	defer finishReply()
	profile.Address = server.URL
	profile.Pin = fmt.Sprintf("%x", sha256.Sum256(server.Certificate().Raw))
	if err := StoreProfile(dir, profile); err != nil {
		t.Fatal(err)
	}
	var connectionLock sync.Mutex
	var connection FolderConnection
	use := func(_ string, action func(*workspacestore.Session, *FolderConnection) error) error {
		return action(session, &connection)
	}
	if cursor, err := WaitForChange(dir, "first + cursor", use, &connectionLock); err != nil || cursor != "next" {
		t.Fatalf("notification did not return the new cursor: %q, %v", cursor, err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := WaitForChange(dir, "next", use, &connectionLock)
		done <- err
	}()
	select {
	case <-request:
	case <-time.After(5 * time.Second):
		t.Fatal("watch did not reach the server")
	}

	rebound := profile
	rebound.ProjectID = strings.Repeat("e", 64)
	saved := make(chan error, 1)
	go func() {
		connectionLock.Lock()
		defer connectionLock.Unlock()
		saved <- StoreProfile(dir, rebound)
	}()
	select {
	case err := <-saved:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the open watch blocked a concurrent connection change")
	}
	finishReply()
	select {
	case err := <-done:
		if !errors.Is(err, syncclient.ErrChanged) {
			t.Fatalf("stale deletion notification did not check the rebound profile: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watch did not finish after deletion notification")
	}
	if got, err := LoadProfile(dir); err != nil || got == nil || *got != rebound {
		t.Fatalf("stale notification detached the new project: %+v, %v", got, err)
	}
}
