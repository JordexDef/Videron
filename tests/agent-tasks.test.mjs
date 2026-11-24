import test from 'node:test';
import assert from 'node:assert/strict';
import {createNote, newLibrary, readLibrary, serializeLibrary} from '../frontend/data.js';
import {agentAreaProgress, agentTaskInfo, applyAgentTaskRequest, isAgentPlanLive, prepareAgentTaskIds, setAgentPlanLive} from '../frontend/agent-tasks.js';
import {resolveMapMetrics} from '../frontend/map-metric-source.js';
import {mergeWorkspace} from '../frontend/workspace-merge.js';

function setup() {
  const lib = newLibrary(), space = lib.spaces.personal;
  const root = createNote(50, 100, 'ideas'), other = createNote(500, 100);
  root.body = [{type:'drawing', board:{version:2, elements:[]}}];
  root.links = [other.id];
  space.notes.push(root, other);
  space.areas.push({id:'all', name:'All', color:'#999999'}, {id:'ideas', name:'Ideas', color:'#888888', parentId:'all'});
  const call = (method, args) => applyAgentTaskRequest(space, root.id, method, args);
  const add = tasks => addTasks(space,root.id,tasks);
  return {lib, space, root, other, call, add};
}
async function addTasks(space,rootId,tasks) {
  const ids = await prepareAgentTaskIds(rootId,tasks);
  return applyAgentTaskRequest(space,rootId,'create_tasks',{tasks},ids);
}
const tasks = [{key:'small', title:'Small', description:'One\n#two', weight:1}, {key:'large', title:'Large', weight:9}];

test('task creation is atomic, linked and idempotent across restart, and leaves the source untouched', async () => {
  const {lib, root, space, add} = setup();
  const original = structuredClone(root);
  await assert.rejects(add([tasks[0], {...tasks[1], weight:-1}]));
  await assert.rejects(add([tasks[0], tasks[0]]));
  assert.equal(space.notes.length, 2);
  const offlineCopy = structuredClone(space);
  const {result, changed} = await add(tasks);
  assert.deepEqual((await addTasks(offlineCopy,root.id,tasks)).changed.notes,changed.notes);
  assert.deepEqual(root, original);
  assert.deepEqual(changed.notes, result.tasks.map(t => t.id));
  const created = space.notes.slice(-2);
  assert.equal(created[0].plain, 'One\n#two');
  assert.deepEqual(created[0].tags, ['two']);
  assert.equal(created[0].body[1].runs[0].text, '#two');
  assert.deepEqual(created.map(n => n.links), [[root.id],[root.id]]);
  created[0].title = 'Edited by the user';
  const saved = readLibrary(serializeLibrary(lib)).spaces.personal;
  const retried = await addTasks(saved, root.id, tasks);
  assert.deepEqual(retried.changed.notes, []);
  assert.equal(retried.result.tasks[0].id, created[0].id);
  assert.equal(retried.result.tasks[0].title, 'Edited by the user');
});

test('updates use scoped keys and do not overwrite task note content or links', async () => {
  const {root, other, space, call, add} = setup();
  await add(tasks);
  await addTasks(space,other.id,[tasks[0]]);
  const child = space.notes[2];
  child.body = [{type:'paragraph', runs:[{text:'user edit'}]}];
  child.links.push(other.id);
  const args = {key:'small', status:'done', result:'Passed', weight:4};
  assert.deepEqual(call('update_task', args).changed.notes, [child.id]);
  assert.deepEqual(call('update_task', args).changed.notes, []);
  assert.equal(child.body[0].runs[0].text, 'user edit');
  assert.deepEqual(child.links, [root.id,other.id]);
  const snapshot = call('list_tasks',{}).result.tasks[0];
  assert.deepEqual([snapshot.status,snapshot.weight,snapshot.result], ['done',4,'Passed']);
  assert.equal(applyAgentTaskRequest(space,other.id,'list_tasks').result.tasks[0].status, 'pending');
  assert.throws(() => applyAgentTaskRequest(space,other.id,'update_task',{key:'large',status:'done'}));
  assert.throws(() => call('update_task', {key:'small', status:'finished'}));
  child.sealed = 'locked';
  assert.equal(agentTaskInfo(child), null);
  assert.equal(call('list_tasks').result.tasks.length, 1);
  assert.throws(() => call('update_task', args));
  await assert.rejects(add(tasks), /Task key unavailable/);
  root.sealed = 'locked';
  assert.throws(() => call('list_tasks'));
  assert.throws(() => call('create_tasks', {tasks}));
});

