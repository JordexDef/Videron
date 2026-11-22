package syncserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProjectCatalogAndReplication(t *testing.T) {
	root := testRoot(t)
	newService := func() *service {
		c, err := openProjectCatalog(root)
		if err != nil {
			t.Fatal(err)
		}
		return &service{token: "test-access", projects: c}
	}
	h := newService()
	lin, a, b := strings.Repeat("c", 64), strings.Repeat("a", 64), strings.Repeat("b", 64)
	const list = "/v1/projects"
	call := func(method, path, scope, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer test-access")
		if method == "PUT" {
			r.Header.Set("X-Videron-Lineage", lin)
			r.Header.Set("If-None-Match", "*")
		}
		if scope != "" {
			r.Header.Set("X-Videron-Project", scope)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, w.Code, want, w.Body.String())
		}
		return w
	}
	checkList := func(want ...projectInfo) {
		t.Helper()
		var got []projectInfo
		r := call("GET", list, "", "", 200)
		if err := json.Unmarshal(r.Body.Bytes(), &got); err != nil || len(got) != len(want) {
			t.Fatalf("wrong catalog %s", r.Body)
		}
		for i, item := range got {
			if item != want[i] {
				t.Fatalf("wrong catalog %s", r.Body)
			}
		}
	}
	body := func(id, name string) string {
		raw, _ := json.Marshal(projectInfo{id, name})
		return string(raw)
	}
	// Start with data written by an existing client. A catalog query reveals
	// no metadata until the usual authentication has completed.
	call("PUT", "/v1/main", "", "original", 204)
	for _, mode := range []landingMode{landingInteractive, landingOff} {
		h.landing = mode
		got := httptest.NewRecorder()
		h.ServeHTTP(got, httptest.NewRequest("GET", list, nil))
		if got.Code != http.StatusUnauthorized {
			t.Fatalf("unpaired client received %d", got.Code)
		}
	}
	checkList(projectInfo{})
	call("POST", list, "", body(a, "  Рабочие  "), 201)
	call("POST", list, "", body(a, "Рабочие"), 200)
	call("POST", list, "", body(b, "рабочие"), 409)
	call("POST", list, "", body(a, "Other"), 409)
	call("POST", list, "", body(b, "Home"), 201)
	checkList(projectInfo{}, projectInfo{b, "Home"}, projectInfo{a, "Рабочие"})
	call("POST", list, "", body(lin, "\n  "), 400)
	call("POST", list, "", body(lin, strings.Repeat("界", 81)), 400)
	call("POST", list, "", body(lin, "one\ntwo"), 400)
	call("POST", list, "", body("../elsewhere", "Unexpected"), 400)
	call("GET", "/v1/projects/"+lin+"/index", "", "", 404)
	call("GET", "/v1/index", lin, "", 404)
	call("GET", "/v1/projects/"+a+"/main", b, "", 400)
	call("GET", "/v1/projects/"+a+"/main", "", "", 404)
	call("GET", "/v1/main", b, "", 404)
	call("PUT", "/v1/projects/"+a+"/main", "", "notes a", 204)
	if call("GET", "/v1/main", a, "", 200).Header().Get("X-Videron-Project") != a {
		t.Fatal("missing scope confirmation")
	}
	call("PUT", "/v1/main", b, "notes b", 204)
	file := "file?path=.videron-sync/" + lin + "/revisions/" + lin + ".json"
	events := func(id string) string {
		t.Helper()
		var event struct{ Cursor string }
		r := call("GET", "/v1/events", id, "", 200)
		if json.Unmarshal(r.Body.Bytes(), &event) != nil || event.Cursor == "" {
			t.Fatal("missing event cursor")
		}
		return event.Cursor
	}
	beforeA, beforeB, beforeDefault := events(a), events(b), events("")
	call("PUT", "/v1/projects/"+a+"/"+file, a, "a revision", 204)
	if events(a) == beforeA || events(b) != beforeB || events("") != beforeDefault {
		t.Fatal("revision notification escaped its project")
	}
	call("GET", "/v1/"+file, b, "", 404)
	call("GET", "/v1/"+file, "", "", 404)
	call("PUT", "/v1/"+file, b, "b revision", 204)

	h.projects.close()
	h = newService()
	defer h.projects.close()
	checkList(projectInfo{}, projectInfo{b, "Home"}, projectInfo{a, "Рабочие"})
	for id, want := range map[string]string{"": "original", a: "notes a", b: "notes b"} {
		if got := call("GET", "/v1/main", id, "", 200).Body.String(); got != want {
			t.Fatalf("wrong bootstrap for %q: %s", id, got)
		}
	}
	for id, want := range map[string]string{a: "a revision", b: "b revision"} {
		if got := call("GET", "/v1/projects/"+id+"/"+file, "", "", 200).Body.String(); got != want {
			t.Fatalf("wrong revision for %s", id)
		}
	}
}

