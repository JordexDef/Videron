import assert from 'node:assert/strict';
import test from 'node:test';
import { inkHandleAt, resizeMapInk } from '../frontend/map-ink-resize.js';

const frame = {id:'frame', type:'rect', x:40, y:-5, w:160, h:80, seed:42, glow:true};

test('ink handle hit areas use screen pixels and give the closest handle priority', () => {
  for (const zoom of [.25, 1, 4]) {
    const corner = {x:frame.x - 4 / zoom, y:frame.y - 4 / zoom};
    assert.equal(inkHandleAt(frame, corner, zoom).name, 'nw');
    assert.equal(inkHandleAt(frame, {x:corner.x - 10 / zoom, y:corner.y}, zoom), null);
    assert.equal(inkHandleAt(frame, {x:corner.x - 10 / zoom, y:corner.y}, zoom, true).name, 'nw');
  }
  assert.equal(inkHandleAt(frame, {x:204, y:35}, 1).name,'e');
  assert.equal(inkHandleAt({...frame,type:'text'}, {x:204, y:35}, 1),null);
  assert.equal(inkHandleAt(frame, {x:90, y:35},1),null);
});

test('ink edge and corner resizing preserves the opposite edge, style and original path samples', () => {
  const pen = {...frame, type:'pen', points:[[0,.4],[1,1]], pressures:[.4,.8]};
  const wider = resizeMapInk(pen,'w',-25,400,false);
  assert.deepEqual(wider,{...pen, x:15, w:185});
  assert.equal(wider.points, pen.points);
  assert.equal(wider.pressures, pen.pressures);
  assert.deepEqual(resizeMapInk(pen,'ne',80,20,false),{...pen, y:15, w:240,h:60});
  assert.deepEqual(resizeMapInk(pen,'nw',400,200,false),{...pen,x:199,y:74,w:1,h:1});
  assert.equal(resizeMapInk(pen,'sw',0,0,false),pen);
});

test('proportional sizing anchors the opposite corner or the middle of the opposite side',()=>{
  assert.deepEqual(resizeMapInk(frame,'nw',-80,-40,true),{...frame,x:-40,y:-45,w:240,h:120});
  assert.deepEqual(resizeMapInk(frame,'e',80,30,true),{...frame,y:-25,w:240,h:120});
  const thin = {...frame,type:'pen',h:1};
  assert.deepEqual(resizeMapInk(thin,'e',-80,0,true),{...thin,w:80});
});

test('text handles scale the font and its actual bounds together through both font limits',()=>{
  const text={...frame,type:'text',fontSize:20,text:'one\ntwo'};
  assert.deepEqual(resizeMapInk(text,'se',80,40,false),{...text,fontSize:30,w:240,h:120});
  assert.deepEqual(resizeMapInk(text,'nw',160,80,false),{...text,x:136,y:43,fontSize:8,w:64,h:32});
  assert.deepEqual(resizeMapInk(text,'se',16000,8000,false),{...text,fontSize:180,w:1440,h:720});
});
