import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../frontend/graph.js';
import { insideContour } from '../frontend/map-contours.js';

function graphFor(notes,areas) {
  const graph=Object.assign(Object.create(Graph.prototype),{
    nodes:new Map(),selectedIds:new Set(),heating:new Set(),callbacks:{},repaint(){}
  });
  graph.setData(notes,areas);
  return graph;
}
function settle(graph) {
  for (let step=0; step<720 && graph.remaining; step++) graph.step();
  graph.measureGroups();
}
function outline(hull) {
  return hull.points || Array.from({length:90},(_,i)=>{
    const a=i*Math.PI/45;
    return {x:hull.x+Math.cos(a)*hull.r,y:hull.y+Math.sin(a)*hull.r};
  });
}
function disjoint(a,b) {
  assert.ok(!outline(a).some(point=>insideContour(b,point)),'first outline enters the other region');
  assert.ok(!outline(b).some(point=>insideContour(a,point)),'second outline enters the other region');
}

test('initially interleaved branches slide their mobile notes around three fixed pins',()=>{
  const areas=['a','b','c'].map(id=>({id})), notes=[];
  for (const [i,{id}] of areas.entries()) {
    const angle=Math.PI*2*i/3;
    for (let k=0;k<6;k++) notes.push({
      id:id+k,areaId:id,x:100*Math.cos(angle)+80*Math.cos(k),y:100*Math.sin(angle)+80*Math.sin(k),
      pinned:k===0,tags:['all',id],weight:2800
    });
  }
  const graph=graphFor(notes,areas);
  settle(graph);
  for (const pin of notes.filter(n=>n.pinned)) {
    const node=graph.nodes.get(pin.id);
    assert.deepEqual([node.x,node.y],[pin.x,pin.y]);
  }
  const members=[...graph.nodes.values()];
  for (const a of members) for (const b of members) if (a.index<b.index)
    assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>a.r+b.r+4,'note ran into its neighbour or its own pin');
  const [a,b,c]=graph.groups.map(group=>group.hull);
  disjoint(a,b);disjoint(a,c);disjoint(b,c);
});

test('a nested folder moves with its free branch and stationary grid seats keep their coordinates',()=>{
  const grid={rows:1,cols:4,x:100,y:0};
  const areas=[{id:'root'},{id:'child',parentId:'root'},{id:'grid',grid}];
  const graph=graphFor([{id:'a',areaId:'child',x:97,y:85,links:['b']},
    {id:'b',areaId:'grid',slot:0,x:100,y:0}],areas);
  settle(graph);
  const root=graph.groups.find(a=>a.id==='root'),child=graph.groups.find(a=>a.id==='child');
  const seat=graph.nodes.get('b'), gridBox=graph.groups.find(a=>a.id==='grid').gridBounds;
  assert.deepEqual([seat.x,seat.y],[grid.x,grid.y]);
  assert.ok(outline(child.hull).every(p=>insideContour(root.hull,p)));
  assert.ok(outline(root.hull).every(p=>p.x<=gridBox.left||p.x>=gridBox.right||p.y<=gridBox.top||p.y>=gridBox.bottom));
});

test('coincident empty sibling anchors resolve without mutating saved positions or jumping on rerender',()=>{
  const areas=[{id:'first',anchor:{x:40,y:30}},{id:'second',anchor:{x:40,y:30}}];
  const graph=graphFor([],areas);
  settle(graph);
  const positions=graph.groups.map(group=>({...group.emptyAnchor}));
  disjoint(...graph.groups.map(group=>group.hull));
  assert.deepEqual(areas.map(area=>area.anchor),[{x:40,y:30},{x:40,y:30}]);
  graph.setData([],areas);
  assert.deepEqual(graph.groups.map(group=>group.emptyAnchor),positions);
  assert.equal(graph.remaining,0);
});

test('editing an empty grid wakes area contacts even when every note is unchanged',()=>{
  const grid={rows:1,cols:1,x:500,y:100};
  const areas=[{id:'free'},{id:'grid',grid}];
  const notes=[{id:'a',areaId:'free',x:0,y:0}];
  const graph=graphFor(notes,areas);
  settle(graph);
  grid.x=0;grid.y=0;
  graph.setData(notes,areas);
  assert.ok(graph.remaining>0);
  settle(graph);
  const note=graph.nodes.get('a');
  assert.ok(Math.max(Math.abs(note.x),Math.abs(note.y))>92+note.r);
});
