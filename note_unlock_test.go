package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"videron/internal/vault"
)

func TestNoteUnlockFollowsWorkspaceAndCurrentEnvelope(t *testing.T) {
	a := &App{loaded: true}
	const id, space = "note-a", "personal"
	sealed, err := a.ProtectNote(id, originalNote, testPass)
	if err != nil {
		t.Fatal(err)
	}
	a.CloseNoteEditor(id)
	unlock := func(minutes int) UnlockedNote {
		t.Helper()
		result, err := a.UnlockNoteFor(space, id, sealed, testPass, minutes)
		if err != nil || result.Plain != originalNote {
			t.Fatal("unlock", err)
		}
		return result
	}
	assertLocked := func(space, envelope string) {
		t.Helper()
		if _, err := a.ResumeNote(space, id, envelope); !errors.Is(err, errLocked) {
			t.Fatal("unexpected resume", err)
		}
	}
	once := unlock(0)
	if once.Remembered || once.ExpiresAt != 0 {
		t.Fatal("single opening gained a grant")
	}
	a.CloseNoteEditor(id)
	assertLocked(space, sealed)
	granted := unlock(-1)
	if !granted.Remembered || granted.ExpiresAt != 0 {
		t.Fatal("session grant")
	}
	updated := strings.Replace(originalNote, "PRIVATE-CODE", "UPDATED", 1)
	edited, err := a.SealNote(id, updated)
	if err != nil {
		t.Fatal(err)
	}
	a.CloseNoteEditor(id)
	assertLocked("other-space", edited)
	if _, err := a.SealNote(id, updated); !errors.Is(err, errLocked) {
		t.Fatal("closed editor still writes")
	}
	if got, err := a.ResumeNote(space, id, edited); err != nil || got.Plain != updated {
		t.Fatal("did not use the latest ciphertext", err)
	}
	a.CloseNoteEditor(id)
	peer := &App{loaded: true}
	rekeyed, err := peer.ProtectNote(id, updated, nextPass)
	if err != nil {
		t.Fatal(err)
	}
	// Authenticating a rekeyed envelope revokes, rather than trusting a cached copy.
	assertLocked(space, rekeyed)
	assertLocked(space, edited)
	unlock(-1)
	a.LockNote(id)
	assertLocked(space, sealed)
	unlock(-1)
	a.ForgetRememberedNotes() // Switching away, including later returning to this space.
	assertLocked(space, sealed)
	unlock(-1)
	a.sessionLocked(context.Background())
	if _, err := a.SealNote(id, updated); err != nil {
		t.Fatal("OS lock lost the unsaved editor key", err)
	}
	a.CloseNoteEditor(id)
	a.ConsumeSessionLock()
	assertLocked(space, sealed)
	unlock(-1)
	a.FinishClose()
	a.loaded = true
	assertLocked(space, sealed)
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
		a := &App{loaded: true}
		const space, id = "test", "note-a"
		sealed, err := a.ProtectNote(id, originalNote, testPass)
		if err != nil {
			t.Fatal(err)
		}
		start, err := a.UnlockNoteFor(space, id, sealed, testPass, 5)
		if err != nil || !start.Remembered || start.ExpiresAt != time.Now().Add(5*time.Minute).UnixMilli() {
			t.Fatal("incorrect deadline", err)
		}
		remembered := a.rememberedNotes[id].key
		a.CloseNoteEditor(id)
		time.Sleep(4 * time.Minute)
		got, err := a.ResumeNote(space, id, sealed)
		if err != nil || got.ExpiresAt != start.ExpiresAt || got.Plain != originalNote {
			t.Fatal("reopen should retain original deadline", err)
		}
		time.Sleep(time.Minute)
		synctest.Wait()
		if _, err := remembered.Seal(vault.NoteScope, id, []byte(originalNote)); !errors.Is(err, errLocked) || len(a.rememberedNotes) != 0 {
			t.Fatal("timer did not revoke the retained key", err)
		}
		if _, err := a.ResumeNote(space, id, sealed); !errors.Is(err, errLocked) {
			t.Fatal("expired reuse accepted", err)
		}
		updated := strings.Replace(originalNote, "PRIVATE-CODE", "SAVED-AT-EXPIRY", 1)
		written, err := a.SealNote(id, updated)
		if err != nil {
			t.Fatal("could not finish saving at deadline", err)
		}
		a.CloseNoteEditor(id)
		if _, err := a.SealNote(id, updated); !errors.Is(err, errLocked) {
			t.Fatal("closed editor key retained", err)
		}
		if got, err := a.PreviewSealedNote(id, written, testPass); err != nil || got != updated {
			t.Fatal("pending edit missing", err)
		}
	})
}
