import test from 'node:test';
import assert from 'node:assert/strict';
import { moveAreaGrid, placeAreaNotes, releaseGridNotes } from '../frontend/areas.js';
import { deleteNote } from '../frontend/note-deletion.js';
import { deleteAreaWithHistory, deleteMapInk, editMapInk, lastMapAction, rememberMapAction, resizeGridWithHistory, undoMapAction } from '../frontend/map-history.js';

const note = (id, areaId, x) => ({id,areaId,x,y:24,title:id,links:[]});

test('undo a track deletion after promotion into a partly full grid and a freeform ancestor', () => {
  const parent = {id:'parent',parentId:'root',grid:{rows:1,cols:2,x:-50,y:10,spacing:100}};
  const track = {id:'track',parentId:'parent',name:'Work',color:'#112233',anchor:{x:4,y:6},
    grid:{rows:2,cols:3,x:80,y:99,spacing:52,rowSpacing:28,stages:['Idea','Doing','Done']}};
  const child = {id:'child',parentId:'track'}, grandchild = {id:'nested',parentId:'child'};
  const space = {areas:[{id:'root'},parent,track,child,grandchild],
    notes:['resident','first','second','third'].map(id => note(id,null,42))};
  const [resident,first,second,third] = space.notes;
  placeAreaNotes(space,[resident.id],parent.id,1);
  placeAreaNotes(space,[first.id],track.id,5);
  placeAreaNotes(space,[second.id],track.id,2);
  placeAreaNotes(space,[third.id],track.id,1);
  second.pinned = true;
  first.links.push(second.id,third.id);
  const prior = structuredClone(space);
  assert.equal(deleteAreaWithHistory(space,track.id),track);
  assert.deepEqual(space.notes.map(n => [n.areaId,n.slot]),[['parent',1],['parent',0],['root',null],['root',null]]);
  assert.deepEqual([child.parentId,grandchild.parentId],['parent','child']);
  assert.deepEqual(first.links,[second.id,third.id]);
  second.x += 100;
  third.title = 'Renamed';
  child.name = 'Renamed folder';
  resident.links.push(third.id);
  first.pinned = true;
  const added = note('new','root',17);
  first.links.push(added.id);
  space.notes.push(added);
  assert.equal(undoMapAction(space).kind,'area-delete');
  prior.notes[0].links.push(third.id);
  prior.notes[1].pinned = true;
  prior.notes[1].links.push(added.id);
  prior.notes[3].title = third.title;
  prior.areas[3].name = child.name;
  prior.notes.push(added);
  assert.deepEqual(space,prior);
});

test('undo nested deletions and restore a previously deleted note to its original stage and row', () => {
  const folder = {id:'folder',parentId:null};
  const track = {id:'track',parentId:'folder',grid:{rows:3,cols:2,x:9,y:0,stages:['A','B']}};
  const space = {areas:[folder,track],notes:[note('gone',null,0),note('neighbor','folder',8)]};
  placeAreaNotes(space,['gone'],'track',5);
  space.notes[1].links.push('gone');
  const prior = structuredClone(space);
  deleteNote(space,'gone');
  rememberMapAction(space,{kind:'deletion',id:'gone'});
  deleteAreaWithHistory(space,'track');
  deleteAreaWithHistory(space,'folder');
  assert.equal(space.areas.length,0);
  space.notes[0].x += 10;
  for (const kind of ['area-delete','area-delete','deletion']) assert.equal(undoMapAction(space).kind,kind);
  prior.notes[1].x += 10;
  assert.deepEqual(space,prior);
});

test('undoing deletion of a freeform folder restores a promoted note’s coordinates and optional slot', () => {
  const parent = {id:'grid',grid:{rows:2,cols:2,x:2,y:4}}, folder = {id:'folder',parentId:'grid'};
  const space = {areas:[parent,folder],notes:[note('loose','folder',9)]};
  const original = structuredClone(space);
  deleteAreaWithHistory(space,'folder');
  assert.deepEqual([space.notes[0].areaId,space.notes[0].slot,space.notes[0].x],['grid',0,2]);
  assert.equal(undoMapAction(space).kind,'area-delete');
  assert.deepEqual(space,original);
});

