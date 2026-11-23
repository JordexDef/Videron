import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapCameraMemory} from '../frontend/map-camera-memory.js';

function localPrefs(t){
  const entries=new Map(),writes=[];
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem:key=>entries.get(key)??null,
    setItem(key,value){entries.set(key,value);writes.push([key,value])},
    removeItem:key=>entries.delete(key)
  }});
  t.after(()=>{
    if(original)Object.defineProperty(globalThis,'localStorage',original);
    else delete globalThis.localStorage;
  });
  return {entries,writes};
}

test('switching or leaving immediately saves the last pan and zoom for that space', t=>{
  const {writes}=localPrefs(t);
  const memory=createMapCameraMemory();
  const camera={x:50,y:20,zoom:1.5};
  assert.equal(memory.open('first'),null);
  memory.remember(camera);
  camera.x=115;camera.y=-78;
  memory.remember(camera);
  assert.equal(writes.length,0);
  assert.equal(memory.open('second'),null);
  assert.equal(writes.length,1);
  const second={x:-440,y:220,zoom:2.75};
  memory.remember(second);
  memory.flush();
  const reopened=createMapCameraMemory();
  assert.deepEqual(reopened.open('second'),second);
  assert.deepEqual(reopened.open('first'),camera);
  reopened.remember({...camera});
  reopened.flush();
  assert.equal(writes.length,2);
});

test('an unusable preference falls back to the initial view and deleted spaces stay forgotten',t=>{
  const {entries,writes}=localPrefs(t);
  const memory=createMapCameraMemory();
  const camera={x:8,y:-4,zoom:1};
  memory.open('space');memory.remember(camera);memory.flush();
  const [key]=entries.keys();
  for(const corrupt of ['{',JSON.stringify({...camera,zoom:0}),JSON.stringify({...camera,y:'4'})]){
    entries.set(key,corrupt);
    assert.equal(memory.open('space'),null);
  }
  memory.remember(camera);
  memory.forget('space');
  memory.flush();
  assert.equal(writes.length,1);
  assert.equal(memory.open('space'),null);
});
