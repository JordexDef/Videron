package workspacemerge

import "slices"

// ListPatch describes which records and their ordering changed in a collection.
type ListPatch struct {
	Upsert []any    `json:"upsert,omitempty"`
	Remove []string `json:"remove,omitempty"`
	Order  []string `json:"order,omitempty"`
}

// Patch contains only fields and collection records changed relative to a local revision.
type Patch struct {
	Head  string               `json:"head"`
	Set   map[string]any       `json:"set,omitempty"`
	Unset []string             `json:"unset,omitempty"`
	Lists map[string]ListPatch `json:"lists,omitempty"`
}

// Diff computes the patch that takes local to merged, preserving missing versus null fields.
func Diff(local, merged map[string]any) Patch {
	patch := Patch{Set: map[string]any{}, Lists: map[string]ListPatch{}}
	for _, k := range sortedMergeKeys(local, merged) {
		l, r := mergeField(local, k), mergeField(merged, k)
		if mergeEqual(l, r) {
			continue
		}
		if r == absentField {
			patch.Unset = append(patch.Unset, k)
			continue
		}
		if CollectionKind(k) != "" && l != absentField {
			old, ok := indexMergeList(l)
			next, valid := indexMergeList(r)
			if ok && valid {
				change := ListPatch{}
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
