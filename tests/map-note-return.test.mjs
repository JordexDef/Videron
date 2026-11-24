import test from 'node:test';
import assert from 'node:assert/strict';
import {Graph} from '../frontend/graph.js';
import {returnToNoteMap} from '../frontend/note-transition.js';
import {geometryFor} from '../frontend/icons/node-art.js';

test('returning from the sidebar restores the displayed map even when a linked note is off screen', () => {
  const camera={x:34,y:-20,zoom:.84};
  const graph=Object.assign(Object.create(Graph.prototype),{
    camera:{x:40,y:10,zoom:.9},target:{x:200,y:50,zoom:1.5},callbacks:{},repaint(){},
    focus(){assert.fail('sidebar return must not fly to a note')},
    noteViewportRect(){assert.fail('sidebar return must not prepare a bubble transition')}
  });
  const visit={origin:'sidebar',noteId:'first',space:'personal',camera};
  returnToNoteMap(graph,'linked-note',visit,'personal');
  assert.deepEqual(graph.captureCamera(),camera);
  assert.equal(graph.target,null);
  graph.camera.x=100;
  returnToNoteMap(graph,'first',visit,'another-space');
  assert.equal(graph.camera.x,100);
});

test('returning uses the displayed camera and the current canvas layout', () => {
  const rect={left:180,top:60,width:600,height:400};
  const note={x:50,y:30,r:12};
  const graph=Object.assign(Object.create(Graph.prototype),{
    canvas:{getBoundingClientRect:()=>rect},nodes:new Map([['note',note]]),
    camera:{x:10,y:-10,zoom:2},target:{x:200,y:-60,zoom:3},
    callbacks:{},repaint(){}
  });
  const camera=graph.captureCamera();
  assert.deepEqual(graph.noteViewportRect('note'),{left:536,top:316,width:48,height:48});
  graph.camera.x=320; graph.camera.zoom=4;
  rect.left=24; rect.width=420; rect.height=300;
  assert.equal(graph.restoreCamera(camera),true);
  assert.equal(graph.target,null);
  assert.deepEqual(graph.camera,{x:10,y:-10,zoom:2});
  assert.deepEqual(graph.noteViewportRect('note'),{left:290,top:266,width:48,height:48});
  note.geometry=geometryFor('square');
  assert.ok(Math.abs(graph.noteViewportRect('note').width-48*Math.SQRT1_2)<1e-8);
  note.geometry=null;
  note.x=-100;
  assert.deepEqual(graph.noteViewportRect('note'),{left:24,top:266,width:14,height:48});
  note.x=-120;
  assert.equal(graph.noteViewportRect('note'),null);
  assert.equal(graph.noteViewportRect('deleted'),null);
  assert.equal(graph.restoreCamera({x:0,y:0,zoom:NaN}),false);
  assert.deepEqual(graph.camera,camera);
});

test('the cue follows one note, expires, and schedules no map paints', t => {
  let inserted=0, removed=0, timer=0;
  const timers=new Map();
  t.mock.method(globalThis,'setTimeout',callback=>{timers.set(++timer,callback);return timer});
  t.mock.method(globalThis,'clearTimeout',key=>timers.delete(key));
  const previous=globalThis.document;
  globalThis.document={createElement:()=>({style:{},setAttribute(){},remove(){removed++}})};
  t.after(()=>{if(previous)globalThis.document=previous;else delete globalThis.document});
  const rect={width:600,height:400}, note={x:70,y:10,r:12};
  const graph=Object.assign(Object.create(Graph.prototype),{
    canvas:{getBoundingClientRect:()=>rect,after(){inserted++}},
    ...rect,nodes:new Map([['note',note]]),camera:{x:0,y:0,zoom:1},
    repaint(){assert.fail('the return cue should never schedule graph paints')}
  });
  graph.showReturnCue('missing');
  assert.equal(inserted,0);
  graph.showReturnCue('note');
  assert.equal(graph.returnCue.element.style.left,'370px');
  note.x+=20;graph.placeReturnCue();
  assert.equal(graph.returnCue.element.style.left,'390px');
  graph.camera.zoom=5;
  graph.camera.x=note.x;
  graph.placeReturnCue();
  assert.equal(graph.returnCue.element.style.width,'136px');
  graph.showReturnCue('note');
  assert.equal(removed,1);
  assert.equal(timers.size,1);
  [...timers.values()][0]();
  assert.equal(graph.returnCue,null);
  assert.equal(removed,2);
  assert.equal(timers.size,0);
});
