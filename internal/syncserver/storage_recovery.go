package syncserver

import (
	"io/fs"
	"os"
	"regexp"
	"strings"
)

var stagedUploadName = regexp.MustCompile(`^\.upload-[0-9a-f]{32}$`)

// Called under the process-wide writer lock, before this directory accepts
// writes. A killed process cannot run stageFile's deferred cleanup.
func recoverStorageDirectory(root *os.Root) ([]fs.DirEntry, error) {
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil, err
	}
	kept := entries[:0]
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".upload-") && stagedUploadName.MatchString(name) && entry.Type().IsRegular() {
			if err := root.Remove(name); err != nil {
				return nil, err
			}
			continue
		}
		kept = append(kept, entry)
	}
	return kept, nil
}
