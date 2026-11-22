import test from 'node:test';
import assert from 'node:assert/strict';
import { moveAreaGrid, placeAreaNotes } from '../frontend/areas.js';
import { slotPoint } from '../frontend/area-grid.js';
import { createNote, newLibrary, readLibrary, serializeLibrary } from '../frontend/data.js';
import { lastMapAction, reorderStageWithHistory, undoMapAction } from '../frontend/map-history.js';

function fixture(slots, names=['Draft','Check','Draft','Ready']) {
  const library=newLibrary(),space=library.spaces.personal;
  const grid={x:10,y:-35,spacing:58,rows:3,cols:names.length,stages:names};
  const area={id:'track',name:'Launch',color:'#c5aa86',grid};
  space.areas.push(area);
  for(const slot of slots){
    const {x,y}=slotPoint(grid,slot);
    space.notes.push({...createNote(x,y,area.id),id:'n'+slot,slot});
  }
  return {library,space,area};
}

test('reordering a full track moves complete columns between duplicate labels, preserving rows through reload',()=>{
  const slots=Array.from({length:12},(_,i)=>i);
  const {library,space,area}=fixture(slots);
  const outside=createNote(100,200);
  space.notes.push(outside);
  assert.equal(reorderStageWithHistory(space,area.id,0,2),true);
  assert.deepEqual(area.grid.stages,['Check','Draft','Draft','Ready']);
  const reloaded=readLibrary(serializeLibrary(library)).spaces.personal;
  for(const [i,n] of reloaded.notes.slice(0,12).entries()){
    const expectedSlot=Math.floor(i/4)*4+[2,0,1,3][i%4];
    assert.equal(n.id,'n'+i);
    assert.equal(n.slot,expectedSlot);
    assert.deepEqual({x:n.x,y:n.y},slotPoint(area.grid,expectedSlot));
  }
  assert.deepEqual(reloaded.notes[12],outside);
  assert.equal(undoMapAction(space).kind,'stage-order');
  assert.deepEqual(space.notes.slice(0,12).map(n=>n.slot),slots);
  assert.deepEqual(area.grid.stages,['Draft','Check','Draft','Ready']);
  assert.equal(lastMapAction(space),undefined);
});

test('consecutive stage moves undo in order using current contents and map origin',()=>{
  const {space,area}=fixture([0,5,10,7]);
  assert.ok(reorderStageWithHistory(space,area.id,3,0));
  const intermediate=space.notes.map(n=>n.slot);
  assert.deepEqual(intermediate,[1,6,11,4]);
  assert.ok(reorderStageWithHistory(space,area.id,1,3));
  assert.deepEqual(space.notes.map(n=>n.slot),[3,5,10,4]);
  const late=createNote(0,0);
  space.notes.push(late);
  placeAreaNotes(space,[late.id],area.id,11);
  space.notes[2].title='Revised';
  moveAreaGrid(space,area.id,-150,94);
  assert.equal(undoMapAction(space).kind,'stage-order');
  assert.deepEqual(space.notes.map(n=>n.slot),[...intermediate,9]);
  assert.equal(undoMapAction(space).kind,'stage-order');
  assert.deepEqual(space.notes.map(n=>n.slot),[0,5,10,7,8]);
  assert.equal(space.notes[2].title,'Revised');
  assert.deepEqual({x:late.x,y:late.y},slotPoint(area.grid,8));
});

test('invalid moves and a drop in place leave the workspace and undo queue intact',()=>{
  const {space,area}=fixture([3]);
  const before=structuredClone(space);
  for(const [from,to] of [[0,0],[-1,2],[2,4],[3,1.5],[NaN,0]]){
    assert.equal(reorderStageWithHistory(space,area.id,from,to),false);
  }
  assert.equal(reorderStageWithHistory(space,'missing',1,2),false);
  assert.deepEqual(space,before);
  delete area.grid.stages;
  assert.equal(reorderStageWithHistory(space,area.id,1,0),false);
  assert.equal(lastMapAction(space),undefined);
});
