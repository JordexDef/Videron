package syncclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"videron/internal/vault"
)

var (
	ErrChanged      = errors.New("VD_CHANGED")
	ErrSpaceMissing = errors.New("VD_SPACE_MISSING")
)

func (p *Profile) request(c *http.Client, method, route string, body io.Reader) (*http.Response, error) {
	return p.requestContext(context.Background(), c, method, route, body)
}

func (p *Profile) requestContext(ctx context.Context, c *http.Client, method, route string, body io.Reader) (*http.Response, error) {
	var mode string
	path, _, _ := strings.Cut(route, "?")
	catalog := path == "/v1/projects" || strings.HasPrefix(path, "/v1/projects/")
	management := catalog && (method == http.MethodPatch || method == http.MethodDelete)
	scoped := p.ProjectID != "" && !catalog
	if scoped {
		if !ValidID(p.ProjectID) || !strings.HasPrefix(route, "/v1/") {
			return nil, ErrCode
		}
		// A legacy server ignores unknown headers. A distinct path prevents
		// any write to its default store if the server is rolled back.
		route = "/v1/projects/" + p.ProjectID + "/" + strings.TrimPrefix(route, "/v1/")
	}
	req, err := http.NewRequestWithContext(traceSyncTransport(ctx, &mode), method, p.Address+route, body)
	if err != nil {
		return nil, ErrCode
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	if path == "/v1/index" {
		req.Header.Set("X-Videron-Catalog-Version", "2")
	}
	if scoped {
		req.Header.Set("X-Videron-Project", p.ProjectID)
	}
	if method == "PUT" {
		req.Header.Set("If-None-Match", "*")
		req.Header.Set("X-Videron-Lineage", p.Lineage)
		req.Header.Set("Content-Type", "application/octet-stream")
	} else if catalog && body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.Do(req)
	if err != nil {
		if errors.Is(err, ErrCert) {
			return nil, ErrCert
		}
		return nil, ErrOffline
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		if scoped && res.Header.Get("X-Videron-Project") != p.ProjectID {
			res.Body.Close()
			return nil, ErrProtocol
		}
		if mode != "" {
			p.Transport = mode
		}
		return res, nil
	}
	res.Body.Close()
	switch res.StatusCode {
	case 401, 403:
		return nil, ErrAuth
	case http.StatusGone:
		if res.Header.Get("X-Videron-Project-Deleted") == "1" && res.Header.Get("X-Videron-Project") == p.ProjectID {
			return nil, ErrProjectDeleted
		}
		return nil, ErrProtocol
	case 412:
		if management {
			return nil, ErrProjectChanged
		}
		return nil, ErrChanged
	case 409:
		if management {
			return nil, ErrProjectExists
		}
		// Our writes use If-None-Match: *. Only a 412 means another peer
		// published this record first. A 409 rejects the target lineage.
		if method == http.MethodPut && (path == "/v1/main" || path == "/v1/file") {
			return nil, ErrSpace
		}
		return nil, ErrChanged
	case http.StatusMethodNotAllowed:
		if management {
			return nil, ErrProjectManagementUnsupported
		}
		return nil, fmt.Errorf("VD_SERVER_RESPONSE|HTTP %d", res.StatusCode)
	case 404:
		return nil, ErrSpaceMissing
	}
	return nil, fmt.Errorf("VD_SERVER_RESPONSE|HTTP %d", res.StatusCode)
}

// WaitChange waits for the server to broadcast a cursor newer than the caller's.
func (p *Profile) WaitChange(c *http.Client, cursor string) (string, error) {
	resp, err := p.request(c, http.MethodGet, "/v1/events?since="+url.QueryEscape(cursor), nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var event struct {
		Cursor string `json:"cursor"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&event) != nil || event.Cursor == "" {
		return "", vault.ErrCorrupt
	}
	return event.Cursor, nil
}
