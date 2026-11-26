package acp

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

type acpConfig struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	CWD     string   `json:"cwd"`
	Prompt  string   `json:"prompt"`
	GrantID string   `json:"grantId"`
	Resume  string   `json:"resumeSessionId"`
}

type acpOption struct {
	ID   string `json:"optionId"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}
type acpPermission struct {
	ID      string      `json:"id"`
	Title   string      `json:"title"`
	Options []acpOption `json:"options"`
}
type State struct {
	ID         string         `json:"id"`
	Status     string         `json:"status"`
	Text       string         `json:"text"`
	Activity   string         `json:"activity"`
	Error      string         `json:"error,omitempty"`
	SessionID  string         `json:"sessionId,omitempty"`
	Resumable  bool           `json:"resumable"`
	Permission *acpPermission `json:"permission,omitempty"`
}

type acpRun struct {
	mu          sync.Mutex
	state       State
	transcript  strings.Builder
	token       string
	pendingText string
	grant       string
	cancel      context.CancelFunc
	decision    chan string
}

// Grant supplies the lifetime and credentials of this run's local MCP connection.
type Grant struct {
	Context   context.Context
	Token     string
	MCPServer map[string]any
}

// Runs owns ACP processes for a desktop session. Its zero value is ready to use.
type Runs struct {
	mu   sync.Mutex
	byID map[string]*acpRun
}

func (m *Runs) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.byID {
		r.cancel()
	}
	m.byID = nil
}

func (m *Runs) get(id string) (*acpRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.byID[id]
	if r == nil {
		return nil, errors.New("VD_AGENT_RUN_MISSING")
	}
	return r, nil
}

func acpID() string {
	var b [16]byte
	rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func acpCommand(c acpConfig) (*exec.Cmd, error) {
	name := strings.TrimSpace(c.Command)
	if len(name) == 0 || len(name) > 4096 || strings.ContainsAny(name, "\x00\r\n") || len(c.Args) > 128 ||
		strings.TrimSpace(c.Prompt) == "" || len(c.Prompt) > 8<<20 || c.GrantID == "" || len(c.Resume) > 512 {
		return nil, errors.New("VD_AGENT_CONFIG")
	}
	for _, arg := range c.Args {
		if len(arg) > 16384 || strings.IndexByte(arg, 0) >= 0 {
			return nil, errors.New("VD_AGENT_CONFIG")
		}
	}
	// PATH is resolved before switching to the project's directory.
	if strings.ContainsAny(name, `/\`) && !filepath.IsAbs(name) {
		return nil, errors.New("VD_AGENT_EXECUTABLE")
	}
	exe, err := exec.LookPath(name)
	if err != nil {
		return nil, fmt.Errorf("VD_AGENT_EXECUTABLE|%s", name)
	}
	exe, args, err := acpExecutable(exe, c.Args)
	if err != nil {
		return nil, err
	}
	if c.CWD != "" {
		info, err := os.Stat(c.CWD)
		if !filepath.IsAbs(c.CWD) || err != nil || !info.IsDir() {
			return nil, errors.New("VD_AGENT_FOLDER")
		}
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = c.CWD
	acpConfigureProcess(cmd)
	return cmd, nil
}

// Start launches an adapter for an explicit user selection. The prompt travels
// over stdin. The scoped credential is supplied only during session negotiation.
// Resolve the grant under the registry lock so Reset cannot overtake a launch.
func (m *Runs) Start(configJSON string, resolveGrant func(string) (Grant, error)) (string, error) {
	var c acpConfig
	if len(configJSON) > 10<<20 || json.Unmarshal([]byte(configJSON), &c) != nil {
		return "", errors.New("VD_AGENT_CONFIG")
	}
	cmd, err := acpCommand(c)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	g, err := resolveGrant(c.GrantID)
	if err != nil {
		return "", err
	}
	if g.Context == nil || g.Token == "" {
		return "", errors.New("VD_AGENT_REVOKED")
	}
	if m.byID == nil {
		m.byID = make(map[string]*acpRun)
	}
	for _, existing := range m.byID {
		if existing.grant == c.GrantID {
			return "", errors.New("VD_AGENT_ALREADY_RUNNING")
		}
	}
	if len(m.byID) >= 32 {
		return "", errors.New("VD_AGENT_RUN_LIMIT")
	}
	ctx, cancel := context.WithCancel(g.Context)
	r := &acpRun{state: State{ID: acpID(), Status: "starting"}, grant: c.GrantID, token: g.Token, cancel: cancel}
	m.byID[r.state.ID] = r
	go func() {
		err := r.execute(ctx, cmd, c, g.MCPServer)
		r.mu.Lock()
		switch {
		case ctx.Err() != nil || errors.Is(err, context.Canceled):
			r.state.Status = "cancelled"
		case err != nil:
			r.state.Status = "failed"
			r.state.Error = r.redacted(err.Error())
		default:
			r.state.Status = "completed"
		}
		r.state.Activity = ""
		// A cancelled stream can end in the middle of an echoed credential.
		if len(r.pendingText) >= 8 {
			r.writeTranscript("[redacted]")
		} else {
			r.writeTranscript(r.pendingText)
		}
		r.pendingText = ""
		r.token = ""
		r.state.Permission = nil
		r.decision = nil
		r.mu.Unlock()
		cancel()
	}()
	return r.state.ID, nil
}

func (m *Runs) Get(id string) (State, error) {
	r, err := m.get(id)
	if err != nil {
		return State{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.state
	state.Text = r.transcript.String()
	if state.Permission != nil {
		permission := *state.Permission
		permission.Options = slices.Clone(permission.Options)
		state.Permission = &permission
	}
	return state, nil
}

func (m *Runs) Stop(id string) error {
	r, err := m.get(id)
	if err == nil {
		r.cancel()
	}
	return err
}

func (m *Runs) Close(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.byID[id]; r != nil {
		r.cancel()
		delete(m.byID, id)
	}
}

// An empty option declines the request without persisting a decision.
func (m *Runs) AnswerPermission(id, permissionID, optionID string) error {
	r, err := m.get(id)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.state.Permission
	if p == nil || p.ID != permissionID || r.decision == nil {
		return errors.New("VD_AGENT_PERMISSION_EXPIRED")
	}
	if optionID != "" {
		valid := false
		for _, opt := range p.Options {
			if opt.ID == optionID {
				valid = true
				break
			}
		}
		if !valid {
			return errors.New("VD_AGENT_PERMISSION_OPTION")
		}
	}
	r.decision <- optionID
	r.decision = nil
	r.state.Permission = nil
	r.state.Status = "running"
	return nil
}

func (r *acpRun) execute(ctx context.Context, cmd *exec.Cmd, c acpConfig, server map[string]any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if cmd.Dir == "" {
		dir, err := os.MkdirTemp("", "videron-agent-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		cmd.Dir = dir
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	defer output.Close()
	// Launchers sometimes log the full protocol payload on stderr, including
	// credentials for external tools. The UI reports protocol errors instead.
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("VD_AGENT_START|%w", err)
	}
	closeTree, err := acpOwnProcess(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	var once sync.Once
	stop := func() { once.Do(closeTree) }
	// Interrupt a blocked stdin write even if the peer stops consuming requests.
	stopCancellation := context.AfterFunc(ctx, func() { time.AfterFunc(600*time.Millisecond, stop) })
	protocolCtx, release := context.WithCancel(ctx)
	defer release()
	rpc := &acpConn{out: json.NewEncoder(input), incoming: acpRead(protocolCtx, output), run: r}
	defer func() {
		if ctx.Err() != nil && rpc.session != "" {
			_ = rpc.out.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]string{"sessionId": rpc.session}})
		}
		stopCancellation()
		input.Close()
		// Give the adapter a chance to persist the session after its final
		// response, then collect any tool/MCP children left by the adapter.
		exited := make(chan struct{})
		go func() { cmd.Wait(); close(exited) }()
		select {
		case <-exited:
		case <-time.After(350 * time.Millisecond):
		}
		stop()
		<-exited
	}()
	// An agent blocked before reading stdin must also be interrupted on timeout.
	startCtx, doneStarting := context.WithTimeout(protocolCtx, 90*time.Second)
	defer doneStarting()
	stopTimeout := context.AfterFunc(startCtx, stop)
	defer stopTimeout()
	var init struct {
		Version      int `json:"protocolVersion"`
		Capabilities struct {
			Load     bool `json:"loadSession"`
			Sessions struct {
				Resume *struct{} `json:"resume"`
			} `json:"sessionCapabilities"`
		} `json:"agentCapabilities"`
	}
	if err := rpc.call(startCtx, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]string{"name": "videron", "version": "1"}}, &init); err != nil {
		return err
	}
	if init.Version != 1 {
		return errors.New("VD_AGENT_PROTOCOL")
	}
	params := map[string]any{"cwd": cmd.Dir, "mcpServers": []any{server}}
	method := "session/new"
	if c.Resume != "" {
		switch {
		case c.CWD == "":
			return errors.New("VD_AGENT_RESUME_FOLDER")
		case init.Capabilities.Sessions.Resume != nil:
			method = "session/resume"
		case init.Capabilities.Load:
			method = "session/load"
		default:
			return errors.New("VD_AGENT_RESUME_UNAVAILABLE")
		}
		params["sessionId"] = c.Resume
	}
	var session struct {
		ID string `json:"sessionId"`
	}
	if err := rpc.call(startCtx, method, params, &session); err != nil {
		return err
	}
	if !stopTimeout() {
		return context.DeadlineExceeded
	}
	doneStarting()
	if c.Resume != "" {
		session.ID = c.Resume
	}
	if session.ID == "" || len(session.ID) > 512 || strings.Contains(session.ID, r.token) {
		return errors.New("VD_AGENT_PROTOCOL")
	}
	rpc.session = session.ID
	r.mu.Lock()
	r.state.Status = "running"
	r.state.SessionID = session.ID
	r.state.Resumable = c.CWD != "" && (init.Capabilities.Load || init.Capabilities.Sessions.Resume != nil)
	r.mu.Unlock()
	prompt := map[string]any{"sessionId": session.ID, "prompt": []any{map[string]any{"type": "text", "text": c.Prompt}}}
	var result struct {
		Reason string `json:"stopReason"`
	}
	if err := rpc.call(protocolCtx, "session/prompt", prompt, &result); err != nil {
		return err
	}
	switch result.Reason {
	case "end_turn":
		return nil
	case "cancelled":
		return context.Canceled
	default:
		return fmt.Errorf("VD_AGENT_STOP_REASON|%s", acpShort(r.redacted(result.Reason), 160))
	}
}
