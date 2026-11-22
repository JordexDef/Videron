import assert from 'node:assert/strict';
import test from 'node:test';
import { preferredFragment, readingCandidate, readingFragments } from '../frontend/map-reading.js';

const paragraph = text => ({type:'paragraph', runs:[{text}]});

test('the automatic excerpt skips a heading and a tag-only line, and old text-only notes work', () => {
  const fragments = readingFragments({body:[{...paragraph('Setup'),type:'heading'}, paragraph('#work #soon'), paragraph('Compile the project')]});
  assert.equal(preferredFragment(fragments)?.text, 'Compile the project');
  assert.equal(readingFragments({plain:'First\nSecond'})[1].target.ranges[0].index,1);
});

test('a pinned paragraph follows inserted blocks and text edits, and a route may show another passage', () => {
  const note = {body:[paragraph('One'), paragraph('Two')]};
  const pinned = readingFragments(note)[1];
  const preference = {key:pinned.key, path:pinned.path, kind:pinned.kind};
  note.body.unshift(paragraph('Zero'));
  let fragments = readingFragments(note);
  assert.equal(preferredFragment(fragments, preference).target.ranges[0].index, 2);
  assert.equal(preferredFragment(fragments, preference, fragments[0].key).text, 'Zero');
  note.body.shift();
  note.body[1] = paragraph('Edited two');
  fragments = readingFragments(note);
  assert.equal(preferredFragment(fragments, preference).text, 'Edited two');
});

test('a sealed placeholder cannot expose a previous excerpt, and external images are skipped', () => {
  const sealed = {sealed:'ciphertext', get body(){throw new Error('private body accessed')}};
  assert.deepEqual(readingFragments(sealed), []);
  assert.deepEqual(readingFragments({body:[{type:'image',src:'https://example.com/test.png'}]}), []);
  const fragments = readingFragments({type:'canvas',board:{elements:[
    {type:'image',id:'img',src:'data:image/png;base64,AAAA',alt:'Portrait'},
    {type:'text',id:'txt',body:[{type:'code',text:'let a = 2'}]}
  ]}});
  assert.equal(fragments[0].label,'Portrait');
  assert.deepEqual(fragments[1].target, {kind:'canvasText',id:'txt',match:{kind:'body',ranges:[{index:0,start:0,end:1}]}});
});

test('table excerpts calculate references across blocks even with reused element IDs', () => {
  const block = (name, cells) => ({type:'drawing', board:{elements:[{type:'table', id:'same-id', name, cells, rows:2, cols:3}]}});
  const [a,b] = readingFragments({body:[block('Revenue',{A1:'4'}),block('Costs',{A1:'=Revenue!A1*2'})]});
  assert.notEqual(a.key,b.key);
  assert.equal(b.rows()[0][0], '8');
});

test('reading activates when zooming toward a note, respects hysteresis, and handles route overrides', () => {
  const nodes = new Map([['a',{id:'a',x:-80,y:0,r:22}],['b',{id:'b',x:2,y:1,r:23}]]);
  const graph = {nodes,camera:{x:0,y:0}, width:500,height:400, zoom:1,view:{}};
  const choose = (pointer,prev,hold=false,forced) => readingCandidate(graph,pointer,prev,hold,forced)?.id;
  assert.equal(choose(),undefined);
  graph.zoom = 2; graph.hover = 'a';
  assert.equal(choose({x:90,y:201}), 'a');
  assert.equal(choose({x:254,y:198}), 'b');
  graph.zoom = 1.7;
  assert.equal(choose(),undefined);
  assert.equal(choose(null,'b',true),'b');
  graph.view.reading = false;
  assert.equal(choose(null,'b',true),undefined);
  assert.equal(choose(null,null,false,'a'),'a');
});
