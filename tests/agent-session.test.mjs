import assert from 'node:assert/strict';
import test from 'node:test';
import {createAgentSession} from '../frontend/agent-session.js';
import {isAgentPlanLive} from '../frontend/agent-tasks.js';
import {formatNoteForAI} from '../frontend/ai-note-export.js';

// Native bridge only. Use the real session, export, task model and paging code.
function harness(t) {
  const root = {id:'idea', title:'Idea', plain:'Draft', body:[], links:[], tags:[]};
  const other = {id:'other', title:'Unrelated', plain:'Private unrelated text', body:[], links:[], tags:[]};
  const sealed = {id:'vault', sealed:'opaque', get title() {throw Error('Read locked title');}};
  const space = {notes:[root,other,sealed], areas:[]};
  const state = {context:{id:'project',folder:{},space}, canEdit:true, hooks:{}, closed:[], runs:[], rights:[],
    clients:[],saves:[], commits:[],taskDrafts:[], replies:new Map(), poll:{status:'running'}};
  const native = {
    OpenAgentAccess:async write => {
      const grant = 'grant-' + state.rights.push(write);
      return JSON.stringify({id:grant,config:{mcpServers:{videron:{env:{VIDERON_AGENT_TOKEN:'temporary'}}}}});
    },
    OpenPairedAgentAccess:async (id,write) => {
      state.clients.push(id);
      const grant='grant-'+state.rights.push(write);
      await state.hooks.openGrant?.(grant);
      return JSON.stringify({id:grant});
    },
    CloseAgentAccess:async id => {state.closed.push(['grant',id]);},
    CloseAgentRun:async id => {state.closed.push(['run',id]);},
    StartAgentRun:async raw => {state.runs.push(JSON.parse(raw)); return 'run-' + state.runs.length;},
    StopAgentRun:async id => {state.closed.push(['stop',id]);},
    GetAgentRun:async () => JSON.stringify(state.poll),
    ResolveAgentCall:async (grant,id,data,failed) => {state.replies.set(id,{grant,failed,data:failed?data:JSON.parse(data)});}
  };
  const session = createAgentSession({bridge:() => native,context:() => state.context,canEdit:() => state.canEdit,
    commitDraft:async id => {state.commits.push(id); await state.hooks.commit?.(id);},
    commitTaskDraft:async rootId => {state.taskDrafts.push(rootId);await state.hooks.taskDraft?.(rootId);},
    persist:async changes => {state.saves.push(changes); await state.hooks.persist?.(changes);},
    onChange:() => {},onLive:() => {}});
  t.after(() => session.reset());
  let next = 0;
  async function call(tool, args = {}, grant = session.current?.grant) {
    const id = String(++next);
    await session.handle(grant,id,tool,JSON.stringify(args));
    return state.replies.get(id);
  }
  const share = (write = false) => session.start(root.id,{mode:'external',clientId:'client-a',clientName:'Desktop agent',write});
  return {state, native, session, space, root, other, sealed, share, call};
}

test('external read-only grant reads a committed draft and only its own task list', async t => {
  const {state, session, space, root, other, sealed, share, call} = harness(t);
  root.links.push(other.id,sealed.id);
  state.hooks.commit = id => { if (id === root.id) root.plain = 'Saved from editor'; };
  await share();
  const grant = session.current.grant;
  assert.deepEqual(state.rights,[false]);
  assert.equal(session.current.snapshot.status,'listening');
  assert.equal(await call('read_idea',{},'foreign'), undefined);
  const read = await call('read_idea',{id:other.id});
  assert.deepEqual(read.data,{text:'# Idea\n\nSaved from editor',nextOffset:null});
  assert.deepEqual((await call('list_tasks')).data,{tasks:[],total:0,nextOffset:null});
  assert.deepEqual(state.commits,[root.id]);
  assert.deepEqual(state.taskDrafts,[root.id]);
  const denied = await call('create_tasks',{tasks:[{key:'one',title:'Write'}]});
  assert.equal(denied.failed,true);
  assert.deepEqual(state.saves,[]);
  assert.equal(space.notes.length,3);
  assert.equal(isAgentPlanLive(root.id),true);
  const previous = session.current;
  await session.stop();
  assert.ok(!Object.hasOwn(previous,'config'));
  assert.equal(previous.grant,null);
  assert.deepEqual(state.closed,[['grant',grant]]);
  assert.equal(isAgentPlanLive(root.id),false);
  assert.equal(await call('read_idea',{},grant),undefined);
});

