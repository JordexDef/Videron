package desktop

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	wails "github.com/wailsapp/wails/v2/pkg/runtime"
)

var (
	ErrFolderInvalid = errors.New("VD_FOLDER_INVALID")
	ErrFolderMissing = errors.New("VD_FOLDER_MISSING")
	ErrFolderAccess  = errors.New("VD_FOLDER_ACCESS")
	ErrFolderOpen    = errors.New("VD_FOLDER_OPEN")
)

func PickFolder(ctx context.Context, title string) (string, error) {
	path, err := wails.OpenDirectoryDialog(ctx, wails.OpenDialogOptions{Title: title})
	if err != nil {
		return "", ErrFolderOpen
	}
	if path == "" {
		return "", nil
	}
	return ExistingFolder(path)
}

func OpenFolder(path string) error {
	dir, err := ExistingFolder(path)
	if err != nil {
		return err
	}
	if err := showFolder(dir); err != nil {
		return ErrFolderOpen
	}
	return nil
}

func ExistingFolder(path string) (string, error) {
	if !filepath.IsAbs(path) || strings.IndexByte(path, 0) >= 0 {
		return "", ErrFolderInvalid
	}
	if runtime.GOOS == "windows" {
		// A UNC share is a filesystem location. Win32 devices and the NT
		// object namespace are not valid Explorer destinations.
		volume := filepath.VolumeName(path)
		if serverShare, unc := strings.CutPrefix(filepath.ToSlash(volume), "//"); unc {
			server, share, ok := strings.Cut(serverShare, "/")
			if !ok || server == "" || server == "." || server == ".." ||
				share == "" || share == "." || share == ".." || strings.ContainsAny(serverShare, "?:") {
				return "", ErrFolderInvalid
			}
		} else if len(volume) != 2 || volume[1] != ':' ||
			!((volume[0] >= 'a' && volume[0] <= 'z') || (volume[0] >= 'A' && volume[0] <= 'Z')) {
			return "", ErrFolderInvalid
		}
		if strings.Contains(path[len(volume):], ":") {
			return "", ErrFolderInvalid
		}
	}
	clean := filepath.Clean(path)
	info, err := os.Stat(clean)
	if errors.Is(err, os.ErrNotExist) {
		return "", ErrFolderMissing
	}
	if err != nil {
		return "", ErrFolderAccess
	}
	if !info.IsDir() {
		return "", ErrFolderInvalid
	}
	return clean, nil
}
