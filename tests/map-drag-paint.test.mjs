import test from 'node:test';
import assert from 'node:assert/strict';
import {Graph} from '../frontend/graph.js';

function canvas() {
  const fills=[];
  let x;
  const ctx={fills,globalAlpha:1,setTransform(){},beginPath(){},stroke(){},fillRect(){},
    arc(px){x=px},fill(){fills.push(x)},drawImage(layer){fills.push(...layer.getContext('2d').fills)}};
  return {width:1000,height:40,getContext:()=>ctx,ownerDocument:{createElement:canvas}};
}

test('a drag reuses one stationary run in painter order and releases its surface on cancel',()=>{
  const nodes=new Map(), selected=new Set();
  for (let i=0;i<1000;i++) {
    nodes.set(i,{id:i,index:i,x:i,y:20,r:1,heat:0,tint:'120,120,120'});
    if (i>=500 && i<532) selected.add(i);
  }
  const surface=canvas(),ctx=surface.getContext('2d');
  const graph=Object.assign(Object.create(Graph.prototype),{
    canvas:surface,ctx,width:1000,height:40,dpr:1,camera:{x:500,y:20,zoom:1},
    selectedIds:selected,nodes,edges:[],groups:[],callbacks:{},view:{},drawLabels(){},measureGroups(){},
    drag:{moved:true,node:nodes.get(500),held:selected,allMoving:selected,noteIds:[...selected]}
  });
  const original=[...nodes.keys()];
  graph.draw();
  assert.deepEqual(ctx.fills,original);
  const layer=graph.drag.bodyLayer;
  assert.equal(layer.first,0);
  assert.equal(layer.last,499);
  assert.equal(layer.ink.fills.length,500);
  nodes.get(500).x=42; // The moving bubble crosses one cached note.
  ctx.fills.length=0;
  graph.draw();
  assert.equal(graph.drag.bodyLayer,layer);
  assert.deepEqual(ctx.fills,original.map(x=>x===500 ? 42 : x));
  assert.equal(layer.ink.fills.length,500);
  graph.camera.x+=2;
  graph.draw();
  assert.equal(layer.canvas.width,0);
  const replacement=graph.drag.bodyLayer.canvas;
  graph.discardGesture();
  assert.equal(replacement.width,0);
});
