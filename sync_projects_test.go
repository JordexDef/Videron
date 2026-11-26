package main

import (
	"encoding/json"
	"errors"

	"os"
	"slices"
	"strings"
	"testing"

	"videron/internal/localprotect"
	"videron/internal/syncclient"
)

func TestClientSelectsAndReopensScopedProject(t *testing.T) {
	a, _ := testStore(t)
	const pass = "Test multi-project sync service"
	server := startPasswordTestService(t, pass)
	first, second, third := t.TempDir(), t.TempDir(), t.TempDir()
	if err := a.CreateFolderSpace(first, syncDoc("default", "shared history"), ""); err != nil {
		t.Fatal(err)
	}
	if err := a.ConnectSpaceServer(first, server.Code); err != nil {
		t.Fatal(err)
	}
	// A copy of the same lineage makes accidental selection by lineage alone detectable.
	if err := a.JoinSpaceServer(server.Code, second); err != nil {
		t.Fatal(err)
	}
	if err := a.DisconnectSpaceServer(second); err != nil {
		t.Fatal(err)
	}
	if _, err := a.OpenFolderSpace(second, ""); err != nil {
		t.Fatal(err)
	}
	verified, err := a.VerifySyncServer(server.Addr, pass)
	if err != nil {
		t.Fatal(err)
	}
	defer a.DiscardSyncServerTicket(verified.Ticket)
	list, err := a.ListServerProjects(verified.Ticket)
	if err != nil || !list.Supported || !slices.Equal(list.Projects, []ServerProject{{}}) {
		t.Fatal(list, err)
	}
	created, err := a.CreateServerProject(verified.Ticket, "  Исследования  ")
	if err != nil || created.Ticket != verified.Ticket || !syncclient.ValidID(created.ProjectID) || created.ProjectName != "Исследования" || created.HasSpace {
		t.Fatal("new project", err)
	}
	retry, err := a.CreateServerProject(verified.Ticket, "Исследования")
	if err != nil || retry != created {
		t.Fatal("idempotent create", err)
	}
	if err = a.ConnectSpaceServer(first, created.Ticket); !errors.Is(err, syncclient.ErrSpace) {
		t.Fatal("overwrote a bound project", err)
	}
	if err = a.ConnectSpaceServer(second, created.Ticket); err != nil {
		t.Fatal(err)
	}
	selected, err := a.SelectServerProject(verified.Ticket, created.ProjectID)
	if err != nil || !selected.HasSpace {
		t.Fatal("published project", err)
	}
	candidates, err := a.MatchingServerFolders(selected.Ticket, []string{first, second})
	if err != nil || !slices.Equal(candidates, []string{canonicalTestFolder(t, second)}) {
		t.Fatal("wrong project suggested", err)
	}
	if err = a.JoinSpaceServer(selected.Ticket, first); !errors.Is(err, syncclient.ErrSpace) {
		t.Fatal("rebound a different project", err)
	}
	if err = a.JoinSpaceServer(selected.Ticket, third); err != nil {
		t.Fatal(err)
	}
	if _, err = a.OpenFolderSpace(third, ""); err != nil {
		t.Fatal(err)
	}
	initial, err := a.SyncSpaceServer(third)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.SaveFolderBranch(second, syncDoc("named", "independent update")); err != nil {
		t.Fatal(err)
	}
	if _, err = a.SyncSpaceServer(second); err != nil {
		t.Fatal(err)
	}
	if changed, err := a.WaitSpaceServerChange(third, initial); err != nil || changed == initial {
		t.Fatal("scoped events", err)
	}
	if _, err = a.SyncSpaceServer(third); err != nil {
		t.Fatal(err)
	}
	update, err := a.PollFolderSpace(third, true)
	if err != nil || update.Token == "" {
		t.Fatal("scoped exchange", err)
	}
	sameDoc(t, update.Remote, "named", "independent update")
	if _, err = a.SyncSpaceServer(first); err != nil {
		t.Fatal(err)
	}
	if update, err = a.PollFolderSpace(first, true); err != nil || update.Token != "" {
		t.Fatal("default project received foreign change", err)
	}
	info, err := a.ServerConnection(second)
	if err != nil || info.ProjectID != created.ProjectID || info.ProjectName != created.ProjectName {
		t.Fatal("persisted project metadata", err)
	}
	for _, dir := range []string{first, second} {
		file, err := profilePath(canonicalTestFolder(t, dir))
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		defer clear(b)
		data, err := localprotect.Unprotect(b)
		if err != nil {
			t.Fatal(err)
		}
		var legacy struct{ Lineage string }
		err = json.Unmarshal(data, &legacy)
		clear(data)
		if err != nil || syncclient.ValidID(legacy.Lineage) != (dir == first) {
			t.Fatal("legacy reader did not isolate the named profile")
		}
	}
	connected, err := a.ConnectedServerTicket(second)
	if err != nil || connected.ProjectID != created.ProjectID || !connected.HasSpace {
		t.Fatal("reauthenticated saved scope", err)
	}
	defer a.DiscardSyncServerTicket(connected.Ticket)
	list, err = a.ListServerProjects(connected.Ticket)
	if err != nil || len(list.Projects) != 2 {
		t.Fatal(list, err)
	}
	if _, err = a.CreateServerProject(connected.Ticket, created.ProjectName); !errors.Is(err, syncclient.ErrProjectExists) {
		t.Fatal("conflicting project name", err)
	}
	if _, err = a.CreateServerProject(connected.Ticket, "A\nB"); !errors.Is(err, syncclient.ErrProjectName) {
		t.Fatal("invalid name", err)
	}
	base, err := a.SelectServerProject(connected.Ticket, "")
	if err != nil || base.ProjectID != "" || base.ProjectName != "" || !base.HasSpace {
		t.Fatal("back to default", err)
	}
}