test('deleting empty and occupied grids can be undone with an empty or full parent grid', () => {
  for (const full of [false,true]) for (const empty of [false,true]) {
    const parent = {id:'outer',grid:{x:20,y:40,cols:1,rows:1}};
    const child = {id:'inner',parentId:'outer',grid:{x:110,y:180,cols:2,rows:2}};
    const space = {areas:[parent,child],notes:[]};
    if (full) {
      space.notes.push(note('occupied',null,4));
      placeAreaNotes(space,['occupied'],'outer',0);
    }
    if (!empty) {
      space.notes.push(note('member',null,8));
      placeAreaNotes(space,['member'],'inner',3);
    }
    const prior = structuredClone(space);
    assert.equal(deleteAreaWithHistory(space,'inner'),child);
    if (!empty) assert.equal(space.notes.at(-1).areaId,full ? null : 'outer');
    assert.equal(undoMapAction(space).kind,'area-delete');
    assert.deepEqual(space,prior);
  }
});

test('a missing area creates no history and stale promoted placements or children prevent a partial restore', () => {
  for (const conflict of ['child','note','reused id','missing parent']) {
    const parent = {id:'parent'}, folder = {id:'folder',parentId:'parent'}, child = {id:'child',parentId:'folder'};
    const space = {areas:[parent,folder,child],notes:[note('a','folder',12),note('b','folder',14)]};
    assert.equal(deleteAreaWithHistory(space,'missing'),null);
    assert.equal(lastMapAction(space),undefined);
    deleteAreaWithHistory(space,'folder');
    if (conflict === 'child') child.parentId = null;
    if (conflict === 'note') space.notes[1].areaId = 'child';
    if (conflict === 'reused id') space.areas.push({id:'folder',name:'Replacement'});
    if (conflict === 'missing parent') space.areas.shift();
    const changed = structuredClone(space);
    assert.equal(undoMapAction(space),null);
    assert.deepEqual(space,changed);
  }
});

test('undo restores appearance-only changes to a plain grid', () => {
  const area={id:'grid',name:'Week',color:'#777777',grid:{x:0,y:0,rows:2,cols:3,spacing:84}};
  const space={areas:[area],notes:[]};
  const before=structuredClone(space);
  assert.ok(resizeGridWithHistory(space,area.id,2,3,84,undefined,{name:'Next week',color:'#aaaaaa'}));
  assert.equal(area.name,'Next week');
  assert.equal(undoMapAction(space).kind,'grid-size');
  assert.deepEqual(space,before);
});

test('undo a deletion then a group drop, restoring mixed folders and preserving edits and links', () => {
  const a = note('a','folder',12), b = note('b',null,32);
  const space = {areas:[{id:'folder'},{id:'grid',grid:{rows:2,cols:3,x:500,y:600}}],notes:[a,b]};
  a.links.push('b');
  const change = placeAreaNotes(space,['a','b'],'grid',2);
  rememberMapAction(space,{kind:'placement',before:change.before,after:change.after});
  deleteNote(space,'b');
  rememberMapAction(space,{kind:'deletion',id:'b'});
  a.title = 'Edited after the move';
  assert.equal(undoMapAction(space).kind,'deletion');
  assert.deepEqual([a.slot,b.slot],[2,1]);
  assert.deepEqual(a.links,['b']);
  assert.equal(undoMapAction(space).kind,'placement');
  assert.deepEqual([a.areaId,b.areaId,a.x,b.x],['folder',null,12,32]);
  assert.equal(a.title,'Edited after the move');
  assert.equal(lastMapAction(space),undefined);
});

test('an occupied former seat prevents partial group undo', () => {
  const space = {areas:[{id:'free'},{id:'grid',grid:{rows:1,cols:2,x:10,y:20}}],
    notes:[note('a',null,14),note('b',null,24),note('c',null,34)]};
  placeAreaNotes(space,['a','b'],'grid',0);
  const change = placeAreaNotes(space,['a','b'],'free');
  rememberMapAction(space,{kind:'placement',before:change.before,after:change.after});
  placeAreaNotes(space,['c'],'grid',1);
  assert.equal(undoMapAction(space),null);
  assert.deepEqual(space.notes.map(n=>[n.areaId,n.slot]),[['free',null],['free',null],['grid',1]]);
});

