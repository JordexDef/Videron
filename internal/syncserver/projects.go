package syncserver

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

type projectInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type namedProject struct {
	info projectInfo
	mu   sync.Mutex
	data *store
	// Requests registered before retirement finish before their directory is removed.
	active  sync.WaitGroup
	stop    context.Context
	cancel  context.CancelFunc
	cleanup sync.Mutex
}

type projectCatalog struct {
	data    *os.Root
	root    *os.Root
	mu      sync.RWMutex
	entries map[string]*namedProject
	retired map[string]*namedProject
}

var errProjectGone = errors.New("project deleted")

func newProjectEntry(info projectInfo) *namedProject {
	stop, cancel := context.WithCancel(context.Background())
	return &namedProject{info: info, stop: stop, cancel: cancel}
}

func validProjectName(name string) bool {
	return name != "" && utf8.ValidString(name) && utf8.RuneCountInString(name) <= 80 &&
		name == strings.TrimSpace(name) && strings.IndexFunc(name, unicode.IsControl) == -1
}

func openProjectCatalog(data *os.Root) (*projectCatalog, error) {
	if err := data.Mkdir("projects", 0700); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	info, err := data.Lstat("projects")
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("invalid project directory")
	}
	root, err := data.OpenRoot("projects")
	if err != nil {
		return nil, err
	}
	c := &projectCatalog{data: data, root: root, entries: make(map[string]*namedProject), retired: make(map[string]*namedProject)}
	if err := c.readNames(); err != nil {
		root.Close()
		return nil, err
	}
	return c, nil
}

func (c *projectCatalog) readNames() error {
	entries, err := fs.ReadDir(c.root.FS(), ".")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		key, ok := strings.CutPrefix(entry.Name(), ".deleted-")
		if !ok {
			continue
		}
		id := key
		if key == "default" {
			id = ""
		} else if !hexID.MatchString(key) {
			continue
		}
		if !entry.Type().IsRegular() {
			return errors.New("invalid project deletion marker")
		}
		c.retired[id] = &namedProject{info: projectInfo{ID: id}}
	}
	for id, p := range c.retired {
		if err := c.cleanRetired(id, p); err != nil {
			return err
		}
	}
	if c.retired[""] == nil {
		name, err := readProjectName(c.root, ".default-name")
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		c.entries[""] = newProjectEntry(projectInfo{Name: name})
	}
	for _, dir := range entries {
		id := dir.Name()
		if !hexID.MatchString(id) || c.retired[id] != nil {
			continue // Include only published directories, never a partial creation.
		}
		if !dir.IsDir() {
			return errors.New("invalid project directory")
		}
		name, err := readProjectName(c.root, id+"/name")
		if err != nil {
			return err
		}
		c.entries[id] = newProjectEntry(projectInfo{id, name})
	}
	return nil
}

func readProjectName(root *os.Root, path string) (string, error) {
	f, err := regularFile(root, path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 4*80+1))
	if err != nil {
		return "", err
	}
	if !validProjectName(string(raw)) {
		return "", errors.New("invalid stored project name")
	}
	return string(raw), nil
}

func (c *projectCatalog) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, project := range c.entries {
		project.cancel()
		project.mu.Lock()
		if project.data != nil {
			project.data.root.Close()
		}
		project.mu.Unlock()
	}
	c.root.Close()
}

