import test from 'node:test';
import assert from 'node:assert/strict';
import { createNote, newLibrary, readLibrary, serializeLibrary } from '../frontend/data.js';
import { moveAreaGrid, placeAreaNotes, stageRemovalOptions } from '../frontend/areas.js';
import { slotPoint } from '../frontend/area-grid.js';
import { deleteStageWithHistory, insertStageWithHistory, lastMapAction, reorderStageWithHistory, undoMapAction } from '../frontend/map-history.js';

function fixture(slots, stages=['Ideas','Work','Work','Ready'], rows=4) {
  const lib=newLibrary(), space=lib.spaces.personal;
  const grid={rows,cols:stages.length,stages,x:21,y:-34,spacing:96};
  const area={id:'track',name:'Design',color:'#b8abc9',grid};
  space.areas.push(area);
  for (const slot of slots) {
    const p=slotPoint(grid,slot);
    space.notes.push({...createNote(p.x,p.y,area.id),id:'n'+slot,slot});
  }
  return {lib,space,area};
}

const slotsOf = space => space.notes.map(n=>n.slot);

function checkSeats(space,area) {
  const taken=new Set();
  for (const note of space.notes.filter(n=>n.areaId===area.id)) {
    assert.ok(Number.isInteger(note.slot) && note.slot>=0 && note.slot<area.grid.rows*area.grid.cols);
    assert.ok(!taken.has(note.slot),'two notes overlap at '+note.slot);taken.add(note.slot);
    assert.deepEqual({x:note.x,y:note.y},slotPoint(area.grid,note.slot));
  }
}

test('insert places an empty intermediate stage among repeated names and preserves every row through reload and undo',()=>{
  const slots=Array.from({length:16},(_,i)=>i),{lib,space,area}=fixture(slots);
  assert.ok(insertStageWithHistory(space,area.id,2,'  Work ').ok);
  assert.deepEqual(area.grid.stages,['Ideas','Work','Work','Work','Ready']);
  assert.deepEqual(slotsOf(space),slots.map(s=>Math.floor(s/4)*5+s%4+(s%4>=2?1:0)));
  const copy=readLibrary(serializeLibrary(lib)).spaces.personal;
  checkSeats(copy,copy.areas[0]);
  space.notes[0].title='Renamed';moveAreaGrid(space,area.id,350,500);
  assert.equal(undoMapAction(space).kind,'stage-insert');
  assert.deepEqual(slotsOf(space),slots);assert.equal(space.notes[0].title,'Renamed');
  assert.deepEqual(area.grid.stages,['Ideas','Work','Work','Ready']);checkSeats(space,area);
});

test('delete reserves matching free rows first and leaves the destination and unrelated stages in place',()=>{
  const {space,area}=fixture([0,4,12,2,10,1,15]);
  const before=slotsOf(space);
  const options=stageRemovalOptions(space,area.id,0);
  assert.equal(options.count,3);
  assert.deepEqual(options.options.find(o=>o.destination===2),{destination:2,rows:5,available:true});
  assert.ok(deleteStageWithHistory(space,area.id,0,2).ok);
  assert.deepEqual(area.grid.stages,['Work','Work','Ready']);assert.equal(area.grid.rows,5);
  // The two free source rows (1 and 3) are kept; only row 0 moves down.
  assert.deepEqual(slotsOf(space),[13,4,10,1,7,0,11]);checkSeats(space,area);
  assert.ok(reorderStageWithHistory(space,area.id,2,1));assert.equal(undoMapAction(space).kind,'stage-order');
  assert.equal(undoMapAction(space).kind,'stage-delete');
  assert.deepEqual(slotsOf(space),before);assert.equal(area.grid.rows,4);checkSeats(space,area);
});

test('undoing insertion releases new notes onto the map while restoring the other columns',()=>{
  const {space,area}=fixture([0,1,2,3],['Draft','Done'],2);
  const note=space.notes[1];
  note.links=['n2'];note.body=[{type:'paragraph',runs:[{text:'private text'}]}];note.pinned=true;
  assert.ok(deleteStageWithHistory(space,area.id,1,0).ok);
  assert.ok(!JSON.stringify(lastMapAction(space)).includes('private text'));
  assert.deepEqual(slotsOf(space),[0,2,1,3]);
  const late={...createNote(0,0),id:'late'};space.notes.push(late);
  // Only the existing destination is full; create a fresh stage and fill an extra row.
  assert.ok(insertStageWithHistory(space,area.id,1,'Later').ok);
  assert.ok(placeAreaNotes(space,[late.id],area.id,7).ok);
  late.title='New note';late.links=['n3'];late.pinned=true;
  const action=undoMapAction(space);
  assert.equal(action.kind,'stage-insert');assert.equal(action.releasedCount,1);
  assert.deepEqual(area.grid.stages,['Draft']);assert.deepEqual(slotsOf(space),[0,2,1,3,null]);
  assert.equal(late.areaId,null);assert.ok(late.x>area.grid.x+96);assert.equal(late.title,'New note');
  assert.deepEqual(late.links,['n3']);assert.equal(late.pinned,true);
  assert.equal(undoMapAction(space).kind,'stage-delete');
  assert.deepEqual(slotsOf(space),[0,1,2,3,null]);checkSeats(space,area);
});

