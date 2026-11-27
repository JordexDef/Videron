import assert from 'node:assert/strict';
import test from 'node:test';
import { parseImportedNotes } from '../frontend/note-import-markdown.js';
import { noteImportAction, planNoteImport } from '../frontend/note-import.js';
import { rememberMapAction, undoMapAction } from '../frontend/map-history.js';

function plan(space) {
  const files = parseImportedNotes({files:[
    {path:'Index.md', text:'[[Folder/Page]]'},
    {path:'Folder/Page.md', text:'An imported note.'},
  ]});
  return planNoteImport(space, files, {name:'Import · Vault',
    bounds:{left:-40, right:40, top:-40, bottom:40}, center:{x:0,y:0}});
}

test('import plans an independent, nested batch to the right of existing notes', () => {
  const space = {notes:[{id:'existing', title:'Page'}], areas:[{id:'old', name:'Import · Vault'}]};
  const batch = plan(space);
  assert.equal(batch.root.name, 'Import · Vault · 2');
  assert.equal(batch.areas[1].parentId, batch.root.id);
  const index = batch.notes.find(note => note.title === 'Index');
  const page = batch.notes.find(note => note.title === 'Page');
  assert.deepEqual(index.links, [page.id]);
  assert.equal(page.areaId, batch.areas[1].id);
  assert.ok(batch.notes.every(note => note.x > 40 && Number.isFinite(note.y)));
  assert.notDeepEqual([index.x, index.y], [page.x, page.y]);
  assert.equal(space.notes.length, 1);
  assert.equal(space.areas.length, 1);
});

test('map undo removes the import batch after layout settles and keeps other work', () => {
  const existing = {id:'existing', links:[], areaId:null};
  const space = {notes:[existing], areas:[]};
  const batch = plan(space);
  space.notes.push(...batch.notes);
  space.areas.push(...batch.areas);
  rememberMapAction(space, noteImportAction(batch));
  batch.notes[0].x += 15;
  batch.notes[0].opens++;
  assert.equal(undoMapAction(space)?.kind, 'note-import');
  assert.deepEqual(space.notes, [existing]);
  assert.deepEqual(space.areas, []);
});

test('import undo preserves notes changed after import or cited by other notes', () => {
  const space = {notes:[], areas:[]};
  const batch = plan(space);
  space.notes.push(...batch.notes);
  space.areas.push(...batch.areas);
  const action = noteImportAction(batch);
  const originalTitle = batch.notes[0].title;
  batch.notes[0].title = 'Changed on another client';
  rememberMapAction(space, action);
  assert.equal(undoMapAction(space), null);
  assert.equal(space.notes.length, 2);
  assert.equal(space.areas.length, 2);

  batch.notes[0].title = originalTitle;
  space.notes.push({id:'existing', links:[batch.notes[0].id]});
  rememberMapAction(space, action);
  assert.equal(undoMapAction(space), null);
  assert.equal(space.notes.length, 3);
  assert.equal(space.areas.length, 2);
});
