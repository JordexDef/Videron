import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../frontend/graph.js';
import { drawSlotGrid, stageHandleBounds } from '../frontend/map-slots.js';

function setup(cols=4, zoom=1.35) {
  const width=800, height=580, grid={x:-155,y:0,rows:3,cols,spacing:96,
    stages:Array.from({length:cols},(_,i)=>'Stage '+(i+1))};
  const reorders=[], moves=[], edits=[];
  const graph=Object.assign(Object.create(Graph.prototype),{
    canvas:{style:{},focus(){},getBoundingClientRect(){return {left:37,top:18}},setPointerCapture(){},hasPointerCapture(){return false}},
    camera:{x:5,y:-19,zoom}, width,height,tool:'select', nodes:new Map(),contacts:new Map(),
    selectedIds:new Set(),heating:new Set(),repaint(){},
    callbacks:{onStageReorder:(...args)=>reorders.push(args),onGridMove:(...args)=>moves.push(args),onEditStage:(...args)=>edits.push(args)}
  });
  graph.setData([{id:'first',areaId:'road',slot:0},{id:'last',areaId:'road',slot:cols-1}],[{id:'road',name:'Road',grid}]);
  const group=graph.groups[0];
  const ctx={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},rect(){},fill(){},arc(){},fillText(){},
    measureText(text){return {width:text.length*7}}};
  const header=drawSlotGrid(ctx,group,{ox:width/2-graph.camera.x*zoom,oy:height/2-graph.camera.y*zoom,zoom,width,height}).stageHeader;
  graph.stageHeaders=[header];
  const event=(x,y,mods={})=>({clientX:x+37,clientY:y+18,pointerType:'mouse',pointerId:1,button:0,preventDefault(){},...mods});
  const handle=(col,mods)=>{const r=stageHandleBounds(header,col);return event((r.l+r.r)/2,(r.b+r.t)/2,mods)};
  const title=(col,mods)=>{const r=header.titles.get(col);return event((r.l+r.r)/2,(r.t+r.b)/2,mods)};
  const begin=(col,mods)=>{
    if(mods?.pointerType==='touch'){graph.pointerDown(title(col,mods));graph.pointerUp(title(col,mods))}
    else graph.pointerMove(title(col,mods));
    graph.pointerDown(handle(col,mods));
  };
  const at=(col,fraction=.5,mods)=>event(header.l+header.pitch*(col+fraction),(header.t+header.b)/2,mods);
  return {graph,grid,group,header,event,handle,title,begin,at,reorders,moves,edits};
}

test('only the pointed title reveals its grip and keeps it active on the way from the text',()=>{
  const {graph,title,handle,at}=setup();
  graph.pointerMove(handle(1));assert.equal(graph.hoverStage,null);
  graph.pointerDown(handle(1));assert.equal(graph.drag.stage,null);graph.cancelDrag();
  graph.pointerMove(title(1));assert.equal(graph.hoverStage,1);assert.equal(graph.hoverHandle,null);
  graph.pointerMove(handle(1));assert.equal(graph.hoverStage,1);assert.equal(graph.hoverHandle,1);
  graph.pointerMove(at(2,.98));assert.equal(graph.hoverStage,null);
  graph.pointerMove(title(2));assert.equal(graph.hoverStage,2);
  graph.pointerMove(handle(1));assert.equal(graph.hoverStage,null);
  graph.pointerDown(title(2,{pointerType:'touch'}));graph.pointerUp(title(2,{pointerType:'touch'}));
  assert.equal(graph.hoverStage,2);
  graph.pointerDown(handle(2,{pointerType:'touch'}));assert.equal(graph.drag.stage.from,2);
  graph.cancelDrag();assert.equal(graph.hoverStage,null);
});

