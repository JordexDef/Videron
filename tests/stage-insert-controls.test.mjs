import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleStageBoundaries } from '../frontend/stage-insert.js';

function header(cols,left=20,bottom=110){
  return {grid:{grid:{cols}},l:left,b:bottom,pitch:80};
}

test('a three-stage track can insert at either end or either internal boundary',()=>{
  const head=header(3);
  const points=visibleStageBoundaries(head,300,200);
  assert.deepEqual(points.map(p=>[p.index,p.x]),[[0,20],[1,100],[2,180],[3,260]]);
  assert.ok(points.every(p=>p.y>=head.b));
  assert.deepEqual(visibleStageBoundaries(header(1),300,200).map(p=>p.index),[0,1]);
});

test('wide tracks expose only in-view insert targets, and full tracks expose none',()=>{
  assert.deepEqual(visibleStageBoundaries(header(99,-300),200,200).map(p=>p.index),[4,5,6]);
  assert.deepEqual(visibleStageBoundaries(header(100),500,200),[]);
  assert.deepEqual(visibleStageBoundaries(header(4,20,194),500,200),[]);
});