func (c *projectCatalog) list(legacy bool) []projectInfo {
	c.mu.RLock()
	defer c.mu.RUnlock()
	items := make([]projectInfo, 0, len(c.entries))
	for id, project := range c.entries {
		if id == "" {
			continue
		}
		items = append(items, project.info)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	// 0.46 expects this entry with an empty name before it can list named projects.
	if legacy {
		return append([]projectInfo{{}}, items...)
	}
	if project := c.entries[""]; project != nil {
		return append([]projectInfo{project.info}, items...)
	}
	return items
}

func (c *projectCatalog) acquire(id string) (*namedProject, error) {
	c.mu.RLock()
	project := c.entries[id]
	if project == nil {
		gone := c.retired[id] != nil
		c.mu.RUnlock()
		if gone {
			return nil, errProjectGone
		}
		return nil, nil
	}
	project.active.Add(1)
	c.mu.RUnlock()
	// Build the index on first access. Opening one project needn't scan the
	// contents of other projects or hold up their long polls.
	project.mu.Lock()
	defer project.mu.Unlock()
	if project.stop.Err() != nil {
		project.active.Done()
		return nil, errProjectGone
	}
	if project.data == nil {
		var s *store
		var err error
		if id == "" {
			s, err = openStore(c.data)
		} else {
			s, err = openStoreDirectory(c.root, id)
		}
		if err != nil {
			project.active.Done()
			return nil, err
		}
		s.projectName = project.info.Name
		project.data = s
	}
	return project, nil
}

func writeProjectMetadata(root *os.Root, path, value string) error {
	stage, _, err := stageFile(root, strings.NewReader(value))
	if err != nil {
		return err
	}
	defer root.Remove(stage)
	return root.Rename(stage, path)
}

func (c *projectCatalog) rename(id, expected, name string) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.entries[id]
	if p == nil {
		if c.retired[id] != nil {
			return http.StatusGone, nil
		}
		return http.StatusNotFound, nil
	}
	// A duplicate PATCH may follow a lost acknowledgement.
	if p.info.Name == name {
		return http.StatusOK, nil
	}
	if p.info.Name != expected {
		return http.StatusPreconditionFailed, nil
	}
	for otherID, other := range c.entries {
		if otherID != id && strings.EqualFold(other.info.Name, name) {
			return http.StatusConflict, nil
		}
	}
	path := id + "/name"
	if id == "" {
		path = ".default-name"
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := writeProjectMetadata(c.root, path, name); err != nil {
		return 0, err
	}
	p.info.Name = name
	if s := p.data; s != nil {
		s.mu.Lock()
		s.projectName = name
		s.indexJSON = nil
		s.announce()
		s.mu.Unlock()
	}
	return http.StatusOK, nil
}

func (c *projectCatalog) remove(id, expected string) (int, error) {
	c.mu.Lock()
	p := c.entries[id]
	if p == nil {
		p = c.retired[id]
		c.mu.Unlock()
		if p == nil {
			return http.StatusNotFound, nil
		}
		return http.StatusNoContent, c.cleanRetired(id, p)
	}
	if p.info.Name != expected {
		c.mu.Unlock()
		return http.StatusPreconditionFailed, nil
	}
	// Persist retirement before making it visible or removing any files. The
	// reserved ID prevents delayed uploads and create retries from resurrecting it.
	key := id
	if key == "" {
		key = "default"
	}
	p.mu.Lock()
	s := p.data
	if s != nil {
		s.mu.Lock()
	}
	err := writeProjectMetadata(c.root, ".deleted-"+key, "")
	if err == nil {
		delete(c.entries, id)
		c.retired[id] = p
		p.cancel()
		if s != nil {
			s.gone = true
			s.announce()
		}
	}
	if s != nil {
		s.mu.Unlock()
	}
	p.mu.Unlock()
	c.mu.Unlock()
	if err != nil {
		return 0, err
	}
	return http.StatusNoContent, c.cleanRetired(id, p)
}

// Cleanup is retryable after IO failure or a process crash. Once retired, no
// new request can acquire this entry, so active.Wait cannot race a new Add.
func (c *projectCatalog) cleanRetired(id string, p *namedProject) error {
	p.cleanup.Lock()
	defer p.cleanup.Unlock()
	p.active.Wait()
	if p.data != nil {
		p.data.root.Close()
		p.data = nil
	}
	if id != "" {
		return c.root.RemoveAll(id)
	}
	if err := c.data.RemoveAll("space"); err != nil {
		return err
	}
	if err := c.root.Remove(".default-name"); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func writeGone(w http.ResponseWriter) {
	w.Header().Set("X-Videron-Project-Deleted", "1")
	http.Error(w, "project deleted", http.StatusGone)
}

func (c *projectCatalog) manage(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPatch && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "PATCH, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var change struct {
		Name         string
		ExpectedName *string
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2048))
	if err != nil || !utf8.Valid(raw) || json.Unmarshal(raw, &change) != nil || change.ExpectedName == nil {
		http.Error(w, "expected project name required", http.StatusBadRequest)
		return
	}
	var status int
	if r.Method == http.MethodPatch {
		change.Name = strings.TrimSpace(change.Name)
		if !validProjectName(change.Name) {
			http.Error(w, "invalid project name", http.StatusBadRequest)
			return
		}
		status, err = c.rename(id, *change.ExpectedName, change.Name)
	} else {
		status, err = c.remove(id, *change.ExpectedName)
	}
	if err != nil {
		http.Error(w, "cannot update project", http.StatusInternalServerError)
		return
	}
	if status == http.StatusGone {
		writeGone(w)
		return
	}
	if status >= 400 {
		http.Error(w, http.StatusText(status), status)
		return
	}
	if status == http.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(projectInfo{ID: id, Name: change.Name})
}

func (c *projectCatalog) create(info projectInfo) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.retired[info.ID] != nil {
		return http.StatusGone, nil
	}
	if existing := c.entries[info.ID]; existing != nil {
		if existing.info == info {
			return http.StatusOK, nil
		}
		return http.StatusConflict, nil
	}
	for _, p := range c.entries {
		if strings.EqualFold(p.info.Name, info.Name) {
			return http.StatusConflict, nil
		}
	}
	// Publish the name and directory together. Retrying after an interrupted
	// request sees either the complete project or an unclaimed ID.
	stage := ".creating-" + rand.Text()
	if err := c.root.Mkdir(stage, 0700); err != nil {
		return 0, err
	}
	defer c.root.Remove(stage)
	f, err := c.root.OpenFile(stage+"/name", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return 0, err
	}
	defer c.root.Remove(stage + "/name")
	if _, err = f.WriteString(info.Name); err == nil {
		err = f.Sync()
	}
	closed := f.Close()
	if err != nil {
		return 0, err
	}
	if closed != nil {
		return 0, closed
	}
	if err := c.root.Rename(stage, info.ID); err != nil {
		return 0, err
	}
	c.entries[info.ID] = newProjectEntry(info)
	return http.StatusCreated, nil
}

func (c *projectCatalog) serve(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Videron-Project-Management", "1")
		json.NewEncoder(w).Encode(c.list(r.URL.Query().Get("version") != "2"))
	case http.MethodPost:
		var info projectInfo
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2048))
		if err != nil || !utf8.Valid(raw) || json.Unmarshal(raw, &info) != nil || !hexID.MatchString(info.ID) {
			http.Error(w, "invalid project", http.StatusBadRequest)
			return
		}
		info.Name = strings.TrimSpace(info.Name)
		if !validProjectName(info.Name) {
			http.Error(w, "invalid project name", http.StatusBadRequest)
			return
		}
		status, err := c.create(info)
		if err != nil {
			http.Error(w, "cannot create project", http.StatusInternalServerError)
			return
		}
		if status == http.StatusGone {
			w.Header().Set("X-Videron-Project", info.ID)
			writeGone(w)
			return
		}
		if status == http.StatusConflict {
			http.Error(w, "project already exists", status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(info)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
