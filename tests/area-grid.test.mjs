import test from 'node:test';
import assert from 'node:assert/strict';
import { createArea, normalizeAreaTree, placeAreaNotes, removeArea, resizeAreaGrid, moveAreaGrid, restoreAreaPlacement } from '../frontend/areas.js';
import { DEFAULT_GRID_SPACING as spacing, GRID_PITCH, gridSpacing, fullGridIds, planGridSlots, slotPoint } from '../frontend/area-grid.js';
import { newLibrary, readLibrary, serializeLibrary } from '../frontend/data.js';
import { deleteNote, deleteNotes, undoNoteDeletion, undoNotesDeletion } from '../frontend/note-deletion.js';
import { openNoteSession } from '../frontend/note-vault.js';

const note = id => ({id,title:id,plain:id,body:[],links:[],tags:[],x:11,y:19,areaId:null});
const workspace = (...ids) => ({areas:[],notes:ids.map(note)});
const area = (space,rows=2,cols=3,parentId=null) => createArea(space,{
  name:'Seats',color:'#acacac',parentId,grid:{x:70,y:90,rows,cols}
});

test('changing grid pitch or switching to a track preserves nearest-seat order at edges and around holes', () => {
  const ids=Array.from({length:5},(_,i)=>'moving'+i);
  const occupied=new Set([0,3,8,19,20,34,41]);
  const occupants=Array.from(occupied,slot=>({id:'seated'+slot,slot}));
  for (const [spacing,rowSpacing,track] of [[64,24,false],[24,64,false],[64,64,true],[64,24,false]]) {
    const grid={rows:8,cols:7,x:13,y:-7,spacing,rowSpacing};
    if (track) grid.stages=Array.from({length:grid.cols},(_,i)=>'Stage '+i);
    for (let target=0;target<grid.rows*grid.cols;target++) {
      const point=slotPoint(grid,target), free=[];
      for (let slot=0;slot<grid.rows*grid.cols;slot++) {
        if (occupied.has(slot) || (track && slot%grid.cols!==target%grid.cols)) continue;
        const {x,y}=slotPoint(grid,slot);
        free.push({slot,distance:(point.x-x)**2+(point.y-y)**2,vertical:Math.abs(point.y-y)});
      }
      free.sort((a,b)=>a.distance-b.distance || a.vertical-b.vertical || b.slot-a.slot);
      const actual=planGridSlots(grid,occupants,ids,target);
      assert.deepEqual(actual && [...actual.values()],free.length<ids.length ? null : free.slice(0,ids.length).map(p=>p.slot));
    }
  }
});

test('batch placement keeps the lead under the pointer, skips occupied seats, and is all-or-nothing', () => {
  const space=workspace('a','b','c','d','extra'), grid=area(space,2,2);
  assert.equal(area(space,101,1),null);
  assert.equal(area(space,2,1.5),null);
  placeAreaNotes(space,['c'],grid.id,3);
  const move=placeAreaNotes(space,['b','a','d'],grid.id,2);
  assert.deepEqual(space.notes.map(n=>n.slot),[0,2,3,1,undefined]);
  assert.deepEqual(space.notes.slice(0,4).map(n=>[n.x,n.y]),[[70,90],[70,90+spacing],[70+spacing,90+spacing],[70+spacing,90]]);
  assert.equal(fullGridIds(space,['b']).has(grid.id),false);
  assert.equal(fullGridIds(space,['extra','b']).has(grid.id),true);
  const snapshot=structuredClone(space);
  assert.equal(placeAreaNotes(space,['extra','b'],grid.id).reason,'full');
  assert.deepEqual(space,snapshot);
  assert.equal(restoreAreaPlacement(space,move.before,move.after),true);
  assert.deepEqual(space.notes.map(n=>n.areaId),[null,null,grid.id,null,null]);
  assert.deepEqual(space.notes.slice(0,2).map(n=>[n.x,n.y]),[[11,19],[11,19]]);
});

