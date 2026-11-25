package syncclient

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"videron/internal/vault"
)

// Manifest describes one server snapshot and its immutable records.
type Manifest struct {
	Cursor      string            `json:"cursor"`
	Main        string            `json:"main"`
	Lineage     string            `json:"lineage"`
	Files       map[string]string `json:"files"`
	ProjectName *string           `json:"projectName,omitempty"`
	IndexCursor string            `json:"indexCursor,omitempty"`
	Base        string            `json:"base,omitempty"`
	Summary     bool              `json:"summary,omitempty"`
	PageTotal   int               `json:"pageTotal,omitempty"`
	Offset      int               `json:"offset,omitempty"`
}

// IndexCache retains record digests and the cursor for one open folder. The caller
// serializes access to the cache and to the maps returned by SyncManifest.
type IndexCache struct {
	address, pin, project, lineage string
	credential                     [sha256.Size]byte
	cursor                         string
	files                          map[string]string
}

func validBlobPath(path, lineage string) bool {
	parts := strings.Split(path, "/")
	return len(parts) == 4 && parts[0] == ".videron-sync" && parts[1] == lineage && (parts[2] == "objects" || parts[2] == "revisions") &&
		strings.HasSuffix(parts[3], ".json") && ValidID(strings.TrimSuffix(parts[3], ".json"))
}

// Manifest fetches a complete index, following all pages for the same snapshot.
func (p *Profile) Manifest(c *http.Client) (Manifest, error) {
	return p.readIndex(context.Background(), c, "", false)
}

// ManifestSummary requests metadata without the full file index on supporting servers.
func (p *Profile) ManifestSummary(ctx context.Context, c *http.Client) (Manifest, error) {
	return p.readIndex(ctx, c, "", true)
}

const syncIndexPageSize = 2048

func (p *Profile) readIndex(ctx context.Context, c *http.Client, since string, summary bool) (Manifest, error) {
	q := url.Values{}
	if summary {
		q.Set("view", "summary")
	} else {
		q.Set("limit", strconv.Itoa(syncIndexPageSize))
		if since != "" {
			q.Set("since", since)
		}
	}
	// A server restart between pages invalidates that snapshot. Discard the
	// partial map and start once more from the beginning against its new epoch.
	m, err := p.readIndexSnapshot(ctx, c, q)
	if errors.Is(err, ErrChanged) {
		q.Del("since")
		m, err = p.readIndexSnapshot(ctx, c, q)
	}
	if err == nil && m.ProjectName != nil {
		p.ProjectName = *m.ProjectName
	}
	return m, err
}

func (p *Profile) readIndexSnapshot(ctx context.Context, c *http.Client, q url.Values) (Manifest, error) {
	first, err := p.indexPage(ctx, c, q)
	if err != nil || first.PageTotal == 0 {
		return first, err
	}
	if first.Offset != 0 {
		return Manifest{}, ErrProtocol
	}
	// Use the first event cursor too. A revision committed while loading
	// the later pages must still wake the very next subscription.
	page := url.Values{"limit": {strconv.Itoa(syncIndexPageSize)}, "snapshot": {first.IndexCursor}}
	if first.Base != "" {
		page.Set("since", first.Base)
	}
	for offset := len(first.Files); offset < first.PageTotal; offset = len(first.Files) {
		page.Set("offset", strconv.Itoa(offset))
		part, err := p.indexPage(ctx, c, page)
		if err != nil {
			return Manifest{}, err
		}
		if part.IndexCursor != first.IndexCursor || part.Lineage != first.Lineage || part.Main != first.Main || part.PageTotal == 0 {
			return Manifest{}, ErrChanged
		}
		if part.Offset != offset || part.PageTotal != first.PageTotal || part.Base != first.Base {
			return Manifest{}, ErrProtocol
		}
		maps.Copy(first.Files, part.Files)
		if len(first.Files)-offset != len(part.Files) {
			return Manifest{}, ErrProtocol
		}
	}
	first.PageTotal = 0
	return first, nil
}

