package main

import (
	"context"
	"fmt"
	"log"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmSessionChange    = 0x02B1
	wmStopMonitor      = 0x8001 // Private WM_APP message on our message-only window.
	sessionWindowTitle = "Videron session notifications"
)

var (
	sessionUser32         = windows.NewLazySystemDLL("user32.dll")
	createWindow          = sessionUser32.NewProc("CreateWindowExW")
	destroyWindow         = sessionUser32.NewProc("DestroyWindow")
	postWindowMessage     = sessionUser32.NewProc("PostMessageW")
	getWindowMessage      = sessionUser32.NewProc("GetMessageW")
	dispatchWindowMessage = sessionUser32.NewProc("DispatchMessageW")
	sessionComctl         = windows.NewLazySystemDLL("comctl32.dll")
	setSubclass           = sessionComctl.NewProc("SetWindowSubclass")
	removeSubclass        = sessionComctl.NewProc("RemoveWindowSubclass")
	defaultSubclassProc   = sessionComctl.NewProc("DefSubclassProc")
	sessionWTS            = windows.NewLazySystemDLL("wtsapi32.dll")
	registerSession       = sessionWTS.NewProc("WTSRegisterSessionNotification")
	unregisterSession     = sessionWTS.NewProc("WTSUnRegisterSessionNotification")
	sessionHandlers       sync.Map // hwnd -> func(); removed before the window is destroyed.
	sessionCallback       = windows.NewCallback(sessionWindowProc)
)

type windowMessage struct {
	hwnd           uintptr
	message        uint32
	wParam, lParam uintptr
	time           uint32
	x, y           int32
	private        uint32
}

func sessionWindowProc(hwnd, message, wParam, lParam, subclassID, data uintptr) uintptr {
	if message == wmSessionChange && wParam == windows.WTS_SESSION_LOCK {
		if notify, ok := sessionHandlers.Load(hwnd); ok {
			notify.(func())()
		}
		return 0
	}
	result, _, _ := defaultSubclassProc.Call(hwnd, message, wParam, lParam)
	return result
}

func watchSessionLocks(notify func()) func() {
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		reported := false
		for ctx.Err() == nil {
			err := runSessionWindow(ctx, notify)
			if err == nil || ctx.Err() != nil {
				return
			}
			// WTS can return RPC_S_INVALID_BINDING while its service starts.
			if !reported {
				log.Printf("Waiting for Windows session notifications: %v", err)
				reported = true
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}()
	return func() { cancel(); <-finished }
}

func runSessionWindow(ctx context.Context, notify func()) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// A private window on its own thread can receive both posted and sent
	// notifications without replacing the Wails window procedure.
	class, _ := windows.UTF16PtrFromString("Static")
	title, _ := windows.UTF16PtrFromString(sessionWindowTitle)
	const hwndMessage = ^uintptr(2) // HWND_MESSAGE = (HWND)-3
	hwnd, _, err := createWindow.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)), 0, 0, 0, 0, 0, hwndMessage, 0, 0, 0)
	if hwnd == 0 {
		return fmt.Errorf("create session window: %w", err)
	}
	defer destroyWindow.Call(hwnd)

	sessionHandlers.Store(hwnd, notify)
	defer sessionHandlers.Delete(hwnd)
	if ok, _, err := setSubclass.Call(hwnd, sessionCallback, 1, 0); ok == 0 {
		return fmt.Errorf("install session listener: %w", err)
	}
	defer removeSubclass.Call(hwnd, sessionCallback, 1)
	if ok, _, err := registerSession.Call(hwnd, 0 /* NOTIFY_FOR_THIS_SESSION */); ok == 0 {
		return fmt.Errorf("register session window: %w", err)
	}
	defer unregisterSession.Call(hwnd)

	wakeDone := make(chan struct{})
	stopWake := context.AfterFunc(ctx, func() {
		defer close(wakeDone)
		postWindowMessage.Call(hwnd, wmStopMonitor, 0, 0)
	})
	defer func() {
		if !stopWake() {
			<-wakeDone
		}
	}()

	var msg windowMessage
	for ctx.Err() == nil {
		result, _, err := getWindowMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(result) == -1 {
			return fmt.Errorf("get session message: %w", err)
		}
		if result == 0 || (msg.hwnd == hwnd && msg.message == wmStopMonitor && ctx.Err() != nil) {
			break
		}
		dispatchWindowMessage.Call(uintptr(unsafe.Pointer(&msg)))
	}
	return nil
}
