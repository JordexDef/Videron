package main

import (
	"bytes"
	"errors"
	"time"
)

// The editor's key and the grant for future opens have independent lifetimes.
// Expiring the latter cannot interrupt sealing an outstanding edit.
type rememberedNote struct {
	spaceID string
	key     *vaultKey
	until   time.Time
	timer   *time.Timer
}

type UnlockedNote struct {
	Plain      string `json:"plain"`
	Remembered bool   `json:"remembered"`
	ExpiresAt  int64  `json:"expiresAt"` // Unix milliseconds; zero for untimed access.
}

func (a *App) canUnlockNote() bool {
	return a.loaded && !a.sessionLockPending.Load() && !a.revokingFolderKeys.Load()
}

func openNoteContents(key *vaultKey, env *envelope, id string) ([]byte, error) {
	plain, err := key.open(env, id)
	if err != nil {
		return nil, err
	}
	if !validNote(id, plain) {
		clear(plain)
		return nil, errCorrupt
	}
	return plain, nil
}

func copyNoteKey(k *vaultKey) *vaultKey {
	return &vaultKey{salt: k.salt, key: bytes.Clone(k.key)}
}

func (g *rememberedNote) result(plain string) UnlockedNote {
	result := UnlockedNote{Plain: plain, Remembered: true}
	if !g.until.IsZero() {
		now := time.Now()
		result.ExpiresAt = g.editorDeadline(now, g.until.Sub(now))
	}
	return result
}

// The WebView arms its editor timer using the current wall clock. If the
// clock moved backwards while the editor was closed, translate the remaining
// monotonic duration to that clock without extending the native grant.
func (g *rememberedNote) editorDeadline(wallNow time.Time, remaining time.Duration) int64 {
	return min(g.until.UnixMilli(), wallNow.Add(remaining).UnixMilli())
}

func (g *rememberedNote) expired() bool {
	now := time.Now()
	// Some monotonic clocks pause during system sleep. Honor the displayed
	// wall-clock deadline too, while retaining elapsed-time checks on clock rollback.
	return !g.until.IsZero() && (!now.Before(g.until) || now.UnixMilli() >= g.until.UnixMilli())
}

// UnlockNoteFor selects the lifetime at the password prompt: zero for this
// visit, -1 for this workspace session, or a fixed number of minutes.
func (a *App) UnlockNoteFor(spaceID, id, sealed, password string, minutes int) (UnlockedNote, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if spaceID == "" || minutes < -1 || minutes > 1440 {
		return UnlockedNote{}, errInvalid
	}
	plain, err := a.readSealedNote(id, sealed, password, true)
	if err != nil {
		return UnlockedNote{}, err
	}
	if minutes == 0 {
		return UnlockedNote{Plain: plain}, nil
	}
	if a.rememberedNotes == nil {
		a.rememberedNotes = make(map[string]*rememberedNote)
	}
	g := &rememberedNote{spaceID: spaceID, key: copyNoteKey(a.noteKeys[id])}
	a.rememberedNotes[id] = g
	if minutes > 0 {
		g.until = time.Now().Add(time.Duration(minutes) * time.Minute)
		g.timer = time.AfterFunc(time.Until(g.until), func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			if a.rememberedNotes[id] == g {
				a.forgetRememberedNote(id)
			}
		})
	}
	return g.result(plain), nil
}

// ResumeNote opens the current ciphertext, including edits synced by another
// device. Reopening a note never extends its original deadline.
func (a *App) ResumeNote(spaceID, id, sealed string) (UnlockedNote, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	g := a.rememberedNotes[id]
	if !a.canUnlockNote() || g == nil || g.spaceID != spaceID {
		return UnlockedNote{}, errLocked
	}
	if g.expired() {
		a.forgetRememberedNote(id)
		return UnlockedNote{}, errLocked
	}
	env, err := parseEnvelope([]byte(sealed), noteVault)
	if err != nil {
		a.forgetRememberedNote(id)
		return UnlockedNote{}, err
	}
	plain, err := openNoteContents(g.key, env, id)
	if err != nil {
		a.forgetRememberedNote(id)
		if errors.Is(err, errPassword) {
			return UnlockedNote{}, errLocked // Includes a fresh salt after a password change.
		}
		return UnlockedNote{}, err
	}
	defer clear(plain)
	if !a.canUnlockNote() || g.expired() {
		a.forgetRememberedNote(id)
		return UnlockedNote{}, errLocked
	}
	a.cacheNoteKey(id, copyNoteKey(g.key))
	return g.result(string(plain)), nil
}

// CloseNoteEditor runs after the final encrypted save. A normal trip back to
// the map leaves only the optional grant that was chosen at unlock.
func (a *App) CloseNoteEditor(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closeNoteEditor(id)
}

func (a *App) forgetRememberedNote(id string) {
	if g := a.rememberedNotes[id]; g != nil {
		if g.timer != nil {
			g.timer.Stop()
		}
		g.key.forget()
		delete(a.rememberedNotes, id)
	}
}

func (a *App) forgetRememberedNotes() {
	for id := range a.rememberedNotes {
		a.forgetRememberedNote(id)
	}
}

// ForgetRememberedNotes also works while an editor finishes its last save.
func (a *App) ForgetRememberedNotes() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.forgetRememberedNotes()
}
