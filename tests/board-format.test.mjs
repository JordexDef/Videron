import assert from 'node:assert/strict';
import test from 'node:test';
import { boardSummary, normalizeBoard } from '../frontend/board.js';
import { exportScene, importScene } from '../frontend/board-files.js';
import { magnets } from '../frontend/board-connectors.js';
import {
  copiedSheetObjects,
  deleteTableAxes,
  insertTableCells,
  noteWorkbooks,
  rebaseTableLinks,
  rebaseTableLinksAfterDelete,
  renamedTable,
  withoutObjects,
  workbookCache
} from '../frontend/board-tables.js';
import { createWorkbook } from '../frontend/table-engine.js';
import { chartData } from '../frontend/table-charts.js';
import { freehandPath } from '../frontend/freehand.js';

test('folder targets survive board saves while Excalidraw receives only the folder name', () => {
  const path = 'D:/private-parent/Рабочие чертежи';
  const doc = normalizeBoard({elements:[{id:'folder', type:'text', folderPath:path}]});
  assert.equal(doc.elements[0].text, 'Рабочие чертежи');
  assert.deepEqual(normalizeBoard(JSON.parse(JSON.stringify(doc))), doc);
  const scene = exportScene(doc);
  assert.equal(scene.elements[0].text, 'Рабочие чертежи');
  assert.doesNotMatch(JSON.stringify(scene), /private-parent/);
  assert.equal(importScene(scene).elements[0].folderPath, undefined);
  const ordinary = normalizeBoard({elements:[{id:'text', type:'text', text:'read', folderPath:'https://example.com'}]});
  assert.equal(ordinary.elements[0].folderPath, undefined);
  assert.equal(ordinary.elements[0].text, 'read');
});

const item = (id, type, options = {}) => ({ id, type, x: 12, y: 20, w: 80, h: 46, ...options });
const roundTrip = (elements) =>
  normalizeBoard(importScene(exportScene(normalizeBoard({ elements })))).elements;

test('canvas text areas keep editable note blocks and publish a portable scene fallback', () => {
  const reference = {text:'Работа', folderPath:'D:/local-only/Работа'};
  const body = [
    {type:'heading', runs:[{text:'Budget', bold:true}]},
    {type:'paragraph', listStyle:'bullet', indent:1, runs:[reference]},
    {type:'divider'},
    {type:'code', language:'json', text:'{"total":5}'},
    {type:'image', src:'data:image/png;base64,AQ==', alt:'Diagram'}
  ];
  const doc = normalizeBoard({elements:[item('rich', 'text', {body, text:'old cache'})]});
  const area = doc.elements[0];
  assert.equal(area.text, 'Budget\nРабота\n\n{"total":5}\nDiagram');
  assert.deepEqual(area.body, body);
  assert.deepEqual(normalizeBoard(JSON.parse(JSON.stringify(doc))), doc);
  assert.equal(boardSummary(doc).plain, area.text);
  const scene = exportScene(doc);
  assert.equal(scene.elements[0].originalText, area.text);
  assert.doesNotMatch(JSON.stringify(scene), /local-only/);
  const publicBody = structuredClone(body);
  delete publicBody[1].runs[0].folderPath;
  assert.deepEqual(normalizeBoard(importScene(scene)).elements[0].body, publicBody);
  scene.elements[0].originalText = 'Changed externally';
  assert.equal(normalizeBoard(importScene(scene)).elements[0].body, undefined);
  assert.equal(normalizeBoard({elements:[item('legacy', 'text', {text:'Existing label'})]}).elements[0].body, undefined);
});

test('text area background and border survive saving and scene exchange independently', () => {
  const body = [{type:'paragraph',runs:[{text:'Frame'}]}];
  for (const frame of [
    {}, {frameBackground:'none'}, {frameBorder:'#b4b1bc'},
    {frameBackground:'#f6e8c0',frameBorder:'none'}, {frameBackground:'none',frameBorder:'none'}
  ]) {
    const area = item('area','text',{body, ...frame});
    const doc = normalizeBoard({elements:[area]});
    assert.deepEqual(normalizeBoard(JSON.parse(JSON.stringify(doc))),doc);
    const [restored] = roundTrip([area]);
    assert.equal(restored.frameBackground,frame.frameBackground);
    assert.equal(restored.frameBorder,frame.frameBorder);
  }
  const [invalid] = roundTrip([item('area','text',{body,frameBackground:'url(example)',frameBorder:42})]);
  assert.equal(invalid.frameBackground,undefined);
  assert.equal(invalid.frameBorder,undefined);
});