func (p *Profile) indexPage(ctx context.Context, c *http.Client, q url.Values) (Manifest, error) {
	var m Manifest
	route := "/v1/index?" + q.Encode()
	resp, err := p.requestContext(ctx, c, "GET", route, nil)
	if err != nil {
		return m, err
	}
	defer resp.Body.Close()
	if err = json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&m); err != nil {
		return m, vault.ErrCorrupt
	}
	if m.Cursor == "" || m.Files == nil {
		return m, vault.ErrCorrupt
	}
	if m.Summary && q.Get("view") != "summary" || len(m.IndexCursor) > 128 ||
		m.Base != "" && (m.Base != q.Get("since") || m.IndexCursor == "") {
		return m, ErrProtocol
	}
	if m.PageTotal == 0 && m.Offset != 0 {
		return m, ErrProtocol
	}
	if m.PageTotal != 0 && (m.IndexCursor == "" || q.Has("view") ||
		m.Offset < 0 || m.Offset >= m.PageTotal || len(m.Files) == 0 ||
		len(m.Files) > min(syncIndexPageSize, m.PageTotal-m.Offset)) {
		return m, ErrProtocol
	}
	if m.ProjectName != nil {
		if !ValidProjectName(*m.ProjectName) && !(p.ProjectID == "" && *m.ProjectName == "") {
			return m, ErrProtocol
		}
	}
	if m.Main == "" && m.Lineage == "" && len(m.Files) == 0 {
		return m, nil
	}
	if !ValidID(m.Lineage) || !ValidID(m.Main) {
		return m, vault.ErrCorrupt
	}
	for path, hash := range m.Files {
		if !validBlobPath(path, m.Lineage) || !ValidID(hash) {
			return m, vault.ErrCorrupt
		}
	}
	return m, nil
}

// SyncManifest applies the latest server delta to the cache for this connection.
func (p *Profile) SyncManifest(c *http.Client, cache *IndexCache) (Manifest, error) {
	credential := sha256.Sum256([]byte(p.Token))
	if cache.address != p.Address || cache.pin != p.Pin || cache.project != p.ProjectID ||
		cache.lineage != p.Lineage || cache.credential != credential {
		*cache = IndexCache{}
	}
	m, err := p.readIndex(context.Background(), c, cache.cursor, false)
	if err != nil {
		if errors.Is(err, vault.ErrCorrupt) || errors.Is(err, ErrProtocol) {
			*cache = IndexCache{}
		}
		return m, err
	}
	if m.Lineage != p.Lineage {
		*cache = IndexCache{}
		return m, ErrSpace
	}
	if m.Base != "" {
		// A delta can only introduce immutable records. Reject a conflicting
		// digest before mutating the acknowledged index.
		for path, hash := range m.Files {
			if old := cache.files[path]; old != "" && old != hash {
				*cache = IndexCache{}
				return m, ErrProtocol
			}
		}
		maps.Copy(cache.files, m.Files)
		m.Files = cache.files
	}
	cache.remember(p, m, credential)
	return m, nil
}

func (cache *IndexCache) remember(p *Profile, m Manifest, credential [sha256.Size]byte) {
	if m.IndexCursor == "" {
		*cache = IndexCache{}
		return
	}
	*cache = IndexCache{address: p.Address, pin: p.Pin, project: p.ProjectID,
		lineage: p.Lineage, credential: credential, cursor: m.IndexCursor, files: m.Files}
}

// Remember seeds the working copy's cache from a successful enrollment.
func (cache *IndexCache) Remember(p *Profile, m Manifest) {
	cache.remember(p, m, sha256.Sum256([]byte(p.Token)))
}

// Cursor returns the last acknowledged index cursor for this session.
func (cache *IndexCache) Cursor() string { return cache.cursor }
