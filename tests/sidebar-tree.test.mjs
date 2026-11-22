import assert from 'node:assert/strict';
import test from 'node:test';
import { sidebarRows } from '../frontend/sidebar-tree.js';

const describe=n=>({title:n.sealed?'Locked note':n.title});
test('sidebar places each note inside its folder and keeps unassigned and orphan notes at root',()=>{
  const areas=[{id:'leaf',parentId:'folder',name:'Leaf'},{id:'folder',name:'Folder'},{id:'next',name:'Next'}];
  const notes=[
    {id:'untitled'},{id:'orphan',areaId:'absent'},{id:'child',areaId:'leaf',sealed:true,title:'secret'},
    {id:'direct',areaId:'folder',type:'data',dataText:'private data'}
  ];
  const rows=sidebarRows(areas,notes,new Set(),describe);
  assert.deepEqual(rows.map(r=>[r.id,r.parentId,r.depth]),[
    ['folder',null,0],['leaf','folder',1],['child','leaf',2],['direct','folder',1],
    ['next',null,0],['untitled',null,0],['orphan',null,0]
  ]);
  assert.equal(rows.find(r=>r.id==='child').title,'Locked note');
  assert.ok(!JSON.stringify(rows).includes('secret') && !JSON.stringify(rows).includes('private data'));
  assert.ok(rows[0].expanded && rows[1].expanded && !rows[4].branch);
});

test('folding a large branch skips its descendants, reopening shows their current membership',()=>{
  const areas=[{id:'root',name:'Root'},{id:'nested',name:'Nested',parentId:'root'},{id:'dest',name:'Destination'}];
  const notes=Array.from({length:6144},(_,i)=>({id:String(i),areaId:'nested'}));
  const closed=new Set(['root']);
  assert.deepEqual(sidebarRows(areas,notes,closed,()=>assert.fail('closed branch rendered a note')).map(r=>r.id),['root','dest']);
  notes[100].areaId='dest';
  const hidden=sidebarRows(areas,notes,closed,describe);
  assert.deepEqual(hidden.map(r=>r.id),['root','dest','100']);
  const open=sidebarRows(areas,notes,new Set(),describe);
  assert.equal(open.length,6147);
  assert.deepEqual(open.slice(-2).map(r=>r.id),['dest','100']);
});
