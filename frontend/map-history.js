import { moveArea, moveAreaGrid, removeArea, reorderAreaStage, resizeAreaGrid, restoreAreaPlacement, restoreRemovedArea } from './areas.js';
import { gridRowSpacing, gridSpacing, setGridSpacing } from './area-grid.js';
import { deleteAreaStage, insertAreaStage, undoStageStructure } from './stage-structure.js';
import { undoNotesDeletion } from './note-deletion.js';
import { sameWorkspaceValue } from './workspace-merge.js';
import { createGroup, dissolveGroup, translateGroup, undoGroupChange } from './map-groups.js';

const histories = new WeakMap();
export function rememberMapAction(space, action) {
  let history = histories.get(space);
  if (!history) histories.set(space, history = []);
  history.push(action);
  if (history.length > 20) history.shift();
}
export function lastMapAction(space) { return histories.get(space)?.at(-1); }

function recordGroupChange(space, action) {
  if (action) rememberMapAction(space,action);
  return action;
}
export function groupMapItems(space,noteIds,inkIds,positions) {
  return recordGroupChange(space,createGroup(space,noteIds,inkIds,positions));
}
export function ungroupMapItems(space,id) {
  return recordGroupChange(space,dissolveGroup(space,id));
}
export function moveMapGroup(space,id,dx,dy) {
  return recordGroupChange(space,translateGroup(space,id,dx,dy));
}

// Ink items are replaced on edit. Keep only the affected stroke and its paint order.
function replaceInk(space, id, expected, replacement, insertAt) {
  const items = space.mapInk ?? [], index = items.findIndex(item => item.id === id);
  if (!sameWorkspaceValue(items[index] ?? null, expected) || (replacement && replacement.id !== id)) return false;
  if (replacement) {
    if (index >= 0) items[index] = replacement;
    else items.splice(Math.min(insertAt, items.length), 0, replacement);
  } else if (index >= 0) items.splice(index, 1);
  space.mapInk = items;
  return true;
}

export function editMapInk(space, id, before, after) {
  if (sameWorkspaceValue(before, after)) return false;
  const index = before ? space.mapInk?.findIndex(item => item.id === id) : space.mapInk?.length;
  if (!replaceInk(space, id, before, after, index ?? 0)) return false;
  rememberMapAction(space, {kind:'ink', id, index:index ?? 0, before, after});
  return true;
}

export function deleteMapInk(space, ids) {
  const selected = new Set(ids), items = space.mapInk ?? [];
  if (!selected.size) return null;
  const kept = [], removed = [];
  let endOfRun = 0;
  for (const item of items) {
    if (selected.has(item.id)) {
      removed.push({item, at:kept.length, previous:kept.at(-1)?.id});
    } else {
      while (endOfRun < removed.length) removed[endOfRun++].next = item.id;
      kept.push(item);
    }
  }
  if (removed.length !== selected.size) return null;
  space.mapInk = kept;
  const action = {kind:'ink-delete', removed};
  rememberMapAction(space,action);
  return action;
}

function restoreMapInk(space, removed) {
  const items = space.mapInk ?? [], indexes = new Map(items.map((item,i)=>[item.id,i]));
  if (removed.some(({item})=>indexes.has(item.id))) return false;
  // Preserve any edits or new strokes from another device. Use the original
  // neighbours for each run, falling back to its offset when both disappeared.
  const insertions = new Map();
  for (const {item,at,previous,next} of removed) {
    const index = indexes.get(next) ?? (indexes.has(previous) ? indexes.get(previous)+1 : Math.min(at,items.length));
    if (!insertions.has(index)) insertions.set(index,[]);
    insertions.get(index).push(item);
  }
  const restored = [];
  for (let i=0;i<=items.length;i++) {
    for (const item of insertions.get(i) ?? []) restored.push(item);
    if (i<items.length) restored.push(items[i]);
  }
  space.mapInk = restored;
  return true;
}

export function deleteAreaWithHistory(space, id) {
  return removeArea(space,id,change => rememberMapAction(space,{kind:'area-delete',...change}));
}

export function insertStageWithHistory(space, id, index, name) {
  const change=insertAreaStage(space,id,index,name);
  if (!change.ok) return change;
  rememberMapAction(space,{kind:'stage-insert',id,index,stages:change.stages});
  return {ok:true};
}

export function deleteStageWithHistory(space, id, index, destination) {
  const change=deleteAreaStage(space,id,index,destination);
  if (!change.ok) return change;
  const {stages,rows,name,moved}=change;
  rememberMapAction(space,{kind:'stage-delete',id,index,stages,rows,name,moved});
  return {ok:true};
}

export function reorderStageWithHistory(space, id, from, to) {
  const area = space.areas.find(a=>a.id===id);
  if (!reorderAreaStage(area,space.notes,from,to)) return false;
  rememberMapAction(space,{kind:'stage-order',id,from,to,stages:area.grid.stages.slice()});
  return true;
}

