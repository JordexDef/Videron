package main

import (
	"context"
	"strings"

	"videron/internal/foldersession"
	"videron/internal/syncclient"
	"videron/internal/syncworkspace"
)

type ServerProject = syncclient.Project
type ServerProjectList = syncclient.ProjectList

// Project management uses an unlocked, verified session. A legacy pairing
// code still connects to its original default project via Connect/Join.
func (a *App) projectProfile(ticket string) (syncclient.Profile, error) {
	if !syncworkspace.IsTicket(ticket) {
		return syncclient.Profile{}, errServerTicket
	}
	return a.resolveServerTicket(ticket)
}

func (a *App) ListServerProjects(ticket string) (ServerProjectList, error) {
	p, err := a.projectProfile(ticket)
	if err != nil {
		return ServerProjectList{}, err
	}
	return syncworkspace.ListProjects(p)
}

func (a *App) SelectServerProject(ticket, id string) (VerifiedSyncServer, error) {
	before, err := a.projectProfile(ticket)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.serverTickets.SelectProject(ticket, before, id)
}

func (a *App) CreateServerProject(ticket, name string) (VerifiedSyncServer, error) {
	before, err := a.projectProfile(ticket)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.serverTickets.CreateProject(ticket, before, name)
}

func (a *App) RenameServerProject(ticket, id, newName, expectedName string) (VerifiedSyncServer, error) {
	if !syncclient.ValidProjectName(strings.TrimSpace(newName)) {
		return VerifiedSyncServer{}, syncclient.ErrProjectName
	}
	before, err := a.projectProfile(ticket)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.serverTickets.RenameProject(ticket, before, id, newName, expectedName)
}

func (a *App) DeleteServerProject(ticket, id, expectedName string) error {
	before, err := a.projectProfile(ticket)
	if err != nil {
		return err
	}
	return a.serverTickets.DeleteProject(ticket, before, id, expectedName)
}

// Reuse the protected credential for this connected folder. Confirm both the
// local lineage and the remote scoped manifest before issuing a WebView ticket.
func (a *App) ConnectedServerTicket(folder string) (VerifiedSyncServer, error) {
	a.serverMu.Lock()
	defer a.serverMu.Unlock()
	ctx, generation, err := a.ticketContext()
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	dir, err := foldersession.CanonicalFolder(folder)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	p, err := syncworkspace.LoadProfile(dir)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	if p == nil {
		return VerifiedSyncServer{}, errServerTicket
	}
	lineage, err := a.openLineage(dir)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.serverTickets.ConfirmCopy(ctx, generation, *p, lineage)
}

type VerifiedSyncServer = syncworkspace.VerifiedSyncServer

var errServerTicket = syncworkspace.ErrTicket

// A sync operation belongs to the vault session that initiated it. The caller
// holds app.mu while reading a local record or committing an enrollment.
type syncSession struct {
	app        *App
	generation uint64
}

func (a *App) syncSession() *syncSession {
	return &syncSession{a, a.serverTickets.Generation()}
}

func (s *syncSession) check() error {
	if !s.app.library.Loaded() {
		return errLocked
	}
	if s.app.serverTickets.Generation() != s.generation {
		return errServerTicket
	}
	return nil
}

func (a *App) ticketContext() (context.Context, uint64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.library.Loaded() {
		return nil, 0, errLocked
	}
	ctx := a.ctx
	// Capture the ticket generation while the unlocked state is still current.
	// A lock during the network request invalidates its result, even after unlock.
	if ctx == nil {
		ctx = context.Background()
	}
	return ctx, a.serverTickets.Generation(), nil
}

func (a *App) VerifySyncServer(address, password string) (VerifiedSyncServer, error) {
	ctx, generation, err := a.ticketContext()
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.serverTickets.Verify(ctx, generation, address, password)
}

func (a *App) DiscardSyncServerTicket(ticket string) {
	a.serverTickets.Discard(ticket)
}

func (a *App) resolveServerTicket(input string) (syncclient.Profile, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.library.Loaded() {
		return syncclient.Profile{}, errLocked
	}
	return a.serverTickets.Resolve(input)
}
