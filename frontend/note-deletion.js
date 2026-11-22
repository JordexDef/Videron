import { gridReservations, slotPoint, validSlot } from './area-grid.js';

// History belongs to this open workspace. Keep only removed notes and the
// incoming references taken out of surviving notes, which may be edited later.
const histories = new WeakMap();
const historyLimit = 20;

export function deleteNote(space, id) {
  return deleteNotes(space,[id])?.[0] ?? null;
}

export function deleteNotes(space, ids) {
  const targets = new Set(ids), entries = [], kept = [], incoming = new Map();
  const areas = new Map((space.areas || []).map(area => [area.id,area]));
  for (const [index,note] of space.notes.entries()) {
    if (!targets.has(note.id)) { kept.push(note); continue; }
    const grid = areas.get(note.areaId)?.grid;
    const cell = validSlot(grid,note.slot) ? {row:Math.floor(note.slot/grid.cols), col:note.slot%grid.cols} : null;
    entries.push({note,index,cell});
  }
  if (!entries.length || entries.length !== targets.size) return null;
  for (const other of kept) {
    if (!other.links.some(id => targets.has(id))) continue;
    const removed = [];
    other.links = other.links.filter((id,index) => {
      if (!targets.has(id)) return true;
      removed.push({id,index});
      return false;
    });
    incoming.set(other.id,removed);
  }
  space.notes = kept;
  const history = histories.get(space) || [];
  history.push({entries,incoming});
  if (history.length > historyLimit) history.shift();
  histories.set(space, history);
  return entries.map(entry => entry.note);
}

export function lastDeletedNote(space) {
  return histories.get(space)?.at(-1)?.entries.at(-1)?.note;
}

export function reparentDeletedNotes(space, areaId, parentId) {
  const placements = [];
  for (const entry of (histories.get(space) || []).flatMap(change => change.entries)) {
    if (entry.note.areaId === areaId) {
      placements.push({id:entry.note.id,slot:entry.note.slot,cell:entry.cell});
      entry.note.areaId = parentId;
      if (entry.note.slot != null) entry.note.slot = null;
      entry.cell = null;
    }
  }
  return placements;
}

export function restoreDeletedNotesArea(space, placements, areaId, parentId) {
  const originals = new Map(placements.map(p => [p.id,p]));
  for (const entry of (histories.get(space) || []).flatMap(change => change.entries)) {
    const original = originals.get(entry.note.id);
    if (!original || entry.note.areaId !== parentId || entry.cell !== null) continue;
    entry.note.areaId = areaId;
    if (original.slot !== undefined) entry.note.slot = original.slot;
    entry.cell = original.cell;
  }
}

export function undoNoteDeletion(space) {
  const note = lastDeletedNote(space);
  return note && undoNotesDeletion(space,[note.id]) ? note : null;
}

// Entries are in their original order. Expand the array once and move each
// survivor at most once, including when the user removed other items later.
function restoreAtIndices(list,entries,valueOf) {
  if (!entries.length) return;
  const oldLength = list.length;
  let read = oldLength, write = oldLength + entries.length;
  list.length = write;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i], position = Math.min(entry.index,oldLength + i);
    while (write > position + 1) list[--write] = list[--read];
    list[--write] = valueOf(entry);
  }
}

export function undoNotesDeletion(space, ids) {
  const deletion = histories.get(space)?.at(-1);
  if (!deletion || ids.length !== deletion.entries.length) return false;
  const notesById = new Map(space.notes.map(other => [other.id, other]));
  if (deletion.entries.some(({note},i) => note.id !== ids[i] || notesById.has(note.id))) return false;
  const areas = new Map((space.areas || []).map(area=>[area.id,area]));
  const gridEntries = deletion.entries.filter(({note})=>areas.get(note.areaId)?.grid);
  if (gridEntries.length) {
    const seats = gridReservations(areas), reseat = new Map();
    for (const note of space.notes) seats.reserve(areas.get(note.areaId),note.slot);
    // Give returning notes their original seats before any overflow from a
    // different grid can claim them. Existing occupants always keep theirs.
    for (const {note,cell} of gridEntries) {
      const area = areas.get(note.areaId), grid = area.grid;
      note.slot = cell && cell.row < grid.rows && cell.col < grid.cols ? cell.row * grid.cols + cell.col : null;
      if (seats.reserve(area,note.slot)) Object.assign(note,slotPoint(grid,note.slot));
      else {
        if (!reseat.has(area.id)) reseat.set(area.id,[]);
        reseat.get(area.id).push(note);
      }
    }
    for (const [areaId,notes] of reseat) seats.settle(notes,areaId);
  }
  restoreAtIndices(space.notes,deletion.entries,entry => entry.note);
  for (const [sourceId,removed] of deletion.incoming) {
    const source = notesById.get(sourceId);
    if (!source) continue;
    const existing = new Set(source.links);
    const missing = removed.filter(({id}) => {
      if (existing.has(id)) return false;
      existing.add(id);
      return true;
    });
    restoreAtIndices(source.links,missing,entry => entry.id);
  }
  histories.get(space).pop();
  return true;
}
