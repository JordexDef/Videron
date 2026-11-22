package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	mu                   sync.Mutex
	serverMu             sync.Mutex
	serverTickets        syncServerTickets
	ctx                  context.Context
	closeGuard           bool
	loaded               bool
	protected            bool
	projectKey           *vaultKey
	noteKeys             map[string]*vaultKey
	folderSpaces         map[string]*folderSpaceSession
	resumeNote           string
	disk                 os.FileInfo
	diskDigest           [sha256.Size]byte
	sessionLockPending   atomic.Bool
	sessionLockListening atomic.Bool
	stopSessionMonitor   func()
}

func (a *App) startup(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ctx = ctx
	a.stopSessionMonitor = watchSessionLocks(func() { a.sessionLocked(ctx) })
}

func (a *App) sessionLocked(ctx context.Context) {
	a.serverTickets.reset()
	a.sessionLockPending.Store(true)
	if a.sessionLockListening.Load() {
		go runtime.EventsEmit(ctx, "videron:session-lock")
	}
}

// The WebView subscribes before consuming. The latch also covers its loading
// and suspended intervals, when Wails events alone may have no listener.
func (a *App) ConsumeSessionLock() bool {
	a.sessionLockListening.Store(true)
	return a.sessionLockPending.Swap(false)
}

func (a *App) shutdown(context.Context) {
	a.sessionLockListening.Store(false)
	a.mu.Lock()
	stop := a.stopSessionMonitor
	a.stopSessionMonitor = nil
	a.dropKeys()
	a.loaded = false
	a.mu.Unlock()
	if stop != nil {
		stop()
	}
}

func workspacePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("VD_CONFIG|%w", err)
	}
	return filepath.Join(dir, "Videron", "workspace.json"), nil
}

func writeAtomic(path string, data []byte, pattern string) (os.FileInfo, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	return writeAtomicInDir(path, data, pattern, os.Rename)
}

// The caller chooses whether publication may replace an existing file. Folder
// spaces also require an existing directory so an offline sync mount stays offline.
func writeAtomicInDir(path string, data []byte, pattern string, publish func(string, string) error) (os.FileInfo, error) {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return nil, err
	}
	defer os.Remove(temp.Name())
	_, err = temp.Write(data)
	if err == nil {
		err = temp.Sync()
	}
	var info os.FileInfo
	if err == nil {
		info, err = temp.Stat()
	}
	closeErr := temp.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err := publish(temp.Name(), path); err != nil {
		return nil, err
	}
	return info, nil
}

func (a *App) EnableCloseGuard() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closeGuard = true
}

// SaveDrawing writes only to a path chosen in the system Save As dialog.
func (a *App) SaveDrawing(payload, language string) (bool, error) {
	title := "Сохранить рисунок"
	if language == "en" {
		title = "Save drawing"
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title: title, DefaultFilename: "Videron.excalidraw",
		Filters: []runtime.FileFilter{{DisplayName: "Excalidraw", Pattern: "*.excalidraw"}},
	})
	if err != nil || path == "" {
		return false, err
	}
	if _, err = writeAtomic(path, []byte(payload), ".drawing-*.tmp"); err != nil {
		return false, err
	}
	return true, nil
}

func (a *App) beforeClose(ctx context.Context) bool {
	a.mu.Lock()
	guard := a.closeGuard
	a.mu.Unlock()
	if guard {
		go runtime.EventsEmit(ctx, "videron:close-requested")
	}
	return guard
}

func (a *App) FinishClose() {
	a.mu.Lock()
	a.closeGuard = false
	a.dropKeys()
	a.loaded = false
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		runtime.Quit(ctx)
	}
}

func (a *App) focusWindow(_ options.SecondInstanceData) {
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		runtime.WindowUnminimise(ctx)
		runtime.WindowShow(ctx)
	}
}
