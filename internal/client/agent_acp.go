package client

import (
	"encoding/json"

	"videron/internal/acp"
)

func (a *App) StartAgentRun(configJSON string) (string, error) {
	return a.agentRuns.Start(configJSON, func(id string) (acp.Grant, error) {
		grant, err := a.noteAccess.ACPGrant(id)
		if err != nil {
			return acp.Grant{}, err
		}
		return acp.Grant{Context: grant.Context, Token: grant.Token, MCPServer: grant.MCPServer}, nil
	})
}

func (a *App) GetAgentRun(id string) (string, error) {
	state, err := a.agentRuns.Get(id)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(state)
	return string(data), err
}

func (a *App) StopAgentRun(id string) error {
	return a.agentRuns.Stop(id)
}

func (a *App) CloseAgentRun(id string) {
	a.agentRuns.Close(id)
}

func (a *App) AnswerAgentPermission(id, permissionID, optionID string) error {
	return a.agentRuns.AnswerPermission(id, permissionID, optionID)
}
