package main

import (
	"crypto/sha256"
	"encoding/json"
	"slices"
	"strings"
)

type FolderMergeProposal struct {
	Token        string                `json:"token"`
	Prepared     bool                  `json:"prepared,omitempty"`
	Conflicts    []FolderMergeConflict `json:"conflicts,omitempty"`
	ChangedNotes []string              `json:"changedNotes,omitempty"`
}

type FolderMergeListPatch struct {
	Upsert []any    `json:"upsert,omitempty"`
	Remove []string `json:"remove,omitempty"`
	Order  []string `json:"order,omitempty"`
}

type FolderMergePatch struct {
	Head  string                          `json:"head"`
	Set   map[string]any                  `json:"set,omitempty"`
	Unset []string                        `json:"unset,omitempty"`
	Lists map[string]FolderMergeListPatch `json:"lists,omitempty"`
}

func buildMergePatch(local, merged mergeObject) FolderMergePatch {
	patch := FolderMergePatch{Set: map[string]any{}, Lists: map[string]FolderMergeListPatch{}}
	for _, k := range sortedMergeKeys(local, merged) {
		l, r := mergeField(local, k), mergeField(merged, k)
		if mergeEqual(l, r) {
			continue
		}
		if r == absentField {
			patch.Unset = append(patch.Unset, k)
			continue
		}
		if mergeCollectionKind(k) != "" && l != absentField {
			old, ok := indexMergeList(l)
			next, valid := indexMergeList(r)
			if ok && valid {
				change := FolderMergeListPatch{}
				for _, id := range old.ids {
					if _, found := next.records[id]; !found {
						change.Remove = append(change.Remove, id)
					}
				}
				for _, id := range next.ids {
					if !mergeEqual(mergeField(old.records, id), next.records[id]) {
						change.Upsert = append(change.Upsert, next.records[id])
					}
				}
				if !slices.Equal(old.ids, next.ids) {
					change.Order = next.ids
				}
				patch.Lists[k] = change
				continue
			}
		}
		patch.Set[k] = r
	}
	return patch
}

// Each revision refers to immutable object IDs. Seed the cache from the local
// head: a one-note remote edit only needs to read the changed archived values.
func (s *folderSpaceSession) newMergePlan(token, tip, base string) (*workspaceMergePlan, error) {
	current, err := decodeMergeJSON(s.sync.payload)
	if err != nil {
		return nil, err
	}
	localRaw := mergeMap(current)
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
	materialize := func(head string) (mergeObject, error) {
		rev, err := s.readRevision(head)
		if err != nil {
			return nil, err
		}
		out := mergeObject{}
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
		for _, item := range mergeArray(out["notes"]) {
			if _, sealed := mergeMap(item)["sealed"]; !sealed {
				continue
			}
			raw, err := json.Marshal(item)
			if err != nil || new(storedNote).UnmarshalJSON(raw) != nil {
				return nil, errCorrupt
			}
		}
		out = cloneMergeWorkspace(out)
		if _, reserved := out[syncProperty]; reserved {
			return nil, errCorrupt
		}
		if err = normalizeMergeWorkspace(out); err != nil {
			return nil, err
		}
		return out, nil
	}
	local := cloneMergeWorkspace(localRaw)
	if err = normalizeMergeWorkspace(local); err != nil {
		return nil, err
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
	return newWorkspaceMergePlan(token, old, local, remote), nil
}

func (a *App) PrepareFolderMerge(folder string, force bool, knownToken string) (FolderMergeProposal, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var proposal FolderMergeProposal
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return proposal, err
	}
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
	plan := s.sync.mergePlan
	if plan == nil || plan.token != token {
		plan, err = s.newMergePlan(token, tip, base)
		if err != nil {
			return proposal, err
		}
		if len(plan.conflicts) == 0 {
			plan.ready, err = plan.resolve(nil)
			if err != nil {
				return proposal, err
			}
			plan.patch = buildMergePatch(plan.local, plan.ready)
			// The commit needs only the resolved result for this pair of heads.
			plan.local = nil
			plan.sources = [3]mergeObject{}
			plan.template = nil
		}
		s.sync.mergePlan = plan
	}
	proposal.Prepared = true
	proposal.Conflicts = plan.conflicts
	notes := plan.patch.Lists["notes"]
	proposal.ChangedNotes = slices.Clone(notes.Remove)
	for _, item := range notes.Upsert {
		proposal.ChangedNotes = append(proposal.ChangedNotes, mergeString(mergeMap(item)["id"]))
	}
	return proposal, nil
}
func (a *App) CommitFolderMergeChoices(folder, token string, choices map[string]string) (FolderMergePatch, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var empty FolderMergePatch
	if token == "" {
		return empty, errInvalid
	}
	s, err := a.currentSpaceSession(folder)
	if err != nil {
		return empty, err
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
		if err := normalizeMergeWorkspace(mergeMap(local)); err != nil {
			return empty, err
		}
		current, err := decodeMergeJSON(s.sync.payload)
		if err != nil {
			return empty, err
		}
		patch := buildMergePatch(mergeMap(local), mergeMap(current))
		patch.Head = receipt.to
		return patch, nil
	}
	plan := s.sync.mergePlan
	if plan == nil || plan.token != token {
		return empty, errChanged
	}
	merged, patch := plan.ready, plan.patch
	if merged == nil {
		merged, err = plan.resolve(choices)
		if err != nil {
			return empty, err
		}
		patch = buildMergePatch(plan.local, merged)
	} else if len(choices) != 0 {
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
