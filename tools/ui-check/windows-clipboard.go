//go:build ignore

// Independent observer for the opt-in desktop clipboard test. Only the
// expected synthetic value arrives over stdin. Clipboard data stays in RAM.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32         = windows.NewLazySystemDLL("user32.dll")
	kernel32       = windows.NewLazySystemDLL("kernel32.dll")
	duplicate      = windows.NewLazySystemDLL("ole32.dll").NewProc("OleDuplicateData")
	open           = user32.NewProc("OpenClipboard")
	closeClipboard = user32.NewProc("CloseClipboard")
	getData        = user32.NewProc("GetClipboardData")
	sequence       = user32.NewProc("GetClipboardSequenceNumber")
)

type entry struct {
	format uintptr
	handle uintptr
}

func openFor(window uintptr) error {
	deadline := time.Now().Add(time.Second)
	for {
		if ok, _, _ := open.Call(window); ok != 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("system clipboard busy")
		}
		time.Sleep(15 * time.Millisecond)
	}
}

func snapshot(window uintptr) ([]entry, uintptr, error) {
	if err := openFor(window); err != nil {
		return nil, 0, err
	}
	defer closeClipboard.Call()
	enum := user32.NewProc("EnumClipboardFormats")
	count, _, _ := user32.NewProc("CountClipboardFormats").Call()
	entries := make([]entry, 0, count)
	for next, _, _ := enum.Call(0); next != 0; next, _, _ = enum.Call(next) {
		// These formats can depend on methods or handles private to their
		// owner. Refuse to touch that clipboard rather than discard data.
		if next == 0x80 || (next >= 0x200 && next <= 0x3ff) {
			return nil, 0, errors.New("clipboard contains owner-specific data; test copy was not started")
		}
		entries = append(entries, entry{format: next})
	}
	if uintptr(len(entries)) != count {
		return nil, 0, errors.New("could not enumerate all clipboard formats")
	}
	for i, e := range entries {
		// GetClipboardData also asks owners to materialize delayed formats.
		data, _, _ := getData.Call(e.format)
		if data == 0 {
			return nil, 0, errors.New("clipboard format could not be preserved; test copy was not started")
		}
		entries[i].handle, _, _ = duplicate.Call(data, e.format, 2) // GMEM_MOVEABLE
		if entries[i].handle == 0 {
			return nil, 0, errors.New("clipboard format could not be copied safely; test copy was not started")
		}
	}
	seq, _, _ := sequence.Call()
	return entries, seq, nil
}

func matches(expected []uint16) bool {
	const unicodeText = 13
	data, _, _ := getData.Call(unicodeText)
	if data == 0 {
		return false
	}
	size, _, _ := kernel32.NewProc("GlobalSize").Call(data)
	if size < 2*uintptr(len(expected)) {
		return false
	}
	ptr, _, _ := kernel32.NewProc("GlobalLock").Call(data)
	if ptr == 0 {
		return false
	}
	defer kernel32.NewProc("GlobalUnlock").Call(data)
	view := unsafe.Slice((*uint16)(unsafe.Pointer(ptr)), len(expected))
	for i, char := range expected {
		if char != view[i] {
			return false
		}
	}
	return true
}

func checkAndRestore(window uintptr, expected []uint16, entries []entry) (bool, error) {
	if err := openFor(window); err != nil {
		return false, err
	}
	defer closeClipboard.Call()
	// Verify and restore under the same lock. If another app has copied
	// something newer, leave it in place.
	if !matches(expected) {
		return false, nil
	}
	if ok, _, _ := user32.NewProc("EmptyClipboard").Call(); ok == 0 {
		return true, errors.New("could not restore original clipboard")
	}
	set := user32.NewProc("SetClipboardData")
	var err error
	for _, e := range entries {
		if ok, _, _ := set.Call(e.format, e.handle); ok == 0 {
			err = errors.New("one or more original clipboard formats could not be restored")
		}
	}
	return true, err
}

func run() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	input := bufio.NewScanner(os.Stdin)
	if !input.Scan() || input.Text() == "" {
		return errors.New("expected synthetic clipboard marker")
	}
	expected, err := windows.UTF16FromString(input.Text())
	if err != nil {
		return err
	}
	// A real owner HWND is required for EmptyClipboard + SetClipboardData.
	static, _ := windows.UTF16PtrFromString("STATIC")
	const hwndMessage = ^uintptr(2)
	window, _, _ := user32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(static)), 0, 0, 0, 0, 0, 0, hwndMessage, 0, 0, 0)
	if window == 0 {
		return errors.New("could not create clipboard owner")
	}
	defer user32.NewProc("DestroyWindow").Call(window)
	entries, before, err := snapshot(window)
	if err != nil {
		return err
	}
	fmt.Println("READY")
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		now, _, _ := sequence.Call()
		if now != before {
			done, err := checkAndRestore(window, expected, entries)
			if err != nil {
				return err
			}
			if done {
				fmt.Println("VERIFIED")
				return nil
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	return errors.New("expected credential was not observed in the Windows clipboard")
}

func main() {
	if err := run(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