test('undo uses the current grid origin, retains later note edits and keeps extra rows required by newly created notes',()=>{
  const second=fixture([0,1,2,3,4,5],['A','B','C'],2);
  assert.ok(deleteStageWithHistory(second.space,second.area.id,0,1).ok);
  const newer={...createNote(0,0),id:'newer'};second.space.notes.push(newer);
  assert.ok(placeAreaNotes(second.space,[newer.id],second.area.id,7).ok);
  second.space.notes[0].title='Edited';
  moveAreaGrid(second.space,second.area.id,-100,-200);
  assert.equal(undoMapAction(second.space).kind,'stage-delete');
  assert.deepEqual(slotsOf(second.space),[0,1,2,3,4,5,11]);
  assert.equal(second.area.grid.rows,4);assert.equal(second.space.notes[0].title,'Edited');
  checkSeats(second.space,second.area);
});

test('release onto map avoids another track, retains rows in order and restores moved notes after physics moves them',()=>{
  const {space,area}=fixture([2,10,5]);
  space.areas.push({id:'other',name:'Other',color:'#8999aa',
    grid:{x:500,y:-34,spacing:120,rows:4,cols:2,stages:['A','B']}});
  const plain=space.notes[0], protectedNote=space.notes[1];
  plain.links=['n10'];plain.pinned=true;
  Object.assign(protectedNote,{sealed:'ciphertext',title:'',body:[]});
  assert.ok(deleteStageWithHistory(space,area.id,2,null).ok);
  assert.deepEqual([plain.areaId,plain.slot,protectedNote.areaId,protectedNote.slot],[null,null,null,null]);
  assert.equal(plain.x,protectedNote.x);assert.ok(plain.x>740);assert.ok(plain.y<protectedNote.y);
  assert.equal(protectedNote.sealed,'ciphertext');assert.ok(!JSON.stringify(lastMapAction(space)).includes('ciphertext'));
  assert.deepEqual(plain.links,['n10']);assert.equal(plain.pinned,true);
  protectedNote.x+=7;moveAreaGrid(space,area.id,200,-200);
  assert.equal(undoMapAction(space).kind,'stage-delete');
  assert.deepEqual(slotsOf(space),[2,10,5]);checkSeats(space,area);
});

test('invalid targets, capacity limits, max columns and the final remaining stage are atomic',()=>{
  const {space,area}=fixture([0,...Array.from({length:100},(_,i)=>2*i+1)],['A','B'],100);
  const before=structuredClone(space);
  assert.deepEqual(stageRemovalOptions(space,area.id,0).options,[
    {destination:1,rows:101,available:false},{destination:null,rows:100,available:true}
  ]);
  assert.deepEqual(deleteStageWithHistory(space,area.id,0,1),{ok:false,reason:'capacity'});
  for(const destination of [undefined,0,-1,2,'1']){
    assert.equal(deleteStageWithHistory(space,area.id,0,destination).reason,'destination');
  }
  assert.deepEqual(space,before);assert.equal(lastMapAction(space),undefined);
  assert.ok(deleteStageWithHistory(space,area.id,0,null).ok);
  assert.equal(stageRemovalOptions(space,area.id,0).reason,'last-stage');
  assert.equal(deleteStageWithHistory(space,area.id,0,null).reason,'last-stage');

  const full=fixture([],Array.from({length:100},(_,i)=>String(i)));
  assert.equal(insertStageWithHistory(full.space,full.area.id,50,'Extra').reason,'limit');
  assert.equal(lastMapAction(full.space),undefined);
  const empty=fixture([]);
  assert.equal(insertStageWithHistory(empty.space,empty.area.id,1,'  ').reason,'name');
  assert.equal(deleteStageWithHistory(empty.space,empty.area.id,1).ok,true);
  assert.equal(undoMapAction(empty.space).kind,'stage-delete');
  assert.equal(empty.area.grid.cols,4);
});
