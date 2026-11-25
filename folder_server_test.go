package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"videron/internal/syncclient"
	"videron/internal/syncclient/synctest"
	"videron/internal/vault"
)

type uploadRecorder func(*http.Request) (*http.Response, error)

func (r uploadRecorder) RoundTrip(req *http.Request) (*http.Response, error) { return r(req) }

func TestSyncEnrollmentRequiresTheSameUnlockedSession(t *testing.T) {
	a, _ := testStore(t)
	const password = "Temporary sync service passphrase"
	server := startPasswordTestService(t, password)
	if err := a.ProtectProject(libraryPrefix+originalNote+librarySuffix, testPass); err != nil {
		t.Fatal(err)
	}
	verified, err := a.VerifySyncServer(server.Addr, password)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.LockProject(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.VerifySyncServer(server.Addr, password); !errors.Is(err, errLocked) {
		t.Fatal("new verification while locked", err)
	}
	if _, err := a.MatchingServerFolders(verified.Ticket, nil); !errors.Is(err, errLocked) {
		t.Fatal("lookup during lock", err)
	}
	if err := a.DisconnectSpaceServer(t.TempDir()); !errors.Is(err, errLocked) {
		t.Fatal("disconnect during lock", err)
	}
	if _, err := a.UnlockProject(testPass); err != nil {
		t.Fatal(err)
	}
	if _, err := a.resolveServerTicket(verified.Ticket); !errors.Is(err, errServerTicket) {
		t.Fatal("previous session's ticket survived unlock", err)
	}
	// Complete a normal login while a lock and unlock intervene between the
	// request and its response. It must not authorize the new session.
	var once sync.Once
	resumed := make(chan error, 1)
	a.ctx = httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{GotFirstResponseByte: func() {
		once.Do(func() {
			a.LockSession("")
			_, err := a.UnlockProject(testPass)
			resumed <- err
		})
	}})
	result, err := a.VerifySyncServer(server.Addr, password)
	if !errors.Is(err, errServerTicket) || result.Ticket != "" {
		t.Fatal("verification completed for a different session", err)
	}
	select {
	case err := <-resumed:
		if err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatal("verification did not reach the local server")
	}
}

func TestJoinCommitsOnlyInOriginalSession(t *testing.T) {
	for _, tc := range []struct {
		name   string
		unlock bool
		want   error
	}{{"locked", false, errLocked}, {"unlocked again", true, errServerTicket}} {
		t.Run(tc.name, func(t *testing.T) {
			a, _ := testStore(t)
			if err := a.ProtectProject(libraryPrefix+originalNote+librarySuffix, testPass); err != nil {
				t.Fatal(err)
			}
			raw, err := encodeSpace(syncDoc("project", "remote"), nil)
			if err != nil {
				t.Fatal(err)
			}
			hash := hexID(raw)
			remote := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/index":
					json.NewEncoder(w).Encode(syncclient.Manifest{Cursor: "initial", Main: hash, Lineage: hash, Files: map[string]string{}})
				case "/v1/main":
					if err := a.LockProject(); err != nil {
						t.Error(err)
					}
					if tc.unlock {
						if _, err := a.UnlockProject(testPass); err != nil {
							t.Error(err)
						}
					}
					w.Write(raw)
				default:
					http.NotFound(w, r)
				}
			}))
			defer remote.Close()
			profile := syncclient.Profile{Address: remote.URL, Pin: hexID(remote.Certificate().Raw), Token: strings.Repeat("1", 64)}
			ticket, err := a.issueServerTicket(profile, a.serverTickets.currentGeneration())
			if err != nil {
				t.Fatal(err)
			}
			defer a.DiscardSyncServerTicket(ticket.Ticket)
			dir := t.TempDir()
			if err := a.JoinSpaceServer(ticket.Ticket, dir); !errors.Is(err, tc.want) {
				t.Fatalf("join returned %v, want %v", err, tc.want)
			}
			if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
				t.Fatal("interrupted join left local files", entries, err)
			}
			if p, err := loadProfile(canonicalTestFolder(t, dir)); err != nil || p != nil {
				t.Fatal("interrupted join saved a connection", err)
			}
		})
	}
}