test('resizing preserves row and column, moving the whole grid translates members, undo checks collisions', () => {
  const space=workspace('a','b','c'), grid=area(space);
  placeAreaNotes(space,['a','b'],grid.id,4);
  const move=placeAreaNotes(space,['a'],null,null,[{id:'a',x:-35,y:11}]);
  assert.deepEqual([space.notes[0].x,space.notes[0].y,space.notes[0].slot],[-35,11,null]);
  assert.equal(resizeAreaGrid(space,grid.id,2,4),true);
  assert.equal(space.notes[1].slot,6);
  moveAreaGrid(space,grid.id,333,-270);
  placeAreaNotes(space,['c'],grid.id,5);
  assert.equal(restoreAreaPlacement(space,move.before,move.after),false);
  placeAreaNotes(space,['c'],null);
  space.notes[0].x=456;
  assert.equal(restoreAreaPlacement(space,move.before,move.after),true);
  assert.equal(space.notes[0].slot,5);
  assert.equal(space.notes[0].x,333+spacing);
  assert.equal(space.notes[0].y,-270+spacing);
  assert.equal(resizeAreaGrid(space,grid.id,1,1),false);
  assert.deepEqual([grid.grid.rows,grid.grid.cols],[2,4]);
  assert.equal(resizeAreaGrid(space,grid.id,1,2),true);
  assert.deepEqual(space.notes.slice(0,2).map(n=>n.slot),[0,1]);
});

test('deletion, file repair, and undo never reserve one seat twice or discard overflow notes', () => {
  const space=workspace('a','b','c','d','e'), parent=area(space,1,2), child=area(space,1,3,parent.id);
  placeAreaNotes(space,['a'],parent.id,0);
  placeAreaNotes(space,['b','c','d'],child.id);
  deleteNote(space,'b');
  removeArea(space,child.id);
  assert.deepEqual(space.notes.map(n=>[n.id,n.areaId]),[['a',parent.id],['c',parent.id],['d',null],['e',null]]);
  const restored=undoNoteDeletion(space);
  assert.equal(restored.areaId,null);
  placeAreaNotes(space,['a'],parent.id,1);
  deleteNote(space,'c');
  placeAreaNotes(space,['e'],parent.id);
  assert.equal(undoNoteDeletion(space).areaId,null);
  const lib=newLibrary();
  lib.spaces.personal=space;
  space.notes.find(n=>n.id==='b').areaId=parent.id;
  space.notes.find(n=>n.id==='b').slot=space.notes.find(n=>n.id==='a').slot;
  const reopened=readLibrary(serializeLibrary(lib)).spaces.personal;
  const seated=reopened.notes.filter(n=>n.areaId===parent.id);
  assert.equal(reopened.notes.length,5);
  assert.deepEqual(seated.map(n=>n.slot).sort(),[0,1]);
});

test('dropping a group at the last seat of a 100 by 100 grid keeps the other notes nearby', () => {
  const space=workspace('first','last'), area100=area(space,100,100);
  const plan=planGridSlots(area100.grid,[],['last','first'],9999);
  assert.deepEqual([...plan],[['last',9999],['first',9998]]);
  placeAreaNotes(space,['last'],area100.id,9999);
  assert.deepEqual(slotPoint(area100.grid,9999),{x:70+99*spacing,y:90+99*spacing});
  assert.equal(space.notes[1].x,70+99*spacing);
});

test('repair of sibling grids reserves each free parent seat once, in file order', () => {
  const space = workspace('parent', 'left', 'right', 'first', 'second', 'overflow');
  const parent = area(space,1,3), left = area(space,1,1,parent.id), right = area(space,1,1,parent.id);
  const owners = [parent,left,right,left,right,right];
  space.notes.forEach((note,i) => Object.assign(note,{areaId:owners[i].id,slot:i === 0 ? 1 : 0}));
  normalizeAreaTree(space);
  assert.deepEqual(space.notes.map(n=>[n.areaId,n.slot]),[
    [parent.id,1],[left.id,0],[right.id,0],[parent.id,0],[parent.id,2],[null,null]
  ]);
  const repaired = structuredClone(space);
  normalizeAreaTree(space);
  assert.deepEqual(space,repaired);
});

test('bulk undo keeps current occupants and saved parent seats ahead of overflow', () => {
  const space = workspace('childNote','parentNote','newChild','newParent');
  const parent = area(space,1,3), child = area(space,1,1,parent.id);
  placeAreaNotes(space,['childNote'],child.id,0);
  placeAreaNotes(space,['parentNote'],parent.id,1);
  const ids = ['childNote','parentNote'];
  deleteNotes(space,ids);
  placeAreaNotes(space,['newChild'],child.id,0);
  placeAreaNotes(space,['newParent'],parent.id,0);
  moveAreaGrid(space,parent.id,360,40);
  assert.equal(undoNotesDeletion(space,ids),true);
  assert.deepEqual(space.notes.map(n=>[n.areaId,n.slot]),[
    [parent.id,2],[parent.id,1],[child.id,0],[parent.id,0]
  ]);
  for (const n of space.notes) {
    const grid = n.areaId === child.id ? child.grid : parent.grid;
    assert.deepEqual({x:n.x,y:n.y},slotPoint(grid,n.slot));
  }
});

