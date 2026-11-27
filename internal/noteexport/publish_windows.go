package noteexport

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func publish(root *os.Root, from, to string) error {
	// Resolve the directory's current path for MoveFileEx, even if it was
	// renamed while the staged export was being written.
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	parent, err := directoryPath(windows.Handle(dir.Fd()))
	if err != nil {
		return err
	}
	// filepath.Join can collapse the extended-length prefix when it cleans a
	// UNC path. Both names are already single, validated path components.
	parent = strings.TrimSuffix(parent, string(filepath.Separator)) + string(filepath.Separator)
	source, err := windows.UTF16PtrFromString(parent + from)
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(parent + to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(source, target, windows.MOVEFILE_WRITE_THROUGH)
}

func directoryPath(handle windows.Handle) (string, error) {
	buf := make([]uint16, 512)
	for {
		n, err := windows.GetFinalPathNameByHandle(handle, &buf[0], uint32(len(buf)), 0)
		if err != nil {
			return "", err
		}
		if n < uint32(len(buf)) {
			return windows.UTF16ToString(buf[:n]), nil
		}
		buf = make([]uint16, int(n)+1)
	}
}
