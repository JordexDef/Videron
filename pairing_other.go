//go:build !windows

package main

// The private account configuration directory and its 0600 credential file
// are separate from the shared folder and the portable space catalog.
func protectPairing(data []byte) ([]byte, error)   { return data, nil }
func unprotectPairing(data []byte) ([]byte, error) { return data, nil }