test('pages keep a consistent committed snapshot across edits and whole Unicode scalars at the split', async t => {
  const {root, share, call} = harness(t);
  const headerLength = '# Idea\n\n'.length;
  root.plain = 'a'.repeat(29999 - headerLength) + '🌿' + 'z'.repeat(31000);
  const expected = formatNoteForAI(root);
  await share();
  const first = (await call('read_idea')).data;
  assert.equal(first.nextOffset,29999);
  root.plain = 'Latest';
  const second = (await call('read_idea',{offset:first.nextOffset})).data;
  assert.ok(second.text.startsWith('🌿'));
  const third = (await call('read_idea',{offset:second.nextOffset})).data;
  assert.equal(third.nextOffset,null);
  assert.equal(first.text + second.text + third.text, expected);
  assert.equal((await call('read_idea')).data.text, formatNoteForAI(root));
  assert.equal((await call('read_idea',{offset:-1})).failed,true);
});

test('sealed or missing roots cannot acquire a grant or block starting the next valid session', async t => {
  const {state, session, sealed, share} = harness(t);
  for (const id of [sealed.id,'missing']) {
    await assert.rejects(session.start(id,{mode:'external',write:true}));
    assert.equal(session.current,null);
  }
  assert.deepEqual(state.rights,[]);
  await share();
  assert.deepEqual(state.rights,[false]);
});

test('write grant persists task creation and completion in request order; blocked access writes nothing', async t => {
  const {state, space, root, share, call} = harness(t);
  await share(true);
  const [created, updated] = await Promise.all([call('create_tasks',{tasks:[{key:'draft',title:'Draft'}]}),
    call('update_task',{key:'draft',status:'done',result:'Compiled'})]);
  assert.equal(created.failed,false);
  assert.equal(updated.data.tasks[0].status,'done');
  const child = space.notes.find(n => n.agentTask?.key === 'draft');
  assert.deepEqual(child.links,[root.id]);
  assert.equal(child.agentTask.result,'Compiled');
  assert.deepEqual(state.saves.map(change => change.notes),[[child.id],[child.id]]);
  state.canEdit = false;
  const blocked = await call('update_task',{key:'draft',status:'pending'});
  assert.equal(blocked.failed,true);
  assert.equal(child.agentTask.status,'done');
  assert.equal(state.saves.length,2);
});

test('task responses recheck child protection after persistence and page through the visible results', async t => {
  const {state, space, share, call} = harness(t);
  await share(true);
  state.hooks.persist = () => {
    const child = space.notes.find(n => n.agentTask?.key === 'task7');
    const index = space.notes.indexOf(child);
    space.notes[index] = {id:child.id,sealed:'ciphertext'};
  };
  const tasks = Array.from({length:9},(_,i) => ({key:'task' + i,title:'Work ' + i}));
  const created = (await call('create_tasks',{tasks})).data;
  assert.equal(created.total,8);
  assert.ok(created.nextOffset > 0 && created.nextOffset < created.total);
  const rest = (await call('list_tasks',{offset:created.nextOffset})).data;
  const keys = [...created.tasks,...rest.tasks].map(task => task.key);
  assert.deepEqual(keys,['task0','task1','task2','task3','task4','task5','task6','task8']);
  assert.equal(rest.nextOffset,null);
});

test('locking or switching same-ID folder while a draft is flushing prevents a queued response and mutation', async t => {
  for (const change of ['lock','replaceFolder','sealIdea']) {
    const {state, session, space, root, share, call} = harness(t);
    await share(true);
    const old = session.current;
    root.plain = 'p'.repeat(40000);
    await call('read_idea');
    const started = Promise.withResolvers(), resume = Promise.withResolvers();
    state.hooks.commit = async () => {started.resolve(); await resume.promise;};
    const pendingRead = call('read_idea');
    const pendingWrite = call('create_tasks',{tasks:[{key:'late',title:'Should never exist'}]});
    await started.promise;
    if (change === 'lock') state.context = null;
    if (change === 'replaceFolder') state.context = {...state.context,folder:{}};
    if (change === 'sealIdea') root.sealed = 'locked';
    session.reconcile();
    resume.resolve();
    assert.equal(await pendingRead, undefined);
    assert.equal(await pendingWrite, undefined);
    assert.equal(session.current,null);
    assert.equal(old.grant,null);
    assert.ok(!Object.hasOwn(old,'config'));
    assert.equal(old.page,null);
    assert.equal(space.notes.length,3);
    assert.equal(state.saves.length,0);
    assert.deepEqual(state.closed,[['grant','grant-1']]);
  }
});

