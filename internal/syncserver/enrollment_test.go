package syncserver

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"videron/internal/syncauth"
)

func TestPasswordSetupAndRotation(t *testing.T) {
	root := testRoot(t)
	run := func(flags []string, input string) (string, error) {
		t.Helper()
		var out, logs bytes.Buffer
		err := RunWithInput(append(flags, "-data", root.Name()), strings.NewReader(input), &out, &logs)
		if logs.Len() != 0 {
			t.Fatal("unexpected credential command output on stderr")
		}
		return out.String(), err
	}
	checkStatus := func(want string) {
		t.Helper()
		got, err := run([]string{"-password-status"}, "")
		if err != nil || got != want+"\n" {
			t.Fatalf("incorrect password status: %v", err)
		}
	}
	set := func(password string) *identity {
		t.Helper()
		out, err := run([]string{"-set-password"}, password+"\r\n")
		if err != nil || out != "" {
			t.Fatalf("password setup failed or wrote to stdout: %v", err)
		}
		id, err := loadIdentity(root)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	checkStatus("unset")
	if _, err := run(nil, ""); err == nil {
		t.Fatal("new server started without local password setup")
	}
	for _, invalid := range []string{"", "    \n", "a\nb\n", "a\n\r\n", strings.Repeat("a", 1025)} {
		if _, err := run([]string{"-set-password"}, invalid); err == nil {
			t.Fatal("accepted an invalid password")
		}
	}
	if _, err := root.Stat("identity.json"); !os.IsNotExist(err) {
		t.Fatal("failed setup published an identity")
	}
	// Start from an identity written by an earlier release.
	legacy, err := newIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if err := legacy.save(root); err != nil {
		t.Fatal(err)
	}
	checkStatus("unset")
	store := openTestStore(t, root)
	main := "main-" + strings.Repeat("c", 64)
	if err = os.WriteFile(filepath.Join(store.root.Name(), main), []byte("original space"), 0600); err != nil {
		t.Fatal(err)
	}
	first := set("a sample enrollment password")
	checkStatus("configured")
	if first.pairing("host:8743") != legacy.pairing("host:8743") {
		t.Fatal("first password setup invalidated legacy pairings")
	}
	second := set(" a different enrollment password ")
	if legacy.pin() != second.pin() || !bytes.Equal(legacy.Key, second.Key) {
		t.Fatal("rotation changed the TLS identity")
	}
	pair, err := run([]string{"-pair", "-public", "host:8743"}, "")
	if err != nil || pair != second.pairing("host:8743")+"\n" || pair == first.pairing("host:8743")+"\n" || second.Token == second.Password.Token {
		t.Fatal("rotation failed to issue a fresh pairing code")
	}
	raw, err := os.ReadFile(filepath.Join(root.Name(), "identity.json"))
	if err != nil || bytes.Contains(raw, []byte("enrollment password")) {
		t.Fatal("password was not stored as a registration record")
	}
	info, err := store.root.ReadFile(main)
	if err != nil || string(info) != "original space" {
		t.Fatal("rotation affected stored space")
	}
	e, err := second.enrollment()
	if err != nil {
		t.Fatal(err)
	}
	h := &service{store: store, token: second.Token, enrollment: e}
	for _, entry := range []struct {
		token string
		want  int
	}{{legacy.Token, 401}, {first.Password.Token, 401}, {second.Token, 200}, {second.Password.Token, 200}, {"", 401}} {
		r := httptest.NewRequest("GET", "https://host/v1/index", nil)
		r.Header.Set("Authorization", "Bearer "+entry.token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != entry.want {
			t.Errorf("unexpected bearer status: %d", w.Code)
		}
	}
}

func TestEnrollmentChecksPasswordPinAndSingleUseProof(t *testing.T) {
	dir := t.TempDir()
	const password = " a single server password "
	if err := RunWithInput([]string{"-set-password", "-data", dir}, strings.NewReader(password+"\n"), io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	id, err := loadIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	enroll, err := id.enrollment()
	if err != nil {
		t.Fatal(err)
	}
	h := &service{token: id.Token, enrollment: enroll}
	post := func(route string, input authMessage) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("POST", "https://host/v1/auth/"+route, bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	start := func(pw, pin string) (authMessage, error) {
		t.Helper()
		c, ke1, err := syncauth.Begin(pw)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		w := post("start", authMessage{Message: ke1})
		var response authMessage
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || !hexID.MatchString(response.Session) {
			t.Fatal("enrollment start failed")
		}
		response.Message, err = c.Finish(response.Message, pin)
		return response, err
	}
	for _, bad := range []struct{ password, pin string }{
		{strings.TrimSpace(password), id.pin()},
		{password, strings.Repeat("a", 64)},
	} {
		if _, err := start(bad.password, bad.pin); err == nil {
			t.Fatal("authenticated an incorrect password or substituted certificate")
		}
	}
	proof, err := start(password, id.pin())
	if err != nil {
		t.Fatal(err)
	}
	w := post("finish", proof)
	var response struct{ Token string }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Token != enroll.token || response.Token == id.Token {
		t.Fatal("expected only the enrollment bearer")
	}
	if w = post("finish", proof); w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), response.Token) {
		t.Fatal("accepted a replayed proof or disclosed the token")
	}
	proof, err = start(password, id.pin())
	if err != nil {
		t.Fatal(err)
	}
	entry := enroll.pending[proof.Session]
	entry.expires = time.Now().Add(-time.Second)
	enroll.pending[proof.Session] = entry
	if post("finish", proof).Code != http.StatusUnauthorized {
		t.Fatal("accepted an expired session")
	}
	proof, err = start(password, id.pin())
	if err != nil {
		t.Fatal(err)
	}
	proof.Message[0] ^= 1
	if post("finish", proof).Code != http.StatusUnauthorized {
		t.Fatal("accepted a modified client proof")
	}
	proof.Message[0] ^= 1
	if post("finish", proof).Code != http.StatusUnauthorized {
		t.Fatal("accepted a second attempt for a spent session")
	}
}

func TestEnrollmentLimitsUnauthenticatedWork(t *testing.T) {
	e := &enrollment{pending: make(map[string]challenge)}
	now := time.Now()
	for i := 0; i < 10; i++ {
		if !e.admit(now) {
			t.Fatal("first ten attempts should be allowed")
		}
	}
	h := &service{enrollment: e}
	req := httptest.NewRequest("POST", "https://host/v1/auth/start", strings.NewReader("{}"))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal("missing throttle for unauthenticated enrollment")
	}
	e.pending["expired"] = challenge{now, []byte("mac")}
	if !e.admit(now.Add(time.Minute)) || len(e.pending) != 0 {
		t.Fatal("expired attempt or challenge was retained")
	}
	req = httptest.NewRequest("POST", "http://host/v1/auth/start", strings.NewReader("{}"))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("accepted plaintext enrollment")
	}
}
