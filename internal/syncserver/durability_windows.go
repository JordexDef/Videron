//go:build windows

package syncserver

import "os"

// Windows cannot fsync an ordinary directory handle. Keep using rooted
// atomic renames and FlushFileBuffers on the staged file itself.
func syncDirectory(*os.Root, string) error { return nil }
