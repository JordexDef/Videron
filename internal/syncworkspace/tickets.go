package syncworkspace

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

var ErrTicket = errors.New("VD_SERVER_TICKET")

type ticketEntry struct {
	profile syncclient.Profile
	expires time.Time
	timer   *time.Timer
}

// Tickets holds verified credentials for the current unlocked workspace session.
type Tickets struct {
	mu         sync.Mutex
	generation uint64
	entries    map[string]ticketEntry
}

func (s *Tickets) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.entries {
		entry.timer.Stop()
	}
	clear(s.entries)
	s.generation++
}

func (s *Tickets) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generation
}

func IsTicket(value string) bool { return strings.HasPrefix(value, verificationTicketPrefix) }

func verifiedServer(p syncclient.Profile, ticket string) VerifiedSyncServer {
	return VerifiedSyncServer{Ticket: ticket, Address: p.Address, HasSpace: p.Lineage != "" && !p.ProjectDeleted, ProjectID: p.ProjectID, ProjectName: p.ProjectName, ProjectDeleted: p.ProjectDeleted}
}

func (tickets *Tickets) Issue(p syncclient.Profile, generation uint64) (VerifiedSyncServer, error) {
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	if tickets.generation != generation {
		return VerifiedSyncServer{}, ErrTicket
	}
	if tickets.entries == nil {
		tickets.entries = make(map[string]ticketEntry)
	}
	ticket := verificationTicketPrefix + rand.Text()
	const lifetime = 10 * time.Minute
	timer := time.AfterFunc(lifetime, func() { tickets.Discard(ticket) })
	tickets.entries[ticket] = ticketEntry{p, time.Now().Add(lifetime), timer}
	return verifiedServer(p, ticket), nil
}

func (tickets *Tickets) Discard(ticket string) {
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	if entry, ok := tickets.entries[ticket]; ok {
		entry.timer.Stop()
		delete(tickets.entries, ticket)
	}
}

// Resolve accepts both current tickets and legacy pairing links. Only tickets
// can authorize operations on the project catalog.
func (tickets *Tickets) Resolve(input string) (syncclient.Profile, error) {
	if !IsTicket(input) {
		return syncclient.ParsePairCode(input)
	}
	tickets.mu.Lock()
	defer tickets.mu.Unlock()
	entry, ok := tickets.entries[input]
	if !ok || !time.Now().Before(entry.expires) {
		return syncclient.Profile{}, ErrTicket
	}
	return entry.profile, nil
}

func (tickets *Tickets) Verify(ctx context.Context, generation uint64, address, password string) (VerifiedSyncServer, error) {
	p, err := syncclient.VerifyCredentials(ctx, address, password)
	if err != nil {
		return VerifiedSyncServer{}, err
	}
	return tickets.Issue(p, generation)
}
