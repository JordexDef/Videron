package main

import (
	"context"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Send the same Win32 messages WTS sends, exclusively to the process-local
// listener. This exercises registration and the window procedure without
// locking the Windows desktop used for the test.
func TestWindowsSessionLockNotification(t *testing.T) {
	var app App
	notified := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	var runErr error
	go func() {
		defer close(stopped)
		runErr = runSessionWindow(ctx, func() {
			app.sessionLocked(ctx)
			notified <- struct{}{}
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-stopped:
		case <-time.After(5 * time.Second):
			t.Error("session window did not stop")
		}
	})
	var hwnd uintptr
	deadline := time.After(5 * time.Second)
	for hwnd == 0 {
		select {
		case <-stopped:
			t.Fatalf("session registration: %v", runErr)
		case <-deadline:
			t.Fatal("session window did not start")
		case <-time.After(10 * time.Millisecond):
			sessionHandlers.Range(func(h, _ any) bool {
				hwnd = h.(uintptr)
				return false
			})
		}
	}
	var sessionID uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &sessionID); err != nil {
		t.Fatal(err)
	}
	send := sessionUser32.NewProc("SendMessageW")
	send.Call(hwnd, wmSessionChange, windows.WTS_SESSION_UNLOCK, uintptr(sessionID))
	if app.sessionLockPending.Load() {
		t.Fatal("unlock was reported as a lock")
	}
	if ok, _, err := postWindowMessage.Call(hwnd, wmSessionChange, windows.WTS_SESSION_LOCK, uintptr(sessionID)); ok == 0 {
		t.Fatal(err)
	}
	select {
	case <-notified:
	case <-stopped:
		t.Fatalf("session registration: %v", runErr)
	case <-time.After(5 * time.Second):
		t.Fatal("no lock notification")
	}
	if !app.ConsumeSessionLock() || app.ConsumeSessionLock() {
		t.Fatal("must replay the pending lock exactly once")
	}
	cancel()
	select {
	case <-stopped:
		if runErr != nil {
			t.Fatal(runErr)
		}
		if _, found := sessionHandlers.Load(hwnd); found {
			t.Fatal("listener still registered")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("listener failed to unregister and exit")
	}
}
