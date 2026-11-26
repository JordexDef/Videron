package desktop

import (
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Send the same Win32 messages WTS sends, exclusively to the process-local
// listener. This exercises registration and the window procedure without
// locking the Windows desktop used for the test.
func TestWindowsSessionLockNotification(t *testing.T) {
	var calls atomic.Int32
	notified := make(chan struct{}, 1)
	stop := WatchSessionLocks(func() {
		calls.Add(1)
		select {
		case notified <- struct{}{}:
		default:
		}
	})
	var hwnd uintptr
	t.Cleanup(func() {
		stopped := make(chan struct{})
		go func() {
			defer close(stopped)
			stop()
		}()
		select {
		case <-stopped:
			if _, found := sessionHandlers.Load(hwnd); found {
				t.Error("listener still registered")
			}
		case <-time.After(5 * time.Second):
			t.Error("session window did not stop")
		}
	})
	deadline := time.After(5 * time.Second)
	for hwnd == 0 {
		select {
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
	if calls.Load() != 0 {
		t.Fatal("unlock was reported as a lock")
	}
	if ok, _, err := postWindowMessage.Call(hwnd, wmSessionChange, windows.WTS_SESSION_LOCK, uintptr(sessionID)); ok == 0 {
		t.Fatal(err)
	}
	select {
	case <-notified:
	case <-time.After(5 * time.Second):
		t.Fatal("no lock notification")
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("got %d lock notifications, want one", got)
	}
}
