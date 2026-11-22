import assert from 'node:assert/strict';
import test from 'node:test';
import { newLibrary, readLibrary, serializeLibrary } from '../frontend/data.js';
import { availableStops, storeRoute } from '../frontend/map-routes.js';

const note = (id) => ({id,title:'Title ' + id,body:[],plain:'',tags:[],links:[]});
const stop = (noteId, fragment = null) => ({noteId,fragment});

test('saved routes belong to a workspace and reference content without storing previews', () => {
  const library = newLibrary(), space = library.spaces.personal;
  library.spaces.demo = {areas:[],notes:[]};
  space.notes.push(note('a'),note('b'));
  const draft = {id:'route',name:'  Review  ',stops:[{...stop('b','block/2'),label:'sensitive text'},stop('a'),stop('b')]};
  assert.ok(storeRoute(space,draft));
  draft.stops[0].fragment = 'other';
  const saved = readLibrary(serializeLibrary(library));
  assert.deepEqual(saved.spaces.personal.routes,[{id:'route',name:'Review',stops:[stop('b','block/2'),stop('a'),stop('b')]}]);
  assert.equal(saved.spaces.demo.routes,undefined);
});

test('deleted and protected stops drop out of playback, restoring a note restores its original stop', () => {
  const notes = [note('a'),note('b'),note('c')], space = {notes};
  const route = {stops:[stop('a'),stop('b','block/1'),stop('c')]};
  const removed = notes.shift();
  notes[0].sealed = 'ciphertext';
  assert.deepEqual(availableStops(space,route).map(item => item.index),[2]);
  notes.push(removed);
  delete notes[0].sealed;
  assert.deepEqual(availableStops(space,route).map(item => [item.note.id,item.index,item.stop.fragment]),[
    ['a',0,null],['b',1,'block/1'],['c',2,null]
  ]);
});

test('editing replaces a route in place, retaining other routes and rejecting an empty replacement', () => {
  const space = {notes:[note('a'),note('b')]};
  storeRoute(space,{id:'r1',name:'First',stops:[stop('a'),stop('b')]});
  storeRoute(space,{id:'r2',name:'Next',stops:[stop('b')]});
  assert.ok(storeRoute(space,{id:'r1',name:'Revised',stops:[stop('b','part/3')]}));
  assert.equal(storeRoute(space,{id:'r1',name:'',stops:[]}),false);
  assert.deepEqual(space.routes.map(route => route.name),['Revised','Next']);
  assert.deepEqual(space.routes[0].stops,[stop('b','part/3')]);
});
