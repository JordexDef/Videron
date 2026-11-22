import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkspace } from '../frontend/extensions.js';

test('extensions can identify a data note without reading its document', () => {
  const note = {id:'raw',type:'data',title:'Log',dataLanguage:'json',
    get dataText(){throw new Error('Extension projection read the full data document')}};
  const [projected] = projectWorkspace({areas:[],notes:[note]}).notes;
  assert.equal(projected.type,'data');
  assert.ok(!Object.hasOwn(projected,'dataText'));
});

test('extensions receive only public note metadata and links to unprotected notes', () => {
  const original = {
    id:'one', title:'First', type:'canvas', appearance:{shape:'square', color:'#ABCDEF'},
    areaId:'shelf', tags:['#One', 'one', ''], links:['sealed-id', 'two', 'two'],
    x:11, y:22, weight:5, opens:3, pinned:true,
    get body() { throw new Error('Extension projection read a note body'); },
    plain:'private body'
  };
  const space = {
    areas:[{id:'shelf', name:'Shelf', color:'#888888', other:'private area data'}],
    notes:[original, {id:'sealed-id', sealed:'private envelope'}, {id:'two', title:'Second'}]
  };
  const data = projectWorkspace(space);
  assert.equal(data.type, 'videron:data');
  assert.equal(data.apiVersion, 1);
  assert.deepEqual(data.notes.map(n => n.id), ['one','two']);
  assert.deepEqual(data.notes[0], {
    id:'one', title:'First', type:'canvas', appearance:{shape:'square', icon:null, color:'#abcdef'},
    areaId:'shelf', tags:['one'], links:['two'], x:11, y:22, weight:5, opens:3, pinned:true
  });
  assert.deepEqual(data.areas, [{id:'shelf', name:'Shelf', color:'#888888', parentId:null}]);
  assert.deepEqual(original.links, ['sealed-id', 'two', 'two']);
  assert.doesNotMatch(JSON.stringify(data), /private|sealed-id/);
});
