package client

import "videron/internal/agentmcp"

func (a *App) OpenAgentAccess(write bool) (string, error) {
	return a.openAgentAccess("", write, a.emitAgentCall)
}

func (a *App) OpenPairedAgentAccess(id string, write bool) (string, error) {
	if id == "" {
		return "", agentmcp.ErrClientUnknown
	}
	return a.openAgentAccess(id, write, a.emitAgentCall)
}

func (a *App) emitAgentCall(grant, request, tool, params string) {
	a.emit(a.runtimeContext(), "videron:agent-call", grant, request, tool, params)
}

func (a *App) openAgentAccess(clientID string, write bool, emit func(string, string, string, string)) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.noteAccess.Open(clientID, write, emit, func() error {
		if !a.agentWorkspaceReady() {
			return errLocked
		}
		return nil
	})
}

func (a *App) CloseAgentAccess(id string) {
	a.noteAccess.Close(id)
}

func (a *App) ResetAgentConnections() {
	a.noteAccess.Reset()
	a.agentRuns.Reset()
}

func (a *App) ResolveAgentCall(grant, request, result string, failed bool) {
	a.noteAccess.Resolve(grant, request, result, failed)
}

func (a *App) agentWorkspaceReady() bool {
	return a.library.Loaded() && !a.sessionLockPending.Load() && !a.folderSessions.Revoking()
}

func (a *App) ListAgentClients() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.agentWorkspaceReady() {
		return "", errLocked
	}
	return a.noteAccess.ListClients()
}

func (a *App) RegisterAgentClient(name string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.agentWorkspaceReady() {
		return "", errLocked
	}
	return a.noteAccess.RegisterClient(name)
}

func (a *App) AgentClientConfig(id string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.agentWorkspaceReady() {
		return "", errLocked
	}
	return a.noteAccess.ClientConfig(id)
}

func (a *App) ForgetAgentClient(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.agentWorkspaceReady() {
		return errLocked
	}
	return a.noteAccess.ForgetClient(id)
}
