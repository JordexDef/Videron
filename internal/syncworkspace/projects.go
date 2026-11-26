package syncworkspace

import (
	"context"
	"errors"
	"time"

	"videron/internal/syncclient"
)

const projectRequestTimeout = 25 * time.Second

func ListProjects(p syncclient.Profile) (syncclient.ProjectList, error) {
	c := p.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), projectRequestTimeout)
	defer cancel()
	return p.ListProjects(ctx, c)
}

func (tickets *Tickets) SelectProject(ticket string, before syncclient.Profile, id string) (VerifiedSyncServer, error) {
	c := before.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), projectRequestTimeout)
	defer cancel()
	p, err := before.SelectProject(ctx, c, id)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return tickets.update(ticket, before, p)
}

func (tickets *Tickets) CreateProject(ticket string, before syncclient.Profile, name string) (VerifiedSyncServer, error) {
	c := before.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), projectRequestTimeout)
	defer cancel()
	p, err := before.CreateProject(ctx, c, ticket, name)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return tickets.update(ticket, before, p)
}

func (tickets *Tickets) RenameProject(ticket string, before syncclient.Profile, id, newName, expectedName string) (VerifiedSyncServer, error) {
	c := before.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), projectRequestTimeout)
	defer cancel()
	p, err := before.RenameProject(ctx, c, id, newName, expectedName)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return tickets.update(ticket, before, p)
}

func (tickets *Tickets) DeleteProject(ticket string, before syncclient.Profile, id, expectedName string) error {
	c := before.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), projectRequestTimeout)
	defer cancel()
	p, err := before.DeleteProject(ctx, c, id, expectedName)
	if err != nil {
		return err
	}
	// The server already deleted the project, even if the ticket expired in flight.
	_, _ = tickets.update(ticket, before, p)
	return nil
}

func (tickets *Tickets) update(ticket string, before, p syncclient.Profile) (VerifiedSyncServer, error) {
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	saved, ok := tickets.entries[ticket]
	if !ok || time.Now().After(saved.expires) || saved.profile != before {
		return VerifiedSyncServer{}, ErrTicket
	}
	saved.profile = p
	tickets.entries[ticket] = saved
	return verifiedServer(p, ticket), nil
}

// ConfirmCopy issues a ticket only if both the local and remote workspace
// identities match the saved profile.
func (tickets *Tickets) ConfirmCopy(ctx context.Context, generation uint64, p syncclient.Profile, lineage string) (VerifiedSyncServer, error) {
	if lineage != p.Lineage {
		return VerifiedSyncServer{}, syncclient.ErrSpace
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, projectRequestTimeout)
	defer cancel()
	m, err := p.ManifestSummary(ctx, c)
	if errors.Is(err, syncclient.ErrProjectDeleted) {
		p.ProjectDeleted = true
		return tickets.Issue(p, generation)
	}
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	if m.Lineage != p.Lineage {
		return VerifiedSyncServer{}, syncclient.ErrSpace
	}
	return tickets.Issue(p, generation)
}