test('shape captions stay searchable and round-trip as bound text in Excalidraw', () => {
  const shapes = ['rect', 'ellipse', 'diamond'].map(type => item(type, type, {
    label:'Стадия\nпроекта', fontFamily:5, fontSize:20, labelColor:'#dddddd', angle:90,
    locked:true, groupIds:['team']
  }));
  const doc = normalizeBoard({elements:[...shapes, item('rect-label', 'rect')]});
  assert.deepEqual(normalizeBoard(JSON.parse(JSON.stringify(doc))), doc);
  assert.equal(boardSummary(doc).plain, shapes.map(s => s.label).join('\n'));
  const scene = exportScene(doc);
  assert.equal(new Set(scene.elements.map(e => e.id)).size, 7);
  for (const shape of shapes) {
    const parent = scene.elements.find(e => e.id === shape.id);
    const text = scene.elements.find(e => e.containerId === shape.id);
    assert.deepEqual(parent.boundElements, [{id:text.id,type:'text'}]);
    assert.equal(text.originalText, shape.label);
    assert.equal(text.verticalAlign, 'middle');
    assert.equal(text.textAlign, 'center');
    assert.equal(text.angle, parent.angle);
    assert.deepEqual(text.groupIds, parent.groupIds);
  }
  // Bound text may appear before its parent in an externally edited drawing.
  scene.elements.sort((a,b) => Number(!!b.containerId) - Number(!!a.containerId));
  assert.deepEqual(normalizeBoard(importScene(scene)).elements, doc.elements);
});

test('curved and angular connector knots survive scene export, including external point edits', () => {
  const points = [[0,1], [.25,0], [.75,.75], [1,.25]];
  const line = item('curve', 'arrow', { points, w:320, h:160, angle:32, smoothPoints:[1] });
  const doc = normalizeBoard({elements:[line]});
  const scene = exportScene(doc);
  const encoded = scene.elements[0];
  assert.equal(encoded.roundness, null);
  assert.ok(encoded.points.length > points.length);
  const restored = normalizeBoard(importScene(scene)).elements[0];
  assert.deepEqual(restored, doc.elements[0]);
  // A control point edited outside Videron takes precedence over cached knots.
  encoded.points[1][0] += 6;
  const edited = normalizeBoard(importScene(scene)).elements[0];
  assert.equal(edited.points.length, encoded.points.length);
  assert.equal(edited.smoothPoints?.length || 0, 0);

  const allSmooth = normalizeBoard({elements:[{ ...line, smoothPoints:[1,2] }]});
  const standard = exportScene(allSmooth);
  assert.deepEqual(standard.elements[0].roundness, {type:2});
  assert.equal(standard.elements[0].points.length, points.length);
  assert.deepEqual(normalizeBoard(importScene(standard)).elements, allSmooth.elements);
  standard.elements[0].elbowed = true;
  assert.equal(importScene(standard).elements[0].smoothPoints, undefined);
});

test('deleting scattered rows rewrites sparse cells, reversed ranges, headers and charts', () => {
  const source = item('s', 'table', { name: 'Sales Q', rows: 6, cols: 3, w: 330, h: 238,
    headerRows: [0, 2, 4, 5], headerCols: [1],
    cells: { A1: '100', A2: '3', A3: '5', A4: '7', A5: '9', A6: '11',
      B2: '=$A$6+$A$1', C3: '=SUM($a$5 : B$2)' } });
  const report = item('report', 'table', { name: 'Report', rows: 6, cols: 3, locked: true,
    cells: { A1: "=SUM('Sales Q'!$b$5 : 'sales q'::$a$2)", A2: "=SUM('Sales Q'!A4:A5)",
      A3: '=A6', A4: '="Sales Q!A5"', A5: "='Sales Q'!$a$6*2" } });
  const plot = item('plot', 'chart', { tableId: 's', range: 'C6:A1', chartType: 'line' });
  const emptyPlot = { ...plot, id: 'empty', range: 'A4:A5' };
  const decoration = item('shape', 'rect');
  const before = [source, report, plot, emptyPlot, decoration], snapshot = structuredClone(before);
  const cut = deleteTableAxes(before, 's', 'rows', [4, 3, 0, 3, -1, 8]);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(cut[0].cells, { A1: '3', A2: '5', A3: '11', B1: '=$A$3+#REF!', C2: '=SUM($a$2 : B$1)' });
  assert.equal(cut[0].rows, 3);
  assert.equal(cut[0].h, 148);
  assert.deepEqual(cut[0].headerRows, [1, 2]);
  assert.equal(cut[0].headerCols, source.headerCols);
  assert.deepEqual(cut[1].cells, { A1: "=SUM('Sales Q'!$b$2 : 'sales q'::$a$1)", A2: '=SUM(#REF!)',
    A3: '=A6', A4: '="Sales Q!A5"', A5: "='Sales Q'!$a$3*2" });
  assert.equal(cut[2].range, 'C3:A1');
  assert.equal(cut[3].range, '#REF!');
  assert.equal(cut[4], decoration);
  const restored = roundTrip(cut);
  const workbook = createWorkbook(restored);
  assert.equal(workbook.value('report', 'A2'), '#REF!');
  assert.equal(workbook.value('report', 'A5'), 22);
  assert.equal(restored[3].tableId, 's');
  assert.equal(restored[3].range, '#REF!');
  assert.deepEqual(chartData(restored[3], workbook, restored).series, []);
  assert.deepEqual(rebaseTableLinksAfterDelete([report], 'Sales Q', 'rows', new Set([0, 3, 4]))[0], cut[1]);
});

