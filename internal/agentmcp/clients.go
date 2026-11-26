package agentmcp

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"videron/internal/localprotect"
	"videron/internal/workspacestore"
)

var (
	ErrClientName       = errors.New("VD_AGENT_CLIENT_NAME")
	ErrClientDuplicate  = errors.New("VD_AGENT_CLIENT_DUPLICATE")
	errAgentClientLimit = errors.New("VD_AGENT_CLIENT_LIMIT")
	ErrClientUnknown    = errors.New("VD_AGENT_CLIENT_UNKNOWN")
	errAgentClientStore = errors.New("VD_AGENT_CLIENT_STORE")
)

type agentClientInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type agentClient struct {
	agentClientInfo
	Key string `json:"key"`
}

func agentFile(name string) (string, error) {
	dir, err := os.UserConfigDir()
	// Windows' configuration directory roams. Pairings belong to this device.
	if runtime.GOOS == "windows" {
		dir, err = os.UserCacheDir()
	}
	if err != nil || !filepath.IsAbs(dir) {
		return "", errAgentClientStore
	}
	return filepath.Join(dir, "Videron", "agents", name), nil
}

func readAgentFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errAgentClientStore
	}
	return data, nil
}

func loadAgentClients() ([]agentClient, error) {
	path, err := agentFile("clients.key")
	if err != nil {
		return nil, err
	}
	data, err := readAgentFile(path, 64<<10)
	if errors.Is(err, os.ErrNotExist) {
		return []agentClient{}, nil
	}
	if err != nil {
		return nil, errAgentClientStore
	}
	defer clear(data)
	raw, err := localprotect.Unprotect(data)
	if err != nil {
		return nil, errAgentClientStore
	}
	defer clear(raw)
	var clients []agentClient
	if json.Unmarshal(raw, &clients) != nil || clients == nil || len(clients) > 64 {
		return nil, errAgentClientStore
	}
	for _, c := range clients {
		if !validAgentName(c.Name) || c.ID == "" || len(c.Key) < 32 {
			return nil, errAgentClientStore
		}
	}
	return clients, nil
}

func saveAgentClients(clients []agentClient) error {
	path, err := agentFile("clients.key")
	if err != nil {
		return err
	}
	raw, err := json.Marshal(clients)
	if err != nil {
		return errAgentClientStore
	}
	defer clear(raw)
	// DPAPI on Windows; private directory and atomic 0600 file on Unix.
	data, err := localprotect.Protect(raw)
	if err != nil {
		return errAgentClientStore
	}
	defer clear(data)
	if _, err = workspacestore.WriteAtomic(path, data, ".clients-*.tmp"); err != nil {
		return errAgentClientStore
	}
	return nil
}

func validAgentName(name string) bool {
	return name != "" && name == strings.TrimSpace(name) && utf8.ValidString(name) && utf8.RuneCountInString(name) <= 64 && strings.IndexFunc(name, unicode.IsControl) < 0
}

func findAgentClient(id string) (agentClient, error) {
	clients, err := loadAgentClients()
	if err != nil {
		return agentClient{}, err
	}
	for _, c := range clients {
		if c.ID == id {
			return c, nil
		}
	}
	return agentClient{}, ErrClientUnknown
}

func (c agentClient) installation() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	record := map[string]any{"command": exe, "args": []string{"--agent-mcp-paired"}, "env": map[string]string{
		"VIDERON_AGENT_CLIENT": c.ID, "VIDERON_AGENT_KEY": c.Key,
	}}
	out, err := json.Marshal(map[string]any{"id": c.ID, "name": c.Name, "config": map[string]any{"mcpServers": map[string]any{"videron": record}}})
	return string(out), err
}

func (s *Access) ListClients() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	clients, err := loadAgentClients()
	if err != nil {
		return "", err
	}
	list := make([]agentClientInfo, 0, len(clients))
	for _, c := range clients {
		list = append(list, c.agentClientInfo)
	}
	out, err := json.Marshal(list)
	return string(out), err
}

func (s *Access) RegisterClient(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name = strings.TrimSpace(name)
	if !validAgentName(name) {
		return "", ErrClientName
	}
	clients, err := loadAgentClients()
	if err != nil {
		return "", err
	}
	for _, c := range clients {
		if strings.EqualFold(c.Name, name) {
			return "", ErrClientDuplicate
		}
	}
	if len(clients) >= 64 {
		return "", errAgentClientLimit
	}
	c := agentClient{agentClientInfo: agentClientInfo{ID: rand.Text(), Name: name}, Key: rand.Text() + rand.Text()}
	config, err := c.installation()
	if err != nil {
		return "", err
	}
	if err = saveAgentClients(append(clients, c)); err != nil {
		return "", err
	}
	return config, nil
}

func (s *Access) ClientConfig(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := findAgentClient(id)
	if err != nil {
		return "", err
	}
	return c.installation()
}

func (s *Access) ForgetClient(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	clients, err := loadAgentClients()
	if err != nil {
		return err
	}
	index := slices.IndexFunc(clients, func(c agentClient) bool { return c.ID == id })
	if index < 0 {
		return ErrClientUnknown
	}
	if err = saveAgentClients(slices.Delete(clients, index, index+1)); err != nil {
		return err
	}
	if g := s.current; g != nil && g.pair != nil && g.pair.clientID == id {
		s.current = nil
		g.close()
	}
	return nil
}
