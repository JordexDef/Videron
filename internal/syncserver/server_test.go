package syncserver

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func openTestStore(t *testing.T, root *os.Root) *store {
	t.Helper()
	s, err := openStore(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.root.Close() })
	return s
}
func testRoot(t *testing.T) *os.Root {
	t.Helper()
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	return root
}

func TestPairingAndExclusiveOwnership(t *testing.T) {
	root := testRoot(t)
	a, err := newIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if err = a.save(root); err != nil {
		t.Fatal(err)
	}
	r1, err := lockServer(root)
	if err != nil {
		t.Fatal(err)
	}
	defer r1.Close()
	if r2, err := lockServer(root); err == nil {
		r2.Close()
		t.Fatal("second writer acquired the lock")
	}
	var out, logs bytes.Buffer
	if err := Run([]string{"-pair", "-public", "https://notes.example:444", "-data", root.Name()}, &out, &logs); err != nil {
		t.Fatal(err)
	}
	if out.String() != a.pairing("notes.example:444")+"\n" || logs.Len() != 0 {
		t.Fatal("bad pairing output")
	}
	info, _ := os.Stat(filepath.Join(root.Name(), "identity.json"))
	if !info.Mode().IsRegular() {
		t.Fatal("invalid identity")
	}
	for _, bad := range []string{"http://example", "https://example/path", "https://user:pass@example", "https://example#secret", "https://example:999999", "https://example?a=1"} {
		if _, err := endpoints(":8743", bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestPublicLanding(t *testing.T) {
	h := &service{store: openTestStore(t, testRoot(t)), token: strings.Repeat("9", 64)}
	call := func(method, path, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	get := call("GET", "/", "")
	if get.Code != 200 || !strings.Contains(get.Body.String(), `src="/landing.js"`) || get.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatal("expected the public Videron page", get.Code)
	}
	if !strings.Contains(get.Header().Get("Content-Security-Policy"), "script-src 'self';") {
		t.Fatal("page must permit its same-origin script")
	}
	script := call("GET", "/landing.js", "")
	if script.Code != 200 || !bytes.Equal(script.Body.Bytes(), landingScript) || script.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Fatal("expected the embedded landing page script")
	}
	head := call("HEAD", "/", "")
	size := strconv.Itoa(get.Body.Len())
	if head.Code != 200 || head.Body.Len() != 0 || head.Header().Get("Content-Length") != size || get.Header().Get("Content-Length") != size {
		t.Fatal("HEAD must describe the full page with an empty body")
	}
	if post := call("POST", "/", ""); post.Code != 405 || post.Header().Get("Allow") != "GET, HEAD" {
		t.Fatal("expected method restriction on the public landing")
	}
	for _, path := range []string{"/v1/index", "/v1/events", "/v1/main", "/v1/file", "/landing.html", "/identity.json", "//", "/./"} {
		if w := call("GET", path, ""); w.Code != 401 || w.Header().Get("WWW-Authenticate") == "" {
			t.Errorf("GET %s without credentials returned %d", path, w.Code)
		}
	}
	if w := call("GET", "/landing.html", h.token); w.Code != 404 {
		t.Errorf("GET /landing.html with valid credentials returned %d", w.Code)
	}
}

func TestLandingOff(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler http.Handler
	}{
		{"native", &service{landing: landingOff}},
		{"gateway", tunnelWeb{landing: landingOff}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewTLSServer(tc.handler)
			defer srv.Close()
			for _, path := range []string{"/", "/landing.js", "/favicon.ico", "/v1/unknown"} {
				for _, method := range []string{"GET", "HEAD", "POST", "OPTIONS", "DELETE"} {
					req, err := http.NewRequest(method, srv.URL+path, nil)
					if err != nil {
						t.Fatal(err)
					}
					resp, err := srv.Client().Do(req)
					if err != nil {
						t.Fatal(err)
					}
					body, err := io.ReadAll(resp.Body)
					resp.Body.Close()
					want := "404 page not found\n"
					if method == "HEAD" {
						want = ""
					}
					if err != nil || resp.StatusCode != 404 || resp.Header.Get("WWW-Authenticate") != "" || string(body) != want {
						t.Errorf("%s %s returned %d %q, %v", method, path, resp.StatusCode, body, err)
					}
					if resp.Header.Get("Cache-Control") != "no-store" {
						t.Errorf("%s %s may cache the disabled landing page", method, path)
					}
				}
			}
		})
	}
}