test('deleting columns compacts data; deleting every column leaves a fresh empty column', () => {
  const source = item('s', 'table', { name: 'Source', rows: 3, cols: 4, w: 430, headerCols:[0, 1, 3],
    cells: { A1:'7', B2:'8', C3:'9', D3:'=$B2+$c3' } });
  const dependent = item('r', 'table', { name:'Result', rows:3, cols:3, cells:{
    A1:'=SUM(Source!$D3:$A1)', A2:'=Source!B2', A3:'=SUM(Source!A1:B3)' } });
  const untouched = item('u', 'table', { name:'U', rows:1, cols:1, cells:{ A1:'=B1+2' } });
  const original = [source, dependent, untouched];
  for (const invalid of [[], [null, -1, 4, 1.4]]) assert.equal(deleteTableAxes(original, 's', 'cols', invalid), original);
  assert.equal(deleteTableAxes(original, 'none', 'cols', [0]), original);
  assert.equal(deleteTableAxes(original, 's', 'width', [0]), original);
  const locked = [{ ...source, locked:true }, dependent];
  assert.equal(deleteTableAxes(locked, 's', 'cols', [1]), locked);
  const cut = deleteTableAxes(original, 's', 'cols', new Set([0, 2]));
  assert.equal(cut[0].w, 230);
  assert.deepEqual(cut[0].cells, { A2:'8', B3:'=$A2+#REF!' });
  assert.deepEqual(cut[0].headerCols,[0, 1]);
  assert.deepEqual(cut[1].cells,{ A1:'=SUM(Source!$B3:$A1)', A2:'=Source!A2', A3:'=SUM(Source!A1:A3)' });
  assert.equal(cut[2],untouched);
  const all = deleteTableAxes(cut, 's', 'cols', [1, 0]);
  assert.equal(all[0].cols, 1);
  assert.deepEqual(all[0].cells,{});
  assert.deepEqual(all[0].headerCols,[]);
  assert.deepEqual(all[1].cells,{ A1:'=SUM(#REF!)', A2:'=#REF!', A3:'=SUM(#REF!)' });
  assert.equal(all[2],untouched);
  const outside = [untouched];
  assert.equal(rebaseTableLinksAfterDelete(outside,'Source','cols',[0]), outside);
});

