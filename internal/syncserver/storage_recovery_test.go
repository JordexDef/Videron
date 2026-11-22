package syncserver

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"strings"
	"testing"
)

func TestRecoverInterruptedServerWrites(t *testing.T) {
	root := testRoot(t)
	setPassword := func() error {
		return RunWithInput([]string{"-set-password", "-data", root.Name()}, strings.NewReader("Temporary server passphrase\n"), io.Discard, io.Discard)
	}
	if err := setPassword(); err != nil {
		t.Fatal(err)
	}
	stage := func(r *os.Root) string {
		t.Helper()
		name, _, err := stageFile(r, strings.NewReader("unfinished synthetic upload"))
		if err != nil {
			t.Fatal(err)
		}
		return name
	}
	exists := func(r *os.Root, name string, want bool) {
		t.Helper()
		_, err := r.Lstat(name)
		if want && err != nil || !want && !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("expected %s to exist=%t, stat: %v", name, want, err)
		}
	}

	lock, err := lockServer(root)
	if err != nil {
		t.Fatal(err)
	}
	// Read-only CLI commands may run while an identity write is pending.
	pendingIdentity := stage(root)
	for _, mode := range []string{"-password-status", "-pair"} {
		if err := Run([]string{mode, "-data", root.Name(), "-public", "localhost:8743"}, io.Discard, io.Discard); err != nil {
			lock.Close()
			t.Fatal(err)
		}
		exists(root, pendingIdentity, true)
	}
	if err := setPassword(); err == nil {
		lock.Close()
		t.Fatal("a second writer acquired the directory")
	}
	exists(root, pendingIdentity, true)
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if err := setPassword(); err != nil {
		t.Fatal(err)
	}
	exists(root, pendingIdentity, false)
	exists(root, "identity.json", true)

	c, err := openProjectCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	pendingMetadata := stage(c.root)
	s, err := openStore(root)
	if err != nil {
		t.Fatal(err)
	}
	pendingBlob := stage(s.root)
	const unrelated = ".upload-local-backup"
	if err := s.root.WriteFile(unrelated, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	dir := ".upload-" + strings.Repeat("a", 32)
	if err := s.root.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	s.root.Close()
	c.close()
	c, err = openProjectCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	exists(c.root, pendingMetadata, false)
	p, err := c.acquire("")
	if err != nil {
		t.Fatal(err)
	}
	defer p.active.Done()
	exists(p.data.root, pendingBlob, false)
	exists(p.data.root, unrelated, true)
	exists(p.data.root, dir, true)
	activeUpload := stage(p.data.root)
	second, err := c.acquire("")
	if err != nil {
		t.Fatal(err)
	}
	defer second.active.Done()
	exists(second.data.root, activeUpload, true)
}
