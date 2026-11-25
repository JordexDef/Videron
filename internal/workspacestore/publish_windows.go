package workspacestore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func SupportedFile(path string, info os.FileInfo) bool {
	if info.Mode().IsRegular() {
		return true
	}
	// OneDrive Files On-Demand can present regular documents as cloud reparse
	// points. Name-surrogate reparse points (junctions and symlinks) redirect
	// the path elsewhere and must not be used as the space document.
	if info.Mode().Type() != os.ModeIrregular {
		return false
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	var entry windows.Win32finddata
	h, err := windows.FindFirstFile(name, &entry)
	if err != nil {
		return false
	}
	windows.FindClose(h)
	return entry.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 && entry.Reserved0&0x20000000 == 0
}

// With no REPLACE_EXISTING flag this is an atomic, no-clobber publication,
// including on volumes that do not support hard links.
func PublishNewFile(temp, path string) error {
	source, err := windows.UTF16PtrFromString(temp)
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(source, target, windows.MOVEFILE_WRITE_THROUGH)
}

// Keep the document itself closed at replacement time: FAT and some cloud
// drivers cannot atomically replace an open target. The marker has no content,
// is created exclusively and is removed by Windows even if the process exits.
func WithWriteLock(path string, action func() error) error {
	name, err := windows.UTF16PtrFromString(filepath.Join(filepath.Dir(path), "~$"+filepath.Base(path)+".lock.tmp"))
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(name, windows.DELETE, 0, nil, windows.CREATE_NEW,
		windows.FILE_FLAG_DELETE_ON_CLOSE|windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_TEMPORARY, 0)
	if errors.Is(err, os.ErrExist) || errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		return errChanged
	}
	if err != nil {
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	defer windows.CloseHandle(h)
	return action()
}

func deleteSpaceFile(session *Session) error {
	path, err := windows.UTF16PtrFromString(session.path)
	if err != nil {
		return errInvalid
	}
	info, err := os.Lstat(session.path)
	if errors.Is(err, os.ErrNotExist) {
		return errChanged
	}
	if err != nil {
		return fmt.Errorf("VD_READ|%w", err)
	}
	if !SupportedFile(session.path, info) {
		return errChanged
	}
	// Hold write and rename exclusion through verification, then delete the
	// very same open handle. No other file arriving at the path can be removed.
	h, err := windows.CreateFile(path, windows.GENERIC_READ|windows.DELETE, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, 0, 0)
	if errors.Is(err, os.ErrNotExist) {
		return errChanged
	}
	if err != nil {
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	file := os.NewFile(uintptr(h), session.path)
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return fmt.Errorf("VD_READ|%w", err)
	}
	if err = session.verifyFile(file, opened); err != nil {
		return err
	}
	dispose := byte(1)
	if err = windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, &dispose, 1); err != nil {
		return fmt.Errorf("VD_WRITE|%w", err)
	}
	return nil
}
