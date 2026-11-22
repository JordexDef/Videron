// Keep the persisted representation separate from the mutable records held by editors.
// An IPC write acknowledges its own snapshot even if typing continued while it ran.
const collections = ['notes', 'areas'];
const collectionKeys = new Set(collections);

function fieldSnapshot(object, excluded) {
  const fields = new Map();
  for (const key of Object.keys(object)) {
    if (excluded.has(key)) continue;
    const value = JSON.stringify(object[key]);
    if (value !== undefined) fields.set(key, value);
  }
  return fields;
}

export function diffFields(previous, object, keys, excluded = new Set()) {
  const next = new Map(), set = Object.create(null), unset = [];
  for (const key of keys ?? new Set([...previous.keys(), ...Object.keys(object)])) {
    if (excluded.has(key)) continue;
    const value = Object.hasOwn(object, key) ? JSON.stringify(object[key]) : undefined;
    if (previous.get(key) === value) continue;
    next.set(key, value);
    if (value === undefined) unset.push(key);
    else set[key] = JSON.parse(value);
  }
  const patch = {};
  if (Object.keys(set).length) patch.set = set;
  if (unset.length) patch.unset = unset;
  return {patch, commit() {
    for (const [key, value] of next) {
      if (value === undefined) previous.delete(key);
      else previous.set(key, value);
    }
  }};
}

function snapshotRows(rows) {
  return new Map(rows.map(row => [row.id, JSON.stringify(row)]));
}

function diffRows(previous, rows, touched) {
  const put = [], remove = [], updates = new Map();
  for (const row of touched ? touched.values() : rows) {
    const value = JSON.stringify(row);
    if (previous.get(row.id) === value) continue;
    updates.set(row.id, value);
    put.push(JSON.parse(value));
  }
  let order;
  if (!touched) {
    const ids = new Set(rows.map(row => row.id));
    for (const id of previous.keys()) if (!ids.has(id)) remove.push(id);
    // New records append in put order. Send an order only for insertion or reordering.
    const appended = [...previous.keys()].filter(id => ids.has(id));
    for (const id of ids) if (!previous.has(id)) appended.push(id);
    if (rows.some((row, i) => appended[i] !== row.id)) order = [...ids];
  }
  const patch = {};
  if (put.length) patch.put = put;
  if (remove.length) patch.remove = remove;
  if (order) patch.order = order;
  return {patch, commit() {
    for (const id of remove) previous.delete(id);
    for (const [id, value] of updates) previous.set(id, value);
    if (order) {
      const sorted = order.map(id => [id, previous.get(id)]);
      previous.clear();
      for (const [id, value] of sorted) previous.set(id, value);
    }
  }};
}

export class WorkspaceRecords {
  constructor(space) {
    this.fields = fieldSnapshot(space, collectionKeys);
    this.rows = Object.fromEntries(collections.map(key => [key, snapshotRows(space[key])]));
    this.sealed = new Set(space.notes.filter(n => Object.hasOwn(n, 'sealed')).map(n => n.id));
    this.generation = 0;
    this.clearMarks();
  }
  clearMarks() {
    this.all = false;
    this.meta = false;
    this.touched = {notes: new Map(), areas: new Map()};
  }
  mark(scope) {
    this.generation++;
    if (!scope || scope.all) this.all = true;
    else if (!this.all) {
      if (scope.meta) this.meta = true;
      for (const key of collections) {
        if (scope[key]) for (const row of scope[key]) this.touched[key].set(row.id, row);
      }
    }
  }
  prepare(space) {
    const generation = this.generation, commits = [], patch = {};
    if (this.meta || this.all) {
      const fields = diffFields(this.fields, space, undefined, collectionKeys);
      Object.assign(patch, fields.patch);
      commits.push(fields.commit);
    }
    for (const key of collections) {
      if (!this.all && !this.touched[key].size) continue;
      const result = diffRows(this.rows[key], space[key], this.all ? null : this.touched[key]);
      if (Object.keys(result.patch).length) patch[key] = result.patch;
      commits.push(result.commit);
    }
    const seal = [], unseal = [];
    for (const id of patch.notes?.remove ?? []) if (this.sealed.has(id)) unseal.push(id);
    for (const note of patch.notes?.put ?? []) {
      const sealed = Object.hasOwn(note, 'sealed');
      if (sealed !== this.sealed.has(note.id)) (sealed ? seal : unseal).push(note.id);
    }
    return {patch: Object.keys(patch).length ? patch : null,
      hasSealedNotes: this.sealed.size + seal.length - unseal.length > 0,
      commit: () => {
        for (const apply of commits) apply();
        for (const id of unseal) this.sealed.delete(id);
        for (const id of seal) this.sealed.add(id);
        if (generation === this.generation) this.clearMarks();
      }};
  }

  // Advance only the disk baseline. Marks from edits made during a merge survive.
  acceptMerge(delta) {
    for (const key of delta.unset ?? []) this.fields.delete(key);
    for (const [key, value] of Object.entries(delta.set ?? {})) this.fields.set(key, JSON.stringify(value));
    for (const [key, changes] of Object.entries(delta.lists ?? {})) {
      const rows = key === 'routes' ? snapshotRows(JSON.parse(this.fields.get('routes') ?? '[]')) : this.rows[key];
      for (const id of changes.remove ?? []) {
        rows.delete(id);
        if (key === 'notes') this.sealed.delete(id);
      }
      for (const row of changes.upsert ?? []) {
        rows.set(row.id, JSON.stringify(row));
        if (key === 'notes') {
          if (Object.hasOwn(row, 'sealed')) this.sealed.add(row.id);
          else this.sealed.delete(row.id);
        }
      }
      const ordered = changes.order ? new Map(changes.order.map(id => [id, rows.get(id)])) : rows;
      if (key === 'routes') this.fields.set(key, JSON.stringify([...ordered.values()].map(raw => JSON.parse(raw))));
      else this.rows[key] = ordered;
    }
  }
}
