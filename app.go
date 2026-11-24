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
	noteAccess           agentAccess
	agentRuns            acpRuns
	mu                   sync.Mutex
	serverMu             sync.Mutex
	serverTickets        syncServerTickets
	ctx                  context.Context
	closeGuard           bool
	loaded               bool
	protected            bool
	projectKey           *vaultKey
	noteKeys             map[string]*vaultKey
	rememberedNotes      map[string]*rememberedNote
	folderSpaces         map[string]*folderSpaceSession
	suspendedFolderKeys  map[string]*vaultKey
	resumeNote           string
	disk                 os.FileInfo
	diskDigest           [sha256.Size]byte
	catalogIndex         *indexedCatalog
	lastCatalogPatch     savePatchReceipt
	sessionLockPending   atomic.Bool
	sessionLockListening atomic.Bool
	revokingFolderKeys   atomic.Bool
	stopSessionMonitor   func()
}

func (a *App) startup(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ctx = ctx
	a.stopSessionMonitor = watchSessionLocks(func() { a.sessionLocked(ctx) })
}

func (a *App) sessionLocked(ctx context.Context) {
	a.revokingFolderKeys.Store(true)
	a.sessionLockPending.Store(true)
	a.ResetAgentConnections()
	a.serverTickets.reset()
	if a.sessionLockListening.Load() {
		go runtime.EventsEmit(ctx, "videron:session-lock")
	}
	// Show the lock screen immediately even if the storage mutex is busy.
	a.ForgetRememberedNotes()
	a.ForgetSuspendedFolderKeys()
	a.revokingFolderKeys.Store(false)
}

// The WebView subscribes before consuming. The latch also covers its loading
// and suspended intervals, when Wails events alone may have no listener.
func (a *App) ConsumeSessionLock() bool {
	a.sessionLockListening.Store(true)
	return a.sessionLockPending.Swap(false)
}

func (a *App) shutdown(context.Context) {
	// Revoke immediately even if a storage operation holds the library mutex.
	a.ResetAgentConnections()
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

// Earlier clients sent a language code instead of the translated dialog title.
func dialogTitle(value, russian, english string) string {
	switch value {
	case "ru", "":
		return russian
	case "en":
		return english
	default:
		return value
	}
}

// SaveDrawing writes only to a path chosen in the system Save As dialog.
func (a *App) SaveDrawing(payload, title string) (bool, error) {
	title = dialogTitle(title, "Сохранить рисунок", "Save drawing")
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

func (a *App) SaveLanguageTemplate(title string) (bool, error) {
	template, err := files.ReadFile("frontend/languages/template.json")
	if err != nil {
		return false, err
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title: title, DefaultFilename: "Videron.language.json",
		Filters: []runtime.FileFilter{{DisplayName: "JSON", Pattern: "*.json"}},
	})
	if err != nil || path == "" {
		return false, err
	}
	_, err = writeAtomic(path, template, ".language-*.tmp")
	return err == nil, err
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
