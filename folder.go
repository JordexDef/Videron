package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	wails "github.com/wailsapp/wails/v2/pkg/runtime"
)

var (
	errFolderInvalid = errors.New("VD_FOLDER_INVALID")
	errFolderMissing = errors.New("VD_FOLDER_MISSING")
	errFolderAccess  = errors.New("VD_FOLDER_ACCESS")
	errFolderOpen    = errors.New("VD_FOLDER_OPEN")
)

func (a *App) PickFolder(language string) (string, error) {
	title := "Выберите папку"
	if language == "en" {
		title = "Choose a folder"
	}
	path, err := wails.OpenDirectoryDialog(a.ctx, wails.OpenDialogOptions{Title: title})
	if err != nil {
		return "", errFolderOpen
	}
	if path == "" {
		return "", nil
	}
	return existingFolder(path)
}

func (a *App) OpenFolder(path string) error {
	dir, err := existingFolder(path)
	if err != nil {
		return err
	}
	if err := showFolder(dir); err != nil {
		return errFolderOpen
	}
	return nil
}

func existingFolder(path string) (string, error) {
	if !filepath.IsAbs(path) || strings.IndexByte(path, 0) >= 0 {
		return "", errFolderInvalid
	}
	if runtime.GOOS == "windows" {
		// A UNC share is a filesystem location. Win32 devices and the NT
		// object namespace are not valid Explorer destinations.
		volume := filepath.VolumeName(path)
		if serverShare, unc := strings.CutPrefix(filepath.ToSlash(volume), "//"); unc {
			server, share, ok := strings.Cut(serverShare, "/")
			if !ok || server == "" || server == "." || server == ".." ||
				share == "" || share == "." || share == ".." || strings.ContainsAny(serverShare, "?:") {
				return "", errFolderInvalid
			}
		} else if len(volume) != 2 || volume[1] != ':' ||
			!((volume[0] >= 'a' && volume[0] <= 'z') || (volume[0] >= 'A' && volume[0] <= 'Z')) {
			return "", errFolderInvalid
		}
		if strings.Contains(path[len(volume):], ":") {
			return "", errFolderInvalid
		}
	}
	clean := filepath.Clean(path)
	info, err := os.Stat(clean)
	if errors.Is(err, os.ErrNotExist) {
		return "", errFolderMissing
	}
	if err != nil {
		return "", errFolderAccess
	}
	if !info.IsDir() {
		return "", errFolderInvalid
	}
	return clean, nil
}
