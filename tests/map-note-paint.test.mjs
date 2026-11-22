import test from 'node:test';
import assert from 'node:assert/strict';
import { paintNoteBody } from '../frontend/map-note-paint.js';
import { Graph } from '../frontend/graph.js';

function canvasProbe() {
  const glows=[],halos=[],bodies=[],strokes=[];
  const ctx={
    globalAlpha:.8, setTransform(){},beginPath(){},arc(){},moveTo(){},lineTo(){},
    createRadialGradient(...coordinates){glows.push(coordinates);return {addColorStop(){}}},
    fillRect(){halos.push(this.globalAlpha)},fill(){bodies.push(this.fillStyle)},stroke(){strokes.push(this.strokeStyle)}
  };
  return {ctx,glows,halos,bodies,strokes};
}

test('overview keeps heat in small shapes and gradually reveals their reusable halo', () => {
  const {ctx,glows,halos,bodies,strokes}=canvasProbe();
  const n={tint:'185,189,194',heat:.8};
  const draw=(r,selected=false)=>paintNoteBody(ctx,n,50,40,r,selected,false,2,true);
  draw(5);draw(5.5);
  assert.equal(glows.length,0);
  draw(7);draw(9);draw(10,true);
  assert.equal(glows.length,1);
  assert.deepEqual(halos,[.4,.8,.8]);
  assert.equal(ctx.globalAlpha,.8);
  assert.equal(bodies[2],bodies[3]);
  assert.notEqual(bodies[3],bodies[4]);
  assert.equal(strokes[4],'#ededed');
  const old=bodies.at(-1);
  n.tint='200,150,120';n.heat=.3;draw(9,true);
  assert.notEqual(bodies.at(-1),old);
  assert.equal(glows.length,2);
});

test('diagonal link culling keeps a crossing even when both endpoint notes are off screen', () => {
  const {ctx,strokes}=canvasProbe();
  const node=(x,y,id)=>({x,y,id,r:8,heat:0,tint:'120,120,120'});
  const a=node(-150,-250,'a'), b=node(160,190,'b');
  const c=node(-240,-10,'c'), d=node(10,-220,'d');
  const graph=Object.assign(Object.create(Graph.prototype),{
    ctx,width:200,height:200,dpr:1,camera:{x:0,y:0,zoom:1},
    selectedIds:new Set(['a']), view:{labels:false,links:true,grid:false}, groups:[],
    nodes:new Map([a,b,c,d].map(n=>[n.id,n])),edges:[{a,b,manual:true},{a:c,b:d,manual:true}],
    callbacks:{},drawLabels(){},measureGroups(){}
  });
  graph.draw();
  assert.deepEqual(strokes,['rgba(237,237,237,.66)']);
});

test('wide group drag keeps the grabbed caption and restores all selected captions on release', () => {
  const {ctx,strokes}=canvasProbe();
  const node=(id,x)=>({id,title:id,x,y:0,r:8,heat:0,tint:'120,120,120'});
  const a=node('a',-70), b=node('b',0), c=node('c',70);
  let captions;
  const graph=Object.assign(Object.create(Graph.prototype),{
    ctx,width:200,height:200,dpr:1,camera:{x:0,y:0,zoom:.4},
    selectedIds:new Set(['a','b']), view:{labels:true,links:true,grid:false}, groups:[],
    nodes:new Map([a,b,c].map(n=>[n.id,n])), edges:[{a,b,manual:true},{a:b,b:c,manual:true}],
    callbacks:{},drawLabels(labels){captions=labels.map(label=>label.text)},measureGroups(){},
    drag:{node:a,noteIds:['a','b'],moved:true}
  });
  graph.draw();
  assert.deepEqual(captions,['a']);
  assert.equal(strokes.filter(s=>s==='rgba(237,237,237,.66)').length,1);
  assert.equal(strokes.filter(s=>s==='rgba(237,237,237,.25)').length,2);
  graph.drag=null;
  strokes.length=0;
  graph.draw();
  assert.deepEqual(captions,['a','b']);
  assert.equal(strokes.filter(s=>s==='rgba(237,237,237,.66)').length,2);
});
