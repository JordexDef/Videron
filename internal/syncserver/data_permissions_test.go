//go:build unix

package syncserver

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServerDataDirectoryPermissions(t *testing.T) {
	dir := t.TempDir()
	for _, mode := range []os.FileMode{0770, 0707} {
		if err := os.Chmod(dir, mode); err != nil {
			t.Fatal(err)
		}
		for _, flags := range [][]string{nil, {"-password-status"}, {"-set-password"}, {"-pair"}} {
			err := RunWithInput(append(flags, "-data", dir), strings.NewReader("test password"), io.Discard, io.Discard)
			if err == nil || !strings.Contains(err.Error(), "0700") {
				t.Fatalf("mode %o, flags %v: expected permission guidance, got %v", mode, flags, err)
			}
		}
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
		t.Fatalf("state changed before permission check: %v, %v", entries, err)
	}
	// A legacy directory may allow listing while its files remain private.
	if err := os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := RunWithInput([]string{"-set-password", "-data", dir}, strings.NewReader("test password"), io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 {
		t.Fatalf("identity permissions = %o", info.Mode().Perm())
	}
}