func TestConcurrentProjectCreationAndRestart(t *testing.T) {
	root := testRoot(t)
	c, err := openProjectCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	info := projectInfo{strings.Repeat("a", 64), "Project"}
	var wg sync.WaitGroup
	const clients = 16
	results := make(chan int, clients)
	for range clients {
		wg.Go(func() {
			status, err := c.create(info)
			if err != nil {
				t.Error(err)
			}
			results <- status
		})
	}
	wg.Wait()
	close(results)
	count := map[int]int{}
	for status := range results {
		count[status]++
	}
	if count[201] != 1 || count[200] != clients-1 {
		t.Fatal(count)
	}
	if err := c.root.Mkdir(".creating-interrupted", 0700); err != nil {
		t.Fatal(err)
	}
	c.close()
	reopened, err := openProjectCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	if got := reopened.list(false); len(got) != 2 || got[1] != info {
		t.Fatalf("wrong project list after restart: %v", got)
	}
	// Losing a published project's directory must not recreate it as an empty space.
	if err := reopened.root.Rename(info.ID, ".missing-fixture"); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.acquire(info.ID); err == nil {
		t.Fatal("replaced a missing project with an empty store")
	}
}

func TestProjectRenameAndDeletionLifecycle(t *testing.T) {
	root := testRoot(t)
	open := func() *service {
		c, err := openProjectCatalog(root)
		if err != nil {
			t.Fatal(err)
		}
		return &service{projects: c, token: "access"}
	}
	h := open()
	defer func() { h.projects.close() }()
	const projects = "/v1/projects"
	id := strings.Repeat("1", 64)
	another := strings.Repeat("2", 64)
	lin := strings.Repeat("a", 64)
	named := projects + "/" + id
	req := func(method, path, body string) *http.Request {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer access")
		r.Header.Set("X-Videron-Catalog-Version", "2")
		if method == "PUT" {
			r.Header.Set("If-None-Match", "*")
			r.Header.Set("X-Videron-Lineage", lin)
		}
		return r
	}
	do := func(r *http.Request, want int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s: expected %d, got %d %s", r.Method, r.URL, want, w.Code, w.Body.String())
		}
		return w
	}
	call := func(method, path, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		return do(req(method, path, body), want)
	}
	create := func(id, name string, want int) {
		t.Helper()
		raw, _ := json.Marshal(projectInfo{id, name})
		w := call("POST", projects, string(raw), want)
		if want == http.StatusGone && (w.Header().Get("X-Videron-Project-Deleted") != "1" || w.Header().Get("X-Videron-Project") != id) {
			t.Fatal("retired project creation retry lacks scope confirmation")
		}
	}
	index := func(path string) (string, string, string) {
		t.Helper()
		w := call("GET", path, "", 200)
		var v struct {
			Cursor, Main string
			ProjectName  *string
		}
		if json.Unmarshal(w.Body.Bytes(), &v) != nil || v.ProjectName == nil || v.Cursor == "" {
			t.Fatalf("invalid index: %s", w.Body)
		}
		return v.Cursor, v.Main, *v.ProjectName
	}
	create(id, "Draft", 201)
	call("PUT", "/v1/main", "existing default", 204)
	call("PUT", named+"/main", "named data", 204)
	before, main, _ := index(named + "/index")
	change := `{"expectedName":"Draft","name":"Идеи"}`
	r := req("PATCH", named, change)
	r.Header.Del("Authorization")
	do(r, 401)
	r = req("DELETE", projects+"/default", `{"expectedName":""}`)
	r.Header.Set("X-Videron-Project", id)
	do(r, 400)
	call("DELETE", named, `{}`, 400)
	call("PATCH", named, `{"expectedName":"Draft","name":""}`, 400)
	call("PATCH", named, change, 200)
	after, current, name := index(named + "/index")
	if after == before || current != main || name != "Идеи" {
		t.Fatal("rename failed to preserve data or notify peers")
	}
	call("PATCH", named, change, 200)
	call("DELETE", named, `{"expectedName":"Draft"}`, 412)
	call("PATCH", projects+"/default", `{"expectedName":"","name":"идеи"}`, 409)
	call("PATCH", projects+"/default", `{"expectedName":"","name":"Main renamed"}`, 200)
	call("PATCH", named, `{"expectedName":"Draft","name":"Late"}`, 412)
	h.projects.close()
	h = open()
	if _, hash, name := index(named + "/index"); hash != main || name != "Идеи" {
		t.Fatal("named rename lost across restart")
	}
	if _, _, name := index("/v1/index"); name != "Main renamed" {
		t.Fatal("default rename lost across restart")
	}
	if _, err := root.Lstat("space/main-" + lin); err != nil {
		t.Fatal(err)
	}
	call("DELETE", named, `{"expectedName":"Идеи"}`, 204)
	call("DELETE", named, `{"expectedName":"Идеи"}`, 204)
	if _, err := root.Lstat("projects/" + id); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("deleted bytes retained", err)
	}
	w := call("GET", named+"/index", "", 410)
	if w.Header().Get("X-Videron-Project-Deleted") != "1" || w.Header().Get("X-Videron-Project") != id {
		t.Fatal("missing scope confirmation")
	}
	call("PUT", named+"/main", "stale client", 410)
	create(id, "Draft", 410)
	create(another, "Идеи", 201)
	if w := call("GET", "/v1/main", "", 200); w.Body.String() != "existing default" {
		t.Fatal("default data changed")
	}
	call("DELETE", projects+"/default", `{"expectedName":"Main renamed"}`, 204)
	call("GET", "/v1/index", "", 410)
	call("GET", "/v1/events", "", 410)
	call("PUT", "/v1/main", "stale default", 410)
	legacy := req("GET", "/v1/index", "")
	legacy.Header.Del("X-Videron-Catalog-Version")
	if w := do(legacy, 200); !strings.Contains(w.Body.String(), `"files":{}`) {
		t.Fatal("legacy discovery failed")
	}
	if _, err := root.Lstat("space"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("default content retained", err)
	}
	call("DELETE", projects+"/"+another, `{"expectedName":"Идеи"}`, 204)
	h.projects.close()
	h = open()
	if w := call("GET", projects+"?version=2", "", 200); strings.TrimSpace(w.Body.String()) != "[]" || w.Header().Get("X-Videron-Project-Management") != "1" {
		t.Fatal("wrong empty catalog", w.Body)
	}
	if w := call("GET", projects, "", 200); !strings.Contains(w.Body.String(), `{"id":"","name":""}`) {
		t.Fatal("wrong legacy discovery catalog")
	}
	call("GET", "/v1/index", "", 410)
	create(id, "Draft", 410)
}

