import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMapItems, ungroupMapItems, moveMapGroup, undoMapAction, lastMapAction } from '../frontend/map-history.js';
import { placeAreaNotes } from '../frontend/areas.js';
import { WorkspaceRecords } from '../frontend/workspace-records.js';

function mapGroupMembers(space,id) {
  const memberIds = rows => rows.filter(row => row.mapGroupId === id).map(row => row.id);
  return {noteIds:memberIds(space.notes),inkIds:memberIds(space.mapInk)};
}

const fixture = () => ({areas:[], notes:[{id:'note',x:30,y:40,pinned:true,sealed:'ciphertext',links:['other']},
  {id:'other',x:500,y:600}], mapInk:[{id:'frame',type:'rect',x:10,y:20,w:60,h:100},
  {id:'caption',type:'text',x:15,y:95,text:'Label'}]});

test('a mixed group moves with one delta, persists across reload, and undoes as a unit without touching content',() => {
  const space = fixture(), [note,other] = space.notes;
  const action = groupMapItems(space,['note'],['frame','caption']);
  const saved = JSON.parse(JSON.stringify(space)), records = new WorkspaceRecords(saved);
  assert.deepEqual(mapGroupMembers(saved,action.groupId),{noteIds:['note'],inkIds:['frame','caption']});
  assert.deepEqual(moveMapGroup(saved,action.groupId,0,0),null);
  assert.ok(moveMapGroup(saved,action.groupId,-45,15));
  assert.deepEqual(saved.mapInk.map(({x,y})=>[x,y]),[[-35,35],[-30,110]]);
  assert.deepEqual(saved.notes[0],{...note,x:-15,y:55});
  assert.deepEqual(saved.notes[1],other);
  records.mark({notes:[saved.notes[0]],mapInk:saved.mapInk});
  assert.deepEqual(JSON.parse(JSON.stringify(records.prepare(saved).patch)),{
    notes:{edit:[{id:'note',set:{x:-15,y:55}}]},
    mapInk:{edit:[{id:'frame',set:{x:-35,y:35}},{id:'caption',set:{x:-30,y:110}}]}});
  saved.notes[0].sealed='updated'; saved.mapInk.reverse();
  saved.mapInk[0].text='New caption';
  assert.equal(undoMapAction(saved).kind,'map-group-move');
  assert.deepEqual(saved.notes[0],{...note,sealed:'updated'});
  assert.deepEqual(saved.mapInk[0],{...space.mapInk[1],text:'New caption'});
  assert.equal(lastMapAction(saved),undefined);
});

test('regroup expands touched groups; undo restores membership, and undoing ungroup restores positions after free drift',() => {
  const space=fixture();
  const g = groupMapItems(space,['note'],['frame']);
  assert.equal(groupMapItems(space,['note'],['frame']),null);
  const h = groupMapItems(space,[],['frame','caption']);
  assert.deepEqual(mapGroupMembers(space,h.groupId),{noteIds:['note'],inkIds:['frame','caption']});
  assert.ok(ungroupMapItems(space,h.groupId));
  space.notes[0].x=501;
  assert.equal(undoMapAction(space).kind,'map-ungroup');
  assert.equal(space.notes[0].x,30);
  assert.equal(undoMapAction(space).kind,'map-group');
  assert.deepEqual(mapGroupMembers(space,g.groupId),{noteIds:['note'],inkIds:['frame']});
  assert.equal(undoMapAction(space).kind,'map-group');
  assert.deepEqual(space,fixture());
});

test('grouping frees occupied grid seats and grouping undo atomically restores their current grid positions',() => {
  for (const occupied of [false,true]) {
    const space=fixture();
    const grid={id:'grid',parentId:'root',grid:{rows:2,cols:2,x:100,y:200,spacing:64}};
    space.areas.push({id:'root'},grid); placeAreaNotes(space,['note'],grid.id,1);
    const action=groupMapItems(space,['note'],['frame']);
    const note=space.notes[0];
    assert.deepEqual([note.areaId,note.slot,note.x,note.y],['root',null,164,200]);
    if (occupied) placeAreaNotes(space,['other'],grid.id,1);
    else grid.grid.x=120;
    if (occupied) {
      const before=structuredClone(space);
      assert.equal(undoMapAction(space),null); assert.deepEqual(space,before);
    } else {
      assert.equal(undoMapAction(space),action);
      assert.deepEqual([note.areaId,note.slot,note.x,note.y],['grid',1,184,200]);
    }
  }
});

test('grid assignment from the sidebar after grouping releases and restores the seat in the same drag action',() => {
  const space=fixture(), group=groupMapItems(space,['note'],['frame']);
  space.areas.push({id:'grid',grid:{rows:2,cols:2,x:10,y:20,spacing:80}});
  placeAreaNotes(space,['note'],'grid',2);
  const before=structuredClone(space);
  assert.ok(moveMapGroup(space,group.groupId,15,20));
  assert.deepEqual([space.notes[0].x,space.notes[0].y,space.notes[0].slot],[25,120,null]);
  assert.ok(undoMapAction(space));
  assert.deepEqual(space,before);
});

test('missing members, invalid moves and concurrent relocations cannot partially change a collection',() => {
  const space=fixture();
  assert.equal(groupMapItems(space,['gone'],['frame','caption']),null);
  assert.equal(groupMapItems(space,['note'],[]),null);
  assert.equal(lastMapAction(space),undefined);
  const group=groupMapItems(space,['note'],['frame','caption'],[{id:'note',x:29,y:-33}]);
  assert.deepEqual([space.notes[0].x,space.notes[0].y],[29,-33]);
  assert.equal(moveMapGroup(space,group.groupId,Infinity,10),null);
  assert.ok(moveMapGroup(space,group.groupId,17,5));
  space.mapInk[1].x+=20;
  const before=structuredClone(space);
  assert.equal(undoMapAction(space),null);
  assert.deepEqual(space,before);
});
