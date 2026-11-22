package syncserver

import (
	"errors"
	"io/fs"
	"os"
)

// One writer process owns the directory. OS locks are released after a crash;
// -pair can still read the already published identity while the service runs.
func lockServer(root *os.Root) (*os.File, error) {
	info, err := root.Lstat("server.lock")
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("invalid lock file")
	}
	f, err := root.OpenFile("server.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lockExclusive(f); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
