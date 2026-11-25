package main

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"sync"
	"time"

	"videron/internal/syncclient"
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
	profile syncclient.Profile
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

func (s *syncServerTickets) currentGeneration() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generation
}

// A sync operation belongs to the vault session that initiated it. The caller
// holds app.mu while reading a local record or committing an enrollment.
type syncSession struct {
	app        *App
	generation uint64
}

func (a *App) syncSession() *syncSession {
	return &syncSession{a, a.serverTickets.currentGeneration()}
}

func (s *syncSession) check() error {
	if !s.app.loaded {
		return errLocked
	}
	if s.app.serverTickets.currentGeneration() != s.generation {
		return errServerTicket
	}
	return nil
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
	if ctx == nil {
		ctx = context.Background()
	}
	return ctx, a.serverTickets.currentGeneration(), nil
}

func (a *App) VerifySyncServer(address, password string) (VerifiedSyncServer, error) {
	ctx, generation, err := a.ticketContext()
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	p, err := syncclient.VerifyCredentials(ctx, address, password)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return a.issueServerTicket(p, generation)
}

func verifiedServer(p syncclient.Profile, ticket string) VerifiedSyncServer {
	return VerifiedSyncServer{Ticket: ticket, Address: p.Address, HasSpace: p.Lineage != "" && !p.ProjectDeleted, ProjectID: p.ProjectID, ProjectName: p.ProjectName, ProjectDeleted: p.ProjectDeleted}
}

func (a *App) issueServerTicket(p syncclient.Profile, generation uint64) (VerifiedSyncServer, error) {
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
	return verifiedServer(p, ticket), nil
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

func (a *App) resolveServerTicket(input string) (syncclient.Profile, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return syncclient.Profile{}, errLocked
	}
	if !strings.HasPrefix(input, verificationTicketPrefix) {
		return syncclient.ParsePairCode(input)
	}
	tickets := &a.serverTickets
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	entry, ok := tickets.entries[input]
	if !ok || !time.Now().Before(entry.expires) {
		return syncclient.Profile{}, errServerTicket
	}
	return entry.profile, nil
}
