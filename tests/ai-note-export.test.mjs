import assert from 'node:assert/strict';
import test from 'node:test';
import {copyNoteForAI, formatNoteForAI} from '../frontend/ai-note-export.js';

const paragraph = (text, extra = {}) => ({type:'paragraph', runs:[{text}], ...extra});
const drawing = (...elements) => ({type:'drawing', board:{version:2, elements}});
const scenes = text => [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));

test('formatted text, nested task states, links and original code are copied in document order', () => {
  const source = 'const example = "```";\nfoo();';
  const note = {title:'Plan', body:[
    {type:'heading', runs:[{text:'Plan', bold:true}]}, paragraph('Open', {listStyle:'task'}),
    paragraph('Done', {listStyle:'task', taskState:'done', indent:1}),
    paragraph('Skipped', {listStyle:'task-choice', taskState:'cancelled'}),
    {type:'quote', runs:[{text:'two\nlines'}]}, {type:'divider'}, {type:'code', language:'js', text:source},
    {type:'paragraph', runs:[{text:'Reference', href:'https://example.org/docs'}, {text:' Team', folderPath:'/private/files/Team'}]}
  ], plain:'stale cached content'};
  const text = formatNoteForAI(note);
  assert.match(text, /## \*\*Plan\*\*\n\n- \[ \] Open\n  - \[x\] Done\n- \[-\] \(cancelled\) Skipped/);
  assert.ok(text.includes('> two\n> lines\n\n---\n\n````js\n' + source + '\n````'));
  assert.ok(text.includes('[Reference](<https://example.org/docs>) Team'));
  assert.doesNotMatch(text, /stale cached|private/);
  assert.equal(formatNoteForAI({title:'Legacy', plain:'original'}), '# Legacy\n\noriginal');
});

test('sparse tables keep formulas, values across drawings, charts, and header coordinates', () => {
  const sheet = (id, name, cells) => ({id, type:'table', name, rows:200, cols:20, cells, headerRows:[0]});
  const note = {title:'Costs', body:[
    drawing(sheet('totals', 'Totals', {A1:'Total', A2:'=Prices!B2*2'}),
      {id:'chart', type:'chart', tableId:'totals', range:'A1:A2', chartType:'bar'}),
    drawing(sheet('prices', 'Prices', {A1:'Code', B2:'09'}))
  ]};
  const [summary, source] = scenes(formatNoteForAI(note));
  assert.deepEqual(summary.objects[0].cells.A2, {formula:'=Prices!B2*2', value:18});
  assert.deepEqual(summary.objects[0].headerRows, [0]);
  assert.deepEqual(source.objects[0].cells, {A1:'Code', B2:'09'});
  assert.equal(summary.objects[1].tableId, 'totals');
  assert.equal(summary.objects[1].chartType, 'bar');
  assert.equal(summary.objects[1].range, 'A1:A2');
});

test('canvas geometry, arrows, rich text, images and legacy freehand drawings survive text-only paste', () => {
  const note = {type:'canvas', title:'Diagram', board:{version:1, elements:[
    {id:'node', type:'rect', x:12, y:127, w:20, h:10, angle:15, label:'Approve', fill:'#ffeecc'},
    {id:'arrow', type:'arrow', points:[[0,0],[1,1]], endBinding:{id:'node', u:.5, v:0}},
    {id:'task', type:'text', body:[paragraph('Sign', {listStyle:'task'}), {type:'image', alt:'Layout', src:'data:image/png;base64,YWJj'}]},
    {id:'local', type:'text', folderPath:'/private/folder/Sketches'}
  ]}};
  const text = formatNoteForAI(note), [scene] = scenes(text);
  assert.deepEqual(scene.objects.map(e => e.id), ['node','arrow','task','local']);
  assert.equal(scene.objects[0].angle, 15);
  assert.equal(scene.objects[0].label, 'Approve');
  assert.deepEqual(scene.objects[1].endBinding, {id:'node', u:.5, v:0});
  assert.equal(scene.objects[2].text, '- [ ] Sign\n\nImage 1 — Layout');
  assert.equal(scene.objects[3].text, 'Sketches');
  assert.doesNotMatch(text, /private|base64|YWJj/);
  const [old] = scenes(formatNoteForAI({title:'Old',body:[{type:'drawing',strokes:[
    {tool:'pen',points:[[15,10],[15,14],[20,14]],width:3,color:'#222222'}]}]}));
  assert.deepEqual(old.objects[0].points, [[0,0],[0,1],[1,1]]);
  assert.equal(old.objects[0].x, 15);
});

test('data notes use the entire source with original line endings and no workspace lookups', () => {
  const dataText = 'a;b\r\n'.repeat(1_000_000) + 'last;row';
  const note = {title:'Rows',type:'data',dataLanguage:'csv',dataText,dataHasHeader:false,
    get plain() { throw Error('Only a short search preview'); },
    get links() { throw Error('No access to other notes'); }};
  assert.equal(formatNoteForAI(note), '# Rows\n\nNo header row.\n\n```csv\n' + dataText + '\n```');
});

test('sealed placeholders are rejected before reading other properties or using a clipboard', async () => {
  const note = {sealed:'opaque', get body() { throw Error('accessed body'); }};
  assert.throws(() => formatNoteForAI(note), /разблокируйте|Unlock/);
  await assert.rejects(copyNoteForAI(note), /разблокируйте|Unlock/);
});

test('rich paste includes embedded raster images and escapes note text; native fallback contains no binary', async t => {
  const note = {title:'<script>', body:[{type:'image', alt:'"plan"', src:'data:image/png;base64,YWJj'}]};
  let written, native;
  globalThis.ClipboardItem = class { constructor(formats) { Object.assign(this, formats); } };
  t.after(() => { delete globalThis.ClipboardItem; delete globalThis.window; });
  const clipboard = {write:async ([item]) => { written = item; }};
  t.mock.getter(globalThis, 'navigator', () => ({clipboard}));
  globalThis.window = {runtime:{ClipboardSetText:async text => { native = text; }}};
  assert.deepEqual(await copyNoteForAI(note), {images:1,embedded:1});
  assert.equal(await written['text/plain'].text(), formatNoteForAI(note));
  const html = await (await written['text/html']).text();
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<img alt="Image 1 — &quot;plan&quot;" src="data:image\/png;base64,YWJj">/);
  clipboard.write = async () => { throw Error('HTML unsupported'); };
  assert.deepEqual(await copyNoteForAI(note), {images:1,embedded:0});
  assert.equal(native, formatNoteForAI(note));
});
