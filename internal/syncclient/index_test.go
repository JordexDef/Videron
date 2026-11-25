package syncclient

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type uploadRecorder func(*http.Request) (*http.Response, error)

func (r uploadRecorder) RoundTrip(req *http.Request) (*http.Response, error) { return r(req) }

func TestColdIndexAcrossResponseLimitAndRestart(t *testing.T) {
	const count = 150000 // the v1 full representation exceeds the single-response byte limit
	lineage, mainHash := strings.Repeat("a", 64), strings.Repeat("b", 64)
	prefix := ".videron-sync/" + lineage + "/objects/"
	epoch := 1
	var completeBytes, largest int
	var mu sync.Mutex
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		q := r.URL.Query()
		if q.Get("limit") != strconv.Itoa(syncIndexPageSize) {
			t.Error("client did not request bounded pages")
		}
		start := 0
		if q.Has("offset") {
			if epoch == 1 {
				epoch = 2 // simulate restarting on the next page of an old generation
				w.WriteHeader(http.StatusConflict)
				return
			}
			var err error
			start, err = strconv.Atoi(q.Get("offset"))
			if err != nil || q.Get("snapshot") != "second" || start <= 0 || start >= count {
				t.Errorf("invalid continuation %s", r.URL.String())
				w.WriteHeader(http.StatusBadRequest)
				return
			}
		}
		reply := Manifest{Lineage: lineage, Main: mainHash, Files: map[string]string{}, PageTotal: count, Offset: start,
			Cursor: "initial-event", IndexCursor: "second"}
		if epoch == 1 {
			reply.IndexCursor = "first"
		}
		if start > 0 {
			reply.Cursor = "concurrent-new-revision"
		}
		for i := start; i < min(count, start+syncIndexPageSize); i++ {
			key := prefix + fmt.Sprintf("%064x.json", i)
			if epoch == 1 {
				key = strings.Replace(key, "/objects/", "/revisions/", 1)
			}
			reply.Files[key] = mainHash
		}
		b, err := json.Marshal(reply)
		if err != nil {
			t.Error(err)
		}
		if epoch == 2 {
			completeBytes += len(b)
			largest = max(largest, len(b))
		}
		w.Write(b)
	}))
	defer srv.Close()
	p := Profile{Address: srv.URL}
	m, err := p.Manifest(srv.Client())
	mu.Lock()
	defer mu.Unlock()
	if err != nil || len(m.Files) != count || m.IndexCursor != "second" || m.Cursor != "initial-event" {
		t.Fatalf("cold index after restart: records=%d err=%v", len(m.Files), err)
	}
	for _, i := range []int{0, syncIndexPageSize - 1, syncIndexPageSize, count - 1} {
		if m.Files[prefix+fmt.Sprintf("%064x.json", i)] != mainHash {
			t.Fatal("restarted read lost a record", i)
		}
	}
	if completeBytes <= 32<<20 || largest > 1<<20 {
		t.Fatalf("body sizes: total=%d largest=%d", completeBytes, largest)
	}
	t.Logf("%d records across %d bounded responses: %d B total, largest %d B", count, (count+syncIndexPageSize-1)/syncIndexPageSize, completeBytes, largest)
}

func TestUploadDistinguishesExistingRecordFromChangedSpace(t *testing.T) {
	p := Profile{Address: "https://test.invalid", Lineage: strings.Repeat("a", 64)}
	status := http.StatusPreconditionFailed
	c := &http.Client{Transport: uploadRecorder(func(r *http.Request) (*http.Response, error) {
		r.Body.Close()
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: http.NoBody}, nil
	})}
	for _, route := range []string{"/v1/main", "/v1/file?path=sample"} {
		status = http.StatusPreconditionFailed
		if err := p.upload(c, route, []byte("sample")); !errors.Is(err, ErrChanged) {
			t.Fatalf("%s duplicate: %v", route, err)
		}
		status = http.StatusConflict
		if err := p.upload(c, route, []byte("sample")); !errors.Is(err, ErrSpace) {
			t.Fatalf("%s wrong space was treated as an existing record: %v", route, err)
		}
	}
}