test('releasing a mixed selection from nested grids moves free companions and can undo all placements together', () => {
  const grid={rows:2,cols:3,x:100,y:200,spacing:60};
  const space={areas:[
    {id:'parent'}, {id:'outer',parentId:'parent',grid:{...grid}},
    {id:'inner',parentId:'outer',grid:{...grid,x:130}}, {id:'track',grid:{...grid,x:-300,stages:['A','B','C']}},
    {id:'other'}
  ],notes:[note('nested',null,12),note('top',null,24),note('loose','other',36),note('pinned','other',48)]};
  const [nested,top,loose,pinned]=space.notes;
  top.pinned=pinned.pinned=true;
  nested.links=['loose'];
  placeAreaNotes(space,[nested.id],'inner',4);
  placeAreaNotes(space,[top.id],'track',2);
  const previous=structuredClone(space.notes);
  const positions=space.notes.map(n=>({id:n.id,x:n.x+200,y:n.y-25}));
  const change=releaseGridNotes(space,positions);
  assert.equal(change.ok,true);
  assert.deepEqual(change.after.map(s=>s.id),['nested','top','loose']);
  assert.deepEqual(space.notes.map(n=>[n.areaId,n.slot??null]),[['parent',null],[null,null],['other',null],['other',null]]);
  assert.deepEqual(space.notes.map(n=>[n.x,n.y]),[[390,235],[20,175],[236,-1],[48,24]]);
  assert.equal(top.pinned,true);
  assert.deepEqual(nested.links,['loose']);
  rememberMapAction(space,{kind:'placement',before:change.before,after:change.after});
  loose.title='Edit after release';
  assert.equal(undoMapAction(space).kind,'placement');
  previous[2].title=loose.title;
  assert.deepEqual(space.notes,previous);
});

test('a stale release or an occupied former seat cannot apply only part of the move', () => {
  const space={areas:[{id:'grid',grid:{rows:1,cols:2,x:0,y:0}}],notes:['a','b','c'].map(id=>note(id,null,0))};
  placeAreaNotes(space,['a','b'],'grid');
  const seated=structuredClone(space.notes);
  const release=[{id:'a',x:105,y:300},{id:'b',x:289,y:300}];
  assert.equal(releaseGridNotes(space,[...release,{id:'gone',x:4,y:6}]).ok,false);
  assert.deepEqual(space.notes,seated);
  const {before,after}=releaseGridNotes(space,release);
  rememberMapAction(space,{kind:'placement',before,after});
  placeAreaNotes(space,['c'],'grid',1);
  const occupied=structuredClone(space.notes);
  assert.equal(undoMapAction(space),null);
  assert.deepEqual(space.notes,occupied);
});

test('undoing spacing on a legacy grid preserves edits and uses its current origin', () => {
  const grid={id:'g',grid:{rows:2,cols:3,x:4,y:10}}, a=note('a',null,0);
  const space={areas:[grid],notes:[a]};
  placeAreaNotes(space,['a'],'g',4);
  assert.equal(resizeGridWithHistory(space,'g',2,3,184),true);
  assert.equal(lastMapAction(space),undefined);
  assert.equal(resizeGridWithHistory(space,'g',2,3,64),true);
  assert.deepEqual(lastMapAction(space).reseated,[]);
  assert.deepEqual([a.x,a.y],[68,74]);
  moveAreaGrid(space,'g',120,-40);
  a.title='Edited';
  assert.equal(undoMapAction(space).kind,'grid-size');
  assert.deepEqual(grid.grid,{rows:2,cols:3,x:120,y:-40});
  assert.deepEqual([a.title,a.x,a.y,a.slot],['Edited',304,144,4]);
});