test('a group already in a grid translates around the grabbed note without flattening its layout', () => {
  const space=workspace('lead','below','diagonal'), shelf=area(space,4,6);
  for (const [id,slot] of [['below',18],['diagonal',14],['lead',12]]) placeAreaNotes(space,[id],shelf.id,slot);
  const move=placeAreaNotes(space,['lead','diagonal','below'],shelf.id,8);
  assert.deepEqual(space.notes.map(n=>n.slot),[8,14,10]);
  assert.equal(restoreAreaPlacement(space,move.before,move.after),true);
  assert.deepEqual(space.notes.map(n=>n.slot),[12,18,14]);
});

test('swapping occupied seats in a full grid previews and moves both notes in one undo step', () => {
  const space=workspace('left','right'), shelf=area(space,1,2);
  placeAreaNotes(space,['left','right'],shelf.id);
  const preview=planGridSlots(shelf.grid,space.notes,['right'],0);
  assert.deepEqual([...preview],[['right',0],['left',1]]);
  const move=placeAreaNotes(space,['right'],shelf.id,0);
  assert.deepEqual(move.after.map(n=>[n.id,n.slot]),[...preview]);
  assert.equal(restoreAreaPlacement(space,move.before,move.after),true);
  assert.deepEqual(space.notes.map(n=>n.slot),[0,1]);
});

test('an external note on an occupied seat follows the actual horizontal and vertical pitches', () => {
  const space=workspace('seated','incoming'), shelf=area(space,3,6);
  resizeAreaGrid(space,shelf.id,3,6,{spacing:150,rowSpacing:24});
  placeAreaNotes(space,['seated'],shelf.id,5);
  placeAreaNotes(space,['incoming'],shelf.id,5);
  assert.deepEqual(space.notes.map(n=>n.slot),[5,11]);
});

test('opening a legacy grid keeps its pitch; choosing a new spacing moves even locked notes and survives reopening', () => {
  const lib=newLibrary(), space=workspace('first','locked','last');
  lib.spaces.personal=space;
  const shelf=area(space,100,100);
  assert.equal(shelf.grid.spacing,96);
  delete shelf.grid.spacing;
  placeAreaNotes(space,['first','locked'],shelf.id,0);
  placeAreaNotes(space,['last'],shelf.id,9999);
  Object.assign(space.notes[1],{title:'',plain:'',body:[],sealed:'encrypted content'});
  const opened=readLibrary(serializeLibrary(lib)).spaces.personal;
  assert.equal(gridSpacing(opened.areas[0].grid),184);
  assert.deepEqual([opened.notes[2].x,opened.notes[2].y],[70+99*GRID_PITCH,90+99*GRID_PITCH]);
  for (const invalid of [0,23,321,NaN,60.5,'40',null,{spacing:100,rowSpacing:0}]) {
    const before=structuredClone(opened);
    assert.equal(resizeAreaGrid(opened,shelf.id,100,100,invalid),false);
    assert.deepEqual(opened,before);
  }
  assert.equal(resizeAreaGrid(opened,shelf.id,100,100,40),true);
  assert.deepEqual(opened.notes.map(n=>[n.slot,n.x,n.y]),[[0,70,90],[1,110,90],[9999,4030,4050]]);
  assert.equal(opened.notes[1].sealed,'encrypted content');
  lib.spaces.personal=opened;
  assert.deepEqual(readLibrary(serializeLibrary(lib)).spaces.personal,opened);
  opened.areas[0].grid.spacing='invalid';
  const repaired=readLibrary(serializeLibrary(lib)).spaces.personal;
  assert.equal(repaired.notes[1].x,70+184);
  assert.equal(gridSpacing(repaired.areas[0].grid),184);
});

test('moving a locked note out restores the map placement over the old encrypted seat', async () => {
  const space=workspace('locked'), grid=area(space);
  placeAreaNotes(space,['locked'],grid.id,3);
  const record=space.notes[0], plaintext=JSON.stringify(record);
  Object.assign(record,{title:'',plain:'',sealed:'cipher'});
  placeAreaNotes(space,['locked'],null,null,[{id:'locked',x:404,y:112}]);
  const session=await openNoteSession({record,persist:async()=>{},dirty(){},
    bridge:{UnlockNote:async()=>plaintext,LockNote:async()=>{}},
    prompt:async({onSubmit})=>{await onSubmit({password:'test'});return true}});
  assert.deepEqual([session.note.title,session.note.slot,session.note.areaId,session.note.x],['locked',null,null,404]);
  assert.equal(record.sealed,'cipher');
  await session.beforeClose();
});
