// Projects saved before spacing was configurable used this fixed pitch.
export const GRID_PITCH = 184;
export const DEFAULT_GRID_SPACING = 96;
export const MIN_GRID_SPACING = 24;
export const MAX_GRID_SPACING = 320;

export function validGridSpacing(spacing) {
  return Number.isInteger(spacing) && spacing >= MIN_GRID_SPACING && spacing <= MAX_GRID_SPACING;
}

export function gridSpacing(grid) {
  return validGridSpacing(grid?.spacing) ? grid.spacing : GRID_PITCH;
}

// Older grids stored one pitch, shared by both axes.
export function gridRowSpacing(grid) {
  return validGridSpacing(grid?.rowSpacing) ? grid.rowSpacing : gridSpacing(grid);
}

export function setGridSpacing(grid, pitch) {
  const spacing = pitch?.spacing ?? pitch, rowSpacing = pitch?.rowSpacing === undefined ? spacing : pitch.rowSpacing;
  if (!validGridSpacing(spacing) || !validGridSpacing(rowSpacing)) return false;
  grid.spacing = spacing;
  if (rowSpacing === spacing) delete grid.rowSpacing;
  else grid.rowSpacing = rowSpacing;
  return true;
}

export const inSlot = note => Number.isInteger(note.slot) && note.slot >= 0;
export const isPinned = note => inSlot(note) || !!note.pinned;

export function validGridSize(rows, cols) {
  return [rows,cols].every(n => Number.isInteger(n) && n >= 1 && n <= 100);
}

export function validStages(stages, cols) {
  return Array.isArray(stages) && stages.length === cols &&
    stages.every(name => typeof name === 'string' && name.trim().length > 0 && name.length <= 80);
}

export function validSlot(grid, slot) {
  return !!grid && Number.isInteger(slot) && slot >= 0 && slot < grid.rows * grid.cols;
}

export function slotPoint(grid, slot, point = {}) {
  point.x = grid.x + slot % grid.cols * gridSpacing(grid);
  point.y = grid.y + Math.floor(slot / grid.cols) * gridRowSpacing(grid);
  return point;
}

// Selection members already in the target keep (or reuse) their seats.
export function fullGridIds(space, ids) {
  const selected = new Set(ids), counts = new Map(), full = new Set();
  const tracks = new Map(space.areas.filter(a=>a.grid?.stages).map(a=>[a.id,{grid:a.grid,first:0,alreadyHere:0}]));
  for (const n of space.notes) {
    if (!selected.has(n.id)) counts.set(n.areaId,(counts.get(n.areaId) || 0) + 1);
    const track=tracks.get(n.areaId);
    if(track && validSlot(track.grid,n.slot)){
      if(n.slot%track.grid.cols===0)track.first++;
      if(selected.has(n.id))track.alreadyHere++;
    }
  }
  for (const area of space.areas) {
    const track=tracks.get(area.id);
    if(track && selected.size-track.alreadyHere > track.grid.rows-track.first)full.add(area.id);
    if (area.grid && selected.size + (counts.get(area.id) || 0) > area.grid.rows * area.grid.cols) full.add(area.id);
  }
  return full;
}

export function planGridSlots(grid, occupants, ids, startSlot = null) {
  if (!grid || !validGridSize(grid.rows,grid.cols) || (startSlot !== null && !validSlot(grid,startSlot))) return null;
  const selected = new Set(ids), original = new Map(), occupied = new Map();
  if (!selected.size) return new Map();
  for (const note of occupants) {
    if (!validSlot(grid,note.slot)) continue;
    if (selected.has(note.id)) original.set(note.id,note.slot);
    else occupied.set(note.slot,note.id);
  }
  const capacity = grid.rows*grid.cols;
  if (capacity-occupied.size < selected.size) return null;
  if (startSlot !== null) return planMapDrop(grid,selected,original,occupied,startSlot);

  // Sidebar drops and resizing keep existing seats and take the first free ones.
  const assigned = new Map();
  for (const [id,slot] of original) if (!occupied.has(slot)) {
    assigned.set(id,slot); occupied.set(slot,id);
  }
  let cursor = 0;
  const stride = grid.stages ? grid.cols : 1;
  for (const id of selected) {
    if (assigned.has(id)) continue;
    while (occupied.has(cursor)) cursor += stride;
    if (cursor >= capacity) return null;
    assigned.set(id,cursor);
    cursor += stride;
  }
  return assigned;
}

