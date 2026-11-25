package workspacestore

import (
	"fmt"
	"os"
	"path/filepath"
)

func CatalogPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("VD_CONFIG|%w", err)
	}
	return filepath.Join(dir, "Videron", "workspace.json"), nil
}

func WriteAtomic(path string, data []byte, pattern string) (os.FileInfo, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	return WriteAtomicInDir(path, data, pattern, os.Rename)
}

// The caller chooses whether publication may replace an existing file. Folder
// spaces also require an existing directory so an offline sync mount stays offline.
func WriteAtomicInDir(path string, data []byte, pattern string, publish func(string, string) error) (os.FileInfo, error) {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return nil, err
	}
	defer os.Remove(temp.Name())
	_, err = temp.Write(data)
	if err == nil {
		err = temp.Sync()
	}
	var info os.FileInfo
	if err == nil {
		info, err = temp.Stat()
	}
	closeErr := temp.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err := publish(temp.Name(), path); err != nil {
		return nil, err
	}
	return info, nil
}
