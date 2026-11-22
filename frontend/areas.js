import { reparentDeletedNotes, restoreDeletedNotesArea } from './note-deletion.js';
export { stageRemovalOptions } from './stage-structure.js';
import { DEFAULT_GRID_SPACING, gridReservations, planGridSlots, setGridSpacing, settleAreaNotes, slotPoint, validGridSize, validGridSpacing, validSlot, validStages } from './area-grid.js';

function childrenByParent(areas) {
  const children = new Map();
  for (const area of areas) {
    const parent = area.parentId ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(area);
  }
  return children;
}

export function areaTreeRows(areas) {
  const children = childrenByParent(areas), seen = new Set(), rows = [];
  function visit(root) {
    const pending = [{area:root, depth:0, pathLabel:root.name}];
    while (pending.length) {
      const row = pending.pop(), {area, depth, pathLabel} = row;
      if (seen.has(area.id)) continue;
      seen.add(area.id);
      rows.push(row);
      const nested = children.get(area.id);
      for (let i = (nested?.length || 0) - 1; i >= 0; i--) {
        pending.push({area:nested[i], depth:depth + 1, pathLabel:pathLabel + ' / ' + nested[i].name});
      }
    }
  }
  for (const root of children.get(null) || []) visit(root);
  // A partially imported tree may still have an orphan or a cycle.
  for (const area of areas) if (!seen.has(area.id)) visit(area);
  return rows;
}

export function areaPath(areas, id) {
  return pathFromIndex(new Map(areas.map(area => [area.id, area])),id);
}

function pathFromIndex(byId, id) {
  const seen = new Set(), path = [];
  for (let area = byId.get(id); area && !seen.has(area.id); area = byId.get(area.parentId)) {
    seen.add(area.id);
    path.push(area);
  }
  return path.reverse();
}

export function descendantAreaIds(areas, id) {
  if (id === null) return new Set(areas.map(area => area.id));
  const children = childrenByParent(areas), ids = new Set();
  const pending = areas.some(area => area.id === id) ? [id] : [];
  while (pending.length) {
    const current = pending.pop();
    if (ids.has(current)) continue;
    ids.add(current);
    for (const child of children.get(current) || []) pending.push(child.id);
  }
  return ids;
}

function hasDestination(areas, id) {
  return id === null || areas.some(area => area.id === id);
}

export function canMoveArea(areas, id, parentId) {
  const area = areas.find(item => item.id === id);
  if (!area || (area.parentId ?? null) === parentId || !hasDestination(areas, parentId)) return false;
  return parentId === null || !descendantAreaIds(areas, id).has(parentId);
}

