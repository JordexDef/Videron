package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

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
