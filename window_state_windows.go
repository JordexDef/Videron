package main

import (
	"context"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Use the same Win32 workspace coordinates to capture and restore. Wails
// reads absolute positions but sets positions relative to the current monitor.
type windowPlacement struct {
	Length, Flags, ShowCommand uint32
	MinPosition, MaxPosition   [2]int32
	NormalPosition             windows.Rect
}

var (
	placementUser32 = windows.NewLazySystemDLL("user32.dll")
	findMainWindow  = placementUser32.NewProc("FindWindowExW")
	getPlacement    = placementUser32.NewProc("GetWindowPlacement")
	setPlacement    = placementUser32.NewProc("SetWindowPlacement")
)

func desktopWindowHandle() uintptr {
	class, _ := windows.UTF16PtrFromString(desktopWindowClass)
	var hwnd uintptr
	for {
		hwnd, _, _ = findMainWindow.Call(0, hwnd, uintptr(unsafe.Pointer(class)), 0)
		if hwnd == 0 {
			return 0
		}
		var owner uint32
		if _, err := windows.GetWindowThreadProcessId(windows.HWND(hwnd), &owner); err == nil && owner == uint32(os.Getpid()) {
			return hwnd
		}
	}
}

func captureDesktopWindow(_ context.Context, _ desktopWindowState) desktopWindowState {
	var p windowPlacement
	p.Length = uint32(unsafe.Sizeof(p))
	if ok, _, _ := getPlacement.Call(desktopWindowHandle(), uintptr(unsafe.Pointer(&p))); ok == 0 {
		return desktopWindowState{}
	}
	r := p.NormalPosition
	const minimized, maximized, restoreToMaximized = 2, 3, 2
	return desktopWindowState{
		X: int(r.Left), Y: int(r.Top), Width: int(r.Right - r.Left), Height: int(r.Bottom - r.Top),
		Maximized: p.ShowCommand == maximized || (p.ShowCommand == minimized && p.Flags&restoreToMaximized != 0),
	}
}

func restoreDesktopWindow(_ context.Context, s desktopWindowState) {
	const normal, maximized = 1, 3
	p := windowPlacement{
		ShowCommand: normal,
		MinPosition: [2]int32{-1, -1}, MaxPosition: [2]int32{-1, -1},
		NormalPosition: windows.Rect{Left: int32(s.X), Top: int32(s.Y), Right: int32(s.X + s.Width), Bottom: int32(s.Y + s.Height)},
	}
	if s.Maximized {
		p.ShowCommand = maximized
	}
	p.Length = uint32(unsafe.Sizeof(p))
	// SetWindowPlacement also moves a saved off-screen window to a connected display.
	setPlacement.Call(desktopWindowHandle(), uintptr(unsafe.Pointer(&p)))
}
