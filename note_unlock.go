package main

import (
	"errors"
	"time"
	"unicode/utf8"

	"videron/internal/vault"
	"videron/internal/workspacestore"
)

// The editor's key and the grant for future opens have independent lifetimes.
// Expiring the latter cannot interrupt sealing an outstanding edit.
type rememberedNote struct {
	spaceID string
	key     *vault.Key
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

func validNote(id string, payload []byte) bool {
	if id == "" || !utf8.Valid(payload) {
		return false
	}
	// Use the same case-sensitive property as the editor and catalog index.
	storedID, err := workspacestore.RecordID(payload)
	return err == nil && storedID == id
}

func (a *App) cacheNoteKey(id string, key *vault.Key) {
	if a.noteKeys == nil {
		a.noteKeys = make(map[string]*vault.Key)
	}
	a.noteKeys[id].Forget()
	a.noteKeys[id] = key
}

func openNoteContents(key *vault.Key, env *vault.Envelope, id string) ([]byte, error) {
	plain, err := key.Open(env, id)
	if err != nil {
		return nil, err
	}
	if !validNote(id, plain) {
		clear(plain)
		return nil, errCorrupt
	}
	return plain, nil
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
	g := &rememberedNote{spaceID: spaceID, key: a.noteKeys[id].Clone()}
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
	env, err := vault.ParseEnvelope([]byte(sealed), vault.NoteScope)
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
	a.cacheNoteKey(id, g.key.Clone())
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
		g.key.Forget()
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

func (a *App) ProtectNote(id, payload, password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	data := []byte(payload)
	defer clear(data)
	if !validNote(id, data) {
		return "", errInvalid
	}
	key, err := vault.NewKey(password)
	if err != nil {
		return "", err
	}
	sealed, err := key.Seal(vault.NoteScope, id, data)
	if err != nil {
		key.Forget()
		return "", err
	}
	a.forgetRememberedNote(id)
	a.cacheNoteKey(id, key)
	return string(sealed), nil
}

func (a *App) UnlockNote(id, sealed, password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.readSealedNote(id, sealed, password, true)
}

// Comparison reads a historical copy without granting an editor session access
// or replacing the key used to save another version of the same note.
func (a *App) PreviewSealedNote(id, sealed, password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.readSealedNote(id, sealed, password, false)
}

// The caller holds mu. A preview never changes the live editor or a remembered key.
func (a *App) readSealedNote(id, sealed, password string, keepKey bool) (string, error) {
	if !a.canUnlockNote() {
		return "", errLocked
	}
	if id == "" {
		return "", errInvalid
	}
	env, err := vault.ParseEnvelope([]byte(sealed), vault.NoteScope)
	if err != nil {
		return "", err
	}
	key := vault.DeriveKey(password, env.Salt)
	plain, err := openNoteContents(key, env, id)
	if err != nil {
		key.Forget()
		return "", err
	}
	defer clear(plain)
	if !a.canUnlockNote() {
		key.Forget()
		return "", errLocked
	}
	if keepKey {
		a.forgetRememberedNote(id)
		a.cacheNoteKey(id, key)
	} else {
		key.Forget()
	}
	return string(plain), nil
}

func (a *App) SealNote(id, payload string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	key := a.noteKeys[id]
	if !a.loaded || key == nil {
		return "", errLocked
	}
	data := []byte(payload)
	defer clear(data)
	if !validNote(id, data) {
		return "", errInvalid
	}
	sealed, err := key.Seal(vault.NoteScope, id, data)
	return string(sealed), err
}

func (a *App) LockNote(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.forgetRememberedNote(id)
	a.closeNoteEditor(id)
}

func (a *App) closeNoteEditor(id string) {
	a.noteKeys[id].Forget()
	delete(a.noteKeys, id)
}
