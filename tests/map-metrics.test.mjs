import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMapMetrics, drawAreaMetric } from '../frontend/map-metrics.js';
import { metricRange } from '../frontend/map-metric-source.js';

const table = (id, name, cells) => ({type:'table', id, name, rows:5, cols:4, cells});
const drawing = (key, ...tables) => ({type:'drawing', mapMetricSource:key, board:{version:2, elements:tables}});
const goal = {sourceId:'source', tableId:'t', blockId:'sheet', range:'B2', goal:50};

test('an area reads results of formulas across inline blocks, survives renames of notes and moving a block, and reflects edits', () => {
  const input = table('numbers', 'Input', {A1:'6', A2:'8'});
  const source = {id:'source', body:[
    drawing('sheet', table('t','Total',{B2:"=SUM('Input'::A1:A2)*2"})),
    drawing('other', input)
  ]};
  const space = {notes:[source], areas:[{id:'area', mapMetric:goal}]};
  assert.deepEqual(resolveMapMetrics(space).areas.get('area'), {value:28, goal:50, ratio:.56});
  source.body.reverse(); source.title = 'Renamed'; input.cells.A2 = '40';
  assert.deepEqual(resolveMapMetrics(space).areas.get('area'), {value:92, goal:50, ratio:1});
  input.cells.A2 = '-10';
  assert.deepEqual(resolveMapMetrics(space).areas.get('area'), {value:-8, goal:50, ratio:0});
  source.body.shift();
  assert.equal(resolveMapMetrics(space).areas.size, 0);
});

test('note trends use a linear range, preserve blanks, zeroes and formula errors and never serialize computed data', () => {
  const binding = {sourceId:'canvas', tableId:'trend', range:'A1:A5'};
  const values = table('trend', 'Trend', {A1:'0', A3:'=A1+4', A4:'=1/0', A5:'text'});
  const space = {notes:[{id:'canvas', type:'canvas', board:{elements:[values]}}, {id:'n', mapMetric:binding}], areas:[]};
  const before = JSON.stringify(space);
  assert.deepEqual(resolveMapMetrics(space).notes.get('n'), {values:[0, null, 4, null, null]});
  binding.range = 'B2:A1';
  assert.equal(resolveMapMetrics(space).notes.size, 0);
  binding.range = 'A1:A5';
  assert.equal(JSON.stringify(space), before);
});

test('identical imported table IDs are scoped to the source block and cannot retarget after it is removed', () => {
  const block = drawing('sheet', table('t', 'Amount', {B2:'25'}));
  const space = {areas:[{id:'area', mapMetric:goal}], notes:[{id:'source', body:[drawing('copy',table('t','Amount',{B2:'99'})), block]}]};
  assert.equal(resolveMapMetrics(space).areas.get('area').value, 25);
  space.notes[0].body.pop();
  assert.equal(resolveMapMetrics(space).areas.size, 0);
});

test('locking a source or a destination clears its result even if stale plaintext is passed', () => {
  const source = {id:'source', body:[drawing('sheet', table('t','Amount',{B2:'25'}))]};
  const target = {id:'n', mapMetric:{...goal}};
  const space = {notes:[source, target], areas:[{id:'a', mapMetric:goal}]};
  assert.equal(resolveMapMetrics(space).notes.size, 1);
  target.sealed = 'opaque';
  assert.equal(resolveMapMetrics(space).notes.size, 0);
  source.sealed = 'opaque';
  assert.equal(resolveMapMetrics(space).areas.size, 0);
  space.notes = [];
  assert.equal(resolveMapMetrics(space).areas.size, 0);
});

test('addresses must be inside the table and only a series may include multiple cells', () => {
  const source = {rows:3, cols:4};
  assert.equal(metricRange(' $C$2: a2 ', source, 'note').text, 'A2:C2');
  for (const text of ['A1:A4','A1:B2','A1:', 'A1:A1:A1']) assert.equal(metricRange(text, source, 'note'), null);
  assert.equal(metricRange('B1:B2', source, 'area'), null);
  assert.equal(metricRange('D3', source, 'area').text, 'D3');
});

test('a deformed area and a slot grid display the measured portion of their real perimeter', () => {
  const paths = [];
  const ctx = {save(){}, restore(){}, beginPath(){}, stroke(){},
    moveTo(x,y){paths.push([x,y]);}, lineTo(x,y){paths.push([x,y]);}};
  const view = {ox:0, oy:0, zoom:1};
  drawAreaMetric(ctx, {hull:{points:[{x:20,y:0},{x:0,y:10},{x:-20,y:0},{x:0,y:-10}]}}, {ratio:.25}, view);
  assert.deepEqual(paths, [[0,-10],[20,0]]);
  paths.length = 0;
  drawAreaMetric(ctx, {grid:{}, gridBounds:{left:0,top:0,right:20,bottom:10}}, {ratio:.25}, view);
  assert.deepEqual(paths, [[10,0],[20,0],[20,5]]);
});
