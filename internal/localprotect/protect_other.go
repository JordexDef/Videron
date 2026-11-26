//go:build !windows

package localprotect

// The private account configuration directory and its 0600 credential file
// are separate from the shared folder and the portable space catalog.
func Protect(data []byte) ([]byte, error)   { return data, nil }
func Unprotect(data []byte) ([]byte, error) { return data, nil }
