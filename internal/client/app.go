// Package client coordinates the desktop application's workspaces and sessions.
package client

import (
	"context"
	"sync"
	"sync/atomic"

	"videron/internal/acp"
	"videron/internal/agentmcp"
	"videron/internal/desktop"
	"videron/internal/foldersession"
	"videron/internal/library"
	"videron/internal/notesession"
	"videron/internal/syncworkspace"
)

type App struct {
	hooks                Hooks
	noteAccess           agentmcp.Access
	agentRuns            acp.Runs
	mu                   sync.Mutex
	serverMu             sync.Mutex
	serverTickets        syncworkspace.Tickets
	ctx                  context.Context
	closeGuard           bool
	library              library.Library
	noteSession          notesession.NoteKeys
	editorHistory        notesession.History
	folderSessions       foldersession.Manager
	sessionLockPending   atomic.Bool
	sessionLockListening atomic.Bool
	noteExportGeneration atomic.Uint64
	stopSessionMonitor   func()
}

// Hooks provide the native UI operations used by the desktop client.
type Hooks struct {
	Emit           func(context.Context, string, ...any)
	Quit           func(context.Context)
	PickFolder     func(context.Context, string) (string, error)
	PickImportFile func(context.Context, string) (string, error)
	SaveFile       func(context.Context, SaveFileOptions) (string, error)
}

// Lifecycle is kept separate from the methods exposed to the WebView.
type Lifecycle struct {
	Startup     func(context.Context)
	Shutdown    func(context.Context)
	BeforeClose func(context.Context) bool
	Context     func() context.Context
}

func New(hooks Hooks) (*App, Lifecycle) {
	a := &App{hooks: hooks}
	return a, Lifecycle{
		Startup: a.startup, Shutdown: a.shutdown,
		BeforeClose: a.beforeClose, Context: a.runtimeContext,
	}
}

func (a *App) runtimeContext() context.Context {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ctx
}

func (a *App) emit(ctx context.Context, event string, args ...any) {
	if ctx != nil && a.hooks.Emit != nil {
		a.hooks.Emit(ctx, event, args...)
	}
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
	a.noteExportGeneration.Add(1)
	a.ResetAgentConnections()
	a.serverTickets.Reset()
	if a.sessionLockListening.Load() {
		go a.emit(ctx, "videron:session-lock")
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
	a.revokeWorkspaceGrants()
	a.library.Close()
	a.editorHistory.Forget("", nil)
	a.mu.Unlock()
	if stop != nil {
		stop()
	}
}

func (a *App) revokeWorkspaceGrants() {
	// Every grant belongs to the current library session, including during
	// a reload that fails or discovers an externally replaced catalog.
	a.ResetAgentConnections()
	a.noteExportGeneration.Add(1)
	// A pending connection carries a verified server credential. Expire it
	// together with the vault session, including verifications still in flight.
	a.serverTickets.Reset()
	a.noteSession.Clear()
	a.folderSessions.Clear()
}

func (a *App) EnableCloseGuard() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closeGuard = true
}

func (a *App) beforeClose(ctx context.Context) bool {
	a.mu.Lock()
	guard := a.closeGuard
	a.mu.Unlock()
	if guard {
		go a.emit(ctx, "videron:close-requested")
	}
	return guard
}

func (a *App) FinishClose() {
	a.mu.Lock()
	a.closeGuard = false
	a.revokeWorkspaceGrants()
	a.library.Close()
	a.editorHistory.Forget("", nil)
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil && a.hooks.Quit != nil {
		a.hooks.Quit(ctx)
	}
}