// Adjacent seats have the same distance ordering everywhere on a regular grid.
// Keep one quadrant of that ordering, shared by previews with the same pitch.
let lastSeatOrder;
function nearestSeatOffsets(grid) {
  const rows = grid.rows, cols = grid.stages ? 1 : grid.cols;
  const pitchX = gridSpacing(grid), pitchY = gridRowSpacing(grid);
  if (lastSeatOrder?.rows===rows && lastSeatOrder.cols===cols && lastSeatOrder.pitchX===pitchX && lastSeatOrder.pitchY===pitchY)
    return lastSeatOrder.offsets;
  const offsets = [];
  for (let row=0; row<rows; row++)
    for (let col=0; col<cols; col++)
      offsets.push({row,col,distance:(row*pitchY)**2+(col*pitchX)**2});
  offsets.sort((a,b)=>a.distance-b.distance || a.row-b.row);
  lastSeatOrder = {rows,cols,pitchX,pitchY,offsets};
  return offsets;
}

function planMapDrop(grid, selected, original, occupied, target) {
  const [lead] = selected, source = original.get(lead);
  const targetCol = target%grid.cols, targetRow = Math.floor(target/grid.cols);
  if (selected.size===1) {
    if (!occupied.has(target)) return new Map([[lead,target]]);
    // Reordering a full grid must be possible without an intermediate empty seat.
    // Swapping across stages would also change the other note's status.
    if (source!==undefined && !occupied.has(source) && (!grid.stages || source%grid.cols===targetCol))
      return new Map([[lead,target],[occupied.get(target),source]]);
  }
  if (selected.size>1 && original.size===selected.size) {
    const dx=targetCol-source%grid.cols, dy=targetRow-Math.floor(source/grid.cols);
    const translated=new Map();
    for (const id of selected) {
      const old=original.get(id), col=old%grid.cols+dx, row=Math.floor(old/grid.cols)+dy;
      const slot=row*grid.cols+col;
      if (col<0 || col>=grid.cols || row<0 || row>=grid.rows ||
          (grid.stages && col!==targetCol) || occupied.has(slot)) break;
      translated.set(id,slot);
    }
    if (translated.size===selected.size) return translated;
  }

  if (grid.stages && selected.size>grid.rows) return null;
  const assigned = new Map(), ids = selected.values();
  function take(row,col) {
    if (assigned.size===selected.size || row<0 || row>=grid.rows || col<0 || col>=grid.cols) return;
    const slot = row*grid.cols+col;
    if (!occupied.has(slot)) assigned.set(ids.next().value,slot);
  }
  // For equal distances prefer the nearer row, then the larger seat index.
  for (const {row,col} of nearestSeatOffsets(grid)) {
    take(targetRow+row,targetCol+col);
    if (col) take(targetRow+row,targetCol-col);
    if (row) {
      take(targetRow-row,targetCol+col);
      if (col) take(targetRow-row,targetCol-col);
    }
    if (assigned.size===selected.size) return assigned;
  }
  return null;
}

function seat(note, area, slot) {
  Object.assign(note, {areaId:area.id, slot}, slotPoint(area.grid,slot));
}

// Share reservations across folders during file repair, including when two
// full grids both send overflow into the same parent.
export function gridReservations(byId) {
  const seats = new Map();
  function occupancy(area) {
    if (!seats.has(area.id)) seats.set(area.id, {used:new Set(), firstFree:0});
    return seats.get(area.id);
  }
  function reserve(area, slot) {
    if (!validSlot(area?.grid,slot)) return false;
    const {used} = occupancy(area);
    if (used.has(slot)) return false;
    used.add(slot);
    return true;
  }
  function settle(notes, areaId) {
    let pending = notes, area = byId.get(areaId);
    const visited = new Set();
    while (area?.grid && !visited.has(area.id)) {
      visited.add(area.id);
      const state = occupancy(area), capacity = area.grid.rows * area.grid.cols;
      const unseated = [];
      for (const n of pending) {
        if (area.id === n.areaId && reserve(area,n.slot)) seat(n,area,n.slot);
        else unseated.push(n);
      }
      pending = [];
      for (const n of unseated) {
        while (state.used.has(state.firstFree)) state.firstFree++;
        if (state.firstFree >= capacity) pending.push(n);
        else {
          state.used.add(state.firstFree);
          seat(n,area,state.firstFree++);
        }
      }
      if (!pending.length) return;
      area = byId.get(area.parentId);
    }
    for (const n of pending) {
      n.areaId = area && !visited.has(area.id) ? area.id : null;
      if (n.slot != null) n.slot = null;
    }
  }
  return {reserve, settle};
}

export function settleAreaNotes(space, notes, areaId) {
  if (!notes.length) return;
  const byId = new Map(space.areas.map(area => [area.id,area]));
  const seats = gridReservations(byId);
  if (byId.get(areaId)?.grid) {
    const moving = new Set(notes.map(n => n.id));
    for (const n of space.notes) {
      if (!moving.has(n.id)) seats.reserve(byId.get(n.areaId),n.slot);
    }
  }
  seats.settle(notes,areaId);
}
