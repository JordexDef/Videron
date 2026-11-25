package workspacestore

import (
	"crypto/sha256"
	"encoding/json"
	"strings"

	"videron/internal/workspacemerge"
)

type MergeProposal struct {
	Token        string                    `json:"token"`
	Prepared     bool                      `json:"prepared,omitempty"`
	Conflicts    []workspacemerge.Conflict `json:"conflicts,omitempty"`
	ChangedNotes []string                  `json:"changedNotes,omitempty"`
}

type preparedFolderMerge struct {
	token string
	plan  *workspacemerge.Plan
}

func (p preparedFolderMerge) proposal() MergeProposal {
	return MergeProposal{
		Token:        p.token,
		Prepared:     true,
		Conflicts:    p.plan.Conflicts(),
		ChangedNotes: p.plan.ChangedNotes(),
	}
}

func decodeMergeJSON(data string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(data))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, errCorrupt
	}
	return value, nil
}

// Each revision refers to immutable object IDs. Seed the cache from the local
// head: a one-note remote edit only needs to read the changed archived values.
func (s *Session) newMergePlan(token, tip, base string) (*preparedFolderMerge, error) {
	current, err := decodeMergeJSON(s.sync.payload)
	if err != nil {
		return nil, err
	}
	localRaw, _ := current.(map[string]any)
	localRev, err := s.readRevision(s.sync.meta.Head)
	if err != nil {
		return nil, err
	}
	cache := map[string]any{}
	for k, id := range localRev.Values {
		v, ok := localRaw[k]
		if !ok {
			return nil, errCorrupt
		}
		cache[id] = v
	}
	for k, ids := range localRev.Lists {
		list, ok := localRaw[k].([]any)
		if !ok || len(list) != len(ids) {
			return nil, errCorrupt
		}
		for i, id := range ids {
			cache[id] = list[i]
		}
	}
	read := func(id string) (any, error) {
		if v, found := cache[id]; found {
			return v, nil
		}
		raw, err := s.readValue(id)
		if err != nil {
			return nil, err
		}
		v, err := decodeMergeJSON(string(raw))
		if err != nil {
			return nil, err
		}
		cache[id] = v
		return v, nil
	}
	materialize := func(head string) (map[string]any, error) {
		rev, err := s.readRevision(head)
		if err != nil {
			return nil, err
		}
		out := map[string]any{}
		for k, id := range rev.Values {
			v, err := read(id)
			if err != nil {
				return nil, err
			}
			out[k] = v
		}
		for k, ids := range rev.Lists {
			if _, duplicate := out[k]; duplicate {
				return nil, errCorrupt
			}
			list := make([]any, len(ids))
			for i, id := range ids {
				v, err := read(id)
				if err != nil {
					return nil, err
				}
				list[i] = v
			}
			out[k] = list
		}
		// A downloaded revision may reference objects that were never accepted
		// by this device. Apply the vault's strict envelope and map-field checks
		// before even offering either note to a conflict preview.
		notes, _ := out["notes"].([]any)
		for _, item := range notes {
			note, _ := item.(map[string]any)
			if _, sealed := note["sealed"]; !sealed {
				continue
			}
			raw, err := json.Marshal(item)
			if err != nil || s.store.validateNote(raw) != nil {
				return nil, errCorrupt
			}
		}
		if _, reserved := out[SyncProperty]; reserved {
			return nil, errCorrupt
		}
		normalized, err := workspacemerge.NormalizedCopy(out)
		if err != nil {
			return nil, errInvalid
		}
		return normalized, nil
	}
	local, err := workspacemerge.NormalizedCopy(localRaw)
	if err != nil {
		return nil, errInvalid
	}
	old := local
	if base != s.sync.meta.Head {
		old, err = materialize(base)
		if err != nil {
			return nil, err
		}
	}
	remote, err := materialize(tip)
	if err != nil {
		return nil, err
	}
	plan, err := workspacemerge.Prepare(old, local, remote)
	if err != nil {
		return nil, errInvalid
	}
	return &preparedFolderMerge{token: token, plan: plan}, nil
}

func (s *Session) PrepareMerge(force bool, knownToken string) (MergeProposal, error) {
	var proposal MergeProposal
	token, tip, base, err := s.pollCandidate(force)
	if err != nil {
		return proposal, err
	}
	proposal.Token = token
	if token == "" {
		s.sync.mergePlan = nil
		return proposal, nil
	}
	if token == knownToken {
		return proposal, nil
	}
	prepared := s.sync.mergePlan
	if prepared == nil || prepared.token != token {
		prepared, err = s.newMergePlan(token, tip, base)
		if err != nil {
			return proposal, err
		}
		s.sync.mergePlan = prepared
	}
	return prepared.proposal(), nil
}

func (s *Session) CommitMergeChoices(token string, choices map[string]string) (workspacemerge.Patch, error) {
	var empty workspacemerge.Patch
	if token == "" {
		return empty, errInvalid
	}
	args, err := json.Marshal(choices)
	if err != nil {
		return empty, errInvalid
	}
	receipt := savePatchReceipt{from: token, to: s.sync.meta.Head, digest: sha256.Sum256(args)}
	if receipt == s.sync.lastMerge {
		// A lost reply can be replayed from the two durable revisions. Keep
		// only a receipt in memory, even when a merge changed many documents.
		before, _, _ := strings.Cut(token, ":")
		revision, err := s.readRevision(before)
		if err != nil {
			return empty, err
		}
		payload, err := s.materialize(revision)
		if err != nil {
			return empty, err
		}
		local, err := decodeMergeJSON(payload)
		if err != nil {
			return empty, err
		}
		localDoc, _ := local.(map[string]any)
		normalized, err := workspacemerge.NormalizedCopy(localDoc)
		if err != nil {
			return empty, errInvalid
		}
		current, err := decodeMergeJSON(s.sync.payload)
		if err != nil {
			return empty, err
		}
		currentDoc, _ := current.(map[string]any)
		patch := workspacemerge.Diff(normalized, currentDoc)
		patch.Head = receipt.to
		return patch, nil
	}
	prepared := s.sync.mergePlan
	if prepared == nil || prepared.token != token {
		return empty, errChanged
	}
	merged, patch, err := prepared.plan.Resolve(choices)
	if err != nil {
		return empty, errInvalid
	}
	data, err := json.Marshal(merged)
	if err != nil {
		return empty, errCorrupt
	}
	// Revalidate both heads under the filesystem writer lock before publishing.
	payload := string(data)
	previousHead := s.sync.meta.Head
	if err = s.commitBranch(token, payload, false); err != nil {
		// The cursor and immutable history are durable before publication of
		// Videron.space. If only publication failed, the next poll retries it.
		// The editor must already use the accepted head and its data.
		if s.sync.meta.Head == previousHead || s.sync.payload != payload {
			return empty, err
		}
	}
	patch.Head = s.sync.meta.Head
	receipt.to = patch.Head
	s.sync.lastMerge = receipt
	return patch, nil
}