test('inserting an axis moves values, headers, bound charts and qualified range endpoints together', () => {
  const source = item('p', 'table', { name: "May's", rows: 4, cols: 2, w: 218, h: 162,
    showName: false, showRowNumbers: false, showColumnLetters: false, headerRows: [0, 2], headerCols: [1],
    cells: { A2: '5', A3: '8', B4: '=$A$3+A2' } });
  const dest = item('r', 'table', { name: 'Report', rows: 4, cols: 2,
    cells: { A1: '=SUM(\'May\'\'s\'::A2:$A$3)', A2: '3', A3: '=A2', A4: '="A3"' } });
  const chart = item('graph', 'chart', { tableId: 'p', range: 'A2:B4' });
  const original = [source, dest, chart];
  const [changed, other, graph] = insertTableCells(original, 'p', 'rows', 2, 2);
  assert.equal(changed.rows, 6);
  assert.equal(changed.h > source.h, true);
  assert.deepEqual(changed.cells, { A2: '5', A5: '8', B6: '=$A$5+A2' });
  assert.deepEqual(changed.headerRows, [0, 4]);
  assert.equal(graph.range, 'A2:B6');
  assert.deepEqual(other.cells, { ...dest.cells, A1: "=SUM('May''s'::A2:$A$5)" });
  assert.deepEqual(rebaseTableLinks([dest], source.name, 'rows', 2, 2)[0], other);
  const [wide, report, shiftedChart] = insertTableCells([changed, other, graph], 'p', 'cols', 0, 1);
  assert.equal(report.cells.A1, "=SUM('May''s'::B2:$B$5)");
  assert.equal(wide.cells.C6, '=$B$5+B2');
  assert.equal(shiftedChart.range, 'B2:C6');
  assert.deepEqual(wide.headerCols, [2]);
  assert.equal(createWorkbook([wide, report]).value('r', 'A1'), 13);
  const [restored] = roundTrip([wide]);
  assert.deepEqual(restored.headerRows, [0, 4]);
  assert.deepEqual(restored.headerCols, [2]);
  assert.deepEqual([restored.showName, restored.showRowNumbers, restored.showColumnLetters], [false, false, false]);
  assert.equal(insertTableCells(original, 'p', 'rows', 3, 500), original);
  assert.equal(source.cells.B4, '=$A$3+A2');
});

test('inline formula chains use the origin block for duplicate legacy names and IDs', () => {
  const scope = noteWorkbooks();
  const sheet = (id, name, cells) => item(id, 'table', { name, cells, cols: 3, rows: 5 });
  const first = [sheet('data', 'Data', { A1: '5' }), sheet('calc', 'North', { A1: '=Data!A1*3' })];
  const second = [sheet('data', 'Data', { A1: '9' }), sheet('calc', 'South', { A1: '=Data!A1*4' })];
  const report = [sheet('calc', 'Report', { A1: '=North!A1+South!A1', B1: '=Data!A1', C1: '=South!A1' })];
  scope.workbook('one', first);
  scope.workbook('two', second);
  const book = scope.workbook('report', report);
  assert.equal(book.value('calc', 'A1'), 51);
  assert.equal(book.summary('calc', 'A1').sum, 51);
  assert.equal(book.value('calc', 'B1'), '#REF!');
  assert.equal(scope.canReference('report', 'one', first[0]), false);
  assert.equal(scope.canReference('report', 'two', second[1]), true);
  assert.equal(scope.canReference('one', 'two', second[0]), false);

  // Repositioning the existing table retains the memoized calculation.
  scope.workbook('one', first.map(e => ({ ...e, x: 425 })));
  assert.equal(scope.workbook('report', report), book);
  scope.workbook('one', [{ ...first[0], cells: { A1: '10' } }, first[1]]);
  assert.equal(scope.workbook('report', report).value('calc', 'A1'), 66);
  scope.forget('two');
  assert.equal(scope.workbook('report', report).value('calc', 'A1'), '#REF!');
  assert.equal(scope.workbook('report', report).value('calc', 'B1'), 10);
  assert.equal(book.value('calc', 'C1'), 36);
});

test('nested groups, locks, handwritten labels and a bound bend survive file exchange', () => {
  const nested = { groupIds: ['pair', 'assembly'], locked: true };
  const elements = [
    item('a', 'rect', { ...nested, rounded: true }),
    item('b', 'diamond', nested),
    item('label', 'text', { groupIds: ['assembly'], fontFamily: 5, text: 'Эскиз' }),
    item('arrow', 'arrow', {
      points: [
        [1, 0],
        [0, 0.5],
        [0.5, 1]
      ],
      startBinding: { id: 'a', u: 1, v: 0 }
    })
  ];
  const [a, b, label, arrow] = roundTrip(elements);
  assert.deepEqual(a.groupIds, nested.groupIds);
  assert.deepEqual(b.groupIds, nested.groupIds);
  assert.ok(a.locked && b.locked && a.rounded);
  assert.deepEqual(label.groupIds, ['assembly']);
  assert.equal(label.fontFamily, 5);
  assert.equal(label.text, 'Эскиз');
  assert.deepEqual(arrow.points, elements[3].points);
  assert.equal(arrow.startBinding.id, 'a');
  assert.equal(arrow.startBinding.u, 1);
  assert.equal(arrow.startBinding.v, 0);
});

