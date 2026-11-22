import { gridRowSpacing, slotPoint, validGridSize, validSlot, validStages } from './area-grid.js';
import { slotGridBounds, suggestGrid } from './map-slots.js';

function trackSeats(space, id) {
  const area = space.areas.find(item => item.id === id), grid = area?.grid;
  if (!grid || !validGridSize(grid.rows,grid.cols) || !validStages(grid.stages,grid.cols)) return {reason:'track'};
  const columns = grid.stages.map(() => new Map());
  for (const note of space.notes) {
    if (note.areaId !== id) continue;
    if (!validSlot(grid,note.slot)) return {reason:'slots'};
    const column = columns[note.slot % grid.cols], row = Math.floor(note.slot/grid.cols);
    if (column.has(row)) return {reason:'slots'};
    column.set(row,note);
  }
  return {area,grid,columns};
}

function removalOptions(track, index) {
  const {grid,columns} = track;
  const source = Number.isInteger(index) && columns?.[index], count = source?.size || 0;
  const reason = track.reason || (!source ? 'index' : grid.cols === 1 ? 'last-stage' : null);
  if (reason) return {count,options:[],reason};
  const options = [];
  for (let destination=0;destination<grid.cols;destination++) {
    if (destination === index) continue;
    const rows = Math.max(grid.rows,count + columns[destination].size);
    options.push({destination,rows,available:validGridSize(rows,grid.cols-1)});
  }
  options.push({destination:null,rows:grid.rows,available:true});
  return {count,options,reason:null};
}

export function stageRemovalOptions(space, id, index) {
  return removalOptions(trackSeats(space,id),index);
}

function seat(note, grid, row, col) {
  note.slot = row * grid.cols + col;
  Object.assign(note,slotPoint(grid,note.slot));
}

// Linear slot indices change for every row, even to the left of the insertion.
function spliceColumn(track, index, name, rows) {
  const stages = track.grid.stages.slice(), inserting = name !== null;
  if (inserting) stages.splice(index,0,name);
  else stages.splice(index,1);
  const grid = {...track.grid,stages,rows,cols:stages.length};
  track.area.grid = grid;
  for (const [col,column] of track.columns.entries()) {
    if (!inserting && col === index) continue;
    const nextCol = col < index ? col : col + (inserting ? 1 : -1);
    for (const [row,note] of column) seat(note,grid,row,nextCol);
  }
  return grid;
}

export function insertAreaStage(space, id, index, name) {
  const track = trackSeats(space,id);
  if (track.reason) return {ok:false,reason:track.reason};
  const {grid} = track;
  if (!Number.isInteger(index) || index<0 || index>grid.cols) return {ok:false,reason:'index'};
  if (!validGridSize(grid.rows,grid.cols+1)) return {ok:false,reason:'limit'};
  const title = typeof name === 'string' ? name.trim() : '';
  if (!validStages([title],1)) return {ok:false,reason:'name'};
  const next = spliceColumn(track,index,title,grid.rows);
  return {ok:true,stages:next.stages.slice()};
}

// Reserve every possible same-row placement before assigning the collisions.
function receivingRows(rows, occupied) {
  const taken = new Set(occupied.keys()), assigned = new Map();
  for (const row of rows) if (!taken.has(row)) { assigned.set(row,row); taken.add(row); }
  let free = 0;
  for (const row of rows) {
    if (assigned.has(row)) continue;
    while (taken.has(free)) free++;
    assigned.set(row,free++);
  }
  return assigned;
}

export function deleteAreaStage(space, id, index, destination) {
  const track = trackSeats(space,id);
  return deleteFromTrack(space,track,index,destination);
}

function deleteFromTrack(space, track, index, destination) {
  const {count,options,reason} = removalOptions(track,index);
  if (reason) return {ok:false,reason};
  if (destination === undefined && !count) destination = null;
  const option = options.find(o => o.destination === destination);
  if (!option) return {ok:false,reason:'destination'};
  if (!option.available) return {ok:false,reason:'capacity'};
  const {grid,columns} = track, source = columns[index];
  const rows = [...source.keys()].sort((a,b)=>a-b);
  const assigned = destination !== null && receivingRows(rows,columns[destination]);
  let outside;
  if (count && destination === null) {
    // A released note regains its natural radius (up to 78 map units).
    const pitch = Math.max(gridRowSpacing(grid),164), start = {
      x:slotGridBounds(grid).right + pitch/2 + 28, y:grid.y + rows[0] * gridRowSpacing(grid)
    };
    outside = suggestGrid(rows.at(-1)-rows[0]+1,1,start,space,pitch);
  }
  const next = spliceColumn(track,index,null,option.rows), moved = [];
  for (const row of rows) {
    const note = source.get(row);
    if (outside) {
      Object.assign(note,{areaId:null,slot:null},slotPoint(outside,row-rows[0]));
    } else {
      seat(note,next,assigned.get(row),destination>index ? destination-1 : destination);
    }
    moved.push({id:note.id,row,slot:note.slot});
  }
  return {ok:true,stages:next.stages.slice(),name:grid.stages[index],rows:grid.rows,moved};
}

export function undoStageStructure(space, action) {
  const track = trackSeats(space,action.id);
  if (track.reason || JSON.stringify(track.grid.stages)!==JSON.stringify(action.stages)) return false;
  if (action.kind === 'stage-insert') {
    // Creating a note is independent of map history. Preserve new notes if
    // undo removes the column that now holds them.
    const change = deleteFromTrack(space,track,action.index,null);
    if (!change.ok) return false;
    action.releasedCount = change.moved.length;
    return true;
  }
  const notes = new Map(space.notes.map(n=>[n.id,n])), returning = new Set();
  for (const former of action.moved) {
    const n = notes.get(former.id);
    if (!n || n.areaId!==(former.slot===null ? null : action.id) || n.slot!==former.slot) return false;
    returning.add(n.id);
  }
  // Restore the previous height unless a newly added note needs an extra row.
  let rows = action.rows;
  if (track.grid.rows>rows) for (const column of track.columns) {
    for (const [row,note] of column) if (!returning.has(note.id)) rows=Math.max(rows,row+1);
  }
  const grid = spliceColumn(track,action.index,action.name,rows);
  for (const former of action.moved) {
    const note = notes.get(former.id);
    note.areaId=action.id;
    seat(note,grid,former.row,action.index);
  }
  return true;
}
