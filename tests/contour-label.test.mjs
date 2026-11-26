import test from 'node:test';
import assert from 'node:assert/strict';
import { contourLabelPositions } from '../frontend/contour-label.js';
import { Graph } from '../frontend/graph.js';

test('area names follow the actual compressed rim and switch sides when a neighbour occupies the label', () => {
  const area={depth:0,hull:{x:0,y:0,r:60,points:[{x:60,y:0},{x:0,y:44},{x:-60,y:0},{x:0,y:-60}]}};
  const view={ox:200,oy:150,zoom:2};
  const at=other=>contourLabelPositions(area,other,view,85).next().value;
  assert.equal(at([]).y,252);
  const adjacent={hull:{x:-8,y:90,r:40}};
  assert.equal(at([area,adjacent]).y,16);
  assert.equal(at([{gridBounds:{left:-90,top:49,right:90,bottom:70}}]).y,16);
});

test('moving a note reuses its measured title and renaming it refreshes the displayed text', () => {
  const measured=[], painted=[];
  const ctx={measureText(text){measured.push(text);return {width:92}},strokeText(){},fillText(text){painted.push(text)}};
  const graph={ctx,width:600,height:400,areaFamilies:[]}, note={};
  const draw=(text,x)=>Graph.prototype.drawLabels.call(graph,[{text,note,x,y:80,rank:1}],new Map(),{});
  const short='🌒'.repeat(28),long=short+'x'.repeat(8000);
  draw(short,100);draw(short,120);draw(long,120);draw('Renamed',120);
  assert.deepEqual(measured,[short,'🌒'.repeat(27)+'…','Renamed']);
  assert.deepEqual(painted,[short,short,'🌒'.repeat(27)+'…','Renamed']);
});

test('sealed notes on the map measure and paint their title only while it is revealed',()=>{
  const measured=[],painted=[],dots=[];
  const ctx={measureText(text){measured.push(text);return {width:80}},strokeText(){},fillText(text){painted.push(text)},
    fillRect(...args){dots.push(args)},save(){},restore(){}};
  const graph=Object.assign(Object.create(Graph.prototype),{
    ctx,canvas:{},width:600,height:400,areaFamilies:[],nodes:new Map(),groups:[],selectedIds:new Set(),
    heating:new Set(),callbacks:{},repaint(){}
  });
  const note={id:'sealed',title:'Private canonical title',mapLabel:'Public legacy alias',sealed:'vault-envelope'};
  const draw=()=>{
    const node=graph.nodes.get(note.id);
    graph.drawLabels([{text:node.title,note:node,x:100,y:80,rank:1}],new Map(),{});
  };
  graph.setData([note],[]);
  assert.notEqual(graph.nodes.get(note.id).title,note.title);
  assert.notEqual(graph.nodes.get(note.id).title,note.mapLabel);
  draw();
  const texture=dots.slice();
  assert.ok(texture.length>0);
  assert.deepEqual(measured,[]);
  assert.deepEqual(painted,[]);

  graph.callbacks.concealsTitle=()=>false;
  graph.setData([note],[]);
  draw();
  assert.deepEqual(painted,[note.title]);

  graph.callbacks.concealsTitle=()=>true;
  graph.setData([{...note,title:'A completely different length'}],[]);
  draw();
  assert.deepEqual(dots,[...texture,...texture]);
  assert.deepEqual(measured,[note.title]);
  assert.deepEqual(painted,[note.title]);
});
