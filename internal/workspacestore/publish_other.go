//go:build !windows

package workspacestore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func SupportedFile(_ string, info os.FileInfo) bool { return info.Mode().IsRegular() }

// Both names are in the same directory. WriteAtomicInDir removes the temporary
// name after this link publishes the complete file without replacing anything.
func PublishNewFile(temp, path string) error {
	return os.Link(temp, path)
}

func WithWriteLock(path string, action func() error) error {
	file, _, err := OpenFile(path)
	if errors.Is(err, ErrMissing) || errors.Is(err, errInvalid) {
		return errChanged
	}
	if err != nil {
		return err
	}
	defer file.Close()
	if err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) {
			return errChanged
		}
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	return action()
}

func deleteSpaceFile(session *Session) error {
	if err := session.verifyCurrent(); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(session.path), ".videron-removing-*.tmp")
	if err != nil {
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	name := temp.Name()
	if err = temp.Close(); err != nil {
		os.Remove(name)
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	if err = os.Rename(session.path, name); err != nil {
		os.Remove(name)
		if errors.Is(err, os.ErrNotExist) {
			return errChanged
		}
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	// A sync client could have replaced the path after verification. Only
	// unlink the captured file if it still has the identity and bytes we opened.
	captured := *session
	captured.path = name
	if err = captured.verifyCurrent(); err != nil {
		if restore := PublishNewFile(name, session.path); restore != nil {
			return fmt.Errorf("VD_CHANGED|%s", name)
		}
		os.Remove(name)
		return errChanged
	}
	if err = os.Remove(name); err != nil {
		if restore := PublishNewFile(name, session.path); restore == nil {
			os.Remove(name)
		}
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	return nil
}
