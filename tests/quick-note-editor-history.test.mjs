import assert from 'node:assert/strict';
import test from 'node:test';
import {packEditorHistory,restoreEditorHistory} from '../frontend/editor-history.js';
import {createQuickEntry} from '../frontend/quick-note.js';
import {quickEditorEntries} from '../frontend/quick-note-editor.js';

const state = body => ({title:'Quick',body,relations:{links:[],pinned:false,areaId:null,slot:null},point:{x:20,y:40}});

test('quick editor undo keeps a later map capture and follows the edited entry', () => {
  const original = createQuickEntry('First entry',{id:'old',created:2});
  const older = createQuickEntry('Prior entry',{id:'older',created:1});
  const changed = {...original,runs:[{text:'First edited entry',bold:true}]};
  const captured = createQuickEntry('New map capture',{id:'new',created:3});
  const snapshot = {...state([original,older]),mark:{id:original.id,index:0,start:6,end:6}};
  const current = state([captured,changed,older]);
  const stored = packEditorHistory(state([changed,older]),[snapshot],[]);
  const restored = restoreEditorHistory(stored,current);
  assert.deepEqual(restored.past[0].body,[captured,original,older]);
  assert.deepEqual(restored.past[0].mark,{...snapshot.mark,index:1});
});

test('quick editor undo declines an overlapping update on another client', () => {
  const entry = createQuickEntry('Original',{id:'same',created:1});
  const local = {...entry,runs:[{text:'Local'}]};
  const remote = {...entry,runs:[{text:'Remote'}]};
  const stored = packEditorHistory(state([local]),[state([entry])],[]);
  assert.deepEqual(restoreEditorHistory(stored,state([remote])).past,[]);
});

test('older clients can leave quick note paragraphs without unique IDs and dates', () => {
  const body = [{type:'paragraph',runs:[{text:'Legacy text'}]},
    {...createQuickEntry('Valid',{id:'legacy-entry-0',created:0})},
    {...createQuickEntry('Repeated',{id:'legacy-entry-0',created:1e99})}];
  const note={body,created:128};
  const entries=quickEditorEntries(note);
  assert.deepEqual(entries.map(({id,created})=>({id,created})), [
    {id:'legacy-entry-0-',created:128},{id:'legacy-entry-0',created:0},{id:'legacy-entry-2',created:128},
  ]);
  assert.equal(entries[0].runs,body[0].runs);
  assert.equal(entries[1],body[1]);
  assert.equal(body[0].id,undefined);
});