test('weighted area progress rolls up once, responds to new work and excludes cancelled tasks', async () => {
  const {root, call, space, add} = setup();
  await add(tasks);
  call('update_task', {key:'large', status:'done'});
  assert.equal(agentAreaProgress(space).get('all').ratio, .9);
  await add([{key:'extra',title:'New work',weight:8}]);
  assert.deepEqual(agentAreaProgress(space).get('ideas'), {value:9, goal:18, ratio:.5});
  call('update_task', {key:'extra', status:'cancelled'});
  assert.equal(resolveMapMetrics(space).areas.get('ideas').ratio, .9);
  space.areas[1].mapMetric = {sourceId:'missing'};
  assert.equal(resolveMapMetrics(space).areas.has('ideas'), false);
  root.sealed = 'locked';
  assert.equal(agentAreaProgress(space).size, 0);
});

test('new tasks cannot displace notes in a full grid, and live indicators are session-local', async () => {
  const {root, space, add, lib} = setup();
  space.areas[1].grid = {cols:3, rows:2, x:30, y:40, stages:['Todo','Doing','Done']};
  root.slot = 0;
  await add(tasks);
  assert.equal(root.slot, 0);
  assert.deepEqual(space.notes.slice(-2).map(n => [n.areaId,n.slot ?? null]), [['ideas',3],['all',null]]);
  const saved = serializeLibrary(lib);
  setAgentPlanLive(root.id, true);
  assert.equal(isAgentPlanLive(root.id), true);
  assert.equal(serializeLibrary(lib), saved);
  setAgentPlanLive(root.id, false);
  assert.equal(isAgentPlanLive(root.id), false);
});

test('task pages stay bounded after user edits and reject malformed or sealed metadata', async () => {
  const {call, space, add} = setup();
  await add(tasks);
  const child = space.notes[2];
  child.plain = 'z'.repeat(15999) + '🟢' + 'x'.repeat(120000);
  child.title = 't'.repeat(280);
  const snapshot = call('list_tasks').result.tasks[0];
  assert.equal(snapshot.description, 'z'.repeat(15999));
  assert.equal(snapshot.descriptionTruncated, true);
  assert.equal(snapshot.title.length, 256);
  assert.equal(snapshot.titleTruncated, true);
  assert.equal(child.title.length, 280);
  for (const patch of [{rootId:''},{rootId:'root\nother'},{rootId:{}},{result:{}},{result:'x'.repeat(32001)}]) {
    assert.equal(agentTaskInfo({...child,agentTask:{...child.agentTask,...patch}}),null);
  }
  const sealed = {id:'sealed',sealed:'opaque', get agentTask(){throw Error('Accessed sealed metadata')}};
  space.notes.push(sealed);
  assert.equal(call('list_tasks').result.tasks.length,2);
});

test('concurrent changes to the source text and progress on a linked task merge on reload', async () => {
  const {lib, space, root, add} = setup();
  await add(tasks);
  const left = structuredClone(space), right = structuredClone(space);
  left.notes[0].body = [{type:'paragraph',runs:[{text:'New draft'}]}];
  left.notes[0].plain = 'New draft';
  applyAgentTaskRequest(right,root.id,'update_task',{key:'large',status:'done',result:'Finished'});
  const {data,conflicts} = mergeWorkspace(space,left,right);
  assert.deepEqual(conflicts,[]);
  lib.spaces.personal = data;
  const saved = readLibrary(serializeLibrary(lib)).spaces.personal;
  assert.equal(saved.notes[0].plain, 'New draft');
  assert.equal(saved.notes.length,4);
  assert.equal(saved.notes.filter(note => !agentTaskInfo(note)).length,2);
  assert.deepEqual(saved.notes[3].links,[root.id]);
  assert.equal(agentAreaProgress(saved).get('all').ratio,.9);
});
