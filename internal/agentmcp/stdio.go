package agentmcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// The MCP child never opens the library. It forwards each stdio message to the
// running desktop session using that session's short-lived, loopback-only grant.
func ServeStdio(input io.Reader, output io.Writer, endpoint, token string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "/mcp" || u.RawQuery != "" || u.Fragment != "" || token == "" {
		return errors.New("invalid or missing Videron connection")
	}
	client := agentHTTPClient(&http.Transport{})
	defer client.CloseIdleConnections()
	return scanAgentStdio(input, output, func(line []byte) ([]byte, error) {
		return forwardAgentRPC(client, endpoint, token, line)
	})
}

func agentHTTPClient(transport *http.Transport) *http.Client {
	return &http.Client{Timeout: 50 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func scanAgentStdio(input io.Reader, output io.Writer, handle func([]byte) ([]byte, error)) error {
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 4096), agentRequestLimit)
	for scan.Scan() {
		line := bytes.TrimSpace(scan.Bytes())
		if len(line) == 0 {
			continue
		}
		data, err := handle(line)
		if err != nil {
			return err
		}
		if len(data) > 0 {
			if _, err = fmt.Fprintln(output, string(bytes.TrimSpace(data))); err != nil {
				return err
			}
		}
	}
	return scan.Err()
}

func forwardAgentRPC(client *http.Client, endpoint, token string, line []byte) ([]byte, error) {
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(line))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("Videron connection closed")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, agentReplyLimit+1))
	resp.Body.Close()
	if err != nil || len(data) > agentReplyLimit || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Videron connection unavailable (%d)", resp.StatusCode)
	}
	if resp.StatusCode == http.StatusAccepted {
		return nil, nil
	}
	if !json.Valid(data) {
		return nil, errors.New("invalid Videron response")
	}
	return data, nil
}
