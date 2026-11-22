import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../frontend/graph.js';

const areas = [{id:'main', name:'Main'}];

function load(notes) {
  const graph = Object.assign(Object.create(Graph.prototype), {
    nodes:new Map(), selectedIds:new Set(), heating:new Set(), repaint(){},
    callbacks:{onMove(positions) {
      for (const {id,x,y} of positions) Object.assign(notes.find(note => note.id === id), {x,y});
    }}
  });
  graph.setData(notes,areas);
  return graph;
}

function pair(linked) {
  return [
    {id:'projects', areaId:'main', x:341, y:317, weight:2000, links:linked ? ['demo'] : []},
    {id:'demo', areaId:'main', x:421, y:350, weight:180}
  ];
}

function midpoint(graph) {
  const [a,b] = graph.nodes.values();
  return {x:(a.x+b.x)/2, y:(a.y+b.y)/2};
}

function settle(graph) {
  const budget = graph.remaining;
  let steps = 0;
  while (steps < budget && graph.remaining) {
    graph.step();
    steps++;
  }
  return {steps,budget};
}

for (const linked of [false,true]) {
  test('unequal bubbles in one free area settle in place ' + (linked ? 'with' : 'without') + ' a link', () => {
    const notes = pair(linked);
    let graph = load(notes);
    const initial = midpoint(graph);
    for (let open = 0; open < 3; open++) {
      // Each fresh graph starts from the positions persisted by the previous one.
      if (open) graph = load(notes);
      const {steps,budget} = settle(graph);
      const center = midpoint(graph);
      const displacement = Math.hypot(center.x-initial.x, center.y-initial.y);
      assert.ok(displacement < 0.5, 'stationary pair drifted ' + displacement.toFixed(2) + ' map units');
      assert.ok(steps < budget, 'the pair should fall asleep before the simulation limit');
      const [a,b] = graph.nodes.values();
      const gap = Math.hypot(a.x-b.x,a.y-b.y)-a.r-b.r;
      assert.ok(gap > 6 && gap < 30, 'the smaller and larger bubbles must retain a visible gap');
    }
  });
}

test('an unequal pair can settle around its new location after a manual group move', () => {
  const notes = pair(true);
  const graph = load(notes);
  settle(graph);
  // Supply fresh map positions through the same data path that restores manual moves.
  Object.assign(notes[0],{x:855,y:-470});
  Object.assign(notes[1],{x:1119,y:-388});
  graph.setData(notes,areas);
  const start = midpoint(graph);
  settle(graph);
  const [a,b] = graph.nodes.values();
  assert.ok(Math.hypot(a.x-b.x,a.y-b.y) < a.r+b.r+30, 'a stretched pair should still attract');
  const end = midpoint(graph);
  assert.ok(Math.hypot(start.x-end.x,start.y-end.y) < 0.5, 'the moved cluster must stay at its new location');
});
