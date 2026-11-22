import assert from 'node:assert/strict';
import test from 'node:test';
import { Graph } from '../frontend/graph.js';
import { intersectsNote, selectionRect } from '../frontend/map-selection.js';
import { geometryFor } from '../frontend/icons/node-art.js';

test('a selection box meets the visible bubble, in either drag direction', () => {
  const touch = selectionRect({x:13,y:7},{x:7,y:-1});
  const corner = selectionRect({x:13,y:13},{x:8,y:8});
  for (const shape of ['circle','diamond','square','triangle']) {
    const node = {x:0,y:0,r:10,geometry:geometryFor(shape)};
    assert.equal(intersectsNote(corner,node),false,shape);
    assert.equal(intersectsNote(selectionRect({x:1,y:1},{x:-1,y:-1}),node),true,shape);
  }
  assert.equal(intersectsNote(touch,{x:0,y:0,r:10,geometry:geometryFor('square')}),true);
  assert.equal(intersectsNote(selectionRect({x:8,y:0},{x:9,y:1}),{x:0,y:0,r:10,geometry:geometryFor('square')}),false);
});

test('each nested map ring encloses its child even when all notes are in one leaf', () => {
  const graph = Object.assign(Object.create(Graph.prototype), {
    nodes:new Map(), selectedIds:new Set(),heating:new Set(),callbacks:{},repaint(){}
  });
  const areas = [{id:'leaf',name:'Leaf',parentId:'middle',color:'#121212'},
    {id:'root',name:'Root',color:'#b0b0b0'},{id:'middle',name:'Middle',parentId:'root',color:'#f0f0f0'}];
  const notes = [{id:'a',x:-30,y:-12,areaId:'leaf'},{id:'b',x:80,y:15,areaId:'leaf'}];
  graph.setData(notes,areas);
  graph.measureGroups();
  assert.deepEqual(graph.groups.map(g => [g.id,g.count,g.nodes.length]),[['root',2,0],['middle',2,0],['leaf',2,2]]);
  const [outer,inner,leaf] = graph.groups.map(g => g.hull);
  assert.ok(outer.r > inner.r && inner.r > leaf.r);
  assert.equal(outer.x,leaf.x);
  assert.equal(graph.nodes.get('a').tint,'18,18,18');
  graph.select('a');
  graph.changeSelection(new Set(['a','b']));
  graph.setData(notes.slice(1),areas);
  assert.deepEqual([...graph.selectedIds],['b']);
});

function dragMap() {
  const saved = [], drops = [], hovered = [], ended = [];
  const captured = new Set();
  const graph = Object.assign(Object.create(Graph.prototype), {
    canvas:{
      style:{}, focus(){}, getBoundingClientRect:()=>({left:200,top:60}),
      setPointerCapture:id=>captured.add(id), hasPointerCapture:id=>captured.has(id),
      releasePointerCapture:id=>captured.delete(id)
    },
    width:500,height:360,camera:{x:0,y:0,zoom:1},contacts:new Map(),
    nodes:new Map(),selectedIds:new Set(),heating:new Set(),tool:'select',
    repaint(){},callbacks:{
      onMove(changes){saved.push(...changes)},
      onNoteDragMove(ids,x){hovered.push(ids);return x<200},
      onNoteDrop(ids){drops.push({ids,x:graph.nodes.get('a').x})},
      onNoteDragEnd(){ended.push(true)}
    }
  });
  graph.setData([{id:'a',x:-40,y:-20},{id:'b',x:50,y:-20,pinned:true},{id:'c',x:100,y:10}],[]);
  graph.changeSelection(new Set(['a','b']));
  const point=(x,y=220,id=1)=>({clientX:x,clientY:y,pointerId:id,button:0,pointerType:'mouse',preventDefault(){}});
  return {graph,point,saved,drops,hovered,ended,captured};
}

test('dragging a group onto the sidebar keeps the pre-drag layout, including neighbours and pinned notes', () => {
  const {graph,point,saved,drops,hovered,ended}=dragMap();
  graph.pointerDown(point(410));
  graph.pointerMove(point(450));
  assert.equal(graph.nodes.get('a').x,0);
  graph.nodes.get('c').x+=8; // A collision while the group crosses the canvas.
  graph.flushPositions();
  assert.deepEqual(saved,[]);
  graph.pointerMove(point(160));
  assert.equal(graph.nodes.get('a').x,-40);
  assert.equal(graph.nodes.get('c').x,100);
  graph.pointerUp(point(160));
  assert.deepEqual(drops,[{ids:['a','b'],x:-40}]);
  assert.ok(hovered.every(ids=>ids===hovered[0]));
  assert.deepEqual(saved,[]);
  assert.equal(ended.length,1);
});