func TestLandingConfiguration(t *testing.T) {
	for _, tc := range []struct {
		env, flag string
		valid     bool
	}{
		{"", "", true}, {"off", "", true}, {"interactive", "", true},
		{"unknown", "", false}, {"unknown", "off", true}, {"off", "unknown", false},
	} {
		t.Setenv("VIDERON_LANDING", tc.env)
		args := []string{"-password-status", "-data", t.TempDir()}
		if tc.flag != "" {
			args = append(args, "-landing", tc.flag)
		}
		err := Run(args, io.Discard, io.Discard)
		if (err == nil) != tc.valid || (err != nil && !strings.Contains(err.Error(), "-landing")) {
			t.Errorf("env=%q flag=%q returned %v", tc.env, tc.flag, err)
		}
	}
}

func TestServerCAS(t *testing.T) {
	root := testRoot(t)
	s := openTestStore(t, root)
	token := strings.Repeat("9", 64)
	srv := httptest.NewTLSServer(&service{store: s, token: token})
	defer srv.Close()
	lin := strings.Repeat("a", 64)
	ver := strings.Repeat("c", 64)
	main := "/v1/main"
	path := ".videron-sync/" + lin + "/objects/" + ver + ".json"
	blob := "/v1/file?path=" + url.QueryEscape(path)
	call := func(method, uri, body, pre, lineage string) (int, string, string) {
		t.Helper()
		req, err := http.NewRequest(method, srv.URL+uri, strings.NewReader(body))
		if err != nil {
			t.Error(err)
			return 0, "", ""
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if pre == "*" {
			req.Header.Set("If-None-Match", pre)
		} else if pre != "" {
			req.Header.Set("If-Match", pre)
		}
		if lineage != "" {
			req.Header.Set("X-Videron-Lineage", lineage)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Error(err)
			return 0, "", ""
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Error(err)
			return 0, "", ""
		}
		return resp.StatusCode, string(b), resp.Header.Get("ETag")
	}
	if code, _, _ := call("GET", main, "", "", ""); code != 404 {
		t.Fatalf("main before bootstrap: %d", code)
	}
	if code, _, _ := call("PUT", blob, "x", "*", ""); code != 409 {
		t.Fatal("accepted upload without bootstrap")
	}
	if code, _, _ := call("PUT", main, "hello", "", ""); code != 400 {
		t.Fatal("accepted missing lineage")
	}
	if code, _, _ := call("PUT", main, "hello", "", lin); code != 428 {
		t.Fatal("accepted missing precondition")
	}
	code, _, etag := call("PUT", main, "hello", "*", lin)
	if code != 204 || etag != fmt.Sprintf("\"%x\"", sha256.Sum256([]byte("hello"))) {
		t.Fatalf("bootstrap status=%d etag=%q", code, etag)
	}
	if code, _, _ := call("PUT", main, "no", "*", lin); code != 412 {
		t.Fatal("reinitialized main")
	}
	if code, _, _ := call("PUT", main, "no", etag, strings.Repeat("e", 64)); code != 409 {
		t.Fatal("accepted a different lineage")
	}
	const peers = 8
	var wg sync.WaitGroup
	results := make(chan int, peers)
	for n := 0; n < peers; n++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); c, _, _ := call("PUT", blob, fmt.Sprint(i), "*", ""); results <- c }(n)
	}
	wg.Wait()
	close(results)
	winners := 0
	for c := range results {
		if c == 204 {
			winners++
		} else if c != 412 {
			t.Fatalf("unexpected raced put status %d", c)
		}
	}
	if winners != 1 {
		t.Fatalf("publish winners %d", winners)
	}
	code, body, etag := call("GET", blob, "", "", "")
	if code != 200 || len(body) != 1 {
		t.Fatal("missing uploaded object")
	}
	if code, _, _ := call("PUT", blob, "replacement", etag, ""); code != 409 {
		t.Fatal("overwrote immutable version")
	}
	_, raw, _ := call("GET", "/v1/index", "", "", "")
	var index struct {
		Main, Lineage string
		Files         map[string]string
	}
	if err := json.Unmarshal([]byte(raw), &index); err != nil {
		t.Fatal(err)
	}
	if index.Lineage != lin || index.Main == "" || len(index.Files) != 1 || index.Files[path] != strings.Trim(etag, "\"") {
		t.Fatalf("bad index %s", raw)
	}
	restart := openTestStore(t, root)
	if restart.files[path] != index.Files[path] || restart.main != index.Main || restart.lineage != lin {
		t.Fatal("restart changed index")
	}
	for _, p := range []string{"../identity.json", path + "/..", strings.Replace(path, "/objects/", "/../", 1), "server.lock"} {
		if code, _, _ := call("PUT", "/v1/file?path="+url.QueryEscape(p), "x", "*", ""); code != 400 {
			t.Fatalf("accepted %s", p)
		}
	}
	resp, err := srv.Client().Get(srv.URL + "/v1/index")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("unpaired reader got access")
	}
}