test('a pen stroke retains its pressure profile and a historic constant-width stroke retains its appearance', () => {
  const points = [
    [0, 0],
    [0.25, 0.8],
    [0.6, 1],
    [1, 0.7]
  ];
  const pressures = [0.12, 0.4, 0.9, 0.45];
  const [pen, historic, mouse] = roundTrip([
    item('pen', 'pen', { strokeProfile: 'freehand', points, pressures }),
    item('historic', 'pen', { points, groupId: 'old' }),
    item('mouse', 'pen', { strokeProfile: 'freehand', points, groupId: 'old' })
  ]);
  assert.deepEqual(pen.pressures, pressures);
  assert.equal(mouse.pressures, undefined);
  assert.equal(historic.strokeProfile, undefined);
  assert.deepEqual(historic.groupIds, ['old']);
  assert.deepEqual(mouse.groupIds, ['old']);
  assert.notEqual(freehandPath(pen), freehandPath(mouse));
});

test('a corner binding imported from absolute proportions still identifies the rounded corner', () => {
  const target = item('box', 'rect', { rounded: true, w: 200, h: 100 });
  const [u, v] = magnets(target)[0];
  assert.ok(u > 0 && v > 0);
  const arrow = item('arrow', 'arrow', {
    points: [
      [0, 0],
      [1, 1]
    ],
    endBinding: { id: target.id, u, v }
  });
  assert.equal(roundTrip([target, arrow])[1].endBinding.site, 0);
});
test('table and chart exchange retains formulas and source identity', () => {
  const source = item('sales', 'table', {
    name: 'Sales',
    rows: 3,
    cols: 2,
    cells: { A1: '5', A2: '=A1*2' }
  });
  const result = item('result', 'table', {
    name: 'Result',
    rows: 3,
    cols: 2,
    cells: { A1: '=SUM(Sales::A1:A2)' }
  });
  const chart = item('chart', 'chart', { tableId: source.id, range: 'A1:A2', chartType: 'bar' });
  const board = normalizeBoard({ background: '#171717', elements: [source, result, chart] });
  assert.equal(board.version, 2);
  const restored = normalizeBoard(importScene(exportScene(board)));
  assert.deepEqual(restored, board);
  assert.equal(createWorkbook(restored.elements).value('result', 'A1'), 15);

  const moved = board.elements.map((e) => ({ ...e, x: e.x + 10 }));
  const cached = workbookCache();
  assert.equal(cached(moved), cached(board.elements));
  const renamed = renamedTable(board.elements, 'sales', 'Доходы');
  assert.equal(createWorkbook(renamed).value('result', 'A1'), 15);
  assert.equal(renamedTable(renamed, 'sales', 'result'), null);
  const removed = withoutObjects(renamed, new Set(['sales']));
  assert.equal(
    createWorkbook([...removed, { ...source, name: 'Доходы' }]).value('result', 'A1'),
    '#REF!'
  );
});

test('duplicating two linked tables and their chart makes an independent copy', () => {
  const originals = [
    item('a', 'table', { name: 'Prices', cells: { A1: '8' }, rows: 2, cols: 2 }),
    item('b', 'table', { name: 'Total', cells: { A1: '=Prices::A1*3' }, rows: 2, cols: 2 }),
    item('c', 'chart', { tableId: 'b', range: 'A1', chartType: 'line' })
  ];
  const ids = new Map(originals.map((e) => [e.id, e.id + '2']));
  const copies = copiedSheetObjects(
    originals.map((e) => ({ ...e, id: ids.get(e.id) })),
    originals,
    originals,
    ids
  );
  assert.equal(copies[2].tableId, 'b2');
  assert.notEqual(copies[0].name, originals[0].name);
  const workbook = createWorkbook([
    ...originals,
    { ...copies[0], cells: { A1: '10' } },
    ...copies.slice(1)
  ]);
  assert.equal(workbook.value('b', 'A1'), 24);
  assert.equal(workbook.value('b2', 'A1'), 30);
});

test('imported tables reuse gaps in numbering and resolve Unicode-equivalent names', () => {
  const names = ['Café', 'Café 4', 'Cafe\u0301', 'Café', 'Café', 'Café 4', 'Café 2'];
  const doc = normalizeBoard({elements:names.map((name,i)=>item(String(i),'table',{name}))});
  assert.deepEqual(doc.elements.map(e=>e.name),[
    'Café','Café 4','Cafe\u0301 2','Café 3','Café 5','Café 6','Café 7'
  ]);
  assert.deepEqual(normalizeBoard(doc),doc);
});