func TestConnectRechecksSessionBeforePublishing(t *testing.T) {
	a, _ := testStore(t)
	dir := t.TempDir()
	if err := a.CreateFolderSpace(dir, syncDoc("project", "local"), testPass); err != nil {
		t.Fatal(err)
	}
	remote := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/index" {
			t.Error("unexpected request after session changed", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		a.LockSession("")
		if _, err := a.Load(); err != nil {
			t.Error(err)
		}
		if _, err := a.OpenFolderSpace(dir, testPass); err != nil {
			t.Error(err)
		}
		json.NewEncoder(w).Encode(syncclient.Manifest{Cursor: "empty", Files: map[string]string{}})
	}))
	defer remote.Close()
	code := strings.Replace(remote.URL, "https://", "videron-sync://", 1) + "#" + hexID(remote.Certificate().Raw) + "." + strings.Repeat("1", 64)
	if err := a.ConnectSpaceServer(dir, code); !errors.Is(err, errServerTicket) {
		t.Fatal("connect completed in a different session", err)
	}
	if p, err := loadProfile(canonicalTestFolder(t, dir)); err != nil || p != nil {
		t.Fatal("interrupted connect saved a profile", err)
	}
}

func TestDefaultProjectRequiresDisconnectBeforeSwitchingServers(t *testing.T) {
	a, _ := testStore(t)
	first := startPasswordTestService(t, "First sync service password")
	second := startPasswordTestService(t, "Second sync service password")
	dir := t.TempDir()
	if err := a.CreateFolderSpace(dir, syncDoc("project", "local"), testPass); err != nil {
		t.Fatal(err)
	}
	if err := a.ConnectSpaceServer(dir, first.Code); err != nil {
		t.Fatal(err)
	}
	if err := a.ConnectSpaceServer(dir, second.Code); !errors.Is(err, syncclient.ErrSpace) {
		t.Fatal("switching an attached folder", err)
	}
	if info, err := a.ServerConnection(dir); err != nil || info.Address != "https://"+first.Addr {
		t.Fatal("original connection changed", info, err)
	}
	p, err := syncclient.ParsePairCode(second.Code)
	if err != nil {
		t.Fatal(err)
	}
	client := p.Client()
	defer client.CloseIdleConnections()
	if m, err := p.Manifest(client); err != nil || m.Main != "" || len(m.Files) != 0 {
		t.Fatal("second server received the attached folder", err)
	}
	if err := a.DisconnectSpaceServer(dir); err != nil {
		t.Fatal(err)
	}
	if err := a.ConnectSpaceServer(dir, second.Code); err != nil {
		t.Fatal("connecting the detached folder", err)
	}
	if info, err := a.ServerConnection(dir); err != nil || info.Address != "https://"+second.Addr {
		t.Fatal("new connection missing", info, err)
	}
	if matches, err := a.MatchingServerFolders(first.Code, []string{dir}); err != nil || len(matches) != 0 {
		t.Fatal("suggested a folder attached to a different server", matches, err)
	}
	if err := a.JoinSpaceServer(first.Code, dir); !errors.Is(err, syncclient.ErrSpace) {
		t.Fatal("rejoined a different server with matching lineage", err)
	}
}