test('returning from a folder to the map commits only the final map displacement', () => {
  const {graph,point,saved,drops}=dragMap();
  graph.pointerDown(point(410));
  graph.pointerMove(point(430));
  graph.pointerMove(point(155));
  graph.pointerMove(point(465));
  graph.pointerUp(point(468));
  assert.deepEqual(drops,[]);
  assert.deepEqual(saved,[{id:'a',x:18,y:-20}]);
  assert.equal(graph.nodes.get('b').x,50);
});

test('a pinned source can transfer the selection and cancellation clears the gesture and capture', () => {
  const {graph,point,drops,saved,ended,captured}=dragMap();
  graph.pointerDown(point(500));
  graph.pointerMove(point(160));
  graph.cancelDrag();
  graph.pointerUp(point(160));
  assert.equal(captured.size,0);
  assert.equal(ended.length,1);
  assert.deepEqual(drops,[]);
  graph.pointerDown(point(500));
  // A coalesced pointer stream may report the destination only at release.
  graph.pointerUp(point(160));
  assert.deepEqual(drops,[{ids:['a','b'],x:-40}]);
  assert.deepEqual(saved,[]);
});

test('a burst of drag samples uses the latest point per paint and the actual release position', () => {
  const {graph,point,saved,hovered}=dragMap();
  graph.draw=()=>{};
  graph.accumulator=0;
  graph.pointerDown(point(410));
  graph.queuePointerMove(point(415));
  for (let x=416;x<=480;x++) graph.queuePointerMove(point(x));
  assert.equal(hovered.length,1);
  graph.tick(1_000);
  assert.equal(hovered.length,2);
  assert.equal(graph.nodes.get('a').x,30);
  graph.queuePointerMove(point(155)); // Unpainted sample over the sidebar.
  graph.pointerUp(point(482));
  graph.flushPointerMove();
  assert.equal(hovered.length,3);
  assert.ok(saved.some(p=>p.id==='a' && p.x===32));
});

test('a grab interrupts camera flight and keeps its material point under the cursor through zoom and pan', () => {
  const {graph,point}=dragMap();
  graph.draw=()=>{};graph.remaining=0;graph.accumulator=0;
  graph.target={x:70,y:30,zoom:1.5};
  graph.tick(100);
  const node=graph.nodes.get('a');
  const offset={x:4,y:-3}; // Grab just off centre while the camera is still travelling.
  const start=point(450+(node.x+offset.x-graph.camera.x)*graph.zoom,
    240+(node.y+offset.y-graph.camera.y)*graph.zoom);
  graph.pointerDown(start);
  assert.equal(graph.target,null);
  const move=point(start.clientX+45,start.clientY+12);
  graph.queuePointerMove(move);
  graph.fit(); // F during a drag.
  assert.equal(graph.target,null);
  const last=point(move.clientX+12,move.clientY+3);
  graph.queuePointerMove(last);
  const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7);
  for (const shiftKey of [false,true]) {
    graph.wheel({...last,shiftKey,deltaMode:0,deltaX:0,deltaY:-90});
    const hand=graph.world(graph.local(last));
    near(node.x+offset.x,hand.x);
    near(node.y+offset.y,hand.y);
  }
  const expected={x:node.x,y:node.y};
  graph.pointerUp(last);
  near(node.x,expected.x);near(node.y,expected.y);
});

test('a moving note stays caught at the same point before the drag threshold', () => {
  const {graph,point}=dragMap(), node=graph.nodes.get('a');
  node.vx=12;
  graph.pointerDown(point(413)); // Three units to the right of the bubble centre.
  graph.step();
  assert.equal(node.x,-40);
  graph.wheel({...point(413),shiftKey:true,deltaMode:0,deltaX:20,deltaY:0});
  graph.queuePointerMove(point(421));
  assert.equal(node.x+3,graph.world(graph.local(point(421))).x);
  graph.cancelDrag();
});

test('cancelling a burst or switching to pinch cannot replay an old drag sample', () => {
  for (const pinch of [false,true]) {
    const {graph,point,saved,hovered}=dragMap();
    graph.pointerDown(point(410));
    graph.queuePointerMove(point(415));
    graph.queuePointerMove(point(460));
    if (pinch) graph.pointerDown(point(500,260,2));
    else graph.cancelDrag();
    const calls=hovered.length;
    graph.flushPointerMove();
    assert.equal(hovered.length,calls);
    assert.equal(graph.nodes.get('a').x,-40);
    assert.deepEqual(saved,[]);
    if (pinch) assert.equal(graph.pinch.p.x,(460+500)/2-200);
  }
});

