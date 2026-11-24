import { createNote } from './data.js';
import { settleAreaNotes } from './area-grid.js';
import { areaTreeRows } from './areas.js';
import { isProtectedNote } from './note-vault.js';
import { noteTags } from './note-tags.js';

const statuses = new Set(['pending', 'working', 'done', 'blocked', 'cancelled']);
const livePlans = new Set();
const validKey = key => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(key);
const validRoot = id => typeof id === 'string' && id.length > 0 && id.length <= 512 &&
  id === id.trim() && !/[\u0000-\u001f\u007f]/.test(id);
const validWeight = weight => Number.isFinite(weight) && weight > 0 && weight <= 1000;

export function setAgentPlanLive(rootId, live) {
  if (live) livePlans.add(rootId);
  else livePlans.delete(rootId);
}

export function isAgentPlanLive(rootId) {
  return livePlans.has(rootId);
}

export function agentTaskInfo(note) {
  if (!note || isProtectedNote(note)) return null;
  const task = note.agentTask;
  if (!task || !validRoot(task.rootId) || task.rootId === note.id ||
      typeof task.result !== 'string' || task.result.length > 32000 ||
      !validKey(task.key) || !validWeight(task.weight) || !statuses.has(task.status)) return null;
  return task;
}

function excerpt(text, limit) {
  if (text.length <= limit) return text;
  if (/[\uD800-\uDBFF]/.test(text[limit - 1])) limit--;
  return text.slice(0,limit);
}

function taskSnapshot(note) {
  const {key, weight, status, result} = note.agentTask;
  const title = excerpt(note.title,256);
  const plain = typeof note.plain === 'string' ? note.plain : '';
  const description = excerpt(plain,16000);
  const snapshot = {id:note.id, key, title, description, weight, status, result};
  if (description.length < plain.length) snapshot.descriptionTruncated = true;
  if (title.length < note.title.length) snapshot.titleTruncated = true;
  return snapshot;
}

function requireText(value, maxLength, field) {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error('Invalid task ' + field);
  return value;
}

// Two clients may independently plan the same key while offline. A stable,
// opaque record ID lets normal note merging handle their concurrent writes and
// keeps a later retry from duplicating a task that has since been encrypted.
export async function prepareAgentTaskIds(rootId, tasks) {
  if (!validRoot(rootId)) throw new Error('Invalid idea ID');
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 64) throw new Error('Provide between 1 and 64 tasks per request');
  const keys = tasks.map(task => task?.key);
  if (keys.some(key => !validKey(key)) || new Set(keys).size !== keys.length) throw new Error('A unique task key is required');
  const encoder = new TextEncoder();
  const entries = await Promise.all(keys.map(async key => {
    const source = encoder.encode(JSON.stringify(['videron-agent-task-v1', rootId, key]));
    const digest = await crypto.subtle.digest('SHA-256', source);
    const hex = Array.from(new Uint8Array(digest, 0, 16), byte => byte.toString(16).padStart(2,'0')).join('');
    return [key, 'at-' + hex];
  }));
  return new Map(entries);
}

