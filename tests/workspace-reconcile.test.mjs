import test from 'node:test';
import assert from 'node:assert/strict';
import { compareIncoming, preservesOpenNote, commitIncoming, commitPreparedMerge } from '../frontend/workspace-reconcile.js';
import { WorkspaceRecords } from '../frontend/workspace-records.js';
import { saveSpaceFolder } from '../frontend/workspace-storage.js';

function documents() {
  const note = id => ({ id, title: id, body: [], links: [], tags: [] });
  const base = { name: 'Shared', notes: [note('writing'), note('elsewhere')], areas: [] };
  const remote = structuredClone(base);
  remote.notes[1].title = 'Arrived from the other computer';
  const session = { folder: 'shared', link: {}, raw: JSON.stringify(base), data: structuredClone(base) };
  const incoming = { token: 'heads', base: JSON.stringify(base), remote: JSON.stringify(remote) };
  return { session, incoming };
}

test('an incoming independent edit preserves editor references and typing during the disk write', async () => {
  const { session, incoming } = documents();
  const open = session.data.notes[0], notes = session.data.notes, areas = session.data.areas;
  const merged = compareIncoming(session, incoming);
  assert.ok(preservesOpenNote(session, merged, open.id));
  let finishWrite;
  const bridge = { CommitFolderMerge: () => new Promise(resolve => { finishWrite = resolve; }) };
  const pending = commitIncoming(bridge, session, incoming, merged, open.id);
  open.title = 'Typed during sync';
  finishWrite();
  await pending;
  assert.equal(session.data.notes, notes);
  assert.equal(session.data.areas, areas);
  assert.equal(notes[0], open);
  assert.equal(notes[0].title, 'Typed during sync');
  assert.equal(notes[1].title, 'Arrived from the other computer');
  assert.equal(JSON.parse(session.raw).notes[0].title, 'writing'); // Still needs autosave.
});

test('a superseded merge leaves the live workspace and the autosave baseline alone', async () => {
  const { session, incoming } = documents();
  const merged = compareIncoming(session, incoming);
  const previous = structuredClone(session);
  const bridge = { CommitFolderMerge: async () => { throw new Error('VD_CHANGED'); } };
  await assert.rejects(commitIncoming(bridge, session, incoming, merged, 'writing'), /VD_CHANGED/);
  assert.deepEqual(session, previous);
});

test('native merge keeps live typing, sends only choices and advances the autosave baseline', async () => {
  const {session}=documents(), [open,other]=session.data.notes, notes=session.data.notes;
  session.records=new WorkspaceRecords(session.data);
  const proposal={prepared:true,token:'local:remote',conflicts:[],changedNotes:[other.id]};
  assert.ok(preservesOpenNote(session,proposal,open.id));
  assert.ok(!preservesOpenNote(session,proposal,other.id));
  let resolveWrite;
  const choices={'note:elsewhere':'remote'};
  const pending=commitPreparedMerge({CommitFolderMergeChoices(...args){
    assert.deepEqual(args,[session.folder,proposal.token,choices]);
    return new Promise(resolve=>{resolveWrite=resolve});
  }},session,proposal,choices);
  open.title='typed while the merge was on disk';session.records.mark({notes:[open]});
  resolveWrite({head:'merged',lists:{notes:{upsert:[{...other,title:'remote value'}],order:[other.id,open.id]}}});
  await pending;
  assert.equal(notes,session.data.notes);assert.equal(notes[1],open);
  assert.equal(notes[0].title,'remote value');
  let requests=0;
  await saveSpaceFolder({SaveFolderPatch:async (_dir,head,raw)=>{
    assert.equal(head,'merged');
    assert.deepEqual(JSON.parse(raw),{notes:{edit:[{id:open.id,set:{title:open.title}}]}});
    requests++;return 'after-typing';
  }},session);
  assert.equal(requests,1);assert.equal(session.head,'after-typing');
});

test('merging a note keeps the server project title separate from the document', async () => {
  const {session,incoming}=documents();
  session.connection={projectName:'Renamed on another computer'};
  await commitIncoming({CommitFolderMerge:async()=>{}},session,incoming,compareIncoming(session,incoming));
  assert.equal(session.link.name,session.connection.projectName);
  assert.equal(session.data.name,'Shared');
  assert.equal(JSON.parse(session.raw).name,'Shared');
});

test('committing a route created by another device clears fingerprints of newly sealed notes only', async () => {
  const {session,incoming}=documents();
  Object.assign(session.data.notes[0],{title:'',plain:'',sealed:'opaque'});
  const remote=JSON.parse(incoming.remote);
  const stops=[{noteId:'writing',fragment:'text/private-fingerprint'},{noteId:'elsewhere',fragment:'text/open-fingerprint'}];
  remote.routes=[{id:'route',name:'Route',stops}];
  incoming.remote=JSON.stringify(remote);
  const merged=compareIncoming(session,incoming);
  assert.equal(merged.conflicts.length,0);
  let written;
  await commitIncoming({CommitFolderMerge:async (_folder,_token,raw)=>{written=raw}},session,incoming,merged);
  assert.doesNotMatch(written,/private-fingerprint/);
  assert.equal(session.data.notes[0].sealed,'opaque');
  assert.deepEqual(session.data.routes[0].stops,[{noteId:'writing',fragment:null},stops[1]]);
});
