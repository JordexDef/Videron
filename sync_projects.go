package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"videron/internal/syncclient"
)

type ServerProject = syncclient.Project
type ServerProjectList = syncclient.ProjectList

// Connection preferences belong to the working copy. An enrollment ticket can
// come from a different copy of the same project with its own preference.
func bindWorkingCopy(p *syncclient.Profile, dir string) error {
	existing, err := loadProfile(dir)
	if err != nil {
		return err
	}
	if existing == nil {
		p.ManualConnect = false
		return nil
	}
	if !p.SameProject(existing) {
		if p.Address == existing.Address && p.Pin != existing.Pin {
			return syncclient.ErrCert
		}
		return syncclient.ErrSpace
	}
	p.ManualConnect = existing.ManualConnect
	return nil
}

// Project management uses an unlocked, verified session. A legacy pairing
// code still connects to its original default project via Connect/Join.
func (a *App) projectProfile(ticket string) (syncclient.Profile, error) {
	if !strings.HasPrefix(ticket, verificationTicketPrefix) {
		return syncclient.Profile{}, errServerTicket
	}
	return a.resolveServerTicket(ticket)
}

func (a *App) ListServerProjects(ticket string) (ServerProjectList, error) {
	p, err := a.projectProfile(ticket)
	if err != nil {
		return ServerProjectList{}, err
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	return p.ListProjects(ctx, c)
}

func (a *App) SelectServerProject(ticket, id string) (VerifiedSyncServer, error) {
	before, err := a.projectProfile(ticket)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	c := before.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	p, err := before.SelectProject(ctx, c, id)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.updateProjectTicket(ticket, before, p)
}

func (a *App) CreateServerProject(ticket, name string) (VerifiedSyncServer, error) {
	before, err := a.projectProfile(ticket)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	c := before.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	p, err := before.CreateProject(ctx, c, ticket, name)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.updateProjectTicket(ticket, before, p)
}

func (a *App) RenameServerProject(ticket, id, newName, expectedName string) (VerifiedSyncServer, error) {
	if !syncclient.ValidProjectName(strings.TrimSpace(newName)) {
		return VerifiedSyncServer{}, syncclient.ErrProjectName
	}
	before, err := a.projectProfile(ticket)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	c := before.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	p, err := before.RenameProject(ctx, c, id, newName, expectedName)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.updateProjectTicket(ticket, before, p)
}

func (a *App) DeleteServerProject(ticket, id, expectedName string) error {
	before, err := a.projectProfile(ticket)
	if err != nil {
		return err
	}
	c := before.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	p, err := before.DeleteProject(ctx, c, id, expectedName)
	if err != nil {
		return err
	}
	// The server already deleted the project, even if the ticket expired in flight.
	_, _ = a.updateProjectTicket(ticket, before, p)
	return nil
}

func (a *App) updateProjectTicket(ticket string, before, p syncclient.Profile) (VerifiedSyncServer, error) {
	tickets := &a.serverTickets
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	saved, ok := tickets.entries[ticket]
	if !ok || time.Now().After(saved.expires) || saved.profile != before {
		return VerifiedSyncServer{}, errServerTicket
	}
	saved.profile = p
	tickets.entries[ticket] = saved
	return verifiedServer(p, ticket), nil
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
	dir, err := spaceDir(folder)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	p, err := loadProfile(dir)
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
	if lineage != p.Lineage {
		return VerifiedSyncServer{}, syncclient.ErrSpace
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	m, err := p.ManifestSummary(ctx, c)
	if errors.Is(err, syncclient.ErrProjectDeleted) {
		p.ProjectDeleted = true
		return a.issueServerTicket(*p, generation)
	}
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	if m.Lineage != p.Lineage {
		return VerifiedSyncServer{}, syncclient.ErrSpace
	}
	return a.issueServerTicket(*p, generation)
}
