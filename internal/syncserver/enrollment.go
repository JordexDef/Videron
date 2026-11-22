package syncserver

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"videron/internal/syncauth"
)

type challenge struct {
	expires time.Time
	mac     []byte
}

type enrollment struct {
	verifier *syncauth.Verifier
	token    string
	mu       sync.Mutex
	attempts []time.Time
	pending  map[string]challenge
}

func (id *identity) enrollment() (*enrollment, error) {
	if id.Password == nil {
		return nil, nil
	}
	if !hexID.MatchString(id.Password.Token) {
		return nil, errors.New("invalid enrollment token in identity.json")
	}
	verifier, err := id.Password.Registration.Open(id.pin())
	if err != nil {
		return nil, errors.New("invalid password registration in identity.json")
	}
	return &enrollment{verifier: verifier, token: id.Password.Token, pending: make(map[string]challenge)}, nil
}

// Throttle the single shared password across all entry points, including
// proxied connections whose original IP cannot be trusted. Count KE1, as an
// incorrect password is detectable by the client before it sends KE3.
func (e *enrollment) admit(now time.Time) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for session, entry := range e.pending {
		if !entry.expires.After(now) {
			clear(entry.mac)
			delete(e.pending, session)
		}
	}
	for len(e.attempts) > 0 && !e.attempts[0].After(now.Add(-time.Minute)) {
		e.attempts = e.attempts[1:]
	}
	if len(e.attempts) >= 10 {
		return false
	}
	e.attempts = append(e.attempts, now)
	return true
}

type authMessage struct {
	Session string `json:"session,omitempty"`
	Message []byte `json:"message"`
}

func (e *enrollment) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.TLS == nil || e == nil {
		http.Error(w, "authentication unavailable", http.StatusUnauthorized)
		return
	}
	var input authMessage
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<10))
	if err != nil || json.Unmarshal(body, &input) != nil {
		http.Error(w, "invalid authentication message", http.StatusBadRequest)
		return
	}
	if r.URL.Path == "/v1/auth/start" {
		if !e.admit(time.Now()) {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "too many authentication attempts", http.StatusTooManyRequests)
			return
		}
		reply, mac, err := e.verifier.Start(input.Message)
		if err != nil {
			http.Error(w, "invalid authentication message", http.StatusBadRequest)
			return
		}
		var nonce [32]byte
		rand.Read(nonce[:])
		session := hex.EncodeToString(nonce[:])
		e.mu.Lock()
		e.pending[session] = challenge{time.Now().Add(time.Minute), mac}
		e.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(authMessage{session, reply})
		return
	}
	e.mu.Lock()
	ch, ok := e.pending[input.Session]
	delete(e.pending, input.Session)
	e.mu.Unlock()
	defer clear(ch.mac)
	if !ok || !ch.expires.After(time.Now()) || !e.verifier.Finish(input.Message, ch.mac) {
		http.Error(w, "authentication failed", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Token string `json:"token"`
	}{e.token})
}
