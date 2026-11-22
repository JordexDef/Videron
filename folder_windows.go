package main

import (
	"errors"
	"os"
	"runtime"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func showFolder(path string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	switch {
	case err == nil, errors.Is(err, syscall.Errno(windows.S_FALSE)):
		defer windows.CoUninitialize()
	case errors.Is(err, syscall.Errno(windows.RPC_E_CHANGED_MODE)):
		// This thread already has a COM apartment.
	default:
		return err
	}
	// Use the folder-specific Explorer verb. The trailing separator also
	// preserves directory semantics if the path is replaced after validation.
	if !strings.HasSuffix(path, string(os.PathSeparator)) {
		path += string(os.PathSeparator)
	}
	target, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	explore, _ := windows.UTF16PtrFromString("explore")
	return windows.ShellExecute(0, explore, target, nil, nil, windows.SW_SHOWNORMAL)
}