test('an already paired client needs a fresh grant and navigating to another note does not change it', async t => {
  const {state,session,root,other,share,call} = harness(t);
  await assert.rejects(session.start(root.id,{mode:'external',write:true}),/CLIENT_MISSING/);
  await share();
  const old=session.current.grant;
  assert.deepEqual(state.clients,['client-a']);
  assert.equal(session.current.clientName,'Desktop agent');
  root.title='Updated idea title';
  assert.equal(session.current.title,root.title);
  // The same workspace is showing a different editor. Its draft never participates in read_idea.
  state.hooks.commit=id=>assert.equal(id,root.id);
  assert.match((await call('read_idea')).data.text,/Updated idea title/);
  await assert.rejects(session.start(other.id,{mode:'external',clientId:'client-a',write:true}),/BUSY/);
  session.reset(); delete state.hooks.commit;
  assert.equal(await call('read_idea',{},old),undefined);
  await session.start(other.id,{mode:'external',clientId:'client-a',clientName:'Desktop agent',write:true});
  assert.deepEqual(state.clients,['client-a','client-a']);
  assert.notEqual(session.current.grant,old);
  assert.match((await call('read_idea')).data.text,/Private unrelated text/);
  assert.equal(await call('create_tasks',{tasks:[{key:'late',title:'Old work'}]},old),undefined);
});

test('a helper can call before the grant response reaches the UI', async t => {
  const {state,share,call} = harness(t);
  const entered=Promise.withResolvers(),ready=Promise.withResolvers();
  state.hooks.openGrant=grant=>{entered.resolve(grant);return ready.promise};
  const opening=share(),grant=await entered.promise;
  const early=call('read_idea',{},grant);
  ready.resolve();await opening;
  assert.match((await early).data.text,/Draft/);
});

test('a new share waits for an in-flight revoked grant to close', async t => {
  const {state,session,share,other} = harness(t);
  const entered=Promise.withResolvers(),ready=Promise.withResolvers();
  state.hooks.openGrant=()=>{entered.resolve();return ready.promise};
  const first=share();await entered.promise;
  const stop=session.stop();
  const next=session.start(other.id,{mode:'external',clientId:'client-b',clientName:'Local',write:false});
  delete state.hooks.openGrant;
  await Promise.resolve();
  assert.deepEqual(state.clients,['client-a']);
  ready.resolve();await Promise.all([stop,first,next]);
  assert.deepEqual(state.clients,['client-a','client-b']);
  assert.deepEqual(state.closed,[['grant','grant-1']]);
  assert.equal(session.current.rootId,other.id);
});

test('completed ACP session closes its grant; resuming requires an explicit choice and matching rights, folder and profile', async t => {
  const {state, session, root} = harness(t);
  state.poll = {status:'completed',resumable:true,sessionId:'adapter-session',text:'Done'};
  const options = {mode:'launch',profile:'qwen',write:true,cwd:'chosen-project',prompt:'Implement the idea'};
  await session.start(root.id,options);
  const run = state.runs[0];
  assert.equal(run.command,'qwen');
  assert.deepEqual(run.args,['--acp']);
  assert.equal(run.cwd,options.cwd);
  assert.ok(run.prompt.includes(options.prompt));
  assert.doesNotMatch(JSON.stringify(run),/temporary|Private unrelated text/);
  assert.equal(session.current.snapshot.text,'Done');
  assert.equal(session.current.grant,null);
  assert.deepEqual(state.closed,[['grant','grant-1'],['run','run-1']]);
  await session.stop();
  await session.start(root.id,options);
  assert.equal(state.runs.at(-1).resumeSessionId,'');
  await session.stop();
  await session.start(root.id,{...options,resume:true});
  assert.equal(state.runs.at(-1).resumeSessionId,'adapter-session');
  for (const change of [{write:false}, {cwd:'different-project'}, {profile:'opencode'}]) {
    await session.stop();
    await session.start(root.id,options);
    await session.stop();
    await session.start(root.id,{...options,...change,resume:true});
    assert.equal(state.runs.at(-1).resumeSessionId,'');
  }
});
