package main

import (
	"bufio"
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
type acpState struct {
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
	state       acpState
	transcript  strings.Builder
	token       string
	pendingText string
	grant       string
	cancel      context.CancelFunc
	decision    chan string
}

type acpRuns struct {
	mu   sync.Mutex
	byID map[string]*acpRun
}

func (m *acpRuns) reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.byID {
		r.cancel()
	}
	m.byID = nil
}

func (m *acpRuns) get(id string) (*acpRun, error) {
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

// StartAgentRun starts a single explicit selection from local client settings.
// The idea and instructions travel over stdin. The scoped MCP credential is
// supplied only to the negotiated session, never to the process command line.
func (a *App) StartAgentRun(configJSON string) (string, error) {
	var c acpConfig
	if len(configJSON) > 10<<20 || json.Unmarshal([]byte(configJSON), &c) != nil {
		return "", errors.New("VD_AGENT_CONFIG")
	}
	cmd, err := acpCommand(c)
	if err != nil {
		return "", err
	}
	m := &a.agentRuns
	m.mu.Lock()
	defer m.mu.Unlock()
	g, err := a.acpGrant(c.GrantID)
	if err != nil {
		return "", err
	}
	server, err := g.mcpConfig()
	if err != nil {
		return "", err
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
	ctx, cancel := context.WithCancel(g.ctx)
	r := &acpRun{state: acpState{ID: acpID(), Status: "starting"}, grant: c.GrantID, token: g.token, cancel: cancel}
	m.byID[r.state.ID] = r
	go func() {
		err := r.execute(ctx, cmd, c, server)
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

func (a *App) GetAgentRun(id string) (string, error) {
	r, err := a.agentRuns.get(id)
	if err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.state
	state.Text = r.transcript.String()
	data, err := json.Marshal(state)
	return string(data), err
}

func (a *App) StopAgentRun(id string) error {
	r, err := a.agentRuns.get(id)
	if err == nil {
		r.cancel()
	}
	return err
}

func (a *App) CloseAgentRun(id string) {
	m := &a.agentRuns
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.byID[id]; r != nil {
		r.cancel()
		delete(m.byID, id)
	}
}

// An empty option declines the request without persisting a decision.
func (a *App) AnswerAgentPermission(id, permissionID, optionID string) error {
	r, err := a.agentRuns.get(id)
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

type acpMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}
type acpPacket struct {
	msg acpMessage
	err error
}

func acpRead(ctx context.Context, source io.Reader) <-chan acpPacket {
	out := make(chan acpPacket)
	go func() {
		defer close(out)
		sc := bufio.NewScanner(source)
		sc.Buffer(make([]byte, 8192), 8<<20)
		for sc.Scan() {
			if len(sc.Bytes()) == 0 {
				continue
			}
			var msg acpMessage
			err := json.Unmarshal(sc.Bytes(), &msg)
			if err != nil {
				err = errors.New("VD_AGENT_PROTOCOL")
			}
			select {
			case out <- acpPacket{msg, err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
		if err := sc.Err(); err != nil {
			select {
			case out <- acpPacket{err: err}:
			case <-ctx.Done():
			}
		}
	}()
	return out
}

type acpConn struct {
	out      *json.Encoder
	incoming <-chan acpPacket
	run      *acpRun
	serial   int
	session  string
}

func acpShort(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return strings.ToValidUTF8(s[:max], "") + "…"
}

func (r *acpRun) redacted(s string) string {
	return strings.ReplaceAll(s, r.token, "[redacted]")
}

func (r *acpRun) writeTranscript(text string) {
	if remaining := (256 << 10) - r.transcript.Len(); remaining > 0 {
		r.transcript.WriteString(acpShort(text, remaining))
	}
}

// A credential echoed in several streamed chunks must never briefly appear in
// the UI. Hold a possible token prefix until the next chunk disambiguates it.
func (r *acpRun) messageChunk(s string) {
	if r.transcript.Len() >= 256<<10 {
		return
	}
	visible := r.redacted(r.pendingText + s)
	pending := min(len(visible), len(r.token)-1)
	for pending > 0 && !strings.HasSuffix(visible, r.token[:pending]) {
		pending--
	}
	r.writeTranscript(visible[:len(visible)-pending])
	r.pendingText = strings.Clone(visible[len(visible)-pending:])
}

func (p *acpConn) call(ctx context.Context, method string, params any, result any) error {
	p.serial++
	id := p.serial
	if err := p.out.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case packet, ok := <-p.incoming:
			if !ok {
				return errors.New("VD_AGENT_EXITED")
			}
			if packet.err != nil {
				return packet.err
			}
			m := packet.msg
			if m.Method != "" {
				if err := p.receive(ctx, m); err != nil {
					return err
				}
				continue
			}
			var replyID int
			if json.Unmarshal(m.ID, &replyID) != nil || replyID != id {
				continue
			}
			if m.Error != nil {
				return fmt.Errorf("VD_AGENT_RPC|%s (%d)", acpShort(p.run.redacted(m.Error.Message), 600), m.Error.Code)
			}
			if len(m.Result) == 0 || json.Unmarshal(m.Result, result) != nil {
				return errors.New("VD_AGENT_PROTOCOL")
			}
			return nil
		}
	}
}
func (p *acpConn) receive(ctx context.Context, m acpMessage) error {
	if len(m.ID) != 0 {
		if m.Method == "session/request_permission" {
			return p.permission(ctx, m)
		}
		return p.out.Encode(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": "Client method unavailable"}})
	}
	if m.Method != "session/update" || p.session == "" {
		return nil
	}
	var update struct {
		Session string `json:"sessionId"`
		Update  struct {
			Type    string          `json:"sessionUpdate"`
			Title   string          `json:"title"`
			Content json.RawMessage `json:"content"`
		} `json:"update"`
	}
	if json.Unmarshal(m.Params, &update) != nil || update.Session != p.session {
		return nil
	}
	u := update.Update
	r := p.run
	r.mu.Lock()
	defer r.mu.Unlock()
	switch u.Type {
	case "agent_message_chunk":
		var content struct{ Type, Text string }
		if json.Unmarshal(u.Content, &content) == nil && content.Type == "text" {
			r.messageChunk(content.Text)
		}
	case "tool_call", "tool_call_update":
		if u.Title != "" {
			r.state.Activity = acpShort(r.redacted(u.Title), 220)
		}
	}
	return nil
}
func (p *acpConn) permission(ctx context.Context, m acpMessage) error {
	var request struct {
		Session string `json:"sessionId"`
		Tool    struct {
			Title string `json:"title"`
		} `json:"toolCall"`
		Options []acpOption `json:"options"`
	}
	outcome := map[string]string{"outcome": "cancelled"}
	if json.Unmarshal(m.Params, &request) == nil && p.session != "" && request.Session == p.session && len(request.Options) > 0 && len(request.Options) <= 16 {
		// Only offer scoped, one-time grants. A model cannot approve its own action.
		var options []acpOption
		for _, o := range request.Options {
			if len(o.ID) > 0 && len(o.ID) <= 128 && !strings.Contains(o.ID, p.run.token) && (o.Kind == "allow_once" || o.Kind == "reject_once") {
				o.Name = acpShort(p.run.redacted(o.Name), 140)
				options = append(options, o)
			}
		}
		if len(options) > 0 {
			answer := make(chan string, 1)
			r := p.run
			r.mu.Lock()
			r.state.Permission = &acpPermission{ID: acpID(), Title: acpShort(r.redacted(request.Tool.Title), 400), Options: options}
			r.state.Status = "permission"
			r.decision = answer
			r.mu.Unlock()
			select {
			case id := <-answer:
				if id != "" {
					outcome = map[string]string{"outcome": "selected", "optionId": id}
				}
			case <-ctx.Done():
				// The agent should also receive a cancelled permission response.
			}
		}
	}
	return p.out.Encode(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"outcome": outcome}})
}