func TestSyncManifestFallbackAndScope(t *testing.T) {
	p := Profile{Address: "https://test.invalid", Token: "first", Lineage: strings.Repeat("a", 64)}
	mainHash := strings.Repeat("b", 64)
	first := ".videron-sync/" + p.Lineage + "/objects/" + mainHash + ".json"
	second := strings.Replace(first, "/objects/", "/revisions/", 1)
	var cache IndexCache
	reply := Manifest{Lineage: p.Lineage, Main: mainHash, Cursor: "event", Files: map[string]string{first: mainHash}, IndexCursor: "one"}
	var since string
	c := &http.Client{Transport: uploadRecorder(func(r *http.Request) (*http.Response, error) {
		since = r.URL.Query().Get("since")
		page := reply
		if r.URL.Query().Has("snapshot") {
			if r.URL.Query().Get("snapshot") != reply.IndexCursor || r.URL.Query().Get("offset") != "1" {
				t.Fatal("incorrect delta continuation", r.URL)
			}
			page.Offset = 1
			page.Files = map[string]string{strings.Replace(first, mainHash+".json", strings.Repeat("d", 64)+".json", 1): mainHash}
		}
		data, err := json.Marshal(page)
		if err != nil {
			return nil, err
		}
		h := make(http.Header)
		h.Set("X-Videron-Project", p.ProjectID)
		return &http.Response{StatusCode: 200, Header: h, Body: io.NopCloser(bytes.NewReader(data))}, nil
	})}
	read := func(wantSince string, count int) Manifest {
		t.Helper()
		m, err := p.SyncManifest(c, &cache)
		if err != nil || since != wantSince || len(m.Files) != count {
			t.Fatalf("since=%q files=%d err=%v", since, len(m.Files), err)
		}
		return m
	}
	read("", 1)
	reply.Base, reply.IndexCursor = "one", "two"
	reply.Files = map[string]string{second: mainHash}
	reply.PageTotal = 2
	got := read("one", 3)
	reply.PageTotal = 0
	if got.Files[first] == "" || got.Files[second] == "" {
		t.Fatal("lost files when applying a delta")
	}
	reply.Base = "wrong-base"
	if _, err := p.SyncManifest(c, &cache); !errors.Is(err, ErrProtocol) {
		t.Fatal("delta from another base was accepted")
	}
	reply.Base = ""
	reply.Summary = true
	if _, err := p.SyncManifest(c, &cache); !errors.Is(err, ErrProtocol) {
		t.Fatal("metadata-only reply accepted as a complete snapshot")
	}
	reply.Summary = false
	reply.IndexCursor = "fresh"
	read("", 1) // a rejected index triggers a full read on retry
	reply.Files = map[string]string{first: mainHash}
	read("fresh", 1) // expired cursor: full fallback replaces the old map
	p.Token = "re-enrolled"
	read("", 1)
	p.ProjectID = strings.Repeat("c", 64)
	read("", 1)
	p.Pin = "new-identity"
	read("", 1)
	p.Address = "https://different.invalid"
	read("", 1)
	reply.IndexCursor = "" // downgraded server ignores the query
	read("fresh", 1)
	read("", 1)
	reply.IndexCursor = "new-start"
	read("", 1)
	reply.Base, reply.IndexCursor = "new-start", "later"
	reply.Files[first] = strings.Repeat("f", 64)
	if _, err := p.SyncManifest(c, &cache); !errors.Is(err, ErrProtocol) || cache.cursor != "" {
		t.Fatal("a delta changed the digest of an existing record", err)
	}
	reply.Base, reply.Offset = "", 5
	if _, err := p.SyncManifest(c, &cache); !errors.Is(err, ErrProtocol) {
		t.Fatal("a middle page was accepted as a complete index", err)
	}
}
