//go:build !windows

package desktop

// WatchSessionLocks returns nil on platforms without this native monitor.
func WatchSessionLocks(func()) func() { return nil }