// Reports when an HTTP handler has captured the cursor and is about to wait.
type subscribed struct {
	context.Context
	ready chan struct{}
	once  sync.Once
}

func (s *subscribed) Done() <-chan struct{} {
	s.once.Do(func() { close(s.ready) })
	return s.Context.Done()
}

func TestRevisionEvents(t *testing.T) {
	root := testRoot(t)
	s := openTestStore(t, root)
	h := &service{store: s, token: strings.Repeat("5", 64)}
	lineage := strings.Repeat("a", 64)
	call := func(ctx context.Context, method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
		r.Header.Set("Authorization", "Bearer "+h.token)
		if method == "PUT" {
			r.Header.Set("X-Videron-Lineage", lineage)
			r.Header.Set("If-None-Match", "*")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	bg := context.Background()
	if w := call(bg, "PUT", "/v1/main", "bootstrap"); w.Code != 204 {
		t.Fatal(w.Code)
	}
	parse := func(w *httptest.ResponseRecorder) string {
		t.Helper()
		var result struct{ Cursor string }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Cursor == "" {
			t.Fatalf("missing cursor: %v", w)
		}
		return result.Cursor
	}
	first := parse(call(bg, "GET", "/v1/index", ""))
	if first != parse(call(bg, "GET", "/v1/events", "")) {
		t.Fatal("empty cursor should read immediately")
	}
	done := make(chan *httptest.ResponseRecorder, 2)
	for i := 0; i < 2; i++ {
		wait := &subscribed{Context: bg, ready: make(chan struct{})}
		go func() { done <- call(wait, "GET", "/v1/events?since="+first, "") }()
		select {
		case <-wait.ready:
		case <-time.After(2 * time.Second):
			t.Fatal("client never subscribed")
		}
	}
	// Staging objects alone must not announce an incomplete revision.
	base := "/v1/file?path=.videron-sync/" + lineage + "/"
	name := strings.Repeat("b", 64) + ".json"
	if w := call(bg, "PUT", base+"objects/"+name, "object"); w.Code != 204 {
		t.Fatal(w.Code)
	}
	staged := call(bg, "GET", "/v1/index", "")
	if cursor := parse(staged); cursor != first {
		t.Fatal("premature event")
	}
	var index struct{ Files map[string]string }
	if err := json.Unmarshal(staged.Body.Bytes(), &index); err != nil || index.Files[".videron-sync/"+lineage+"/objects/"+name] == "" {
		t.Fatal("staged object missing from index before revision publication", err)
	}
	if w := call(bg, "PUT", base+"revisions/"+name, "revision"); w.Code != 204 {
		t.Fatal(w.Code)
	}
	next := parse(call(bg, "GET", "/v1/index", ""))
	if next == first {
		t.Fatal("cursor unchanged")
	}
	for i := 0; i < 2; i++ {
		select {
		case w := <-done:
			if parse(w) != next {
				t.Fatal("listener missed revision")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("waiting for heartbeat instead of push")
		}
	}
	if next != parse(call(bg, "GET", "/v1/events?since="+first, "")) {
		t.Fatal("stale cursor lost update")
	}
	ctx, cancel := context.WithCancel(bg)
	wait := &subscribed{Context: ctx, ready: make(chan struct{})}
	go func() { done <- call(wait, "GET", "/v1/events?since="+next, "") }()
	<-wait.ready
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("client cancellation ignored")
	}
	if other := openTestStore(t, root); other.cursor == next {
		t.Fatal("restart should invalidate pending cursors")
	}
}
