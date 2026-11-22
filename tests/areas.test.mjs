import test from 'node:test';
import assert from 'node:assert/strict';
import { areaTreeRows, areaPath, descendantAreaIds, canMoveArea, createArea, moveArea, assignNotesToArea, removeArea } from '../frontend/areas.js';
import { newLibrary, readLibrary, serializeLibrary } from '../frontend/data.js';
import { deleteNote, undoNoteDeletion } from '../frontend/note-deletion.js';
import { openNoteSession } from '../frontend/note-vault.js';
import { findNotes } from '../frontend/search-worker.js';

const area = (id, parentId) => ({id, name:id, color:'#aabbcc', parentId});
const note = (id, areaId) => ({id, areaId, title:id, plain:id, body:[], links:[], tags:[]});

test('load flat areas, orphans and cycles as a connected forest without losing notes', () => {
  const lib = newLibrary(), space = lib.spaces.personal;
  space.areas = [area('flat'), area('orphan','old'), area('a','b'), area('b','a'), area('c','a')];
  space.notes = [note('n','c'), note('other','old')];
  const restored = readLibrary(serializeLibrary(lib)).spaces.personal;
  assert.deepEqual(restored.areas.map(a => [a.id,a.parentId]), [['flat',null],['orphan',null],['a','b'],['b',null],['c','a']]);
  assert.deepEqual(restored.notes.map(n => n.areaId), ['c',null]);
  assert.deepEqual(areaTreeRows(restored.areas).map(row => [row.area.id,row.depth]),
    [['flat',0],['orphan',0],['b',0],['a',1],['c',2]]);
  assert.deepEqual(areaPath(restored.areas,'c').map(a => a.id), ['b','a','c']);
  assert.equal(areaTreeRows(restored.areas).at(-1).pathLabel, 'b / a / c');
  assert.deepEqual(descendantAreaIds(restored.areas,'a'), new Set(['a','c']));
  assert.deepEqual(descendantAreaIds(restored.areas,'missing'), new Set());
  space.areas.push(area('flat'));
  assert.throws(() => readLibrary(serializeLibrary(lib)));
});

test('create areas and move a whole branch, disallowing invalid and cyclic destinations', () => {
  const space = {areas:[area('parent'),area('child','parent'),area('other')],notes:[]};
  const created = createArea(space,{name:'  Ideas  ',color:'#aabbcc',parentId:'child'});
  assert.equal(created.name,'Ideas');
  assert.equal(createArea(space,{name:'',color:'#aabbcc'}), null);
  assert.equal(createArea(space,{name:'Ideas',color:'#aabbcc',parentId:'gone'}), null);
  for (const destination of ['parent','child',created.id,'gone',null]) {
    assert.equal(canMoveArea(space.areas,'parent',destination),false);
    assert.equal(moveArea(space,'parent',destination),false);
  }
  assert.equal(moveArea(space,'child','other'),true);
  assert.deepEqual(areaPath(space.areas,created.id).map(a => a.id), ['other','child',created.id]);
  assert.equal(moveArea(space,'child',null),true);
  assert.equal(areaPath(space.areas,created.id)[0].id,'child');
});

test('folder removal promotes contents, including restoration of a deleted note, while preserving links and ciphertext', async () => {
  const child = area('child','root'), grandchild = area('grandchild','child');
  const plain = note('plain',null), lost = note('lost','child'), inside = note('inside','grandchild');
  plain.links = ['inside','lost'];
  const wrapped = {...note('private','child'), title:'',plain:'',sealed:'opaque'};
  const space = {areas:[area('root'),child,grandchild],notes:[plain,lost,inside,wrapped]};
  assert.equal(assignNotesToArea(space,['plain','plain','unknown','private'],'child'),1);
  assert.equal(assignNotesToArea(space,['plain','private'],'gone'),0);
  deleteNote(space,'lost');
  assert.equal(removeArea(space,'child'),child);
  assert.equal(grandchild.parentId,'root');
  assert.deepEqual(space.notes.map(n => n.areaId), ['root','grandchild','root']);
  assert.equal(undoNoteDeletion(space).areaId, 'root');
  assert.deepEqual(plain.links,['inside','lost']);
  removeArea(space,'root');
  assert.equal(grandchild.parentId,null);
  assert.equal(wrapped.areaId,null);
  assert.equal(wrapped.sealed,'opaque');
  assert.equal(space.notes.length,4);
  assert.equal(removeArea(space,'child'),null);
  // The encrypted payload still records its original folder. The map placement wins on unlock.
  const session = await openNoteSession({record:wrapped,
    bridge:{UnlockNote:async () => JSON.stringify(note('private','child')), LockNote:async () => {}},
    persist:async () => {}, prompt:async ({onSubmit}) => { await onSubmit({password:'test'}); return true; }});
  assert.equal(session.note.areaId,null);
  assert.equal(session.note.title,'private');
  assert.equal(await session.beforeClose(),true);
});

test('folder filters search descendants and keep unfiled or unrelated notes separate', () => {
  const areas = [area('parent'),area('child','parent'),area('other')];
  const notes = [note('top','parent'),note('nested','child'),note('unrelated','other'),note('free',null)];
  function results(filter) {
    return findNotes(notes,{query:'',...filter}).matches.map(match => match.id);
  }
  assert.deepEqual(results({area:'parent',areaIds:[...descendantAreaIds(areas,'parent')]}),['top','nested']);
  assert.deepEqual(results({area:'child',areaIds:['child']}),['nested']);
  assert.deepEqual(results({area:'_none'}),['free']);
});
