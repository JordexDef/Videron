import test from 'node:test';
import assert from 'node:assert/strict';
import { stageControlPosition } from '../frontend/stage-controls.js';

test('the edit button fits beside a track name and above its stage headings',()=>{
  const header={l:20,r:270,t:60,b:84};
  const title={l:103,r:182,t:44,b:60};
  const p=stageControlPosition(header,title,300,200);
  assert.ok(p.x>title.r);
  assert.ok(p.y+28<header.t);
  const rightEdgeName={...title,l:200,r:286};
  const left=stageControlPosition(header,rightEdgeName,300,200);
  assert.ok(left.x+28<rightEdgeName.l);
});

test('a track filling the width can place settings above its stages with note labels hidden',()=>{
  const header={l:-400,r:1200,t:65,b:89};
  const p=stageControlPosition(header,null,400,200);
  assert.ok(p.x>0 && p.x+28<400);
  assert.ok(p.y+28<header.t);
  assert.equal(stageControlPosition({...header,t:-40,b:-16},null,400,200),null);
});