type blockedUpload struct {
	io.ReadCloser
	started chan struct{}
	once    sync.Once
}

type observingContext struct {
	context.Context
	entered chan struct{}
	once    sync.Once
}

func (c *observingContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.Context.Done()
}

func (b *blockedUpload) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	return b.ReadCloser.Read(p)
}

func TestProjectDeletionStopsActiveRequests(t *testing.T) {
	root := testRoot(t)
	c, err := openProjectCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	id := strings.Repeat("9", 64)
	if status, err := c.create(projectInfo{id, "Streaming"}); err != nil || status != 201 {
		t.Fatal(status, err)
	}
	h := service{projects: c, token: "test"}
	p, err := c.acquire(id)
	if err != nil {
		t.Fatal(err)
	}
	cursor := p.data.cursor
	p.active.Done()
	reader, writer := io.Pipe()
	defer writer.Close()
	body := &blockedUpload{ReadCloser: reader, started: make(chan struct{})}
	run := func(r *http.Request) <-chan int {
		done := make(chan int, 1)
		r.Header.Set("Authorization", "Bearer test")
		go func() { w := httptest.NewRecorder(); h.ServeHTTP(w, r); done <- w.Code }()
		return done
	}
	upload := httptest.NewRequest("PUT", "/v1/projects/"+id+"/main", body)
	upload.Header.Set("If-None-Match", "*")
	upload.Header.Set("X-Videron-Lineage", id)
	put := run(upload)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	select {
	case <-body.started:
	case <-ctx.Done():
		t.Fatal("upload did not begin")
	}
	watch := &observingContext{Context: ctx, entered: make(chan struct{})}
	events := run(httptest.NewRequest("GET", "/v1/projects/"+id+"/events?since="+cursor, nil).WithContext(watch))
	select {
	case <-watch.entered:
	case <-ctx.Done():
		t.Fatal("event listener did not begin waiting")
	}
	drop := run(httptest.NewRequest("DELETE", "/v1/projects/"+id, strings.NewReader(`{"expectedName":"Streaming"}`)))
	for _, reply := range []struct {
		done <-chan int
		want int
	}{{drop, 204}, {put, 410}, {events, 410}} {
		select {
		case status := <-reply.done:
			if status != reply.want {
				t.Fatal(status, reply.want)
			}
		case <-ctx.Done():
			t.Fatal("deletion left a request outstanding")
		}
	}
}

func TestProjectRestartFinishesRetiredDirectoryCleanup(t *testing.T) {
	root := testRoot(t)
	c, err := openProjectCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("0", 64)
	if status, err := c.create(projectInfo{id, "Project"}); err != nil || status != 201 {
		t.Fatal(status, err)
	}
	// Simulate termination between committing the marker and unlinking the payload.
	if err := writeProjectMetadata(c.root, ".deleted-"+id, ""); err != nil {
		t.Fatal(err)
	}
	c.close()
	reopened, err := openProjectCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	if _, err := root.Lstat("projects/" + id); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("retired payload remains", err)
	}
	if items := reopened.list(false); len(items) != 1 || items[0].ID != "" {
		t.Fatal(items)
	}
	if status, err := reopened.create(projectInfo{id, "Project"}); err != nil || status != 410 {
		t.Fatal(status, err)
	}
}
