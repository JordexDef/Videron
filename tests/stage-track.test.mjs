import test from 'node:test';
import assert from 'node:assert/strict';
import { createArea, placeAreaNotes } from '../frontend/areas.js';
import { fullGridIds } from '../frontend/area-grid.js';
import { createNote, newLibrary, readLibrary, serializeLibrary } from '../frontend/data.js';
import { rememberMapAction, resizeGridWithHistory, undoMapAction } from '../frontend/map-history.js';

function project(){
  const lib=newLibrary(),space=lib.spaces.personal;
  const area=createArea(space,{name:'Studio',color:'#a7b9cf',grid:{rows:3,cols:2,x:0,y:0,stages:['Draft','Ready']}});
  space.notes=['a','b','c','d'].map(id=>Object.assign(createNote(0,0),{id}));
  return {lib,space,area};
}

test('a group stays in the chosen stage, wraps up the column and undoes in one step',()=>{
  const {lib,space,area}=project();
  placeAreaNotes(space,['c'],area.id,1);
  const change=placeAreaNotes(space,['a','b'],area.id,5);
  assert.deepEqual(space.notes.slice(0,3).map(n=>n.slot),[5,3,1]);
  assert.equal(placeAreaNotes(space,['d'],area.id,1).ok,false);
  const copy=readLibrary(serializeLibrary(lib)).spaces.personal;
  assert.deepEqual(copy.areas[0].grid.stages,['Draft','Ready']);
  assert.deepEqual(copy.notes.slice(0,3).map(n=>n.slot),[5,3,1]);
  rememberMapAction(space,{kind:'placement',before:change.before,after:change.after});
  assert.equal(undoMapAction(space).kind,'placement');
  assert.deepEqual(space.notes.map(n=>n.areaId),[null,null,area.id,null]);
});

test('sidebar entry starts new notes in the first stage and keeps existing stages',()=>{
  const {space,area}=project();
  placeAreaNotes(space,['a','b','c'],area.id);
  assert.deepEqual(space.notes.slice(0,3).map(n=>n.slot),[0,2,4]);
  assert.ok(fullGridIds(space,['a','d']).has(area.id));
  assert.equal(placeAreaNotes(space,['d'],area.id).ok,false);
  placeAreaNotes(space,['a'],area.id,1);
  assert.ok(!fullGridIds(space,['a','d']).has(area.id));
  placeAreaNotes(space,['a','d'],area.id);
  assert.deepEqual(space.notes.map(n=>n.slot),[1,2,4,0]);
});

test('two positions in a stage can swap, while dropping across stages leaves existing work in its stage',()=>{
  const {space,area}=project();
  placeAreaNotes(space,['a','b','c'],area.id);
  placeAreaNotes(space,['d'],area.id,3);
  const swapped=placeAreaNotes(space,['c'],area.id,0);
  assert.deepEqual(swapped.after.map(n=>[n.id,n.slot]),[['c',0],['a',4]]);
  const moved=placeAreaNotes(space,['a'],area.id,3);
  assert.deepEqual(moved.after.map(n=>[n.id,n.slot]),[['a',5]]);
  assert.deepEqual(space.notes.map(n=>n.slot),[5,2,0,3]);
});

test('editing a track preserves stages, compacts within a column and restores labels on undo',()=>{
  const {space,area}=project();
  placeAreaNotes(space,['a'],area.id,5);
  const appearance={name:'Launch',color:'#c5aa86'};
  assert.equal(resizeGridWithHistory(space,area.id,3,1,96,['Draft'],appearance),false);
  assert.equal(area.name,'Studio');
  assert.equal(resizeGridWithHistory(space,area.id,2,3,100,['Writing','Published','Archived'],appearance),true);
  assert.equal(area.name,'Launch');
  assert.equal(area.color,'#c5aa86');
  assert.equal(space.notes[0].slot,1);
  assert.equal(undoMapAction(space).kind,'grid-size');
  assert.deepEqual(area.grid.stages,['Draft','Ready']);
  assert.equal(area.name,'Studio');
  assert.equal(area.color,'#a7b9cf');
  assert.equal(space.notes[0].slot,5);
});
