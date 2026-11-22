import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../frontend/graph.js';
import { MapZoomPreview } from '../frontend/map-zoom-preview.js';

test('overview projection uses the exact source bounds and coalesces the final repaint', t => {
  const timers=new Map();
  let timerId=0, paints=0;
  t.mock.method(globalThis,'setTimeout',callback=>{timers.set(++timerId,callback);return timerId});
  t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
  const canvas={style:{}};
  const preview=new MapZoomPreview(canvas,()=>{paints++;preview.reset()});
  const base={x:40,y:30,zoom:.1,width:500,height:300};
  preview.base=base;
  for(const camera of [
    {x:40,y:30,zoom:.09}, {x:40,y:30,zoom:.14}, {x:850,y:30,zoom:.12}
  ]) assert.equal(preview.show(camera,500,300),false);
  assert.equal(preview.show({x:40,y:30,zoom:.12},499,300),false);
  assert.equal(timers.size,0);

  for (const zoom of [.11,.12,.125]) {
    const camera={x:130,y:80,zoom};
    assert.equal(preview.show(camera,500,300),true);
    const [top,right,bottom,left]=canvas.style.objectViewBox.slice(6,-1).split(' ').map(x=>parseFloat(x)/100);
    const point={x:-70,y:-45};
    const projected=(world,axis,size,leading,trailing)=>
      ((world-base[axis])*base.zoom+size/2-leading*size)/(1-leading-trailing);
    assert.ok(Math.abs(projected(point.x,'x',500,left,right) - ((point.x-camera.x)*zoom+250))<1e-9);
    assert.ok(Math.abs(projected(point.y,'y',300,top,bottom) - ((point.y-camera.y)*zoom+150))<1e-9);
    assert.equal(timers.size,1);
  }
  for (const callback of [...timers.values()]) callback();
  assert.equal(paints,1);
  assert.equal(canvas.style.objectViewBox,'');
  assert.equal(preview.base,null);
});

test('hover, selection, dynamic overlays and the label threshold always render a fresh map', () => {
  const canvas={style:{},parentElement:{dataset:{}}};
  let paints=0;
  const graph=Object.assign(Object.create(Graph.prototype),{
    canvas, width:500,height:300, camera:{x:0,y:0,zoom:.1}, nodes:{size:4000},
    remaining:0, heating:new Set(), selectedIds:new Set(), groups:[],callbacks:{},contacts:new Map(),
    draw(){paints++},repaint(){},zoomPreview:new MapZoomPreview(canvas,()=>{})
  });
  graph.zoomPreview.supported=true;
  graph.tick(0);
  assert.ok(graph.zoomPreview.base);
  graph.camera.zoom=.11;graph.zoomChanged=true;graph.tick(16);
  assert.equal(paints,1);
  assert.equal(graph.zoomPreview.cropped,true);
  for (const change of [
    ()=>{graph.hover='item'}, ()=>{graph.selectedIds.add('item')}, ()=>{graph.groups=[{grid:{}}]},
    ()=>{canvas.parentElement.dataset.routeMode='play'}, ()=>{graph.camera.zoom=.23}
  ]) {
    graph.hover=null;graph.selectedIds.clear();graph.groups=[];delete canvas.parentElement.dataset.routeMode;
    graph.camera.zoom=.1;graph.tick(32);
    const before=paints;
    graph.camera.zoom=.12;graph.zoomChanged=true;change();graph.tick(48);
    assert.equal(paints,before+1);
    assert.equal(graph.zoomPreview.base,null);
    assert.equal(canvas.style.objectViewBox,'');
  }
});

