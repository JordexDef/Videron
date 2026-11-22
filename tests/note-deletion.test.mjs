import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteNote, deleteNotes, lastDeletedNote, undoNoteDeletion, undoNotesDeletion } from '../frontend/note-deletion.js';

const note = (id, links = []) => ({id, title: id, body: [], tags: [], links});

test('bulk undo clamps old positions and keeps links that were re-added or reordered',()=>{
  const hub=note('hub',['x','a','y','b','z','c','d']);
  const space={notes:[hub,...['x','a','y','b','z','c','d'].map(id=>note(id))]};
  const ids=['a','b','c','d'];
  deleteNotes(space,ids);
  space.notes=space.notes.filter(n=>n.id==='hub' || n.id==='z');
  hub.links=['z','b','new'];
  const notes=space.notes,links=hub.links;
  assert.equal(undoNotesDeletion(space,ids),true);
  assert.equal(space.notes,notes);
  assert.equal(hub.links,links);
  assert.deepEqual(space.notes.map(n=>n.id),['hub','z','a','b','c','d']);
  assert.deepEqual(hub.links,['z','a','b','new','c','d']);
});

test('a large selection is one undo, preserves link order and returns each note to its seat', () => {
  const grid={rows:5,cols:5,spacing:80,x:0,y:0};
  const members=Array.from({length:25},(_,slot)=>({
    ...note('n'+slot,['source','n'+((slot+1)%25)]),areaId:'grid',slot,x:(slot%5)*80,y:Math.floor(slot/5)*80,
  }));
  const ids=members.map(n=>n.id);
  const source=note('source',['before',...ids,'after']);
  const space={areas:[{id:'grid',grid}],notes:[members[0],source,...members.slice(1)]};
  const original=structuredClone(space.notes);
  assert.equal(deleteNotes(space,[...ids,'unknown']),null);
  assert.deepEqual(space.notes,original);
  const deleted=deleteNotes(space,ids.toReversed());
  assert.deepEqual(deleted.map(n=>n.id),ids);
  assert.deepEqual(source.links,['before','after']);
  source.title='Changed';
  source.links.push('new');
  space.notes.push(note('n2'));
  assert.equal(undoNotesDeletion(space,ids),false);
  assert.equal(space.notes.length,2);
  space.notes.pop();
  assert.equal(undoNotesDeletion(space,ids),true);
  original[1].title='Changed';
  original[1].links.push('new');
  assert.deepEqual(space.notes,original);
  assert.equal(undoNotesDeletion(space,ids),false);
});

test('restore the original note and its links without reverting later edits to neighbors', () => {
  const canvas = {...note('canvas', ['target']), type: 'canvas', x: 10, y: 12, pinned: true,
    board: {version: 2, elements: [{type: 'text', text: 'diagram'}]},
    areaId: 'research', tags: ['diagram'], appearance: {shape: 'diamond', color: '#aabbcc'}};
  const original = structuredClone(canvas);
  const source = note('source', ['older', 'canvas', 'target']);
  const space = {notes: [source, canvas, note('target'), note('older')]};
  deleteNote(space, 'canvas');
  assert.deepEqual(source.links, ['older', 'target']);
  source.title = 'Later title';
  source.links.push('new');
  space.notes.push(note('new'));
  assert.deepEqual(undoNoteDeletion(space), original);
  assert.deepEqual(space.notes.map(n => n.id), ['source', 'canvas', 'target', 'older', 'new']);
  assert.deepEqual(source.links, ['older', 'canvas', 'target', 'new']);
  assert.equal(source.title, 'Later title');
  assert.equal(undoNoteDeletion(space), null);
});

test('undo consecutive deletions of linked notes in reverse order, scoped to their space', () => {
  const space = {notes: [note('a', ['b']), note('b', ['a']), note('c', ['a', 'b'])]};
  const untouched = structuredClone(space);
  const other = structuredClone(space);
  deleteNote(space, 'a');
  deleteNote(other, 'b');
  deleteNote(space, 'b');
  assert.equal(lastDeletedNote(space).id, 'b');
  assert.deepEqual(space.notes, [note('c')]);
  undoNoteDeletion(space);
  assert.deepEqual(space.notes, [note('b'), note('c', ['b'])]);
  assert.equal(lastDeletedNote(space).id, 'a');
  undoNoteDeletion(space);
  assert.deepEqual(space, untouched);
  assert.deepEqual(other.notes, [note('a'), note('c', ['a'])]);
  assert.equal(undoNoteDeletion(structuredClone(other)), null);
  undoNoteDeletion(other);
  assert.deepEqual(other, untouched);
});
