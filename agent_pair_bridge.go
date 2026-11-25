package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"videron/internal/syncclient"
)

type pairedNoteGrant struct {
	clientID      string
	discoveryPath string
	workScope     string
}

func (g *noteGrant) checkPairedScope(tool string, args json.RawMessage) error {
	// The WebView reads case-sensitive JavaScript properties. Go's default
	// struct decoder also accepts "Offset", which could mask the real offset.
	var properties map[string]json.RawMessage
	var scope string
	var offset int
	if json.Unmarshal(args, &properties) != nil ||
		(properties["scope"] != nil && json.Unmarshal(properties["scope"], &scope) != nil) ||
		(properties["offset"] != nil && json.Unmarshal(properties["offset"], &offset) != nil) {
		return errors.New("Invalid scope or page offset.")
	}
	if tool == "create_tasks" || tool == "update_task" {
		if scope != g.pair.workScope {
			return errors.New("The write scope is missing or expired. Read the currently shared idea with read_idea and use its scope for work on that idea.")
		}
		return nil
	}
	if scope != "" || offset > 0 {
		if scope != g.pair.workScope && (tool != "list_tasks" || scope != g.id) {
			return errors.New("This page belongs to a different or expired idea. Read the first page of the currently shared idea.")
		}
	}
	return nil
}

func (g *noteGrant) pairedPage(tool string, answer agentAnswer) agentAnswer {
	var page map[string]json.RawMessage
	if json.Unmarshal([]byte(answer.text), &page) != nil || page == nil {
		return agentAnswer{"Invalid page from Videron.", true}
	}
	// A tasks page can authorize its own continuation. Only a successful
	// read of the idea gives the caller the scope required for mutations.
	scope := g.id
	if tool == "read_idea" {
		scope = g.pair.workScope
	}
	page["scope"], _ = json.Marshal(scope)
	access := "read"
	if g.write {
		access = "tasks"
	}
	page["access"], _ = json.Marshal(access)
	text, err := json.Marshal(page)
	if err != nil {
		return agentAnswer{"Invalid page from Videron.", true}
	}
	return agentAnswer{string(text), false}
}

// Only this public, authenticated locator outlives a crashed desktop process.
// The desktop creates a new TLS identity and bearer credential for every grant.
type agentRoute struct {
	Client    string `json:"client"`
	Grant     string `json:"grant"`
	Endpoint  string `json:"endpoint"`
	Pin       string `json:"pin"`
	Signature string `json:"signature"`
}

func agentMAC(key string, fields ...string) string {
	msg, _ := json.Marshal(fields)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write(msg)
	return hex.EncodeToString(mac.Sum(nil))
}

func (r agentRoute) signature(key string) string {
	return agentMAC(key, "Videron MCP discovery 1", r.Client, r.Grant, r.Endpoint, r.Pin)
}

func (r agentRoute) bearer(key string) string {
	return agentMAC(key, "Videron MCP request 1", r.Client, r.Grant)
}

func (g *noteGrant) preparePairedListener(listener net.Listener, c agentClient) (net.Listener, error) {
	path, err := agentFile("active.json")
	if err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	leaf := &x509.Certificate{NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(1, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, leaf, leaf, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	r := agentRoute{Client: c.ID, Grant: g.id, Endpoint: "https://" + listener.Addr().String() + "/mcp", Pin: fmt.Sprintf("%x", sha256.Sum256(der))}
	r.Signature = r.signature(c.Key)
	payload, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	if _, err = writeAtomic(path, payload, ".active-*.tmp"); err != nil {
		return nil, errAgentClientStore
	}
	g.pair = &pairedNoteGrant{clientID: c.ID, discoveryPath: path, workScope: rand.Text()}
	g.endpoint = r.Endpoint
	g.token = r.bearer(c.Key)
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	return tls.NewListener(listener, &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}}), nil
}

const agentNoSharedIdea = "No idea is shared with this client. Open Videron, unlock the workspace, and share an idea with this saved agent."

func (c agentClient) currentRoute() (agentRoute, error) {
	path, err := agentFile("active.json")
	if err != nil {
		return agentRoute{}, err
	}
	data, err := readAgentFile(path, 4096)
	if err != nil {
		return agentRoute{}, err
	}
	var r agentRoute
	if json.Unmarshal(data, &r) != nil || r.Client != c.ID || !hmac.Equal([]byte(r.Signature), []byte(r.signature(c.Key))) {
		return agentRoute{}, errors.New("no matching grant")
	}
	u, err := url.Parse(r.Endpoint)
	if err != nil || u.Scheme != "https" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.String() != "https://"+u.Host+"/mcp" || !syncclient.ValidID(r.Pin) {
		return agentRoute{}, errors.New("invalid local grant")
	}
	return r, nil
}

func servePairedAgentStdio(input io.Reader, output io.Writer, c agentClient) error {
	if c.ID == "" || c.Key == "" {
		return errors.New("missing Videron client credentials")
	}
	return scanAgentStdio(input, output, func(line []byte) ([]byte, error) {
		var req agentRPC
		if json.Unmarshal(line, &req) != nil {
			return agentReply(nil, nil, -32700, "Invalid JSON")
		}
		if req.Version != "2.0" || req.Method == "" {
			return agentReply(req.ID, nil, -32600, "Invalid request")
		}
		if len(req.ID) == 0 {
			if strings.HasPrefix(req.Method, "notifications/") {
				return nil, nil
			}
			return agentReply(nil, nil, -32600, "Missing request ID")
		}
		// A client may cache tools/list for its lifetime. Keep discovery stable
		// across desktop restarts and check the live permissions on every call.
		if req.Method != "tools/call" {
			result, code, message := agentInfo(req, true, true)
			return agentReply(req.ID, result, code, message)
		}
		r, err := c.currentRoute()
		if err != nil {
			return agentReply(req.ID, agentToolResult(agentNoSharedIdea, true), 0, "")
		}
		client := agentHTTPClient(&http.Transport{TLSClientConfig: syncclient.PinnedTLS(r.Pin), TLSHandshakeTimeout: 3 * time.Second, DisableKeepAlives: true})
		data, err := forwardAgentRPC(client, r.Endpoint, r.bearer(c.Key), line)
		if err == nil {
			return data, nil
		}
		// Never retry a call against a replacement grant, even if its endpoint
		// appears while the previous one is shutting down.
		return agentReply(req.ID, agentToolResult("The Videron connection ended before a reply arrived. Open Videron and check the shared idea and its tasks before retrying.", true), 0, "")
	})
}
