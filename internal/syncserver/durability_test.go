package syncserver

import (
	"context"
	"errors"
	"io/fs"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestUploadDirectorySyncFailure(t *testing.T) {
	root := testRoot(t)
	s := openTestStore(t, root)
	h := &service{store: s, token: "temporary"}
	lineage := strings.Repeat("a", 64)
	call := func(method, path, body string, want int) string {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer temporary")
		if method == "PUT" {
			r.Header.Set("If-None-Match", "*")
			r.Header.Set("X-Videron-Lineage", lineage)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s returned %d, want %d", method, path, w.Code, want)
		}
		return w.Body.String()
	}
	failed := true
	s.durability.syncDir = func(r *os.Root, dir string) error {
		if failed {
			return fs.ErrPermission
		}
		return syncDirectory(r, dir)
	}
	call("PUT", "/v1/main", "test payload", 500)
	if _, err := s.root.Stat("main-" + lineage); err != nil {
		t.Fatal("rename should already be visible on disk", err)
	}
	call("GET", "/v1/index", "", 500)
	call("GET", "/v1/main", "", 500)
	call("GET", "/v1/events", "", 500)
	call("PUT", "/v1/main", "other payload", 500)
	failed = false
	if got := call("GET", "/v1/main", "", 200); got != "test payload" {
		t.Fatal("original publication was lost")
	}
	call("PUT", "/v1/main", "other payload", 412)
}

func TestCatalogDirectorySyncFailure(t *testing.T) {
	root := testRoot(t)
	c, err := openProjectCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	id := strings.Repeat("b", 64)
	info := projectInfo{id, "Initial name"}
	failDirectory := "."
	c.durability.syncDir = func(r *os.Root, dir string) error {
		if dir == failDirectory {
			return fs.ErrPermission
		}
		return syncDirectory(r, dir)
	}
	if _, err := c.create(info); !errors.Is(err, fs.ErrPermission) {
		t.Fatal("acknowledged a non-durable project", err)
	}
	if _, err := c.list(false); !errors.Is(err, fs.ErrPermission) {
		t.Fatal("listed project during failed publication", err)
	}
	failDirectory = ""
	if code, err := c.create(info); code != 200 || err != nil {
		t.Fatal("create retry", code, err)
	}
	failDirectory = id
	if _, err := c.rename(id, info.Name, "New name"); !errors.Is(err, fs.ErrPermission) {
		t.Fatal("failed to sync the renamed project's own directory", err)
	}
	if _, err := c.acquire(id); !errors.Is(err, fs.ErrPermission) {
		t.Fatal("opened project during failed rename", err)
	}
	failDirectory = ""
	if code, err := c.rename(id, info.Name, "New name"); code != 200 || err != nil {
		t.Fatal("rename retry", code, err)
	}
	p, err := c.acquire(id)
	if err != nil {
		t.Fatal(err)
	}
	poll := "/v1/projects/" + id + "/events?since=" + p.data.cursor
	p.active.Done()
	sub := &subscribed{Context: context.Background(), ready: make(chan struct{})}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", poll, nil).WithContext(sub)
	r.Header.Set("Authorization", "Bearer temporary")
	done := make(chan struct{})
	go func() {
		defer close(done)
		(&service{projects: c, token: "temporary"}).ServeHTTP(w, r)
	}()
	select {
	case <-sub.ready:
	case <-time.After(5 * time.Second):
		t.Fatal("poll did not start")
	}
	failDirectory = "."
	if _, err := c.remove(id, "New name"); !errors.Is(err, fs.ErrPermission) {
		t.Fatal("acknowledged a non-durable deletion", err)
	}
	if _, err := c.root.Stat(id + "/name"); err != nil {
		t.Fatal("discarded project before tombstone was durable", err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("poll did not end")
	}
	if w.Code != 500 || w.Header().Get("X-Videron-Project-Deleted") != "" {
		t.Fatalf("in-flight poll confirmed a non-durable deletion: %d", w.Code)
	}
	failDirectory = ""
	if code, err := c.remove(id, "New name"); code != 204 || err != nil {
		t.Fatal("delete retry", code, err)
	}
	if _, err := c.root.Stat(id); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("project cleanup", err)
	}
}
