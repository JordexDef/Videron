package main

import (
	"context"
	"sync"
	"sync/atomic"

	"videron/internal/acp"
	"videron/internal/agentmcp"
	"videron/internal/desktop"
	"videron/internal/foldersession"
	"videron/internal/notesession"
	"videron/internal/syncworkspace"
	"videron/internal/vault"
	"videron/internal/workspacestore"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	noteAccess           agentmcp.Access
	agentRuns            acp.Runs
	mu                   sync.Mutex
	serverMu             sync.Mutex
	serverTickets        syncworkspace.Tickets
	ctx                  context.Context
	closeGuard           bool
	loaded               bool
	projectKey           *vault.Key
	noteSession          notesession.NoteKeys
	editorHistory        notesession.History
	folderSessions       foldersession.Manager
	resumeNote           string
	catalog              workspacestore.Catalog
	sessionLockPending   atomic.Bool
	sessionLockListening atomic.Bool
	stopSessionMonitor   func()
}

func (a *App) startup(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ctx = ctx
	a.stopSessionMonitor = desktop.WatchSessionLocks(func() { a.sessionLocked(ctx) })
}

func (a *App) sessionLocked(ctx context.Context) {
	a.folderSessions.SetRevoking(true)
	a.sessionLockPending.Store(true)
	a.ResetAgentConnections()
	a.serverTickets.Reset()
	if a.sessionLockListening.Load() {
		go runtime.EventsEmit(ctx, "videron:session-lock")
	}
	// Show the lock screen immediately even if the storage mutex is busy.
	a.ForgetRememberedNotes()
	a.ForgetSuspendedFolderKeys()
	a.folderSessions.SetRevoking(false)
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
	a.editorHistory.Forget("", nil)
	a.loaded = false
	a.mu.Unlock()
	if stop != nil {
		stop()
	}
}

func (a *App) dropKeys() {
	// Every grant belongs to the current library session, including during
	// a reload that fails or discovers an externally replaced catalog.
	a.ResetAgentConnections()
	a.catalog.ClearIndex()
	// A pending connection carries a verified server credential. Expire it
	// together with the vault session, including verifications still in flight.
	a.serverTickets.Reset()
	a.projectKey.Forget()
	a.projectKey = nil
	a.noteSession.Clear()
	a.folderSessions.Clear()
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
	if _, err = workspacestore.WriteAtomic(path, []byte(payload), ".drawing-*.tmp"); err != nil {
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
	_, err = workspacestore.WriteAtomic(path, template, ".language-*.tmp")
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
	a.editorHistory.Forget("", nil)
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
