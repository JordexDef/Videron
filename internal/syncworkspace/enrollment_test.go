package syncworkspace

import (
	"bytes"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"strings"
	"testing"

	"videron/internal/syncclient"
	"videron/internal/syncclient/synctest"
	"videron/internal/vault"
	"videron/internal/workspacestore"
)

type enrollmentNote struct{}

var enrollmentNoteValidator = vault.NewNoteValidator(nil)

func (*enrollmentNote) UnmarshalJSON(raw []byte) error {
	return enrollmentNoteValidator.Validate(raw)
}

func enrollmentDoc(first, second string) string {
	data, _ := json.Marshal(map[string]any{
		"name": "Test space", "areas": []any{},
		"notes": []any{
			map[string]string{"id": "x", "title": first},
			map[string]string{"id": "y", "title": second},
		},
	})
	return string(data)
}

type enrollmentFixture struct {
	dir        string
	session    *workspacestore.Session
	connection FolderConnection
}

func newEnrollmentFixture(t *testing.T, store *workspacestore.Store, payload, password string) *enrollmentFixture {
	t.Helper()
	dir := t.TempDir()
	session, err := store.Create(dir, payload, password)
	if err != nil {
		t.Fatal(err)
	}
	f := &enrollmentFixture{dir: dir, session: session}
	t.Cleanup(func() { f.session.Key().Forget() })
	return f
}

func (f *enrollmentFixture) access(folder string, action func(*workspacestore.Session, *FolderConnection) error) error {
	if folder != f.dir {
		return syncclient.ErrFolder
	}
	return action(f.session, &f.connection)
}

func (f *enrollmentFixture) read(dir, lineage, kind, id string) ([]byte, error) {
	if dir != f.dir {
		return nil, syncclient.ErrFolder
	}
	return f.session.TransferRecord(lineage, kind, id)
}

func TestSyncServiceProcess(t *testing.T) { synctest.RunServerProcess(t) }

type uploadRecorder func(*http.Request) (*http.Response, error)

func (r uploadRecorder) RoundTrip(req *http.Request) (*http.Response, error) { return r(req) }

func TestSyncSaveDuringObjectUpload(t *testing.T) {
	useTestProfileDirectory(t)
	fixture := newEnrollmentFixture(t, workspacestore.New[enrollmentNote](), enrollmentDoc("original", "unchanged"), "")
	lineage, err := fixture.session.EnsureLineage()
	if err != nil {
		t.Fatal(err)
	}
	p := syncclient.Profile{Address: "https://test.invalid", Lineage: lineage}
	files := map[string]string{}
	prefix := ".videron-sync/" + lineage + "/"
	var revisions int
	client := &http.Client{Transport: uploadRecorder(func(req *http.Request) (*http.Response, error) {
		defer req.Body.Close()
		path := req.URL.Query().Get("path")
		if len(files) == 0 {
			// The first object request is in flight when the editor publishes a new revision.
			if err := fixture.session.SaveBranch(enrollmentDoc("edited during upload", "unchanged")); err != nil {
				t.Fatal(err)
			}
		}
		if strings.HasPrefix(path, prefix+"revisions/") {
			revisions++
			var r struct {
				Lists map[string][]string `json:"lists"`
			}
			if err := json.NewDecoder(req.Body).Decode(&r); err != nil {
				t.Fatal(err)
			}
			for _, ids := range r.Lists {
				for _, id := range ids {
					if _, ok := files[prefix+"objects/"+id+".json"]; !ok {
						t.Fatal("published revision before its objects", id)
					}
				}
			}
		}
		files[path] = "uploaded"
		return &http.Response{StatusCode: http.StatusCreated, Body: http.NoBody}, nil
	})}
	for pass := 1; pass <= 2; pass++ {
		m := syncclient.Manifest{Lineage: lineage, Files: maps.Clone(files)}
		if err := p.Exchange(client, fixture.dir, m, fixture.read, workspacestore.PublishNewFile); err != nil {
			t.Fatal(err)
		}
		if revisions != pass {
			t.Fatalf("pass %d: server has %d revisions", pass, revisions)
		}
	}
}

func TestEncryptedSyncUploadBodies(t *testing.T) {
	useTestProfileDirectory(t)
	server := synctest.NewServer(t, "Temporary sync service passphrase")
	store := workspacestore.New[enrollmentNote]()
	const password = "fixture space password"
	// A large unmodified value shares this space with the edited note.
	large := strings.Repeat("unmodified-data-", 1<<16)
	doc := func(title string) string {
		return strings.Replace(enrollmentDoc(title, "Data"), `"title":"Data"`, `"title":"Data","dataText":"`+large+`"`, 1)
	}
	f := newEnrollmentFixture(t, store, doc("Note"), password)
	verified, err := syncclient.ParsePairCode(server.Code)
	if err != nil {
		t.Fatal(err)
	}
	if err := Connect(f.dir, verified, f.access, f.access, f.read); err != nil {
		t.Fatal(err)
	}
	p, err := LoadProfile(f.dir)
	if err != nil || p == nil {
		t.Fatal("missing test profile", err)
	}
	cache := f.connection.index
	if cache == nil || cache.Cursor() == "" {
		t.Fatal("first sync would redownload the enrollment index")
	}
	client := p.Client()
	next := client.Transport.(*http.Transport)
	defer next.CloseIdleConnections()
	var files, mainUploads, uploadBytes int
	client.Transport = uploadRecorder(func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodPut {
			body, err := io.ReadAll(r.Body)
			r.Body.Close()
			if err != nil {
				return nil, err
			}
			// The transfer layer receives only client-sealed envelopes.
			if _, err = vault.ParseEnvelope(body, workspacestore.SyncScope); err != nil {
				t.Fatalf("unencrypted upload: %v", err)
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			uploadBytes += len(body)
			if r.URL.Path == "/v1/main" {
				mainUploads++
			} else {
				files++
			}
		}
		return next.RoundTrip(r)
	})
	syncFiles := func() {
		t.Helper()
		m, err := p.SyncManifest(client, cache)
		if err != nil {
			t.Fatal(err)
		}
		if err = p.Exchange(client, f.dir, m, f.read, workspacestore.PublishNewFile); err != nil {
			t.Fatal(err)
		}
	}
	syncFiles()
	if err := f.session.SaveBranch(doc("Notes")); err != nil {
		t.Fatal(err)
	}
	syncFiles()
	if files != 2 || mainUploads != 0 || uploadBytes > 8<<10 {
		t.Fatalf("one title edit: records=%d main=%d bytes=%d", files, mainUploads, uploadBytes)
	}
	t.Logf("one-letter title edit with %d B of unmodified text: %d encrypted records, %d B of PUT bodies", len(large), files, uploadBytes)
	files, uploadBytes = 0, 0
	syncFiles()
	if files != 0 || mainUploads != 0 || uploadBytes != 0 {
		t.Fatal("an already-current project uploaded records on its next check")
	}
	f.session.Key().Forget()
	reopened, _, err := store.Open(f.dir, password, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.session = reopened
	f.connection = FolderConnection{}
	fresh := f.connection.indexCache()
	if fresh == cache || fresh.Cursor() != "" {
		t.Fatal("reopened folder retained the old connection index")
	}
	if _, err := Sync(f.dir, f.access, f.read); err != nil {
		t.Fatal("could not sync the reopened copy", err)
	}
	if f.connection.index != fresh || fresh.Cursor() == "" {
		t.Fatal("first sync did not populate the fresh connection index")
	}
}
