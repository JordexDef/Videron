package notesession

import (
	"errors"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"videron/internal/vault"
)

const (
	noteFixture      = `{"id":"note-a","title":"Private note","plain":"PRIVATE-CODE","body":[{"type":"code","text":"PRIVATE-CODE"}]}`
	notePassword     = "fixture note password"
	nextNotePassword = "updated note password"
)

func canUnlockFixture() bool { return true }

func TestNoteUnlockFollowsWorkspaceAndCurrentEnvelope(t *testing.T) {
	a := new(NoteKeys)
	const id, space = "note-a", "personal"
	sealed, err := a.Protect(id, noteFixture, notePassword)
	if err != nil {
		t.Fatal(err)
	}
	a.CloseEditor(id)
	unlock := func(minutes int) UnlockedNote {
		t.Helper()
		result, err := a.UnlockFor(space, id, sealed, notePassword, minutes, canUnlockFixture)
		if err != nil || result.Plain != noteFixture {
			t.Fatal("unlock", err)
		}
		return result
	}
	assertLocked := func(space, envelope string) {
		t.Helper()
		if _, err := a.Resume(space, id, envelope, canUnlockFixture); !errors.Is(err, vault.ErrLocked) {
			t.Fatal("unexpected resume", err)
		}
	}
	once := unlock(0)
	if once.Remembered || once.ExpiresAt != 0 {
		t.Fatal("single opening gained a grant")
	}
	a.CloseEditor(id)
	assertLocked(space, sealed)
	granted := unlock(-1)
	if !granted.Remembered || granted.ExpiresAt != 0 {
		t.Fatal("session grant")
	}
	updated := strings.Replace(noteFixture, "PRIVATE-CODE", "UPDATED", 1)
	edited, err := a.Seal(id, updated)
	if err != nil {
		t.Fatal(err)
	}
	a.CloseEditor(id)
	assertLocked("other-space", edited)
	if _, err := a.Seal(id, updated); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("closed editor still writes")
	}
	if got, err := a.Resume(space, id, edited, canUnlockFixture); err != nil || got.Plain != updated {
		t.Fatal("did not use the latest ciphertext", err)
	}
	a.CloseEditor(id)
	peer := new(NoteKeys)
	rekeyed, err := peer.Protect(id, updated, nextNotePassword)
	if err != nil {
		t.Fatal(err)
	}
	// Authenticating a rekeyed envelope revokes, rather than trusting a cached copy.
	assertLocked(space, rekeyed)
	assertLocked(space, edited)
	unlock(-1)
	a.Lock(id)
	assertLocked(space, sealed)
	unlock(-1)
	a.ForgetRemembered() // Switching away, including later returning to this space.
	assertLocked(space, sealed)
	unlock(-1)
	a.Clear()
	assertLocked(space, sealed)
	if key := a.EditorKey(id); key != nil {
		t.Fatal("clearing the session retained the editor key")
	}
}

func TestNoteUnlockRechecksSessionBeforeGrantingAccess(t *testing.T) {
	var keys NoteKeys
	const space, id = "personal", "note-a"
	sealed, err := keys.Protect(id, noteFixture, notePassword)
	if err != nil {
		t.Fatal(err)
	}
	keys.CloseEditor(id)

	checks := 0
	canUnlock := func() bool {
		checks++
		return checks == 1
	}
	got, err := keys.UnlockFor(space, id, sealed, notePassword, -1, canUnlock)
	if !errors.Is(err, vault.ErrLocked) || got != (UnlockedNote{}) || keys.EditorKey(id) != nil {
		t.Fatal("unlock published an editor key after the session changed", err)
	}
	if _, err := keys.Resume(space, id, sealed, canUnlockFixture); !errors.Is(err, vault.ErrLocked) {
		t.Fatal("unlock retained a reopening grant after the session changed", err)
	}
}

func TestNoteUnlockEditorDeadlineAfterClockChange(t *testing.T) {
	start := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	grant := rememberedNote{until: start.Add(5 * time.Minute)}
	// The user reopens the note four elapsed minutes after granting access.
	// One monotonic minute remains regardless of the wall clock's position.
	atReopen := start.Add(4 * time.Minute)
	rollback := atReopen.Add(-time.Hour)
	if got := grant.editorDeadline(rollback, time.Minute); got != rollback.Add(time.Minute).UnixMilli() {
		t.Fatalf("clock rollback extended editor access: %d", got)
	}
	forward := atReopen.Add(30 * time.Second)
	if got := grant.editorDeadline(forward, time.Minute); got != grant.until.UnixMilli() {
		t.Fatalf("clock advance ignored original wall-clock expiry: %d", got)
	}
}

func TestNoteUnlockDeadlineIsAbsoluteAndPreservesFinalSave(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		a := new(NoteKeys)
		const space, id = "test", "note-a"
		sealed, err := a.Protect(id, noteFixture, notePassword)
		if err != nil {
			t.Fatal(err)
		}
		start, err := a.UnlockFor(space, id, sealed, notePassword, 5, canUnlockFixture)
		if err != nil || !start.Remembered || start.ExpiresAt != time.Now().Add(5*time.Minute).UnixMilli() {
			t.Fatal("incorrect deadline", err)
		}
		remembered := a.rememberedNotes[id].key
		a.CloseEditor(id)
		time.Sleep(4 * time.Minute)
		got, err := a.Resume(space, id, sealed, canUnlockFixture)
		if err != nil || got.ExpiresAt != start.ExpiresAt || got.Plain != noteFixture {
			t.Fatal("reopen should retain original deadline", err)
		}
		time.Sleep(time.Minute)
		synctest.Wait()
		if _, err := remembered.Seal(vault.NoteScope, id, []byte(noteFixture)); !errors.Is(err, vault.ErrLocked) || len(a.rememberedNotes) != 0 {
			t.Fatal("timer did not revoke the retained key", err)
		}
		if _, err := a.Resume(space, id, sealed, canUnlockFixture); !errors.Is(err, vault.ErrLocked) {
			t.Fatal("expired reuse accepted", err)
		}
		updated := strings.Replace(noteFixture, "PRIVATE-CODE", "SAVED-AT-EXPIRY", 1)
		written, err := a.Seal(id, updated)
		if err != nil {
			t.Fatal("could not finish saving at deadline", err)
		}
		a.CloseEditor(id)
		if _, err := a.Seal(id, updated); !errors.Is(err, vault.ErrLocked) {
			t.Fatal("closed editor key retained", err)
		}
		if got, err := a.Preview(id, written, notePassword, canUnlockFixture); err != nil || got != updated {
			t.Fatal("pending edit missing", err)
		}
	})
}
