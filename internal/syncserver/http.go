package syncserver

import (
	"context"
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxBytes int64 = 1 << 30

//go:embed landing.html
var landingPage []byte

//go:embed landing.js
var landingScript []byte

type landingMode string

const (
	landingInteractive landingMode = "interactive"
	landingOff         landingMode = "off"
	landingScriptPath              = "/landing.js"
)

type service struct {
	store      *store
	projects   *projectCatalog
	token      string
	enrollment *enrollment
	landing    landingMode
}

func setResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (mode landingMode) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// A browser or proxy must see a changed landing mode on its next request.
	setResponseHeaders(w)
	if mode == landingOff {
		http.NotFound(w, r)
		return
	}
	var content []byte
	var contentType string
	switch r.URL.EscapedPath() {
	case "/":
		content, contentType = landingPage, "text/html; charset=utf-8"
	case landingScriptPath:
		content, contentType = landingScript, "text/javascript; charset=utf-8"
	default:
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.Method == http.MethodGet {
		w.Write(content)
	}
}

func (h *service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if path := r.URL.EscapedPath(); path == "/" || path == landingScriptPath {
		h.landing.ServeHTTP(w, r)
		return
	}
	setResponseHeaders(w)
	if r.URL.Path == "/v1/auth/start" || r.URL.Path == "/v1/auth/finish" {
		h.enrollment.serve(w, r)
		return
	}
	route, projectID := syncRoute(r.URL.EscapedPath())
	if route == "" && h.landing == landingOff {
		http.NotFound(w, r)
		return
	}
	if !h.authorized(r.Header.Values("Authorization")) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="Videron"`)
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}
	if route == "" || ((route == "projects" || route == "project") && h.projects == nil) {
		http.NotFound(w, r)
		return
	}
	if route == "projects" {
		h.projects.serve(w, r)
		return
	}
	if headers := r.Header.Values("X-Videron-Project"); len(headers) > 0 {
		if len(headers) != 1 || (headers[0] != "" && !hexID.MatchString(headers[0])) || ((route == "project" || projectID != "") && projectID != headers[0]) {
			http.Error(w, "invalid project selector", http.StatusBadRequest)
			return
		}
		projectID = headers[0]
	}
	if projectID != "" {
		w.Header().Set("X-Videron-Project", projectID)
	}
	if route == "project" {
		h.projects.manage(w, r, projectID)
		return
	}
	s := h.store
	if h.projects != nil {
		p, err := h.projects.acquire(projectID)
		if errors.Is(err, errProjectGone) {
			// 0.46 verifies credentials using the default index before it can
			// list named projects. Keep that discovery path read-only.
			if projectID == "" && route == "index" && r.Method == http.MethodGet && r.Header.Get("X-Videron-Catalog-Version") != "2" {
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"lineage":"","main":"","files":{},"cursor":"deleted"}`))
			} else {
				writeGone(w)
			}
			return
		}
		if err != nil {
			http.Error(w, "cannot open project", http.StatusInternalServerError)
			return
		}
		if p == nil {
			http.NotFound(w, r)
			return
		}
		defer p.active.Done()
		s = p.data
		if route == "main" || route == "file" {
			// Cancel a stalled transfer so its open file doesn't hold up physical
			// deletion (particularly on Windows). Wait for the hook before reuse
			// of the HTTP connection or response writer.
			done := make(chan struct{})
			stop := context.AfterFunc(p.stop, func() {
				defer close(done)
				controller := http.NewResponseController(w)
				if r.Method == http.MethodPut {
					_ = controller.SetReadDeadline(time.Now())
					_ = r.Body.Close()
				} else if r.Method == http.MethodGet {
					_ = controller.SetWriteDeadline(time.Now())
				}
			})
			defer func() {
				if !stop() {
					<-done
				}
			}()
		}
	} else if projectID != "" {
		http.NotFound(w, r)
		return
	}
	switch route {
	case "index", "events":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "method not allowed", 405)
			return
		}
		if route == "events" {
			s.events(w, r)
			return
		}
		index, err := s.index(r.URL.Query())
		if errors.Is(err, errIndexChanged) {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		if errors.Is(err, errIndexPage) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if errors.Is(err, errProjectGone) {
			writeGone(w)
			return
		}
		if err != nil {
			http.Error(w, "cannot read index", 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(index)
	case "main", "file":
		if r.Method != http.MethodGet && r.Method != http.MethodPut {
			w.Header().Set("Allow", "GET, PUT")
			http.Error(w, "method not allowed", 405)
			return
		}
		t := target{main: route == "main"}
		if t.main {
			t.lineage = r.Header.Get("X-Videron-Lineage")
			if (t.lineage != "" || r.Method == http.MethodPut) && !hexID.MatchString(t.lineage) {
				http.Error(w, "invalid space lineage", 400)
				return
			}
		} else {
			values := r.URL.Query()["path"]
			if len(values) != 1 {
				http.Error(w, "one path required", 400)
				return
			}
			t.path = values[0]
			match := apiBlob.FindStringSubmatch(t.path)
			if match == nil {
				http.Error(w, "invalid version path", 400)
				return
			}
			t.lineage, t.name = match[1], match[2]+"-"+match[3]+".json"
		}
		if r.Method == http.MethodPut {
			s.put(w, r, t)
		} else {
			s.get(w, r, t)
		}
	}
}

func (h *service) authorized(headers []string) bool {
	if len(headers) != 1 {
		return false
	}
	bearer, ok := strings.CutPrefix(headers[0], "Bearer ")
	if !ok || bearer == "" {
		return false
	}
	token := []byte(bearer)
	match := subtle.ConstantTimeCompare(token, []byte(h.token))
	if h.enrollment != nil {
		match |= subtle.ConstantTimeCompare(token, []byte(h.enrollment.token))
	}
	return match == 1
}

// A named URL also scopes requests sent during a downgrade: a legacy server
// only recognizes the original /v1/{index,events,main,file} paths.
func syncRoute(path string) (route, projectID string) {
	route, ok := strings.CutPrefix(path, "/v1/")
	if !ok {
		return "", ""
	}
	if route == "projects" {
		return route, ""
	}
	if scoped, found := strings.CutPrefix(route, "projects/"); found {
		projectID, route, ok = strings.Cut(scoped, "/")
		if !ok {
			if projectID == "default" {
				return "project", ""
			}
			if hexID.MatchString(projectID) {
				return "project", projectID
			}
			return "", ""
		}
		if !hexID.MatchString(projectID) {
			return "", ""
		}
	}
	switch route {
	case "index", "events", "main", "file":
		return route, projectID
	}
	return "", ""
}

func writePublicationError(w http.ResponseWriter, err error) {
	if errors.Is(err, errProjectGone) {
		writeGone(w)
		return
	}
	http.Error(w, "cannot confirm stored files", 500)
}

func (s *store) events(w http.ResponseWriter, r *http.Request) {
	since := r.URL.Query().Get("since")
	state := func() (string, <-chan struct{}, bool) {
		s.mu.RLock()
		defer s.mu.RUnlock()
		if err := s.publicationError(); err != nil {
			writePublicationError(w, err)
			return "", nil, false
		}
		return s.cursor, s.changed, true
	}
	cursor, changed, ok := state()
	if !ok {
		return
	}
	if since == cursor {
		timer := time.NewTimer(25 * time.Second)
		defer timer.Stop()
		select {
		case <-r.Context().Done():
			return
		case <-changed:
		case <-timer.C:
		}
		cursor, _, ok = state()
		if !ok {
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Cursor string `json:"cursor"`
	}{cursor})
}

type target struct {
	main                bool
	lineage, path, name string
}

func (s *store) get(w http.ResponseWriter, r *http.Request, t target) {
	s.mu.RLock()
	if err := s.publicationError(); err != nil {
		s.mu.RUnlock()
		writePublicationError(w, err)
		return
	}
	if s.main == "" {
		s.mu.RUnlock()
		http.NotFound(w, r)
		return
	}
	if t.lineage != "" && t.lineage != s.lineage {
		s.mu.RUnlock()
		http.Error(w, "different space", 409)
		return
	}
	hash := s.files[t.path]
	if t.main {
		hash, t.name = s.main, "main-"+s.lineage
	}
	if hash == "" {
		s.mu.RUnlock()
		http.NotFound(w, r)
		return
	}
	file, err := regularFile(s.root, t.name)
	s.mu.RUnlock()
	if err != nil {
		http.Error(w, "cannot read stored file", 500)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.Error(w, "cannot read stored file", 500)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("ETag", strconv.Quote(hash))
	http.ServeContent(w, r, "payload", info.ModTime(), file)
}

func (s *store) checkPut(r *http.Request, t target) int {
	if err := s.publicationError(); err != nil {
		if errors.Is(err, errProjectGone) {
			return http.StatusGone
		}
		return http.StatusInternalServerError
	}
	if (s.lineage != "" && s.lineage != t.lineage) || (!t.main && s.lineage == "") {
		return 409
	}
	current := s.files[t.path]
	if t.main {
		current = s.main
	}
	match, none := r.Header.Get("If-Match"), r.Header.Get("If-None-Match")
	if none == "*" && match == "" {
		if current == "" {
			return 0
		}
		return 412
	}
	if match == "" && none == "" {
		return 428
	}
	if none != "" || len(match) != 66 || match[0] != '"' || match[len(match)-1] != '"' || !hexID.MatchString(match[1:65]) {
		return 400
	}
	if match != strconv.Quote(current) {
		return 412
	}
	return 0
}

func (s *store) put(w http.ResponseWriter, r *http.Request, t target) {
	s.mu.RLock()
	status := s.checkPut(r, t)
	s.mu.RUnlock()
	if status == http.StatusGone {
		writeGone(w)
		return
	}
	if status != 0 {
		http.Error(w, http.StatusText(status), status)
		return
	}
	if r.ContentLength > maxBytes {
		http.Error(w, "file too large", 413)
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxBytes)
	name, hash, err := stageFile(s.root, body)
	if err != nil {
		s.mu.RLock()
		retirement := s.retirement
		s.mu.RUnlock()
		if retirement != nil {
			writePublicationError(w, retirement)
			return
		}
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			http.Error(w, "file too large", 413)
		} else {
			http.Error(w, "upload failed", 500)
		}
		return
	}
	defer s.root.Remove(name)
	s.mu.Lock()
	defer s.mu.Unlock()
	if status = s.checkPut(r, t); status != 0 {
		if status == http.StatusGone {
			writeGone(w)
			return
		}
		http.Error(w, http.StatusText(status), status)
		return
	}
	if t.main {
		t.name = "main-" + t.lineage
	} else if existing := s.files[t.path]; existing != "" {
		if existing != hash {
			http.Error(w, "immutable version already exists", 409)
			return
		}
		w.Header().Set("ETag", strconv.Quote(hash))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err = s.root.Rename(name, t.name); err != nil {
		http.Error(w, "cannot publish upload", 500)
		return
	}
	if t.main {
		s.main, s.lineage = hash, t.lineage
	} else {
		s.addIndexFile(t.path, hash)
	}
	s.indexJSON = nil
	if t.main || strings.HasPrefix(t.name, "revisions-") {
		s.announce()
	}
	if err := s.durability.publish(s.root, "."); err != nil {
		http.Error(w, "cannot confirm stored file", 500)
		return
	}
	w.Header().Set("ETag", strconv.Quote(hash))
	w.WriteHeader(http.StatusNoContent)
}
