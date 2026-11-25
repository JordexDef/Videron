import assert from 'node:assert/strict';
import test from 'node:test';
import {canvasFindRecords, replaceCanvasMatches} from '../frontend/canvas-note-find.js';

test('canvas search reads visible document fields and formula sources, including legacy numeric cells', () => {
  const items = [
    {id:'shape',type:'rect',label:'Label',href:'private destination',locked:true},
    {id:'plain',type:'text',text:'Plain'},
    {id:'file',type:'text',folderPath:'/private/path',text:'Folder'},
    {id:'picture',type:'image',src:'private payload'},
    {id:'empty',type:'table'},
    {id:'rich',type:'text',body:[{type:'paragraph',runs:[{text:'Visible',href:'private URL'}]},
      {type:'credentials',entries:[{password:'private password'}]},{type:'code',text:'A\r\nB'}]},
    {id:'sheet',type:'table',rows:2,cols:2,cells:{A1:'=B2*2',B2:17,C4:'outside',custom:'property'}}
  ];
  const records = canvasFindRecords(items);
  assert.deepEqual(records.map(r => r.text),['Label','Plain','Visible','A\nB','=B2*2','17']);
  assert.deepEqual(records.filter(r => r.readOnly).map(r => r.text),['Label']);
});

test('canvas replacement preserves formatting, immovable objects, private blocks and table contents', () => {
  const asset = {id:'image',type:'image',src:'payload'};
  const secret = {type:'credentials',entries:[{password:'confidential'}]};
  const body = [{type:'paragraph',runs:[{text:'sea',bold:true},{text:'rch',italic:true}]},secret];
  const items = [asset,{id:'rich',type:'text',body,w:230,h:110,x:12,y:50,angle:.15},
    {id:'label/1',type:'ellipse',label:'search',locked:true},
    {id:'table',type:'table',cells:{A1:12,B1:'value'}},{id:'old',type:'table'}];
  const changes = canvasFindRecords(items).map(r=>({id:r.id,from:0,to:r.text.length,text:r.text==='value'?'':'ok'}));
  const result = replaceCanvasMatches(items,changes);
  assert.deepEqual(result[1],{...items[1],body:[{type:'paragraph',runs:[{text:'ok',bold:true}]},secret],text:'ok'});
  assert.equal(result[1].body[1],secret);
  assert.deepEqual(result[3].cells,{A1:'ok'});
  assert.equal(result[0],asset);
  assert.equal(result[2],items[2]);
  assert.equal(result[4],items[4]);
  assert.deepEqual(items[3].cells,{A1:12,B1:'value'});
  assert.equal(replaceCanvasMatches(items,[]),items);
});