export function resizeGridWithHistory(space, id, rows, cols, spacing, stages, appearance) {
  const area = space.areas.find(area=>area.id===id), grid=area?.grid;
  if (!grid) return false;
  const before = {rows:grid.rows, cols:grid.cols, spacing:grid.spacing, rowSpacing:grid.rowSpacing};
  const after = {rows, cols, spacing:gridSpacing(grid), rowSpacing:gridRowSpacing(grid)};
  if (spacing!==undefined && !setGridSpacing(after,spacing)) return false;
  if (grid.stages) {
    before.stages = grid.stages.slice();
    after.stages = (stages ?? grid.stages).slice();
  }
  if (appearance && (area.name!==appearance.name || area.color!==appearance.color)) {
    before.appearance = {name:area.name,color:area.color};
    after.appearance = {name:appearance.name,color:appearance.color};
  }
  if (!after.appearance && rows===grid.rows && cols===grid.cols && after.spacing===gridSpacing(grid) && gridRowSpacing(after)===gridRowSpacing(grid) &&
      JSON.stringify(before.stages)===JSON.stringify(after.stages)) return true;
  // Only notes whose old addresses disappear can need explicit restoration.
  const clipped = [];
  if (rows<grid.rows || cols<grid.cols) {
    for (const note of space.notes) {
      if (note.areaId===id && (Math.floor(note.slot/grid.cols)>=rows || note.slot%grid.cols>=cols))
        clipped.push({note,slot:note.slot});
    }
  }
  if (!resizeAreaGrid(space,id,rows,cols,spacing,undefined,stages)) return false;
  if (after.appearance) Object.assign(area,after.appearance);
  const reseated = clipped.map(({note,slot})=>({id:note.id, before:slot, after:note.slot}));
  rememberMapAction(space,{kind:'grid-size',id,before,after,reseated});
  return true;
}

function undoGridResize(space, action) {
  const {id,before,after,reseated} = action;
  const area = space.areas.find(a=>a.id===id), grid = area?.grid;
  if (!grid || grid.rows!==after.rows || grid.cols!==after.cols || gridSpacing(grid)!==after.spacing || gridRowSpacing(grid)!==gridRowSpacing(after) ||
      JSON.stringify(grid.stages)!==JSON.stringify(after.stages)) return false;
  if (after.appearance && (area.name!==after.appearance.name || area.color!==after.appearance.color)) return false;
  let restoredSlots;
  if (reseated.length) {
    const current = new Map(space.notes.filter(n=>n.areaId===id).map(n=>[n.id,n.slot]));
    if (reseated.some(n=>current.get(n.id)!==n.after)) return false;
    restoredSlots = new Map(reseated.map(n=>[n.id,n.before]));
  }
  const pitch = {spacing:gridSpacing(before),rowSpacing:gridRowSpacing(before)};
  if (!resizeAreaGrid(space,id,before.rows,before.cols,pitch,restoredSlots,before.stages)) return false;
  if (before.spacing===undefined) delete area.grid.spacing;
  if (before.rowSpacing!==undefined) area.grid.rowSpacing=before.rowSpacing;
  if (before.appearance) Object.assign(area,before.appearance);
  return true;
}

// Only metadata is retained for moves. Text edits, encryption changes and
// links created since the drag survive its undo.
export function undoMapAction(space) {
  const action = histories.get(space)?.pop();
  if (!action) return null;
  switch (action.kind) {
    case 'ink-delete': return restoreMapInk(space,action.removed) ? action : null;
    case 'map-group':
    case 'map-ungroup':
    case 'map-group-move': return undoGroupChange(space,action) ? action : null;
    case 'ink': return replaceInk(space,action.id,action.after,action.before,action.index) ? action : null;
    case 'deletion':
      return undoNotesDeletion(space,action.ids??[action.id]) ? action : null;
    case 'area-delete': return restoreRemovedArea(space,action) ? action : null;
    case 'placement':
      return restoreAreaPlacement(space,action.before,action.after) ? action : null;
    case 'positions': {
      const notes = new Map(space.notes.map(note=>[note.id,note]));
      if (!action.before.every(({id})=>notes.has(id) && !Number.isInteger(notes.get(id).slot))) return null;
      for (const {id,x,y} of action.before) Object.assign(notes.get(id),{x,y});
      return action;
    }
    case 'grid': return moveAreaGrid(space,action.id,action.before.x,action.before.y) ? action : null;
    case 'stage-delete':
    case 'stage-insert': return undoStageStructure(space,action) ? action : null;
    case 'stage-order': {
      const area = space.areas.find(a=>a.id===action.id);
      if (JSON.stringify(area?.grid?.stages)!==JSON.stringify(action.stages)) return null;
      return reorderAreaStage(area,space.notes,action.to,action.from) ? action : null;
    }
    case 'grid-size': return undoGridResize(space,action) ? action : null;
    case 'folder': return moveArea(space,action.id,action.parentId) ? action : null;
    default: return null;
  }
}
