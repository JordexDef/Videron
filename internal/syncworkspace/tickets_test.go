package syncworkspace

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"videron/internal/syncclient"
)

func TestTicketSelectionAndRevocation(t *testing.T) {
	var tickets Tickets
	t.Cleanup(tickets.Reset)
	generation := tickets.Generation()
	profile := syncclient.Profile{Address: "https://test.invalid:443", Pin: strings.Repeat("a", 64), Token: strings.Repeat("b", 64)}
	issued, err := tickets.Issue(profile, generation)
	if err != nil || !IsTicket(issued.Ticket) || issued.HasSpace {
		t.Fatal("issue ticket", err)
	}
	selected := profile
	selected.ProjectID = strings.Repeat("c", 64)
	selected.ProjectName = "Research"
	selected.Lineage = strings.Repeat("d", 64)
	updated, err := tickets.update(issued.Ticket, profile, selected)
	if err != nil || updated.Ticket != issued.Ticket || updated.ProjectID != selected.ProjectID ||
		updated.ProjectName != selected.ProjectName || !updated.HasSpace {
		t.Fatal("select project", err)
	}
	encoded, err := json.Marshal(updated)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{selected.Pin, selected.Token, selected.Lineage} {
		if strings.Contains(string(encoded), private) {
			t.Fatal("ticket summary exposed private server metadata")
		}
	}
	if _, err := tickets.update(issued.Ticket, profile, profile); !errors.Is(err, ErrTicket) {
		t.Fatal("stale selection overwrote the current project", err)
	}
	if got, err := tickets.Resolve(issued.Ticket); err != nil || got != selected {
		t.Fatal("resolved the wrong project", err)
	}
	tickets.Reset()
	if _, err := tickets.Resolve(issued.Ticket); !errors.Is(err, ErrTicket) {
		t.Fatal("the old ticket survived a session reset", err)
	}
	if _, err := tickets.Issue(profile, generation); !errors.Is(err, ErrTicket) {
		t.Fatal("issued a ticket using the previous session generation", err)
	}
}

func TestExpiredAndDiscardedTickets(t *testing.T) {
	var tickets Tickets
	t.Cleanup(tickets.Reset)
	profile := syncclient.Profile{Address: "https://test.invalid:443"}
	for _, expire := range []bool{false, true} {
		issued, err := tickets.Issue(profile, tickets.Generation())
		if err != nil {
			t.Fatal(err)
		}
		if expire {
			tickets.mu.Lock()
			entry := tickets.entries[issued.Ticket]
			entry.expires = time.Now().Add(-time.Second)
			tickets.entries[issued.Ticket] = entry
			tickets.mu.Unlock()
		} else {
			tickets.Discard(issued.Ticket)
		}
		if _, err := tickets.Resolve(issued.Ticket); !errors.Is(err, ErrTicket) {
			t.Fatal("resolved an expired or discarded ticket", err)
		}
		if _, err := tickets.update(issued.Ticket, profile, profile); !errors.Is(err, ErrTicket) {
			t.Fatal("updated an expired or discarded ticket", err)
		}
	}
}
