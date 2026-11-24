import { releaseGridNotes, restoreAreaPlacement } from './areas.js';

const groupIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validMapGroupId = id => typeof id === 'string' && id.length === 36 && groupIdPattern.test(id);

function idsOf(items) { return items.map(item => item.id); }
function members(space, id) {
  if (!id) return {notes:[], ink:[]};
  return {notes:space.notes.filter(item => item.mapGroupId === id),
    ink:(space.mapInk ?? []).filter(item => item.mapGroupId === id)};
}
// Keep live editor note objects. Ink records are immutable so that an
// unrelated group gesture cannot mutate an older stroke's undo snapshot.
function updateItems(space, notes, ink, transform) {
  for (const item of notes) transform(item);
  if (!ink.length) return;
  const affected = new Set(ink);
  space.mapInk = space.mapInk.map(item => {
    if (!affected.has(item)) return item;
    const next = {...item};
    transform(next);
    return next;
  });
}
function setGroup(item, id) {
  if (id) item.mapGroupId = id;
  else delete item.mapGroupId;
}
function selectedRows(space, noteIds, inkIds) {
  const notes = new Set(noteIds), ink = new Set(inkIds);
  const picked = {notes:space.notes.filter(item => notes.has(item.id)), ink:(space.mapInk ?? []).filter(item => ink.has(item.id))};
  return picked.notes.length === notes.size && picked.ink.length === ink.size ? picked : null;
}
function actionFor(kind, id, notes, ink) {
  return {kind, groupId:id, noteIds:idsOf(notes), inkIds:idsOf(ink)};
}
const pointOf = ({x,y}) => ({x,y});
const finitePoint = p => Number.isFinite(p?.x) && Number.isFinite(p.y);
function releaseSeats(space,notes,pointFor) {
  const seats = notes.filter(note => Number.isInteger(note.slot));
  return seats.length ? releaseGridNotes(space,seats.map(note => ({id:note.id,...pointOf(pointFor(note))})),{movePinned:true}) : null;
}

export function createGroup(space, noteIds, inkIds, positions = []) {
  const picked = selectedRows(space,noteIds,inkIds);
  if (!picked) return null;
  const previous = new Set([...picked.notes,...picked.ink].map(item => item.mapGroupId));
  if (!previous.size || (previous.size === 1 && !previous.has(undefined))) return null;
  previous.delete(undefined);
  // Selecting one member of an existing group includes that whole group.
  const noteSet = new Set(picked.notes), inkSet = new Set(picked.ink);
  const notes = space.notes.filter(item => noteSet.has(item) || previous.has(item.mapGroupId));
  const ink = (space.mapInk ?? []).filter(item => inkSet.has(item) || previous.has(item.mapGroupId));
  if (notes.length + ink.length < 2) return null;
  const points = new Map(positions.map(point => [point.id,point]));
  if (notes.some(item => !finitePoint(points.get(item.id) ?? item))) return null;

  const id = crypto.randomUUID(), action = actionFor('map-group',id,notes,ink);
  action.previousNotes = notes.map(item => item.mapGroupId);
  action.previousInk = ink.map(item => item.mapGroupId);
  action.placements = releaseSeats(space,notes,item => points.get(item.id) ?? item);
  if (action.placements && !action.placements.ok) return null;
  for (const item of notes) if (points.has(item.id)) Object.assign(item,pointOf(points.get(item.id)));
  updateItems(space,notes,ink,item => setGroup(item,id));
  return action;
}

export function dissolveGroup(space, id) {
  const {notes,ink} = members(space,id);
  if (!notes.length && !ink.length) return null;
  const action = actionFor('map-ungroup',id,notes,ink);
  // Unconstrained notes can start drifting immediately after an ungroup.
  action.notePositions = notes.map(pointOf);
  updateItems(space,notes,ink,item => setGroup(item,null));
  return action;
}

export function translateGroup(space,id,dx,dy) {
  const {notes,ink} = members(space,id);
  if (notes.length + ink.length < 2 || (!dx && !dy) || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const action = actionFor('map-group-move',id,notes,ink);
  action.dx = dx; action.dy = dy;
  action.notePositions = notes.map(pointOf);
  action.inkPositions = ink.map(pointOf);
  if ([...notes,...ink].some(item => !finitePoint(item) || !Number.isFinite(item.x+dx) || !Number.isFinite(item.y+dy))) return null;
  // A member may have been seated through the note sidebar after grouping.
  action.placements = releaseSeats(space,notes,item => item);
  if (action.placements && !action.placements.ok) return null;
  updateItems(space,notes,ink,item => { item.x += dx; item.y += dy; });
  return action;
}

export function undoGroupChange(space,action) {
  const {kind,groupId,noteIds,inkIds} = action;
  const rows = selectedRows(space,noteIds,inkIds);
  if (!rows) return false;
  // A sync may reorder rows, add members, or change only their text/style.
  // Validate the entire transform before modifying a single member.
  const stored = members(space,groupId);
  const noteById = new Map(rows.notes.map(item => [item.id,item])), inkById = new Map(rows.ink.map(item => [item.id,item]));
  const notes = noteIds.map(id => noteById.get(id)), ink = inkIds.map(id => inkById.get(id));
  if (kind === 'map-ungroup') {
    if (stored.notes.length || stored.ink.length || [...notes,...ink].some(item => item.mapGroupId) || notes.some(item => Number.isInteger(item.slot))) return false;
    notes.forEach((item,i) => Object.assign(item,action.notePositions[i]));
    updateItems(space,notes,ink,item => setGroup(item,groupId));
    return true;
  }
  if (stored.notes.length !== notes.length || stored.ink.length !== ink.length ||
      [...notes,...ink].some(item => item.mapGroupId !== groupId)) return false;
  if (kind === 'map-group') {
    const seats = action.placements;
    if (seats && !restoreAreaPlacement(space,seats.before,seats.after)) return false;
    notes.forEach((item,i) => setGroup(item,action.previousNotes[i]));
    const previous = new Map(inkIds.map((id,i) => [id,action.previousInk[i]]));
    updateItems(space,[],ink,item => setGroup(item,previous.get(item.id)));
    return true;
  }
  const unchanged = (item,point) => item.x === point.x + action.dx && item.y === point.y + action.dy;
  if (notes.some((item,i) => Number.isInteger(item.slot) || !unchanged(item,action.notePositions[i])) ||
      ink.some((item,i) => !unchanged(item,action.inkPositions[i]))) return false;
  const seats = action.placements;
  if (seats && !restoreAreaPlacement(space,seats.before,seats.after)) return false;
  notes.forEach((item,i) => {
    if (!Number.isInteger(item.slot)) Object.assign(item,action.notePositions[i]);
  });
  const before = new Map(inkIds.map((id,i) => [id,action.inkPositions[i]]));
  updateItems(space,[],ink,item => Object.assign(item,before.get(item.id)));
  return true;
}