export function applyAgentTaskRequest(space, rootId, method, params = {}, preparedIds) {
  const root = space.notes.find(note => note.id === rootId);
  if (!root || isProtectedNote(root)) throw new Error('The idea is unavailable');
  const children = space.notes.filter(note => agentTaskInfo(note)?.rootId === rootId);
  const byKey = new Map(children.map(note => [note.agentTask.key, note]));
  if (byKey.size !== children.length) throw new Error('Duplicate task keys in this idea');
  const changed = {notes:[], areas:[]};

  if (method === 'create_tasks') {
    if (!Array.isArray(params.tasks) || !params.tasks.length || params.tasks.length > 64) {
      throw new Error('Provide between 1 and 64 tasks per request');
    }
    const occupied = new Set(space.notes.map(note => note.id)), added = [];
    if (preparedIds?.size !== params.tasks.length) throw new Error('Missing task keys');
    for (const input of params.tasks) {
      const id = preparedIds.get(input?.key);
      if (!id) throw new Error('A unique task key is required');
      const title = requireText(input.title, 256, 'title').trim();
      const description = requireText(input.description ?? '', 16000, 'description').replace(/\r\n?/g, '\n');
      const weight = input.weight ?? 1;
      if (!title || !validWeight(weight)) throw new Error('A task needs a title and a positive weight up to 1000');
      if (byKey.has(input.key)) continue;
      if (occupied.has(id)) throw new Error('Task key unavailable');
      const index = children.length + added.length, angle = index * 2.399963, radius = 100 + 30 * Math.sqrt(index);
      const note = createNote((root.x || 0) + radius * Math.cos(angle), (root.y || 0) + radius * Math.sin(angle), root.areaId);
      note.id = id;
      note.title = title;
      note.plain = description;
      note.body = description.split('\n').map(line => ({type:'paragraph', runs:line ? [{text:line}] : []}));
      note.weight = description.length;
      note.tags = noteTags(title, description);
      note.links = [rootId];
      note.agentTask = {rootId, key:input.key, weight, status:'pending', result:''};
      added.push(note);
      occupied.add(id);
    }
    if (children.length + added.length > 256) throw new Error('This idea already has too many tasks');
    settleAreaNotes(space, added, root.areaId, {firstStageOnly:true});
    space.notes.push(...added);
    children.push(...added);
    changed.notes = added.map(note => note.id);
  } else if (method === 'update_task') {
    const note = byKey.get(params.key);
    if (!note) throw new Error('Unknown task in this idea');
    if (params.status !== undefined && !statuses.has(params.status)) throw new Error('Unknown task status');
    if (params.weight !== undefined && !validWeight(params.weight)) throw new Error('Invalid task weight');
    if (params.result !== undefined) requireText(params.result, 32000, 'result');
    const task = note.agentTask;
    const status = params.status ?? task.status, weight = params.weight ?? task.weight, result = params.result ?? task.result;
    if (task.status !== status || task.weight !== weight || task.result !== result) {
      note.agentTask = {...task, status, weight, result};
      note.modified = Date.now();
      changed.notes.push(note.id);
    }
  } else if (method !== 'list_tasks') {
    throw new Error('Unknown task operation');
  }
  return {result:{tasks:children.map(taskSnapshot)}, changed};
}

export function agentProgress(tasks) {
  let done = 0, total = 0;
  for (const task of tasks) {
    if (task.status === 'cancelled') continue;
    total += task.weight;
    if (task.status === 'done') done += task.weight;
  }
  return {value:done, goal:total, ratio:total ? done / total : 0};
}

// Each idea contributes to its current area, even when its children use
// different slots or spill out of a full grid. Fold children into ancestors once.
export function agentAreaProgress(space) {
  const byRoot = new Map(), totals = new Map();
  for (const note of space.notes) {
    const task = agentTaskInfo(note);
    if (!task || task.status === 'cancelled') continue;
    const group = byRoot.get(task.rootId);
    if (group) group.push(task);
    else byRoot.set(task.rootId, [task]);
  }
  if (!byRoot.size) return totals;
  function add(areaId, {value, goal}) {
    const progress = totals.get(areaId) || {value:0, goal:0};
    progress.value += value;
    progress.goal += goal;
    progress.ratio = progress.value / progress.goal;
    totals.set(areaId, progress);
  }
  for (const note of space.notes) {
    if (note.areaId && !isProtectedNote(note) && byRoot.has(note.id)) add(note.areaId, agentProgress(byRoot.get(note.id)));
  }
  for (const {area, depth} of areaTreeRows(space.areas).reverse()) {
    if (depth > 0 && totals.has(area.id)) add(area.parentId, totals.get(area.id));
  }
  return totals;
}