test('undo restores clipped addresses after a combined shape and spacing change, preserving a later note', () => {
  const grid={id:'g',grid:{rows:3,cols:4,x:0,y:0,spacing:120}};
  const space={areas:[grid],notes:['a','b','c','d'].map(id=>note(id,null,0))};
  for (const [id,slot] of [['a',1],['b',6],['c',11]]) placeAreaNotes(space,[id],'g',slot);
  assert.equal(resizeGridWithHistory(space,'g',2,2,40),true);
  assert.deepEqual(space.notes.slice(0,3).map(n=>n.slot),[1,0,2]);
  placeAreaNotes(space,['d'],'g',3);
  assert.equal(undoMapAction(space).kind,'grid-size');
  assert.deepEqual(space.notes.map(n=>[n.slot,n.x,n.y]),[[1,120,0],[6,240,120],[11,360,240],[5,120,120]]);
});

test('undoing an enlargement cannot discard members added after the resize', () => {
  const space={areas:[{id:'g',grid:{rows:1,cols:1,x:20,y:30,spacing:40}}],notes:[note('a',null,0),note('b',null,0)]};
  placeAreaNotes(space,['a'],'g',0);
  assert.equal(resizeGridWithHistory(space,'g',1,2,320),true);
  placeAreaNotes(space,['b'],'g',1);
  const enlarged=structuredClone(space);
  assert.equal(undoMapAction(space),null);
  assert.deepEqual(space,enlarged);
});

test('changing only row spacing preserves column centres, stage membership and the old grid representation on undo',()=>{
  const grid={id:'g',grid:{x:3,y:4,rows:4,cols:2,spacing:140,stages:['Ideas','Done']}};
  const space={areas:[grid],notes:[note('a',null,0)]};
  placeAreaNotes(space,['a'],'g',5);
  assert.ok(resizeGridWithHistory(space,'g',4,2,{spacing:140,rowSpacing:24}));
  const member=space.notes[0];
  assert.deepEqual([member.slot,member.x,member.y],[5,143,52]);
  assert.ok(resizeGridWithHistory(space,'g',4,2,{spacing:84,rowSpacing:24}));
  assert.deepEqual([member.x,member.y],[87,52]);
  assert.ok(undoMapAction(space));assert.deepEqual([member.x,member.y],[143,52]);
  assert.ok(undoMapAction(space));assert.deepEqual([member.x,member.y],[143,284]);
  assert.equal(Object.hasOwn(grid.grid,'rowSpacing'),false);
});
test('map drawing undo restores paint order and preserves concurrent strokes',()=>{
  const space={}, a={id:'a',type:'pen'}, b={id:'b',type:'rect'};
  assert.ok(editMapInk(space,'a',null,a));assert.ok(editMapInk(space,'b',null,b));
  assert.ok(editMapInk(space,'a',a,null));
  space.mapInk.push({id:'remote'});
  assert.equal(undoMapAction(space).kind,'ink');
  assert.deepEqual(space.mapInk.map(item=>item.id),['a','b','remote']);
  space.mapInk[1]={...b,glow:true};
  assert.equal(undoMapAction(space),null);
  assert.equal(space.mapInk[1].glow,true);
})

test('bulk drawing deletion has one undo and restores separate layers around surviving neighbours',()=>{
  const items=['first','a','b','between','c','last'].map(id=>({id,type:'pen'}));
  items[1].mapGroupId=items[2].mapGroupId='group';
  const space={mapInk:[...items],notes:[{id:'a'}]};
  assert.equal(deleteMapInk(space,['a','missing']),null);
  const action=deleteMapInk(space,new Set(['c','b','a']));
  assert.deepEqual(space.mapInk.map(i=>i.id),['first','between','last']);
  const updated={...items[3],stroke:'red'},remote={id:'remote'};
  space.mapInk=[updated,items[5],remote]; // A peer removed the first stroke and edited the middle one.
  assert.equal(undoMapAction(space),action);
  assert.deepEqual(space.mapInk,[items[1],items[2],updated,items[4],items[5],remote]);
  assert.deepEqual(space.notes,[{id:'a'}]);
  assert.equal(lastMapAction(space),undefined);

  deleteMapInk(space,['a','b']);
  space.mapInk.push({id:'b',type:'text',text:'Recreated remotely'});
  const before=structuredClone(space.mapInk);
  assert.equal(undoMapAction(space),null);
  assert.deepEqual(space.mapInk,before);
});