test('dragging a handle previews one insertion and commits only the final slot on release',()=>{
  for(const [from,to,fraction,expectedBoundary] of [[0,2,.75,3],[3,0,.25,0]]){
    const {graph,grid,handle,title,at,reorders,moves}=setup();
    const initial=structuredClone(grid);
    graph.pointerMove(title(from));graph.pointerMove(handle(from));
    assert.equal(graph.hoverHandle,from);
    graph.pointerDown(handle(from));graph.pointerMove(at(to,fraction));
    assert.equal(graph.drag.stage.to,to);assert.equal(graph.drag.stage.boundary,expectedBoundary);
    assert.deepEqual(reorders,[]);assert.deepEqual(grid,initial);assert.deepEqual([...graph.nodes.values()].map(n=>n.slot),[0,3]);
    graph.pointerUp(at(to,fraction));graph.pointerUp(at(to,fraction));
    assert.deepEqual(reorders,[['road',from,to]]);assert.deepEqual(moves,[]);
  }
  const {graph,begin,at,reorders}=setup();
  begin(2);graph.pointerUp(at(1,.2));
  assert.deepEqual(reorders,[['road',2,1]],'fast release includes the final pointer location');
});

test('click, releasing over the source, dropping outside and cancelled touch do not reorder',()=>{
  const {graph,handle,begin,at,event,reorders,moves,edits}=setup();
  begin(0);graph.pointerUp(handle(0));graph.doubleClick(handle(0));
  begin(1);graph.pointerMove(at(3,.8));graph.pointerUp(at(1,.25));
  begin(1);graph.pointerMove(at(3,.8));graph.pointerUp(event(815,555));
  begin(1);graph.pointerMove(at(3,.8));graph.cancelDrag();graph.pointerUp(at(3,.8));
  const finger={pointerType:'touch'};
  begin(1,finger);graph.pointerMove(at(3,.8,finger));graph.pointerUp(at(3,.8,finger),true);
  begin(1,finger);graph.pointerMove(at(3,.8,finger));graph.pointerDown(at(1,.3,{...finger,pointerId:2}));
  assert.ok(graph.pinch);assert.equal(graph.drag,null);graph.cancelDrag();
  assert.deepEqual(reorders,[]);assert.deepEqual(moves,[]);assert.deepEqual(edits,[]);
  begin(1,finger);graph.pointerUp(at(0,.25,finger));
  assert.deepEqual(reorders,[['road',1,0]]);
});

test('the stage heading still moves or renames the track, and modifiers retain their gestures',()=>{
  const {graph,handle,at,reorders,moves,edits}=setup();
  graph.pointerDown(at(1));assert.ok(graph.drag.grid);graph.pointerUp(at(2));
  assert.equal(moves.length,1);graph.doubleClick(at(1));assert.equal(edits[0][1],1);
  graph.pointerDown(handle(1,{shiftKey:true}));assert.ok(graph.drag.marquee);graph.cancelDrag();
  for(const how of ['hand','middle button','space','route']){
    graph.tool=how==='hand'?'hand':'select'; graph.spacePan=how==='space'; graph.callbacks.recordingRoute=()=>how==='route';
    graph.pointerDown(handle(1,{button:how==='middle button'?1:0}));
    assert.ok(graph.drag.pan);assert.equal(graph.drag.stage,null);graph.cancelDrag();
  }
  assert.deepEqual(reorders,[]);
});

test('holding a dragged stage at the viewport edge reveals and reaches the last of 100 stages',()=>{
  const {graph,begin,header,event,reorders,grid}=setup(100,1);
  const edge=event(graph.width-4,(header.t+header.b)/2);
  begin(0);graph.pointerMove(edge);
  assert.ok(graph.drag.stage.to<10);
  graph.draw=()=>{};graph.remaining=0;graph.lastTime=0;
  for(let frame=1;frame<=1100;frame++)graph.tick(frame*16);
  assert.equal(graph.drag.stage.to,99);assert.equal(graph.drag.stage.boundary,100);
  const finalX=graph.camera.x;graph.tick(18000);assert.equal(graph.camera.x,finalX);
  assert.equal(grid.x,-155);graph.pointerUp(edge);
  assert.deepEqual(reorders,[['road',0,99]]);
});
