package syncserver

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestIndexDeltaHTTP(t *testing.T) {
	s := openTestStore(t, testRoot(t))
	s.lineage = strings.Repeat("a", 64)
	s.main = strings.Repeat("b", 64)
	prefix := ".videron-sync/" + s.lineage + "/"
	path := func(kind string, i int) string {
		return fmt.Sprintf("%s%s/%x.json", prefix, kind, sha256.Sum256([]byte(fmt.Sprint(i))))
	}
	const entries = 5000
	for i := range entries {
		s.addIndexFile(path("objects", i), fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprint("payload", i)))))
	}
	h := &service{store: s, token: "test"}
	srv := httptest.NewTLSServer(h)
	defer srv.Close()
	call := func(method, route string, expected ...int) []byte {
		t.Helper()
		req, err := http.NewRequest(method, srv.URL+route, strings.NewReader("sample"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer test")
		req.Header.Set("If-None-Match", "*")
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		ok := resp.StatusCode == 200 || resp.StatusCode == 204
		if len(expected) == 1 {
			ok = resp.StatusCode == expected[0]
		}
		if err != nil || !ok {
			t.Fatalf("%s %s: status=%d err=%v", method, route, resp.StatusCode, err)
		}
		return body
	}
	type manifest struct {
		Cursor, IndexCursor, Base string
		Files                     map[string]string
		Summary                   bool
		PageTotal, Offset         int
	}
	get := func(query string) (manifest, int) {
		t.Helper()
		body := call("GET", "/v1/index"+query)
		var m manifest
		if err := json.Unmarshal(body, &m); err != nil {
			t.Fatal(err)
		}
		return m, len(body)
	}
	full, fullBytes := get("")
	if len(full.Files) != entries || full.IndexCursor == "" || full.Base != "" {
		t.Fatal("incomplete cold snapshot")
	}
	firstPage, _ := get("?limit=2000")
	if firstPage.PageTotal != entries || len(firstPage.Files) != 2000 || firstPage.IndexCursor != full.IndexCursor {
		t.Fatal("unexpected first page")
	}
	since := "?since=" + url.QueryEscape(full.IndexCursor)
	empty, idleBytes := get(since)
	if len(empty.Files) != 0 || empty.Base != full.IndexCursor || idleBytes >= 1024 {
		t.Fatal("idle peer received the full index")
	}
	newObject, newRev := path("objects", entries), path("revisions", entries)
	call("PUT", "/v1/file?path="+url.QueryEscape(newObject))
	staged, _ := get(since)
	if staged.Cursor != full.Cursor || len(staged.Files) != 1 || staged.Files[newObject] == "" {
		t.Fatal("incomplete revision woke peers or hid the staged object")
	}
	call("PUT", "/v1/file?path="+url.QueryEscape(newRev))
	delta, deltaBytes := get(since)
	if delta.Base != full.IndexCursor || delta.Cursor == full.Cursor || len(delta.Files) != 2 ||
		delta.Files[newObject] == "" || delta.Files[newRev] == "" || deltaBytes >= 2048 {
		t.Fatal("revision delta did not identify both new files")
	}
	query := "?limit=2000&snapshot=" + url.QueryEscape(firstPage.IndexCursor)
	for _, offset := range []int{2000, 4000} {
		page, _ := get(query + fmt.Sprintf("&offset=%d", offset))
		if page.PageTotal != entries || page.Offset != offset || page.IndexCursor != firstPage.IndexCursor || len(page.Files) != min(2000, entries-offset) {
			t.Fatal("published files moved the boundary between pages")
		}
		maps.Copy(firstPage.Files, page.Files)
	}
	if !maps.Equal(firstPage.Files, full.Files) {
		t.Fatal("cold pages did not reconstruct the pre-edit snapshot")
	}
	call("GET", "/v1/index?limit=2000&snapshot=previous-epoch.5000&offset=2000", http.StatusConflict)
	base := s.indexEpoch + ".2000"
	deltaPage := "?limit=2000&since=" + base
	p1, _ := get(deltaPage)
	p2, _ := get(deltaPage + "&snapshot=" + p1.IndexCursor + "&offset=2000")
	if p1.Base != base || p2.Base != base || p1.PageTotal != entries+2-2000 || p2.PageTotal != p1.PageTotal ||
		len(p1.Files) != 2000 || len(p2.Files) != 1002 || p2.Files[newObject] == "" || p2.Files[newRev] == "" {
		t.Fatal("an offline peer did not receive just the missing records in pages")
	}
	if _, resent := p1.Files[path("objects", 1999)]; resent {
		t.Fatal("delta resent a record from before the cursor")
	}
	summary, summaryBytes := get("?view=summary")
	if !summary.Summary || len(summary.Files) != 0 || summaryBytes >= 1024 {
		t.Fatal("project discovery returned the file list")
	}
	for _, invalid := range []string{"another-generation.0", s.indexEpoch + ".0"} {
		m, _ := get("?since=" + invalid)
		if m.Base != "" || len(m.Files) != entries+2 {
			t.Fatal("an expired cursor did not receive the full current snapshot")
		}
	}
	t.Logf("HTTPS response bodies, %d seeded archive records: full %d B, idle %d B, one object + revision %d B, discovery %d B", entries, fullBytes, idleBytes, deltaBytes, summaryBytes)
}