test('previewing a grid over a loose note and cancelling leaves the loose note in place', () => {
  const {graph,point,saved}=dragMap();
  graph.callbacks.onGridMove=()=>assert.fail('a cancelled move must not commit');
  const grid={rows:1,cols:2,spacing:70,rowSpacing:70,x:-100,y:0,stages:['A','B']};
  graph.setData([{id:'seated',areaId:'grid',slot:0},{id:'loose',x:10,y:0}],[{id:'grid',grid}]);
  const loose=graph.nodes.get('loose');
  graph.draw=()=>{};graph.accumulator=0;
  graph.pointerDown(point(420,240)); // The empty second seat at world x=-30.
  graph.queuePointerMove(point(530,240));
  assert.equal(graph.drag.grid.grid.x,10);
  graph.tick(1_000);
  graph.cancelDrag();
  assert.deepEqual([loose.x,loose.y],[10,0]);
  assert.equal(graph.groups[0].grid.x,-100);
  assert.deepEqual(saved,[]);
});

test('hiding the map pauses queued frames and resumes ongoing work without a catch-up burst', t => {
  const {graph,point}=dragMap();
  const frames=new Map();
  let sequence=0, steps=0;
  const pending=callback=>{frames.set(++sequence,callback);return sequence};
  globalThis.cancelAnimationFrame=id=>frames.delete(id);
  globalThis.requestAnimationFrame=pending;
  t.after(()=>{delete globalThis.cancelAnimationFrame;delete globalThis.requestAnimationFrame});
  delete graph.repaint;
  graph.draw=()=>{};
  graph.step=()=>{steps++;graph.remaining--};
  graph.accumulator=0;graph.remaining=24;
  graph.repaint();
  graph.setVisible(false);
  graph.repaint();
  assert.equal(frames.size,0);
  assert.equal(graph.remaining,24);
  graph.setVisible(true);
  const first=frames.get(graph.frame);
  assert.equal(frames.size,1);
  frames.delete(graph.frame);
  first(20_000);
  assert.equal(steps,1);
  graph.pointerDown(point(410));
  graph.queuePointerMove(point(430));
  frames.get(graph.frame)(20_100);
  assert.equal(steps,2);
});
test('an expensive physics step yields to painting while a fast map catches up', t => {
  const {graph}=dragMap();
  let now=0, frames=0, steps=0, cost=12;
  t.mock.method(performance,'now',()=>now);
  graph.repaint=()=>{graph.frame=1};
  graph.draw=()=>frames++;
  graph.step=()=>{steps++;now+=cost;graph.remaining--};
  graph.lastTime=100;
  graph.accumulator=0;graph.remaining=30;
  graph.tick(149);
  assert.equal(steps,1);
  assert.equal(frames,1);
  cost=1;
  graph.tick(198);
  assert.equal(steps,4);
  assert.equal(frames,2);
});

test('a group moves as a unit while aiming and releases the simulation on drop',()=>{
  const {graph,point}=dragMap();
  graph.nodes.get('b').pinned=false;
  const neighbour=graph.nodes.get('c');
  let steps=0;
  graph.draw=()=>{};graph.step=()=>{steps++;neighbour.x++};
  graph.accumulator=0;graph.lastTime=null;
  graph.pointerDown(point(410));graph.pointerMove(point(440));
  graph.tick(100);
  assert.equal(steps,0);
  assert.equal(neighbour.x,100);
  assert.equal(graph.nodes.get('b').x-graph.nodes.get('a').x,90);
  graph.pointerUp(point(440));graph.tick(120);
  assert.equal(steps,1);
});

test('continuous wheel zoom paints the camera first, then resumes a moving map',()=>{
  const {graph}=dragMap();
  let steps=0,paints=0;
  graph.draw=()=>paints++;graph.step=()=>steps++;
  graph.repaint=()=>{graph.frame=1};
  graph.accumulator=0;graph.remaining=10;
  const at={x:190,y:130},world=graph.world(at);
  for(const time of [10,30,50]){
    graph.zoomAt(1.05,at);graph.tick(time);
    assert.ok(Math.abs(graph.world(at).x-world.x)<1e-9);
  }
  assert.deepEqual([steps,paints],[0,3]);
  graph.tick(70);assert.deepEqual([steps,paints],[1,4]);
});
