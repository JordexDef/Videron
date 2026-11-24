import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWorkspace } from '../frontend/workspace-merge.js';

const note=(id,title=id)=>({id,title,body:[],tags:[],links:[],x:0,y:0,opens:0,modified:1});
const workspace=(...notes)=>({name:'space',notes,areas:[]});
const copies=base=>[structuredClone(base),structuredClone(base)];

test('independent notes, new notes, deletes and future fields survive without mutating sources',()=>{
  const base=workspace(note('one'),note('two'),note('old')), [local,remote]=copies(base);
  local.notes[0].title='local';local.notes.pop();remote.notes[1].future={body:'remote'};
  remote.notes.push(note('new'));remote.futureSetting={enabled:true};
  const merged=mergeWorkspace(base,local,remote);
  assert.deepEqual(merged.conflicts,[]);
  assert.deepEqual(merged.data.notes.map(n=>[n.id,n.title]),[['one','local'],['two','two'],['new','new']]);
  merged.data.notes[1].future.body='independent';
  assert.equal(remote.notes[1].future.body,'remote');
  assert.deepEqual(merged.data.futureSetting,{enabled:true});
});

test('different changes to the same document need a choice and keep its version intact',()=>{
  const base=workspace(note('n')), [local,remote]=copies(base);
  local.notes[0].body=[{type:'code',source:'aaa'}];remote.notes[0].title='other';
  const {conflicts}=mergeWorkspace(base,local,remote);
  assert.deepEqual(conflicts,[{key:'note:n',kind:'note',id:'n',base:base.notes[0],local:local.notes[0],remote:remote.notes[0]}]);
  const chosen=mergeWorkspace(base,local,remote,{'note:n':'remote'});
  assert.deepEqual(chosen,{data:remote,conflicts:[]});
  assert.deepEqual(mergeWorkspace(base,local,local),{data:local,conflicts:[]});
});

test('opaque note payloads conflict, while passive views and drift merge with real edits',()=>{
  const base=workspace({...note('n',''),sealed:'first'}),[local,remote]=copies(base);
  local.notes[0].opens=8;local.notes[0].x=20;remote.notes[0].sealed='second';
  local.notes[0].appearance={shape:'hexagon',icon:'lucide/bookmark',color:'#a9c6ed'};
  let result=mergeWorkspace(base,local,remote);
  assert.deepEqual(result.conflicts,[]);assert.deepEqual(result.data.notes[0],{...local.notes[0],sealed:'second'});
  local.notes[0].sealed='third';
  result=mergeWorkspace(base,local,remote);
  assert.equal(result.conflicts[0].remote.sealed,'second');
});

test('edited versus deleted shows both versions and restoring also repairs incoming links',()=>{
  const base=workspace(note('a'),note('b'));base.notes[0].links=['b'];
  const [local,remote]=copies(base);local.notes.pop();local.notes[0].links=[];remote.notes[1].title='keep';
  assert.equal(mergeWorkspace(base,local,remote).conflicts[0].local,null);
  assert.deepEqual(mergeWorkspace(base,local,remote,{'note:b':'remote'}).data,remote);
  assert.deepEqual(mergeWorkspace(base,local,remote,{'note:b':'local'}).data,local);
  remote.notes[1].title='b';remote.notes[1].x=99;remote.notes[1].opens++;
  assert.deepEqual(mergeWorkspace(base,local,remote),{data:local,conflicts:[]});
});

test('area properties, routes, settings and note links merge independently',()=>{
  const base=workspace(note('n'),note('m'),note('z'));
  base.areas=[{id:'f',parentId:null,name:'old',color:'#abcdef'}];
  base.routes=[{id:'r',name:'one',stops:[]}];
  const [local,remote]=copies(base);
  local.areas[0].name='new';remote.areas[0].color='#123456';
  local.routes[0].name='two';remote.routes[0].stops=[{noteId:'n'}];
  local.notes[0].links=['m'];remote.notes[0].links=['z'];
  local.name='local name';remote.name='remote name';
  const result=mergeWorkspace(base,local,remote);
  assert.deepEqual(result.conflicts.map(c=>c.key),['setting:name']);
  assert.deepEqual(result.data.areas,[{...local.areas[0],color:'#123456'}]);
  assert.deepEqual(result.data.routes,[{...remote.routes[0],name:'two'}]);
  assert.deepEqual(result.data.notes[0].links,['m','z']);
});

test('two peers independently merge parallel insertions in the same order',()=>{
  const base=workspace(note('first')),[left,right]=copies(base);
  left.notes.push(note('z'));right.notes.push(note('a'));
  left.notes[0].links.push('z');right.notes[0].links.push('a');
  assert.deepEqual(mergeWorkspace(base,left,right),mergeWorkspace(base,right,left));
});

test('restoring targets from opposite peers repairs only incoming links the survivor still wanted',()=>{
  const base=workspace(note('hub'),note('other'),note('a'),note('b'),note('gone'));
  base.notes[0].links=['a','b','gone','unknown'];
  base.notes[1].links=['a','b'];
  const [local,remote]=copies(base);
  local.notes=local.notes.filter(n=>n.id!=='a' && n.id!=='gone');
  remote.notes=remote.notes.filter(n=>n.id!=='b' && n.id!=='gone');
  local.notes[0].links=['b','unknown'];
  remote.notes[0].links=['a','unknown'];
  local.notes[1].links=[]; // An explicit unlink of b in the version that kept b.
  remote.notes[1].links=['a'];
  local.notes.at(-1).title='keep b';
  remote.notes.at(-1).title='keep a';
  const result=mergeWorkspace(base,local,remote,{'note:a':'remote','note:b':'local'});
  assert.deepEqual(result.conflicts,[]);
  assert.deepEqual(result.data.notes[0].links,['unknown','a','b']);
  assert.deepEqual(result.data.notes[1].links,['a']);
});
