package notesession

import (
	"errors"
	"sync"
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

// NoteKeys keeps each live editor key separate from a timed reopening grant.
// Its zero value is ready to use.
type NoteKeys struct {
	mu              sync.Mutex
	editorKeys      map[string]*vault.Key
	rememberedNotes map[string]*rememberedNote
}

// EditorKey borrows the active key for editor history. The caller serializes
// its use against operations that replace or clear editor keys. The expiry
// timer only clears the independent remembered key.
func (s *NoteKeys) EditorKey(id string) *vault.Key {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.editorKeys[id]
}

func validNote(id string, payload []byte) bool {
	if id == "" || !utf8.Valid(payload) {
		return false
	}
	// Use the same case-sensitive property as the editor and catalog index.
	storedID, err := workspacestore.RecordID(payload)
	return err == nil && storedID == id
}

// The caller holds mu.
func (s *NoteKeys) cacheNoteKey(id string, key *vault.Key) {
	if s.editorKeys == nil {
		s.editorKeys = make(map[string]*vault.Key)
	}
	s.editorKeys[id].Forget()
	s.editorKeys[id] = key
}

func openNoteContents(key *vault.Key, env *vault.Envelope, id string) ([]byte, error) {
	plain, err := key.Open(env, id)
	if err != nil {
		return nil, err
	}
	if !validNote(id, plain) {
		clear(plain)
		return nil, vault.ErrCorrupt
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

// UnlockFor selects the lifetime at the password prompt: zero for this
// visit, -1 for this workspace session, or a fixed number of minutes.
// canUnlock checks the caller's session before and after decrypting.
func (s *NoteKeys) UnlockFor(spaceID, id, sealed, password string, minutes int, canUnlock func() bool) (UnlockedNote, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if spaceID == "" || minutes < -1 || minutes > 1440 {
		return UnlockedNote{}, vault.ErrInvalid
	}
	plain, err := s.readSealedNote(id, sealed, password, true, canUnlock)
	if err != nil {
		return UnlockedNote{}, err
	}
	if minutes == 0 {
		return UnlockedNote{Plain: plain}, nil
	}
	if s.rememberedNotes == nil {
		s.rememberedNotes = make(map[string]*rememberedNote)
	}
	g := &rememberedNote{spaceID: spaceID, key: s.editorKeys[id].Clone()}
	s.rememberedNotes[id] = g
	if minutes > 0 {
		g.until = time.Now().Add(time.Duration(minutes) * time.Minute)
		g.timer = time.AfterFunc(time.Until(g.until), func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.rememberedNotes[id] == g {
				s.forgetRememberedNote(id)
			}
		})
	}
	return g.result(plain), nil
}

// Resume opens the current ciphertext, including edits synced by another
// device. Reopening a note never extends its original deadline.
func (s *NoteKeys) Resume(spaceID, id, sealed string, canUnlock func() bool) (UnlockedNote, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.rememberedNotes[id]
	if !canUnlock() || g == nil || g.spaceID != spaceID {
		return UnlockedNote{}, vault.ErrLocked
	}
	if g.expired() {
		s.forgetRememberedNote(id)
		return UnlockedNote{}, vault.ErrLocked
	}
	env, err := vault.ParseEnvelope([]byte(sealed), vault.NoteScope)
	if err != nil {
		s.forgetRememberedNote(id)
		return UnlockedNote{}, err
	}
	plain, err := openNoteContents(g.key, env, id)
	if err != nil {
		s.forgetRememberedNote(id)
		if errors.Is(err, vault.ErrPassword) {
			return UnlockedNote{}, vault.ErrLocked // Includes a fresh salt after a password change.
		}
		return UnlockedNote{}, err
	}
	defer clear(plain)
	if !canUnlock() || g.expired() {
		s.forgetRememberedNote(id)
		return UnlockedNote{}, vault.ErrLocked
	}
	s.cacheNoteKey(id, g.key.Clone())
	return g.result(string(plain)), nil
}

// CloseEditor runs after the final encrypted save. A normal trip back to
// the map leaves only the optional grant that was chosen at unlock.
func (s *NoteKeys) CloseEditor(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeNoteEditor(id)
}

func (s *NoteKeys) forgetRememberedNote(id string) {
	if g := s.rememberedNotes[id]; g != nil {
		if g.timer != nil {
			g.timer.Stop()
		}
		g.key.Forget()
		delete(s.rememberedNotes, id)
	}
}

func (s *NoteKeys) forgetRememberedNotes() {
	for id := range s.rememberedNotes {
		s.forgetRememberedNote(id)
	}
}

// ForgetRemembered also works while an editor finishes its last save.
func (s *NoteKeys) ForgetRemembered() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.forgetRememberedNotes()
}

func (s *NoteKeys) Protect(id, payload, password string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := []byte(payload)
	defer clear(data)
	if !validNote(id, data) {
		return "", vault.ErrInvalid
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
	s.forgetRememberedNote(id)
	s.cacheNoteKey(id, key)
	return string(sealed), nil
}

func (s *NoteKeys) Unlock(id, sealed, password string, canUnlock func() bool) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readSealedNote(id, sealed, password, true, canUnlock)
}

// Preview reads a historical copy without granting an editor session access
// or replacing the key used to save another version of the same note.
func (s *NoteKeys) Preview(id, sealed, password string, canUnlock func() bool) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readSealedNote(id, sealed, password, false, canUnlock)
}

// The caller holds mu. A preview never changes the live editor or a remembered key.
func (s *NoteKeys) readSealedNote(id, sealed, password string, keepKey bool, canUnlock func() bool) (string, error) {
	if !canUnlock() {
		return "", vault.ErrLocked
	}
	if id == "" {
		return "", vault.ErrInvalid
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
	if !canUnlock() {
		key.Forget()
		return "", vault.ErrLocked
	}
	if keepKey {
		s.forgetRememberedNote(id)
		s.cacheNoteKey(id, key)
	} else {
		key.Forget()
	}
	return string(plain), nil
}

func (s *NoteKeys) Seal(id, payload string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.editorKeys[id]
	if key == nil {
		return "", vault.ErrLocked
	}
	data := []byte(payload)
	defer clear(data)
	if !validNote(id, data) {
		return "", vault.ErrInvalid
	}
	sealed, err := key.Seal(vault.NoteScope, id, data)
	return string(sealed), err
}

// Clear revokes all note access and stops any grant timers.
func (s *NoteKeys) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.forgetRememberedNotes()
	for _, key := range s.editorKeys {
		key.Forget()
	}
	clear(s.editorKeys)
}

func (s *NoteKeys) Lock(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.forgetRememberedNote(id)
	s.closeNoteEditor(id)
}

func (s *NoteKeys) closeNoteEditor(id string) {
	s.editorKeys[id].Forget()
	delete(s.editorKeys, id)
}
