package main

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"sync"
	"time"
)

// The WebView receives a short-lived handle. The verified server credential
// stays in Go until the user chooses a folder and completes the connection.
type VerifiedSyncServer struct {
	Ticket         string `json:"ticket"`
	Address        string `json:"address"`
	HasSpace       bool   `json:"hasSpace"`
	ProjectID      string `json:"projectId"`
	ProjectName    string `json:"projectName"`
	ProjectDeleted bool   `json:"projectDeleted,omitempty"`
}

const verificationTicketPrefix = "verified:"

var errServerTicket = errors.New("VD_SERVER_TICKET")

type syncServerTicket struct {
	profile serverProfile
	expires time.Time
	timer   *time.Timer
}

type syncServerTickets struct {
	mu         sync.Mutex
	generation uint64
	entries    map[string]syncServerTicket
}

func (s *syncServerTickets) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.entries {
		entry.timer.Stop()
	}
	clear(s.entries)
	s.generation++
}

func (a *App) ticketContext() (context.Context, uint64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return nil, 0, errLocked
	}
	ctx := a.ctx
	// Capture the ticket generation while the unlocked state is still current.
	// A lock during the network request invalidates its result, even after unlock.
	tickets := &a.serverTickets
	tickets.mu.Lock()
	generation := tickets.generation
	tickets.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	return ctx, generation, nil
}

func (a *App) VerifySyncServer(address, password string) (VerifiedSyncServer, error) {
	ctx, generation, err := a.ticketContext()
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	p, err := verifyServerCredentials(ctx, address, password)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.issueServerTicket(p, generation)
}

func (p serverProfile) verified(ticket string) VerifiedSyncServer {
	return VerifiedSyncServer{Ticket: ticket, Address: p.Address, HasSpace: p.Lineage != "" && !p.ProjectDeleted, ProjectID: p.ProjectID, ProjectName: p.ProjectName, ProjectDeleted: p.ProjectDeleted}
}

func (a *App) issueServerTicket(p serverProfile, generation uint64) (VerifiedSyncServer, error) {
	tickets := &a.serverTickets
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	if tickets.generation != generation {
		return VerifiedSyncServer{}, errServerTicket
	}
	if tickets.entries == nil {
		tickets.entries = make(map[string]syncServerTicket)
	}
	ticket := verificationTicketPrefix + rand.Text()
	const lifetime = 10 * time.Minute
	timer := time.AfterFunc(lifetime, func() { a.DiscardSyncServerTicket(ticket) })
	tickets.entries[ticket] = syncServerTicket{p, time.Now().Add(lifetime), timer}
	return p.verified(ticket), nil
}

func (a *App) DiscardSyncServerTicket(ticket string) {
	tickets := &a.serverTickets
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	if entry, ok := tickets.entries[ticket]; ok {
		entry.timer.Stop()
		delete(tickets.entries, ticket)
	}
}

func (a *App) resolveServerTicket(input string) (serverProfile, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return serverProfile{}, errLocked
	}
	if !strings.HasPrefix(input, verificationTicketPrefix) {
		return parsePairCode(input)
	}
	tickets := &a.serverTickets
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	entry, ok := tickets.entries[input]
	if !ok || !time.Now().Before(entry.expires) {
		return serverProfile{}, errServerTicket
	}
	return entry.profile, nil
}
