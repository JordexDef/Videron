// Package synctest runs the shipped HTTPS server in an isolated working directory.
package synctest

import (
	"bytes"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"videron/internal/syncserver"
)

// Server can be stopped and restarted with the same data, certificate and port.
type Server struct {
	Dir, Addr, Code string
	process         *exec.Cmd
}

// RunServerProcess is the body of TestSyncServiceProcess in each test binary.
func RunServerProcess(t *testing.T) {
	t.Helper()
	dir := os.Getenv("VIDERON_TEST_SERVICE_DIR")
	if dir == "" {
		return
	}
	if err := syncserver.Run([]string{"-listen", os.Getenv("VIDERON_TEST_SERVICE_ADDR"), "-data", dir}, os.Stdout, io.Discard); err != nil {
		t.Fatal(err)
	}
}

func NewServer(t *testing.T, password string) *Server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Dir: t.TempDir(), Addr: ln.Addr().String()}
	_ = ln.Close()
	if err := syncserver.RunWithInput([]string{"-set-password", "-data", s.Dir}, strings.NewReader(password+"\n"), io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	var pair bytes.Buffer
	if err := syncserver.Run([]string{"-pair", "-public", s.Addr, "-data", s.Dir}, &pair, io.Discard); err != nil {
		t.Fatal(err)
	}
	s.Code = strings.TrimSpace(pair.String())
	t.Cleanup(s.Stop)
	s.Start(t)
	return s
}

func (s *Server) Start(t *testing.T) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestSyncServiceProcess$")
	cmd.Env = append(os.Environ(), "VIDERON_TEST_SERVICE_DIR="+s.Dir, "VIDERON_TEST_SERVICE_ADDR="+s.Addr)
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s.process = cmd
	deadline := time.Now().Add(10 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", s.Addr, 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("sync test server did not start: %v", err)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func (s *Server) Stop() {
	if s.process != nil {
		_ = s.process.Process.Kill()
		_ = s.process.Wait()
		s.process = nil
	}
}
