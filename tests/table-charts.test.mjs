import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbook } from '../frontend/table-engine.js';
import { chartData } from '../frontend/table-charts.js';

function read(cells, range = 'A1:C6') {
  const table = { type: 'table', id: 't', name: 'Sales', rows: 10, cols: 5, cells };
  return chartData({ tableId: 't', range }, createWorkbook([table]), [table]);
}

test('numeric data marked as row and column headers becomes chart labels', () => {
  const table = { type: 'table', id: 't', name: 'Samples', rows: 4, cols: 3,
    headerRows: [0], headerCols: [0], cells: {
      A1: '0', B1: '2025', C1: '2026', A2: '101', A3: '102', B2: '8', B3: '12', C2: '10', C3: '16'
    } };
  const chart = chartData({ tableId: 't', range: 'A1:C3' }, createWorkbook([table]), [table]);
  assert.deepEqual(chart.labels, ['101', '102']);
  assert.deepEqual(chart.series.map(s => s.name), ['2025', '2026']);
  assert.deepEqual(chart.series.map(s => s.values), [[8, 12], [10, 16]]);
});

test('category labels and series come from headers; zeros, errors, empty rows and trailing space stay distinct', () => {
  const data = read({
    A1: 'Month',
    B1: 'Plan',
    C1: 'Actual',
    A2: 'Jan',
    B2: '10',
    C2: '=B2*2',
    A3: 'Feb',
    B3: '=1/0',
    C3: '0',
    A4: 'Mar',
    B4: '4',
    C4: '-3'
  });
  assert.deepEqual(data.labels, ['Jan', 'Feb', 'Mar']);
  assert.deepEqual(
    data.series.map((s) => s.name),
    ['Plan', 'Actual']
  );
  assert.deepEqual(
    data.series.map((s) => s.values),
    [
      [10, null, 4],
      [20, 0, -3]
    ]
  );
});

test('two-row and one-row selections make a single horizontal series', () => {
  const withHeader = read(
    { B1: 'Jan', C1: 'Feb', D1: 'Mar', A2: 'Actual', B2: '5', C2: '8', D2: '-3' },
    'A1:D2'
  );
  assert.deepEqual(withHeader.labels, ['Jan', 'Feb', 'Mar']);
  assert.equal(withHeader.title, 'Actual');
  assert.deepEqual(withHeader.series[0].values, [5, 8, -3]);
  const noHeader = read({ B4: '12', D4: '8' }, 'D4:B4');
  assert.deepEqual(noHeader.labels, ['B', 'C', 'D']);
  assert.deepEqual(noHeader.series[0].values, [12, null, 8]);
});

test('a numeric-only selection preserves every column and takes its category numbers from real rows', () => {
  const data = read({ B4: '12', C4: '6', B5: '7', C5: '1' }, 'B4:C5');
  assert.deepEqual(data.labels, ['4', '5']);
  assert.deepEqual(
    data.series.map((s) => s.values),
    [
      [12, 7],
      [6, 1]
    ]
  );
});

test('categories with numeric years and a textual header stay labels; blanks and missing source are supported', () => {
  const result = read(
    { A1: 'Год', B1: 'Выручка', A2: '2023', B2: '325', A3: '2024', B3: '380' },
    'A1:B3'
  );
  assert.deepEqual(result.labels, ['2023', '2024']);
  assert.deepEqual(
    result.series.map((s) => s.values),
    [[325, 380]]
  );
  assert.deepEqual(read({}).series, []);
  assert.equal(chartData({ tableId: 'missing', range: 'A1:B2' }, createWorkbook([]), []).missing, true);
});