export function createArea(space, {name, color, parentId = null, grid}) {
  const title = typeof name === 'string' ? name.trim() : '';
  if (!title || !/^#[\da-f]{6}$/i.test(color) || !hasDestination(space.areas, parentId)) return null;
  const area = {id:crypto.randomUUID(), name:title, color, parentId};
  if (grid) {
    const {rows,cols,x,y,spacing=DEFAULT_GRID_SPACING,rowSpacing} = grid;
    if (!validGridSize(rows,cols) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    area.grid = {rows,cols,x,y};
    if (!setGridSpacing(area.grid,{spacing,rowSpacing})) return null;
    if (grid.stages !== undefined) {
      if (!validStages(grid.stages,cols)) return null;
      area.grid.stages = grid.stages.slice();
    }
  }
  space.areas.push(area);
  return area;
}

export function moveArea(space, id, parentId) {
  if (!canMoveArea(space.areas, id, parentId)) return false;
  space.areas.find(area => area.id === id).parentId = parentId;
  return true;
}

function placement(note, grid) {
  const state = {id:note.id, areaId:note.areaId ?? null, slot:note.slot ?? null, x:note.x, y:note.y};
  if (validSlot(grid,state.slot)) {
    state.row = Math.floor(state.slot / grid.cols);
    state.col = state.slot % grid.cols;
  }
  return state;
}

export function planAreaNotes(space, noteIds, areaId, startSlot = null, positions = []) {
  const areas = new Map(space.areas.map(a => [a.id,a])), grid = areas.get(areaId)?.grid;
  const failure = reason => ({ok:false,reason,before:[],after:[]});
  if (areaId !== null && !areas.has(areaId)) return failure('destination');
  if (startSlot !== null && !validSlot(grid,startSlot)) return failure('slot');
  const notes = new Map(space.notes.map(n => [n.id,n]));
  const ids = [...new Set(noteIds)].filter(id => notes.has(id));
  const slots = grid && planGridSlots(grid,space.notes.filter(n => n.areaId === areaId),ids,startSlot);
  if (grid && !slots) return failure('full');
  const points = new Map(positions.map(p => [p.id,p]));
  const before = [], after = [];
  // A swap includes the previous occupant so its position is saved and undone
  // together with the dragged note.
  for (const id of slots ? slots.keys() : ids) {
    const note = notes.get(id), slot = slots?.get(id) ?? null;
    const target = grid ? slotPoint(grid,slot) : points.get(id);
    const {x,y} = Number.isFinite(target?.x) && Number.isFinite(target?.y) ? target : note;
    if ((note.areaId ?? null) === areaId && (note.slot ?? null) === slot && note.x === x && note.y === y) continue;
    before.push(placement(note,areas.get(note.areaId)?.grid));
    after.push(placement({id,areaId,slot,x,y},grid));
  }
  return {ok:true,before,after};
}

function applyPlacement(note, state) {
  note.areaId = state.areaId;
  if (note.slot != null || state.slot != null) note.slot = state.slot;
  if (Number.isFinite(state.x) && Number.isFinite(state.y)) { note.x = state.x; note.y = state.y; }
}

export function placeAreaNotes(space, ids, areaId, startSlot = null, positions = []) {
  const plan = planAreaNotes(space,ids,areaId,startSlot,positions);
  if (plan.after.length) {
    const changes = new Map(plan.after.map(s => [s.id,s]));
    for (const note of space.notes) if (changes.has(note.id)) applyPlacement(note,changes.get(note.id));
  }
  return plan;
}

// A free-canvas drop releases each grid member into its own nearest freeform
// parent. Other movable members of the selection keep their existing folders.
export function releaseGridNotes(space, positions, {movePinned = false} = {}) {
  const notes = new Map(space.notes.map(note => [note.id,note]));
  const areas = new Map(space.areas.map(area => [area.id,area]));
  const destinations = new Map(), before = [], after = [];
  const failure = {ok:false,before:[],after:[]};
  const seen = new Set();
  for (const {id,x,y} of positions) {
    const note = notes.get(id);
    if (!note || seen.has(id) || !Number.isFinite(x) || !Number.isFinite(y)) return failure;
    seen.add(id);
    const area = areas.get(note.areaId);
    let areaId = note.areaId ?? null;
    if (area?.grid) {
      if (!validSlot(area.grid,note.slot)) return failure;
      if (!destinations.has(areaId)) {
        const parent = pathFromIndex(areas,areaId).findLast(a => !a.grid);
        destinations.set(areaId,parent?.id ?? null);
      }
      areaId = destinations.get(areaId);
    } else if ((note.pinned && !movePinned) || (note.x === x && note.y === y)) continue;
    before.push(placement(note,area?.grid));
    after.push({id,areaId,slot:null,x,y});
  }
  if (!destinations.size) return failure;
  for (const state of after) applyPlacement(notes.get(state.id),state);
  return {ok:true,before,after};
}

// Row/column address survives changing the number of columns between a move
// and its undo. Ordinary physics updates to x/y don't invalidate the move.
function snapshotSlot(state, grid) {
  if (!grid) return state.slot == null ? null : -1;
  if (Number.isInteger(state.row) && Number.isInteger(state.col))
    return state.row < grid.rows && state.col < grid.cols ? state.row * grid.cols + state.col : -1;
  return validSlot(grid,state.slot) ? state.slot : -1;
}

export function restoreAreaPlacement(space, before, after) {
  if (!before.length || before.length !== after.length) return false;
  const notes = new Map(space.notes.map(n => [n.id,n])), areas = new Map(space.areas.map(a => [a.id,a]));
  const expected = new Map(after.map(s => [s.id,s])), reserved = new Map(), restored = [];
  for (const s of before) {
    const n = notes.get(s.id), was = expected.get(s.id), grid = areas.get(s.areaId)?.grid;
    if (!n || !was || (s.areaId !== null && !areas.has(s.areaId)) || (n.areaId ?? null) !== was.areaId ||
        (n.slot ?? null) !== snapshotSlot(was,areas.get(was.areaId)?.grid)) return false;
    const slot = snapshotSlot(s,grid);
    if (slot === -1) return false;
    if (grid) {
      if (!reserved.has(s.areaId)) reserved.set(s.areaId,new Set());
      const seats = reserved.get(s.areaId);
      if (seats.has(slot)) return false;
      seats.add(slot);
    }
    restored.push(grid ? {...s,slot,...slotPoint(grid,slot)} : s);
  }
  if (space.notes.some(n => !expected.has(n.id) && reserved.get(n.areaId)?.has(n.slot))) return false;
  for (const state of restored) applyPlacement(notes.get(state.id),state);
  return true;
}

export function assignNotesToArea(space, noteIds, areaId) {
  return placeAreaNotes(space,noteIds,areaId).after.length;
}

export function resizeAreaGrid(space, id, rows, cols, spacing, restoredSlots, stages) {
  const area = space.areas.find(a => a.id === id);
  if (!area?.grid || !validGridSize(rows,cols)) return false;
  const members = space.notes.filter(n => n.areaId === id);
  if (members.length > rows * cols) return false;
  const grid = {...area.grid, rows, cols};
  if (grid.stages) {
    const names = stages ?? grid.stages;
    if (!validStages(names,cols)) return false;
    grid.stages = names.slice();
  }
  if (spacing !== undefined && !setGridSpacing(grid,spacing)) return false;
  const oldSeats = members.map(n => {
    const row = Math.floor(n.slot / area.grid.cols), col = n.slot % area.grid.cols;
    const keptSlot = validSlot(area.grid,n.slot) && row < rows && col < cols ? row * cols + col : null;
    return {id:n.id, slot:restoredSlots?.get(n.id) ?? keptSlot};
  });
  if (grid.stages) {
    const occupied = new Set(oldSeats.map(n=>n.slot));
    for (const [i,n] of oldSeats.entries()) {
      if (n.slot !== null) continue;
      const col = members[i].slot % area.grid.cols;
      if (col >= cols) return false;
      let slot = col;
      while (occupied.has(slot)) slot += cols;
      if (!validSlot(grid,slot)) return false;
      n.slot = slot;
      occupied.add(slot);
    }
  }
  const seats = planGridSlots(grid,oldSeats,members.map(n => n.id));
  if (!seats) return false;
  // A note added after a resize may now occupy a former seat. Keep the grid
  // intact if restoring it would silently displace an unrelated member.
  if (restoredSlots?.size && oldSeats.some(n => n.slot !== null && seats.get(n.id) !== n.slot)) return false;
  area.grid = grid;
  for (const n of members) applyPlacement(n,{areaId:id,slot:seats.get(n.id),...slotPoint(grid,seats.get(n.id))});
  return true;
}

export function moveAreaGrid(space, id, x, y) {
  const area = space.areas.find(a => a.id === id);
  if (!area?.grid || !Number.isFinite(x) || !Number.isFinite(y) || (area.grid.x === x && area.grid.y === y)) return false;
  area.grid = {...area.grid,x,y};
  for (const n of space.notes) {
    if (n.areaId === id && validSlot(area.grid,n.slot)) Object.assign(n,slotPoint(area.grid,n.slot));
  }
  return true;
}

// from and to are column positions in the original and final order.
// A stage's name is editable and may also be shared by another stage.
export function reorderAreaStage(area, notes, from, to) {
  const grid = area?.grid;
  if (!grid || !validGridSize(grid.rows,grid.cols) || !validStages(grid.stages,grid.cols)) return false;
  if (from===to || ![from,to].every(col=>Number.isInteger(col) && col>=0 && col<grid.cols)) return false;

  const members = notes.filter(note=>note.areaId===area.id);
  if (members.some(note=>!validSlot(grid,note.slot))) return false;
  const stages = grid.stages.slice();
  const [stage] = stages.splice(from,1);
  stages.splice(to,0,stage);
  area.grid = {...grid,stages};

  const first = Math.min(from,to), last = Math.max(from,to);
  const shift = from<to ? -1 : 1;
  for (const note of members) {
    const col = note.slot % grid.cols;
    if (col<first || col>last) continue;
    note.slot += col===from ? to-from : shift;
    Object.assign(note,slotPoint(grid,note.slot));
  }
  return true;
}

export function removeArea(space, id, recordDeletion) {
  const index = space.areas.findIndex(area => area.id === id);
  if (index < 0) return null;
  const [removed] = space.areas.splice(index, 1), parent = removed.parentId ?? null;
  const children = space.areas.filter(area => area.parentId === id);
  const members = space.notes.filter(note => note.areaId === id);
  const before = recordDeletion && members.map(({id,slot,x,y}) => ({id,slot,x,y}));
  for (const child of children) child.parentId = parent;
  settleAreaNotes(space,members,parent);
  const deletedNotes = reparentDeletedNotes(space,id,parent);
  if (recordDeletion) {
    const grids = new Map(space.areas.map(area => [area.id,area.grid]));
    const after = members.map(note => placement(note,grids.get(note.areaId)));
    recordDeletion({area:removed,id,index,before,after,children:children.map(a => a.id),deletedNotes});
  }
  return removed;
}

export function restoreRemovedArea(space, {area,index,before,after,children,deletedNotes}) {
  const parent = area.parentId ?? null;
  const areas = new Map(space.areas.map(a => [a.id,a]));
  if (areas.has(area.id) || (parent !== null && !areas.has(parent))) return false;
  if (children.some(id => !areas.has(id) || (areas.get(id).parentId ?? null) !== parent)) return false;
  const notes = new Map(space.notes.map(n => [n.id,n]));
  // A parent grid may have moved or changed width. Its row and column still
  // identify a promoted member, while an unrelated later move takes priority.
  for (const expected of after) {
    const note = notes.get(expected.id);
    if (!note || (note.areaId ?? null) !== expected.areaId ||
        (note.slot ?? null) !== snapshotSlot(expected,areas.get(expected.areaId)?.grid)) return false;
  }
  space.areas.splice(index,0,area);
  for (const id of children) areas.get(id).parentId = area.id;
  for (const [i,original] of before.entries()) {
    const note = notes.get(original.id);
    note.areaId = area.id;
    // A freeform-to-freeform promotion only changed the folder. Coordinates
    // may have been updated since, including by the map simulation.
    const fields = area.grid || after[i].slot !== null ? ['slot','x','y'] : ['slot'];
    for (const field of fields) {
      if (original[field] === undefined) delete note[field];
      else note[field] = original[field];
    }
  }
  restoreDeletedNotesArea(space,deletedNotes,area.id,parent);
  return true;
}

// Earlier files omit parentId. Keep recoverable notes and areas accessible
// even if an imported parent is missing, or two folders point to each other.
export function normalizeAreaTree(space) {
  const byId = new Map(space.areas.map(area => [area.id, area])), resolved = new Set();
  for (const start of space.areas) {
    let area = start;
    const chain = new Set();
    while (area && !resolved.has(area.id)) {
      chain.add(area.id);
      const parent = byId.get(area.parentId);
      if (!parent || chain.has(parent.id)) {
        area.parentId = null;
        break;
      }
      area = parent;
    }
    for (const id of chain) resolved.add(id);
  }
  for (const area of space.areas) {
    if (!area.grid) continue;
    if (!validGridSize(area.grid.rows,area.grid.cols)) { delete area.grid; continue; }
    if (!validStages(area.grid.stages,area.grid.cols)) delete area.grid.stages;
    if (!validGridSpacing(area.grid.spacing)) delete area.grid.spacing;
    if (!validGridSpacing(area.grid.rowSpacing)) delete area.grid.rowSpacing;
    if (!Number.isFinite(area.grid.x)) area.grid.x = 0;
    if (!Number.isFinite(area.grid.y)) area.grid.y = 0;
  }
  const seats = gridReservations(byId), repairs = new Map();
  for (const note of space.notes) {
    if (note.areaId != null && !byId.has(note.areaId)) note.areaId = null;
    const area = byId.get(note.areaId);
    if (!area?.grid) { if (note.slot != null) note.slot = null; continue; }
    if (seats.reserve(area,note.slot)) {
      Object.assign(note,slotPoint(area.grid,note.slot));
    } else {
      if (!repairs.has(note.areaId)) repairs.set(note.areaId,[]);
      repairs.get(note.areaId).push(note);
    }
  }
  for (const [id,notes] of repairs) seats.settle(notes,id);
}
