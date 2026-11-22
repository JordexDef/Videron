import assert from 'node:assert/strict';
import test from 'node:test';
import { pasteCellsAtRange, tabDestination } from '../frontend/table-view.js';
import { tableBarPosition } from '../frontend/table-canvas-footer.js';

const item = {rows:3, cols:3, cells:{A1:'keep', B2:'old'}};
const selection = {top:1, left:1, bottom:2, right:2};

test('canvas formula bar stays clear of the selected cell and the docks at the screen edges', () => {
  const view={left:0,right:720,top:58,bottom:520};
  const tools={rect:{left:90,right:630,width:540,top:72,bottom:111},atTop:true};
  const actions={rect:{left:257,right:463,width:206,top:466,bottom:507},atTop:false};
  const cell={top:370,bottom:410};
  const position=sheet=>tableBarPosition(sheet,cell,view,520,31,[tools,actions]);
  assert.deepEqual(position({left:88,top:147,bottom:397}),{x:88,y:403});
  // The normal spot below this sheet intersects the actions. Move above it.
  assert.deepEqual(position({left:88,top:303,bottom:620}),{x:88,y:240});
  // A zoomed sheet spans both edges; the visible cell is the remaining anchor.
  assert.deepEqual(position({left:-580,top:-90,bottom:900}),{x:6,y:416});
});

test('Tab follows the reading order and releases focus at both ends', () => {
  assert.equal(tabDestination(item, 'C1', false), 'A2');
  assert.equal(tabDestination(item, 'A2', true), 'C1');
  assert.equal(tabDestination(item, 'A1', true), null);
  assert.equal(tabDestination(item, 'C3', false), null);
  assert.equal(tabDestination({rows:2, cols:1}, 'A1', false), 'A2');
});

test('pasting one value fills the selected rectangle and shifts each copied formula from its original cell', () => {
  const {patch, last} = pasteCellsAtRange(item, selection, [['6']]);
  assert.deepEqual(patch.cells, {A1:'keep', B2:'6', C2:'6', B3:'6', C3:'6'});
  assert.equal(last, 'C3');
  const values = [['=A1+$A$1']];
  const result = pasteCellsAtRange(item, selection, values, {row:0, col:1});
  assert.deepEqual(result.patch.cells, {A1:'keep', B2:'=A2+$A$1', C2:'=B2+$A$1', B3:'=A3+$A$1', C3:'=B3+$A$1'});
  assert.deepEqual(item.cells, {A1:'keep', B2:'old'});
});

test('cut moves once and a multi-cell paste preserves its shape and expands the table', () => {
  const cut = pasteCellsAtRange(item, selection, [['=A1']], {row:0, col:1, cut:true});
  assert.deepEqual(cut.patch.cells, {A1:'keep', B2:'=A1'});
  assert.equal(cut.last, 'B2');
  const matrix = pasteCellsAtRange(item, selection, [['1','2','3'],['4','5','6']]);
  assert.equal(matrix.last, 'D3');
  assert.equal(matrix.patch.cols, 4);
  assert.equal(matrix.patch.cells.D3, '6');
});
