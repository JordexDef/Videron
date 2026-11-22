//go:build !windows

package main

func watchSessionLocks(func()) func() { return nil }
