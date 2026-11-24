import test from 'node:test';
import assert from 'node:assert/strict';
import { paintNoteBody } from '../frontend/map-note-paint.js';
import { darkMap, lightMap } from '../frontend/map-palette.js';
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

test('cached nodes retain their custom colour and a visible outline when themes change', () => {
  const {ctx,bodies,strokes}=canvasProbe();
  const node={tint:'255,248,235',heat:.5,customColor:true};
  const paint=palette=>paintNoteBody(ctx,node,40,40,10,false,false,1,false,palette);
  paint(darkMap);paint(lightMap);paint(darkMap);
  assert.deepEqual([bodies[2],strokes[2]],[bodies[0],strokes[0]]);
  assert.notEqual(bodies[1],bodies[0]);
  const [red,green,blue]=strokes[1].match(/\d+/g).map(Number);
  assert.ok(red < 130 && red >= green && green > blue, 'the pastel rim keeps its hue on white');
  assert.equal(node.tint,'255,248,235');
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

test('free layout suppresses both manual and shared-tag lines while preserving the route overlay',()=>{
  const {ctx,strokes}=canvasProbe();
  const node=(id,x,y)=>({id,x,y,r:8,heat:0,tint:'120,120,120'});
  const a=node('a',-80,-500),b=node('b',80,500),c=node('c',-90,500);
  const graph=Object.assign(Object.create(Graph.prototype),{
    ctx,width:200,height:200,dpr:1,camera:{x:0,y:0,zoom:1},nodes:new Map([a,b,c].map(n=>[n.id,n])),
    selectedIds:new Set(['a']),view:{labels:false,links:true,manualLayout:true},groups:[],
    edges:[{a,b,manual:true},{a,b:c,manual:false}],callbacks:{onDrawRoute(){strokes.push('route')}},
    drawLabels(){},measureGroups(){}
  });
  graph.draw();
  assert.deepEqual(strokes,['route','route']);
  graph.view.manualLayout=false;
  strokes.length=0;graph.draw();
  assert.deepEqual(strokes,['rgba(237,237,237,.66)','rgba(237,237,237,.66)','route','route']);
});

test('manual linking previews only a new link between the chosen source and hovered note',()=>{
  const {ctx}=canvasProbe();
  let dashed=false,preview,start;
  Object.assign(ctx,{
    save(){},setLineDash(){dashed=true},restore(){dashed=false},
    moveTo(x,y){start=[x,y]},lineTo(x,y){if(dashed)preview=[start,[x,y]]}
  });
  const graph=Object.assign(Object.create(Graph.prototype),{
    ctx,canvas:{style:{}},width:200,height:200,dpr:1,camera:{x:0,y:0,zoom:1},contacts:new Map(),
    nodes:new Map(),selectedIds:new Set(),heating:new Set(),callbacks:{},view:{links:true},repaint(){},
    drawLabels(){}
  });
  const notes=[{id:'a',x:-50,y:0,tags:['project']},{id:'b',x:50,y:0,tags:['project']}];
  graph.setData(notes,[]);
  const draw=()=>{preview=null;graph.draw();return preview};
  graph.hover='b';
  graph.setLinkMode(true);
  assert.equal(draw(),null);
  graph.setLinkMode(true,'a');
  assert.deepEqual(draw(),[[50,100],[150,100]],'a shared tag still permits a manual link');
  for(const hover of [null,'a']){
    graph.hover=hover;assert.equal(draw(),null);
  }
  graph.hover='b';
  graph.nodes.get('b').links.push('a');
  assert.equal(draw(),null,'a manual link stored on either endpoint already exists');
  graph.nodes.get('b').links=[];
  graph.view.links=false;assert.equal(draw(),null);
  graph.view.links=true;graph.view.manualLayout=true;assert.equal(draw(),null);
  graph.view.manualLayout=false;graph.setLinkMode(false);assert.equal(draw(),null);
  graph.setLinkMode(true,'a');graph.setData(notes.slice(1),[]);
  assert.equal(graph.linkSource,null,'a removed first note can be picked again');
  assert.equal(draw(),null);
});
