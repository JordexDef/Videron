// Keep the persisted representation separate from the mutable records held by editors.
// An IPC write acknowledges its own snapshot even if typing continued while it ran.
const collections = ['notes', 'areas', 'mapInk'];
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

// Strings are immutable. Keep their original value so changing a title or map
// position never serializes a data document or a sealed envelope.
function snapshotRow(row) {
  const fields = Object.create(null);
  for (const [key, value] of Object.entries(row)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') fields[key] = value;
    else if (typeof value === 'number') fields[key] = Number.isFinite(value) ? value : null;
    else {
      const json = JSON.stringify(value);
      if (json !== undefined) fields[key] = {json};
    }
  }
  return fields;
}

function fieldValue(value) {
  return value && typeof value === 'object' ? JSON.parse(value.json) : value;
}

// In Unicode mode a valid surrogate pair matches its full code point.
// Retain lone UTF-16 units verbatim by sending that string as ordinary JSON.
const unpairedSurrogate = /[\uD800-\uDFFF]/u;

function textSplice(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string' || after.length < 4096 ||
      unpairedSurrogate.test(before) || unpairedSurrogate.test(after)) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0, tail = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  // Cut between Unicode code points, including when two emoji share a surrogate.
  const lowSurrogate = code => code >= 0xdc00 && code <= 0xdfff;
  if (lowSurrogate(before.charCodeAt(start))) start--;
  while (tail < limit - start &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  if (lowSurrogate(before.charCodeAt(before.length - tail))) tail--;
  if (start + tail < 128) return null;
  return {start, remove: before.length - start - tail, insert: after.slice(start, after.length - tail)};
}

function editRow(before, after, isNote) {
  const edit = {}, set = Object.create(null), unset = [];
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) unset.push(key);
  for (const [key, value] of Object.entries(after)) {
    const old = before[key];
    if (old === value || (value && typeof value === 'object' && old?.json === value.json)) continue;
    const splice = isNote && key === 'dataText' && textSplice(old, value);
    if (splice) edit.textSplice = splice;
    else set[key] = fieldValue(value);
  }
  if (Object.keys(set).length) edit.set = set;
  if (unset.length) edit.unset = unset;
  return edit;
}

function diffRows(previous, rows, touched, isNote, checkOrder) {
  const put = [], edit = [], remove = [], updates = new Map();
  for (const row of touched ? touched.values() : rows) {
    if (!row) continue;
    const next = snapshotRow(row), before = previous.get(row.id);
    if (before) {
      const changes = editRow(before, next, isNote);
      if (!Object.keys(changes).length) continue;
      edit.push({id: row.id, ...changes});
    } else {
      put.push(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, fieldValue(v)])));
    }
    updates.set(row.id, next);
  }
  let order;
  if (touched) {
    for (const [id,row] of touched) if (row === null && previous.has(id)) remove.push(id);
  }
  if (!touched || checkOrder) {
    const ids = new Set(rows.map(row => row.id));
    if (!touched) for (const id of previous.keys()) if (!ids.has(id)) remove.push(id);
    // New records append in put order. Send an order only for insertion or reordering.
    const appended = [...previous.keys()].filter(id => ids.has(id));
    for (const row of put) appended.push(row.id);
    if (rows.some((row, i) => appended[i] !== row.id)) order = [...ids];
  }
  const patch = {};
  if (put.length) patch.put = put;
  if (edit.length) patch.edit = edit;
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
    this.rows = Object.fromEntries(collections.map(key => [key, new Map((space[key] ?? []).map(row => [row.id, snapshotRow(row)]))]));
    this.sealed = new Set(space.notes.filter(n => Object.hasOwn(n, 'sealed')).map(n => n.id));
    this.generation = 0;
    this.clearMarks();
  }
  clearMarks() {
    this.all = false;
    this.meta = false;
    this.mapInkOrder = false;
    this.touched = {notes: new Map(), areas: new Map(), mapInk: new Map()};
  }
  mark(scope) {
    this.generation++;
    if (!scope || scope.all) this.all = true;
    else if (!this.all) {
      if (scope.meta) this.meta = true;
      if (scope.mapInkOrder) this.mapInkOrder = true;
      if (scope.removedInk && this.touched.mapInk) {
        for (const id of typeof scope.removedInk === 'string' ? [scope.removedInk] : scope.removedInk)
          this.touched.mapInk.set(id,null);
      }
      for (const key of collections) {
        if (scope[key] === true) this.touched[key] = null;
        else if (scope[key] && this.touched[key]) for (const row of scope[key]) this.touched[key].set(row.id, row);
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
      if (!this.all && this.touched[key]?.size === 0) continue;
      const result = diffRows(this.rows[key], space[key] ?? [], this.all ? null : this.touched[key], key === 'notes', key === 'mapInk' && this.mapInkOrder);
      if (Object.keys(result.patch).length) patch[key] = result.patch;
      commits.push(result.commit);
    }
    const seal = [], unseal = [];
    for (const id of patch.notes?.remove ?? []) if (this.sealed.has(id)) unseal.push(id);
    for (const note of patch.notes?.put ?? []) {
      const sealed = Object.hasOwn(note, 'sealed');
      if (sealed !== this.sealed.has(note.id)) (sealed ? seal : unseal).push(note.id);
    }
    for (const change of patch.notes?.edit ?? []) {
      if (change.unset?.includes('sealed') && this.sealed.has(change.id)) unseal.push(change.id);
      if (change.set && Object.hasOwn(change.set, 'sealed') && !this.sealed.has(change.id)) seal.push(change.id);
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
    for (const key of delta.unset ?? []) {
      if (collectionKeys.has(key)) this.rows[key].clear();
      else this.fields.delete(key);
    }
    for (const [key, value] of Object.entries(delta.set ?? {})) {
      if (collectionKeys.has(key)) this.rows[key] = new Map(value.map(row => [row.id,snapshotRow(row)]));
      else this.fields.set(key, JSON.stringify(value));
    }
    for (const [key, changes] of Object.entries(delta.lists ?? {})) {
      const rows = key === 'routes' ? new Map(JSON.parse(this.fields.get('routes') ?? '[]').map(row => [row.id, row])) : this.rows[key];
      for (const id of changes.remove ?? []) {
        rows.delete(id);
        if (key === 'notes') this.sealed.delete(id);
      }
      for (const row of changes.upsert ?? []) {
        rows.set(row.id, key === 'routes' ? row : snapshotRow(row));
        if (key === 'notes') {
          if (Object.hasOwn(row, 'sealed')) this.sealed.add(row.id);
          else this.sealed.delete(row.id);
        }
      }
      const ordered = changes.order ? new Map(changes.order.map(id => [id, rows.get(id)])) : rows;
      if (key === 'routes') this.fields.set(key, JSON.stringify([...ordered.values()]));
      else this.rows[key] = ordered;
    }
  }
}