func TestClientRenamesDeletesAndKeepsOfflineCopies(t *testing.T) {
	a, _ := testStore(t)
	b := new(App)
	if _, err := b.Load(); err != nil {
		t.Fatal(err)
	}
	const password = "Lifecycle test service password"
	server := startPasswordTestService(t, password)
	verify := func(app *App) VerifiedSyncServer {
		v, err := app.VerifySyncServer(server.Addr, password)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { app.DiscardSyncServerTicket(v.Ticket) })
		return v
	}
	ticket := verify(a).Ticket
	list, err := a.ListServerProjects(ticket)
	if err != nil || !list.CanManage {
		t.Fatal(list, err)
	}
	source := t.TempDir()
	if err = a.CreateFolderSpace(source, syncDoc("original", "default"), ""); err != nil {
		t.Fatal(err)
	}
	if err = a.ConnectSpaceServer(source, ticket); err != nil {
		t.Fatal(err)
	}
	renamed, err := a.RenameServerProject(ticket, "", "Archive", "")
	if err != nil || renamed.ProjectName != "Archive" {
		t.Fatal(renamed, err)
	}
	remote := verify(b)
	if remote.ProjectName != "Archive" || !remote.HasSpace {
		t.Fatal("login did not return renamed default")
	}
	named, err := a.CreateServerProject(ticket, "Research")
	if err != nil {
		t.Fatal(err)
	}
	folder := t.TempDir()
	if err = a.CreateFolderSpace(folder, syncDoc("First", "Second"), testPass); err != nil {
		t.Fatal(err)
	}
	if err = a.ConnectSpaceServer(folder, ticket); err != nil {
		t.Fatal(err)
	}
	if _, err = b.SelectServerProject(remote.Ticket, named.ProjectID); err != nil {
		t.Fatal(err)
	}
	peer := t.TempDir()
	if err = b.JoinSpaceServer(remote.Ticket, peer); err != nil {
		t.Fatal(err)
	}
	if _, err = b.OpenFolderSpace(peer, testPass); err != nil {
		t.Fatal(err)
	}
	cursor, err := b.SyncSpaceServer(peer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.RenameServerProject(ticket, named.ProjectID, "Field notes", "Research"); err != nil {
		t.Fatal(err)
	}
	if _, err = b.RenameServerProject(remote.Ticket, named.ProjectID, "Discard", "Research"); !errors.Is(err, syncclient.ErrProjectChanged) {
		t.Fatal("stale rename", err)
	}
	if err = b.DeleteServerProject(remote.Ticket, named.ProjectID, "Research"); !errors.Is(err, syncclient.ErrProjectChanged) {
		t.Fatal("stale delete", err)
	}
	changed, err := b.WaitSpaceServerChange(peer, cursor)
	if err != nil || changed == cursor {
		t.Fatal("rename did not wake peer", err)
	}
	cursor, err = b.SyncSpaceServer(peer)
	info, infoErr := b.ServerConnection(peer)
	if err != nil || infoErr != nil || info.ProjectName != "Field notes" {
		t.Fatal("rename not propagated", info, err, infoErr)
	}
	// Save locally while the peer is offline. The following server deletion
	// must revoke the connection without touching the encrypted working copy.
	pending := syncDoc("Offline", "draft")
	if err = b.SaveFolderBranch(peer, pending); err != nil {
		t.Fatal(err)
	}
	if err = a.DeleteServerProject(ticket, named.ProjectID, "Field notes"); err != nil {
		t.Fatal(err)
	}
	if err = a.DeleteServerProject(ticket, named.ProjectID, "Field notes"); err != nil {
		t.Fatal("retry after delete", err)
	}
	if _, err = b.WaitSpaceServerChange(peer, cursor); !errors.Is(err, syncclient.ErrProjectDeleted) {
		t.Fatal("watch tombstone", err)
	}
	if p, err := loadProfile(canonicalTestFolder(t, peer)); err != nil || p != nil {
		t.Fatal("peer connection still active", err)
	}
	b.CloseFolderSpace(peer)
	value, err := b.OpenFolderSpace(peer, testPass)
	if err != nil {
		t.Fatal(err)
	}
	sameDoc(t, value, "Offline", "draft")
	admin, err := a.ConnectedServerTicket(folder)
	if err != nil || !admin.ProjectDeleted {
		t.Fatal("connected manager after tombstone", err)
	}
	defer a.DiscardSyncServerTicket(admin.Ticket)
	if _, err = a.SyncSpaceServer(folder); !errors.Is(err, syncclient.ErrProjectDeleted) {
		t.Fatal("offline tombstone", err)
	}
	if _, err = a.SelectServerProject(ticket, ""); err != nil {
		t.Fatal(err)
	}
	if err = a.DeleteServerProject(ticket, "", "Archive"); err != nil {
		t.Fatal(err)
	}
	fresh := verify(b)
	if !fresh.ProjectDeleted || fresh.HasSpace {
		t.Fatal("wrong state after deleting the last project")
	}
	if err = b.ConnectSpaceServer(peer, fresh.Ticket); !errors.Is(err, syncclient.ErrProjectDeleted) {
		t.Fatal("deleted default accepted write", err)
	}
	list, err = b.ListServerProjects(fresh.Ticket)
	if err != nil || len(list.Projects) != 0 || !list.CanManage {
		t.Fatal(list, err)
	}
	replacement, err := b.CreateServerProject(fresh.Ticket, "Field notes")
	if err != nil || replacement.ProjectDeleted || replacement.ProjectID == named.ProjectID {
		t.Fatal("could not start an independent project", err)
	}
	if err = b.DeleteServerProject(fresh.Ticket, named.ProjectID, "Field notes"); !errors.Is(err, syncclient.ErrProjectChanged) {
		t.Fatal("old confirmation could affect a new same-name project", err)
	}
	orphan := verify(a)
	if _, err = a.SelectServerProject(orphan.Ticket, replacement.ProjectID); err != nil {
		t.Fatal(err)
	}
}

func TestProjectDeletionPreservesReboundFolder(t *testing.T) {
	original := syncclient.Profile{Address: "https://test.invalid:443", ProjectID: strings.Repeat("a", 64), Pin: strings.Repeat("b", 64), Lineage: strings.Repeat("c", 64), Token: strings.Repeat("d", 64)}
	_, _ = testStore(t)
	folder := t.TempDir()
	other := original
	other.ProjectID = strings.Repeat("f", 64)
	if err := storeProfile(folder, other); err != nil {
		t.Fatal(err)
	}
	if err := detachDeletedProject(folder, &original, syncclient.ErrProjectDeleted); !errors.Is(err, errChanged) {
		t.Fatal(err)
	}
	if p, err := loadProfile(folder); err != nil || p == nil || p.ProjectID != other.ProjectID {
		t.Fatal("newly rebound folder lost its connection", err)
	}
}