func TestEncryptedAttachmentThroughServer(t *testing.T) {
	a, _ := testStore(t)
	server := startPasswordTestService(t, "Local attachment sync password")
	one, two := t.TempDir(), t.TempDir()
	const name = "PRIVATE-FOLDER-NAME"
	const imageMarker = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo1"
	const title = "PRIVATE-ATTACHMENT-TITLE"
	image := "data:image/png;base64," + strings.Repeat(imageMarker, separateStringBytes/len(imageMarker)+2)
	doc := func(caption string) string {
		data, err := json.Marshal(map[string]any{
			"name": name, "areas": []any{}, "notes": []any{map[string]any{
				"id": "a", "title": title, "body": []any{map[string]string{"type": "image", "src": image, "caption": caption}},
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if err := a.CreateFolderSpace(one, doc("PRIVATE-OLD-CAPTION"), testPass); err != nil {
		t.Fatal(err)
	}
	if err := a.ConnectSpaceServer(one, server.Code); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveFolderBranch(one, doc("PRIVATE-NEW-CAPTION")); err != nil {
		t.Fatal(err)
	}
	if _, err := a.SyncSpaceServer(one); err != nil {
		t.Fatal(err)
	}
	if err := a.JoinSpaceServer(server.Code, two); err != nil {
		t.Fatal(err)
	}
	if _, err := a.OpenFolderSpace(two, ""); !errors.Is(err, errLocked) {
		t.Fatal("joined folder did not require its password", err)
	}
	if _, err := a.OpenFolderSpace(two, testPass); err != nil {
		t.Fatal(err)
	}
	update, err := a.PollFolderSpace(two, true)
	if err != nil || !strings.Contains(update.Remote, image) || !strings.Contains(update.Remote, "PRIVATE-NEW-CAPTION") {
		t.Fatal("attachment or caption did not round-trip", err)
	}
	if err := a.CommitFolderMerge(two, update.Token, update.Remote); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{one, two, filepath.Join(server.Dir, "space")} {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for _, marker := range []string{name, title, imageMarker, "PRIVATE-OLD-CAPTION", "PRIVATE-NEW-CAPTION", testPass} {
				if strings.Contains(d.Name(), marker) || bytes.Contains(data, []byte(marker)) {
					t.Errorf("plaintext in %s", d.Name())
					break
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestSyncSaveDuringObjectUpload(t *testing.T) {
	a, _ := testStore(t)
	folder := t.TempDir()
	if err := a.CreateFolderSpace(folder, syncDoc("original", "unchanged"), ""); err != nil {
		t.Fatal(err)
	}
	lineage, err := a.FolderSpaceLineage(folder)
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
			if err := a.SaveFolderBranch(folder, syncDoc("edited during upload", "unchanged")); err != nil {
				t.Fatal(err)
			}
		}
		if strings.HasPrefix(path, prefix+"revisions/") {
			revisions++
			var r spaceRevision
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
		if err := p.Exchange(client, folder, m, a.syncSession().transferRecord, publishNewSpaceFile); err != nil {
			t.Fatal(err)
		}
		if revisions != pass {
			t.Fatalf("pass %d: server has %d revisions", pass, revisions)
		}
	}
}

func TestSyncServiceProcess(t *testing.T) { synctest.RunServerProcess(t) }

func startPasswordTestService(t *testing.T, password string) *synctest.Server {
	t.Helper()
	return synctest.NewServer(t, password)
}

func TestLiveSyncTwoDesktops(t *testing.T) {
	a, _ := testStore(t)
	b := new(App)
	if _, err := b.Load(); err != nil {
		t.Fatal(err)
	}
	const serverPassword = "Local test sync access"
	server := startPasswordTestService(t, serverPassword)
	if _, err := a.VerifySyncServer(server.Addr, "incorrect"); !errors.Is(err, syncclient.ErrAuth) {
		t.Fatal("incorrect server password", err)
	}
	first, err := a.VerifySyncServer(server.Addr, serverPassword)
	if err != nil || first.Address == "" || first.Ticket == "" || first.HasSpace {
		t.Fatal("first desktop verification", err)
	}
	one, two := t.TempDir(), t.TempDir()
	if err = a.CreateFolderSpace(one, syncDoc("first", "second"), testPass); err != nil {
		t.Fatal(err)
	}
	if err = a.ConnectSpaceServer(one, first.Ticket); err != nil {
		t.Fatal(err)
	}
	firstInfo, err := a.ServerConnection(one)
	if err != nil || firstInfo.Address != first.Address || firstInfo.Transport != syncclient.TransportDirect || firstInfo.LastSync <= 0 {
		t.Fatal("connected folder details", firstInfo, err)
	}
	second, err := b.VerifySyncServer(server.Addr, serverPassword)
	if err != nil || !second.HasSpace {
		t.Fatal("verification did not report the published space", err)
	}
	if err = b.JoinSpaceServer(second.Ticket, two); err != nil {
		t.Fatal(err)
	}
	b.DiscardSyncServerTicket(second.Ticket)
	if _, err := b.resolveServerTicket(second.Ticket); !errors.Is(err, errServerTicket) {
		t.Fatal("discarded credentials usable", err)
	}
	if _, err = b.OpenFolderSpace(two, "incorrect password"); !errors.Is(err, errPassword) {
		t.Fatal(err)
	}
	if _, err = b.OpenFolderSpace(two, testPass); err != nil {
		t.Fatal(err)
	}
	if info, err := b.ServerConnection(two); err != nil || info.Address != second.Address || info.Transport != syncclient.TransportDirect || info.LastSync <= 0 {
		t.Fatal(info, err)
	}
	if _, err = b.PollFolderSpace(two, true); err != nil {
		t.Fatal(err)
	}

	server.Stop()
	if _, err = a.SyncSpaceServer(one); !errors.Is(err, syncclient.ErrOffline) {
		t.Fatal("offline not reported", err)
	}
	if info, err := a.ServerConnection(one); err != nil || info != firstInfo {
		t.Fatal("offline failure changed the last successful sync", info, err)
	}
	if err = a.SaveFolderBranch(one, syncDoc("LIVE-LAPTOP-SENTINEL", "second")); err != nil {
		t.Fatal(err)
	}
	if err = b.SaveFolderBranch(two, syncDoc("first", "LIVE-DESKTOP-SENTINEL")); err != nil {
		t.Fatal(err)
	}
	server.Start(t)
	cursor, err := b.SyncSpaceServer(two)
	if err != nil {
		t.Fatal(err)
	}
	// Complete our own upload before subscribing. A's new files wake the request.
	cursor, err = b.SyncSpaceServer(two)
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan error, 1)
	go func() {
		next, e := b.WaitSpaceServerChange(two, cursor)
		if e == nil && next == cursor {
			e = errors.New("server cursor did not advance")
		}
		events <- e
	}()
	if _, err = a.SyncSpaceServer(one); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-events:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("live update was not delivered")
	}
	incoming, err := a.PollFolderSpace(one, true)
	if err != nil || incoming.Token == "" {
		t.Fatal(incoming.Token, err)
	}
	sameDoc(t, incoming.Base, "first", "second")
	sameDoc(t, incoming.Remote, "first", "LIVE-DESKTOP-SENTINEL")
	if err = a.SaveFolderBranch(one, syncDoc("LIVE-LAPTOP-SECOND-EDIT", "second")); err != nil {
		t.Fatal(err)
	}
	if err = a.CommitFolderMerge(one, incoming.Token, syncDoc("stale", "choice")); !errors.Is(err, errChanged) {
		t.Fatal("accepted old merge", err)
	}
	incoming, err = a.PollFolderSpace(one, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.CommitFolderMerge(one, incoming.Token, syncDoc("LIVE-LAPTOP-SECOND-EDIT", "LIVE-DESKTOP-SENTINEL")); err != nil {
		t.Fatal(err)
	}
	if _, err = a.SyncSpaceServer(one); err != nil {
		t.Fatal(err)
	}
	if _, err = b.SyncSpaceServer(two); err != nil {
		t.Fatal(err)
	}
	incoming, err = b.PollFolderSpace(two, true)
	if err != nil || incoming.Token == "" {
		t.Fatal("no combined remote version", err)
	}
	sameDoc(t, incoming.Remote, "LIVE-LAPTOP-SECOND-EDIT", "LIVE-DESKTOP-SENTINEL")
	if err = b.CommitFolderMerge(two, incoming.Token, incoming.Remote); err != nil {
		t.Fatal(err)
	}
	if u, e := b.PollFolderSpace(two, false); e != nil || u.Token != "" {
		t.Fatal("repeated conflict", e)
	}

	copyDir := t.TempDir()
	if err = b.JoinSpaceServer(server.Code, copyDir); err != nil {
		t.Fatal(err)
	}
	if _, err = b.OpenFolderSpace(copyDir, testPass); err != nil {
		t.Fatal(err)
	}
	profileDir := canonicalTestFolder(t, copyDir)
	legacy, err := loadProfile(profileDir)
	if err != nil || legacy == nil || legacy.Transport != syncclient.TransportDirect || legacy.LastSync <= 0 {
		t.Fatal("pairing link did not persist actual connection details", err)
	}
	legacy.Transport, legacy.LastSync = "", 0
	if err = storeProfile(profileDir, *legacy); err != nil {
		t.Fatal(err)
	}
	if info, err := b.ServerConnection(copyDir); err != nil || info.Address != first.Address || info.Transport != "" || info.LastSync != 0 {
		t.Fatal("legacy connection details", info, err)
	}
	if _, err = b.SyncSpaceServer(copyDir); err != nil {
		t.Fatal(err)
	}
	if info, err := b.ServerConnection(copyDir); err != nil || info.Transport != syncclient.TransportDirect || info.LastSync <= 0 {
		t.Fatal("sync did not refresh the legacy profile", info, err)
	}
	incoming, err = b.PollFolderSpace(copyDir, true)
	if err != nil {
		t.Fatal(err)
	}
	sameDoc(t, incoming.Remote, "LIVE-LAPTOP-SECOND-EDIT", "LIVE-DESKTOP-SENTINEL")
	unrelated := t.TempDir()
	if err = b.CreateFolderSpace(unrelated, syncDoc("different", "space"), testPass); err != nil {
		t.Fatal(err)
	}
	if err = b.ConnectSpaceServer(unrelated, server.Code); !errors.Is(err, syncclient.ErrSpace) {
		t.Fatal("connected a different space", err)
	}
	profile, e := syncclient.ParsePairCode(server.Code)
	if e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		pin, token string
		expected   error
	}{{strings.Repeat("0", 64), profile.Token, syncclient.ErrCert}, {profile.Pin, strings.Repeat("0", 64), syncclient.ErrAuth}} {
		code := "videron-sync://" + server.Addr + "#" + tc.pin + "." + tc.token
		if err = a.ConnectSpaceServer(one, code); !errors.Is(err, tc.expected) {
			t.Fatal("accepted wrong credentials", err)
		}
	}
	if _, err = a.SyncSpaceServer(one); err != nil {
		t.Fatal("failed pairing lost previous connection", err)
	}
	server.Stop()
	err = filepath.WalkDir(server.Dir, func(path string, e fs.DirEntry, err error) error {
		if err != nil || e.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if bytes.Contains(data, []byte("LIVE-LAPTOP")) || bytes.Contains(data, []byte("LIVE-DESKTOP")) || bytes.Contains(data, []byte(testPass)) {
			t.Fatal("server retained decrypted user data", filepath.Base(path))
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestServerAutoConnectAcrossRestarts(t *testing.T) {
	a, _ := testStore(t)
	server := startPasswordTestService(t, "Temporary sync service passphrase")
	dir := t.TempDir()
	if err := a.CreateFolderSpace(dir, syncDoc("first", "second"), testPass); err != nil {
		t.Fatal(err)
	}
	if err := a.ConnectSpaceServer(dir, server.Code); err != nil {
		t.Fatal(err)
	}
	expect := func(app *App, folder string, enabled bool) {
		t.Helper()
		info, err := app.ServerConnection(folder)
		if err != nil || info.Address == "" || info.AutoConnect != enabled {
			t.Fatalf("expected stored auto-connect=%v, got %v (err %v)", enabled, info.AutoConnect, err)
		}
	}
	// As in profiles created before the preference existed, the default is
	// serialized without a setting. A paused copy keeps its credentials.
	expect(a, dir, true)
	if err := a.SetServerAutoConnect(dir, false); err != nil {
		t.Fatal(err)
	}
	a.FinishClose()
	b := new(App)
	if _, err := b.Load(); err != nil {
		t.Fatal(err)
	}
	if err := b.SetServerAutoConnect(dir, true); !errors.Is(err, errLocked) {
		t.Fatal("updated a closed encrypted working copy", err)
	}
	if _, err := b.OpenFolderSpace(dir, testPass); err != nil {
		t.Fatal(err)
	}
	expect(b, dir, false)
	if cursor, err := b.SyncSpaceServer(dir); err != nil || cursor == "" {
		t.Fatal("manual sync after restart", err)
	}
	if err := b.JoinSpaceServer(server.Code, dir); err != nil {
		t.Fatal("rejoining the working copy", err)
	}
	expect(b, dir, false)

	ticket, err := b.ConnectedServerTicket(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer b.DiscardSyncServerTicket(ticket.Ticket)
	other := t.TempDir()
	if err = b.JoinSpaceServer(ticket.Ticket, other); err != nil {
		t.Fatal(err)
	}
	if _, err = b.OpenFolderSpace(other, testPass); err != nil {
		t.Fatal(err)
	}
	expect(b, other, true)
	if err = b.SetServerAutoConnect(dir, true); err != nil {
		t.Fatal(err)
	}
	expect(b, dir, true)
	if err = b.DisconnectSpaceServer(dir); err != nil {
		t.Fatal(err)
	}
	if err = b.SetServerAutoConnect(dir, true); !errors.Is(err, errChanged) {
		t.Fatal("stale setting update on a detached working copy", err)
	}
	if info, err := b.ServerConnection(dir); err != nil || info.Address != "" {
		t.Fatal("manual disconnect was lost", err)
	}
}

func TestRejoinWorkingFolder(t *testing.T) {
	for _, tc := range []struct{ name, password string }{{"plain", ""}, {"encrypted", testPass}} {
		t.Run(tc.name, func(t *testing.T) {
			a, _ := testStore(t)
			b := new(App)
			if _, err := b.Load(); err != nil {
				t.Fatal(err)
			}
			server := startPasswordTestService(t, "Sync server access")
			original, copyDir := t.TempDir(), t.TempDir()
			if err := a.CreateFolderSpace(original, syncDoc("first", "second"), tc.password); err != nil {
				t.Fatal(err)
			}
			if err := a.ConnectSpaceServer(original, server.Code); err != nil {
				t.Fatal(err)
			}
			if err := b.JoinSpaceServer(server.Code, copyDir); err != nil {
				t.Fatal(err)
			}
			if _, err := b.OpenFolderSpace(copyDir, tc.password); err != nil {
				t.Fatal(err)
			}
			if err := b.DisconnectSpaceServer(copyDir); err != nil {
				t.Fatal(err)
			}
			if err := b.SaveFolderBranch(copyDir, syncDoc("local branch", "second")); err != nil {
				t.Fatal(err)
			}
			if err := a.SaveFolderBranch(original, syncDoc("first", "remote branch")); err != nil {
				t.Fatal(err)
			}
			if _, err := a.SyncSpaceServer(original); err != nil {
				t.Fatal(err)
			}
			// A legacy writer updated the main without publishing its revision.
			// It retained the tracked head, so the edit has a known parent.
			s, err := b.currentSpaceSession(copyDir)
			if err != nil {
				t.Fatal(err)
			}
			main := filepath.Join(copyDir, folderSpaceFilename)
			edit, err := encodeTrackedSpace(syncDoc("uncaptured edit", "second"), s.sync.meta, s.key)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = writeAtomic(main, edit, ".test-main-*"); err != nil {
				t.Fatal(err)
			}
			b.CloseFolderSpace(copyDir)

			unrelated := t.TempDir()
			if err = b.CreateFolderSpace(unrelated, syncDoc("first", "second"), tc.password); err != nil {
				t.Fatal(err)
			}
			otherMain := filepath.Join(unrelated, folderSpaceFilename)
			before := stored(t, otherMain)
			if err = b.JoinSpaceServer(server.Code, unrelated); !errors.Is(err, syncclient.ErrSpace) {
				t.Fatal("joined an unrelated space", err)
			}
			if got, err := os.ReadDir(unrelated); err != nil || len(got) != 1 || !bytes.Equal(before, stored(t, otherMain)) {
				t.Fatal("changed the unrelated folder", got, err)
			}
			userFile := filepath.Join(copyDir, "personal.txt")
			if err = os.WriteFile(userFile, []byte("keep me"), 0600); err != nil {
				t.Fatal(err)
			}
			verified, err := b.VerifySyncServer(server.Addr, "Sync server access")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { b.DiscardSyncServerTicket(verified.Ticket) })
			profileDir := canonicalTestFolder(t, copyDir)
			candidates, err := b.MatchingServerFolders(verified.Ticket, []string{unrelated, copyDir, profileDir, t.TempDir()})
			if err != nil || len(candidates) != 1 || spaceSessionID(candidates[0]) != spaceSessionID(profileDir) {
				t.Fatal("expected only the disconnected working folder", candidates, err)
			}
			if tc.password != "" {
				if err = b.JoinSpaceServer(verified.Ticket, copyDir); !errors.Is(err, errLocked) {
					t.Fatal("encrypted rejoin must authenticate the document", err)
				}
				if p, err := loadProfile(profileDir); err != nil || p != nil {
					t.Fatal("locked candidate acquired a profile", err)
				}
				if _, err = b.OpenFolderSpace(copyDir, tc.password); err != nil {
					t.Fatal(err)
				}
			}
			if err = b.JoinSpaceServer(verified.Ticket, copyDir); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(edit, stored(t, main)) || string(stored(t, userFile)) != "keep me" {
				t.Fatal("rejoining replaced local files")
			}
			local, err := b.OpenFolderSpace(copyDir, tc.password)
			if err != nil {
				t.Fatal(err)
			}
			sameDoc(t, local, "uncaptured edit", "second")
			if info, err := b.ServerConnection(copyDir); err != nil || info.Address != verified.Address || info.LastSync == 0 {
				t.Fatal("rejoin did not restore the connection", info, err)
			}
			incoming, err := b.PollFolderSpace(copyDir, true)
			if err != nil || incoming.Token == "" {
				t.Fatal("rejoin did not download remote changes", err)
			}
			sameDoc(t, incoming.Remote, "first", "remote branch")
			if _, err = a.SyncSpaceServer(original); err != nil {
				t.Fatal(err)
			}
			update, err := a.PollFolderSpace(original, true)
			if err != nil || update.Token == "" {
				t.Fatal("rejoin did not exchange offline changes", err)
			}
			sameDoc(t, update.Base, "first", "second")
			sameDoc(t, update.Remote, "uncaptured edit", "second")
		})
	}
}

func TestRejoinChecksCurrentServerAndDocument(t *testing.T) {
	a, _ := testStore(t)
	server := startPasswordTestService(t, "Sync server access")
	dir := t.TempDir()
	if err := a.CreateFolderSpace(dir, syncDoc("local", "space"), ""); err != nil {
		t.Fatal(err)
	}
	if err := a.ConnectSpaceServer(dir, server.Code); err != nil {
		t.Fatal(err)
	}
	ticket, err := a.VerifySyncServer(server.Addr, "Sync server access")
	if err != nil {
		t.Fatal(err)
	}
	defer a.DiscardSyncServerTicket(ticket.Ticket)
	if err = a.SaveFolderBranch(dir, syncDoc("offline", "edit")); err != nil {
		t.Fatal(err)
	}
	profileDir := canonicalTestFolder(t, dir)
	profile, err := loadProfile(profileDir)
	if err != nil || profile == nil {
		t.Fatal("missing original profile", err)
	}
	client := profile.Client()
	defer client.CloseIdleConnections()
	original, err := profile.Manifest(client)
	if err != nil {
		t.Fatal(err)
	}
	// Replace the local document while its old profile, history and open
	// session are all present. Those markers alone must never authorize a join.
	other := t.TempDir()
	if err = a.CreateFolderSpace(other, syncDoc("different", "space"), ""); err != nil {
		t.Fatal(err)
	}
	main := filepath.Join(dir, folderSpaceFilename)
	local := stored(t, main)
	foreign := stored(t, filepath.Join(other, folderSpaceFilename))
	if _, err = writeAtomic(main, foreign, ".replacement-*"); err != nil {
		t.Fatal(err)
	}
	if err = a.JoinSpaceServer(ticket.Ticket, dir); !errors.Is(err, syncclient.ErrSpace) {
		t.Fatal("stale history authorized unrelated document", err)
	}
	after, err := profile.Manifest(client)
	if err != nil || !maps.Equal(original.Files, after.Files) || !bytes.Equal(foreign, stored(t, main)) {
		t.Fatal("failed join changed data", err)
	}
	if _, err = writeAtomic(main, local, ".restored-*"); err != nil {
		t.Fatal(err)
	}
	server.Stop()
	if err = os.Rename(filepath.Join(server.Dir, "space"), filepath.Join(server.Dir, "old-space")); err != nil {
		t.Fatal(err)
	}
	server.Start(t)
	if err = a.JoinSpaceServer(ticket.Ticket, dir); !errors.Is(err, syncclient.ErrEmpty) {
		t.Fatal("seeded a reset server during reopen", err)
	}
	empty, err := profile.Manifest(client)
	if err != nil || empty.Main != "" || len(empty.Files) != 0 {
		t.Fatal("empty server changed", err)
	}
	if err = a.ConnectSpaceServer(other, server.Code); err != nil {
		t.Fatal(err)
	}
	// Although this server and destination now match each other, the verified
	// ticket still names the space the user saw before the reset.
	if err = a.JoinSpaceServer(ticket.Ticket, other); !errors.Is(err, syncclient.ErrSpace) {
		t.Fatal("accepted a different space after verification", err)
	}
	if err = a.JoinSpaceServer(server.Code, dir); !errors.Is(err, syncclient.ErrSpace) {
		t.Fatal("attached the old local folder to a replacement space", err)
	}
	last, err := loadProfile(profileDir)
	if err != nil || last == nil || *last != *profile || !bytes.Equal(local, stored(t, main)) {
		t.Fatal("failed reopen replaced main or profile", err)
	}
}

func TestEncryptedSyncUploadBodies(t *testing.T) {
	a, _ := testStore(t)
	folder := t.TempDir()
	server := startPasswordTestService(t, "Temporary sync service passphrase")
	// A large unmodified value shares this space with the edited note.
	large := strings.Repeat("unmodified-data-", 1<<16)
	doc := func(title string) string {
		return strings.Replace(syncDoc(title, "Data"), `"title":"Data"`, `"title":"Data","dataText":"`+large+`"`, 1)
	}
	if err := a.CreateFolderSpace(folder, doc("Note"), testPass); err != nil {
		t.Fatal(err)
	}
	if err := a.ConnectSpaceServer(folder, server.Code); err != nil {
		t.Fatal(err)
	}
	profileDir := canonicalTestFolder(t, folder)
	p, err := loadProfile(profileDir)
	if err != nil || p == nil {
		t.Fatal("missing test profile", err)
	}
	cache, err := a.sessionServerIndex(folder, p.Lineage)
	if err != nil || cache.Cursor() == "" {
		t.Fatal("first sync would redownload the enrollment index", err)
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
			if _, err = vault.ParseEnvelope(body, syncScope); err != nil {
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
		if err = p.Exchange(client, profileDir, m, a.syncSession().transferRecord, publishNewSpaceFile); err != nil {
			t.Fatal(err)
		}
	}
	syncFiles()
	if err := a.SaveFolderBranch(folder, doc("Notes")); err != nil {
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
	a.CloseFolderSpace(folder)
	if _, err := a.OpenFolderSpace(folder, testPass); err != nil {
		t.Fatal(err)
	}
	fresh, err := a.sessionServerIndex(folder, p.Lineage)
	if err != nil || fresh == cache || fresh.Cursor() != "" {
		t.Fatal("closed folder retained its old session's index", err)
	}
}
