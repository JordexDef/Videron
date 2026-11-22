import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../frontend/graph.js';
import { contact } from '../frontend/icons/node-art.js';

function graphWith(notes, areas) {
  const graph = Object.assign(Object.create(Graph.prototype), {
    callbacks:{}, nodes:new Map(), groups:[], selectedIds:new Set(), heating:new Set(), repaint(){},
  });
  graph.setData(notes,areas);
  return graph;
}

function settle(graph) {
  for (let i=0; i<720 && graph.remaining; i++) graph.step();
}

const note = (id,x,y,extra={}) => ({id,x,y,areaId:'a',...extra});
const gap = (a,b) => Math.hypot(a.x-b.x,a.y-b.y)-a.r-b.r;

test('an area gently gathers even unlinked notes, leaving room between them',()=>{
  const graph=graphWith([note('one',-200,0),note('two',200,0),note('free',700,350,{areaId:null})],[{id:'a'}]);
  settle(graph);
  const [a,b,free]=graph.nodes.values();
  assert.ok(gap(a,b)>6 && gap(a,b)<30, 'two area members settle close with a visible gap');
  assert.deepEqual([free.x,free.y],[700,350]);
});

test('a dense cluster of linked and tagged bubbles keeps a visible space around every note',()=>{
  const notes=Array.from({length:28},(_,i)=>note('n'+i,Math.cos(i*2.4)*(1+i),Math.sin(i*2.4)*(1+i),{
    tags:['tag'+(i%4)], links:['n'+((i+3)%28)],weight:100+i*20,
  }));
  const graph=graphWith(notes,[{id:'a'}]);
  settle(graph);
  const nodes=[...graph.nodes.values()];
  for(let i=0;i<nodes.length;i++) for(let j=0;j<i;j++){
    assert.ok(gap(nodes[i],nodes[j])>4, 'crowded notes: '+nodes[i].id+' and '+nodes[j].id);
  }
});

test('links preserve a gap from the visible outline of a pinned polygon',()=>{
  const graph=graphWith([note('pin',0,0,{pinned:true,appearance:{shape:'triangle'}}),
    note('square',0,0,{links:['pin'],appearance:{shape:'square'}})],[{id:'a'}]);
  settle(graph);
  const [a,b]=graph.nodes.values(),d=Math.hypot(b.x-a.x,b.y-a.y);
  assert.deepEqual([a.x,a.y],[0,0]);
  assert.equal(contact(a,b,(b.x-a.x)/d,(b.y-a.y)/d,d,5),null);
  assert.ok(d<100);
});

test('compact and sparse contact grids preserve the same ordering for mixed-size circles and polygons',()=>{
  const shapes=['circle','square','triangle','hexagon'];
  const cluster=Array.from({length:180},(_,i)=>note('n'+i,(i%18)*39,Math.floor(i/18)*32,{
    appearance:{shape:shapes[i%shapes.length]},weight:(i%9)*125,pinned:i%20===0
  }));
  const graph=x=>graphWith([...cluster,note('isolated',x,2000,{pinned:true})],[]);
  const dense=graph(1000),sparse=graph(1e9);
  for(let i=0;i<12;i++){dense.step();sparse.step()}
  for(const {id} of cluster) {
    const a=dense.nodes.get(id),b=sparse.nodes.get(id);
    assert.deepEqual([a.x,a.y,a.vx,a.vy],[b.x,b.y,b.vx,b.vy]);
  }
});

test('cached primitive axes scale independently to both radii and preserve corner clearance',()=>{
  const graph=graphWith([note('square',0,0,{appearance:{shape:'square'}}),note('dot',0,0)],[]);
  const a=graph.nodes.get('square'),b=graph.nodes.get('dot');
  for(const [r,other] of [[14,40],[40,14],[25,25]]) {
    a.r=r;b.r=other;
    // The nearest square feature on this diagonal is its upper-right vertex.
    const nx=Math.SQRT1_2, ny=-Math.SQRT1_2;
    for(const overlap of [-.4,.4,2]) {
      const d=r+other+2-overlap;
      b.x=nx*d;b.y=ny*d;
      const hit=contact(a,b,nx,ny,d,2),reverse=contact(b,a,-nx,-ny,d,2);
      if(overlap<0){assert.equal(hit,null);assert.equal(reverse,null)}
      else {
        assert.ok(Math.abs(hit[2]-overlap)<1e-10);
        assert.ok(Math.abs(reverse[2]-overlap)<1e-10);
        assert.ok(Math.abs(hit[0]-nx)<1e-10 && Math.abs(hit[1]-ny)<1e-10);
      }
    }
  }
});

test('adding multiple links across an area boundary does not multiply the pull on one note',()=>{
  const outside=Array.from({length:12},(_,i)=>note('b'+i,1500,80*i-440,{areaId:'b',pinned:true}));
  const graph=graphWith([note('a0',0,0,{links:outside.map(n=>n.id)}),...outside],[{id:'a'},{id:'b'}]);
  graph.step();
  const lead=graph.nodes.get('a0');
  assert.ok(lead.x>0 && Math.hypot(lead.x,lead.y)<0.65);
  for(const n of outside) assert.deepEqual([graph.nodes.get(n.id).x,graph.nodes.get(n.id).y],[n.x,n.y]);
});

test('a crowded layout saved by 0.21 settles with clearance between both bubbles and neighboring outlines',()=>{
  const coordinates=[
    [[-95,-30],[-87.56,32.49],[20.31,15.16],[73.29,82.09],[136.37,0],[43.14,-31.16]],
    [[227.04,5.96],[100.69,-47.4],[-10.01,-62.86],[-37.83,-16.82],[19.77,75.37],[124.04,61.35]],
    [[35.12,151.11],[126.01,122.28],[183.47,50.62],[77.18,20.04],[-34.74,39.07],[-37.2,100.55]],
  ];
  const ids=['visual','research','ideas'];
  const notes=coordinates.flatMap((points,g)=>points.map(([x,y],i)=>note(ids[g]+i,x,y,{
    areaId:ids[g],pinned:i===0,weight:g===2 && i===0 ? 2300 : 320,tags:i<2 ? [] : ['shared'],
    links:[ids[g]+((i+1)%6),ids[(g+1)%3]+((i+2)%6)],
  })));
  const graph=graphWith(notes,ids.map(id=>({id})));
  let steps=0;
  while(graph.remaining && steps++<720) graph.step();
  assert.ok(steps<720,'the saved layout reaches rest');
  const nodes=[...graph.nodes.values()];
  for(let i=0;i<nodes.length;i++) for(let j=0;j<i;j++) {
    assert.ok(gap(nodes[i],nodes[j])>=6, nodes[i].id+' touches '+nodes[j].id);
  }
  function front(hull,nx,ny) {
    if (!hull.points) return hull.x*nx+hull.y*ny+hull.r;
    return Math.max(...hull.points.map(p=>p.x*nx+p.y*ny));
  }
  graph.measureGroups();
  for(let i=0;i<graph.groups.length;i++) for(let j=0;j<i;j++){
    const a=graph.groups[i].hull,b=graph.groups[j].hull;
    let separation=-Infinity;
    for(let angle=0;angle<360;angle+=2) {
      const nx=Math.cos(angle*Math.PI/180),ny=Math.sin(angle*Math.PI/180);
      separation=Math.max(separation,-front(b,-nx,-ny)-front(a,nx,ny));
    }
    assert.ok(separation>=6,'area outlines approach within the intended gap');
  }
});
