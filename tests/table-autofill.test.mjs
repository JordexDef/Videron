import assert from 'node:assert/strict';
import test from 'node:test';
import { autofillCells, planAutofill } from '../frontend/table-autofill.js';
import { addressOf, createWorkbook } from '../frontend/table-engine.js';
import { noteWorkbooks } from '../frontend/board-tables.js';

const rect = (top, left, bottom = top, right = left) => ({top, left, bottom, right});
const sheet = cells => ({id: 'sheet', type: 'table', name: 'Sheet', rows: 20, cols: 10, cells});

function continueRow(values, count = 2, locale = 'ru') {
  const data = sheet(Object.fromEntries(values.map((value, col) => [addressOf(0, col), value])));
  const cells = autofillCells(data, rect(0, 0, 0, values.length - 1), rect(0, 0, 0, values.length + count - 1), locale);
  return Array.from({ length: count }, (_, i) => cells[addressOf(0, values.length + i)]);
}

test('numeric series use exact signed decimal steps, with one template copied literally', () => {
  assert.deepEqual(continueRow(['1', '2']), ['3', '4']);
  assert.deepEqual(continueRow(['5', '3', '1']), ['-1', '-3']);
  assert.deepEqual(continueRow(['7']), ['7', '7']);
  assert.deepEqual(continueRow([' 7']), [' 7', ' 7']);
  assert.deepEqual(continueRow(['-0.2', '-0.1']), ['0.0', '0.1']);
  assert.deepEqual(continueRow(['1,50', '1,75']), ['2,00', '2,25']);
  assert.deepEqual(continueRow(['0.1', '0.2']), ['0.3', '0.4']);
  assert.deepEqual(continueRow(['2', '2.25']), ['2.5', '2.75']);
  assert.deepEqual(continueRow(['90071992547409921', '90071992547409922']), ['90071992547409923', '90071992547409924']);
  assert.deepEqual(continueRow(['+001', '+003']), ['+005', '+007']);
  assert.deepEqual(continueRow(['1 000', '2 000']), ['3 000', '4 000']);
  assert.deepEqual(continueRow(['2e2', '3e2']), ['400', '500']);
});

test('geometric progression requires at least three consistent nonzero terms', () => {
  assert.deepEqual(continueRow(['2', '4']), ['6', '8']);
  assert.deepEqual(continueRow(['2', '4', '8']), ['16', '32']);
  assert.deepEqual(continueRow(['1000000000000001', '2000000000000002', '4000000000000004']),
    ['8000000000000008', '16000000000000016']);
  assert.deepEqual(continueRow(['8', '4', '2']), ['1', '0.5']);
  assert.deepEqual(continueRow(['-4', '2', '-1']), ['0.5', '-0.25']);
  assert.deepEqual(continueRow(['1', '2', '5']), ['1', '2']);
});

test('long geometric series preserve their actual magnitude beyond the floating-point range', () => {
  const data = { ...sheet({ A1: '10', A2: '100', A3: '1000', B1: '0.1', B2: '0.01', B3: '0.001',
    C1: '2', C2: '-20', C3: '200' }), rows: 500 };
  const cells = autofillCells(data, rect(0, 0, 2, 2), rect(0, 0, 499, 2));
  assert.equal(cells.A500, '1e500');
  assert.equal(cells.B500, '1e-500');
  assert.equal(cells.C500, '-2e499');
  assert.equal(createWorkbook([{ ...data, cells }]).value('sheet', 'A500'), '#NUM!');
  assert.deepEqual(continueRow(['9', '3', '1']), ['0.333333333333333', '0.111111111111111']);
});

test('localized dates preserve layout, leap days, elapsed-day and calendar-month steps', () => {
  assert.deepEqual(continueRow(['28.02.2024']), ['29.02.2024', '01.03.2024']);
  assert.deepEqual(continueRow(['2024-02-25', '2024-03-03']), ['2024-03-10', '2024-03-17']);
  assert.deepEqual(continueRow(['31.01.2024', '29.02.2024']), ['31.03.2024', '30.04.2024']);
  assert.deepEqual(continueRow(['2023-01-30', '2023-02-28']), ['2023-03-30', '2023-04-30']);
  assert.deepEqual(continueRow(['2021-02-28', '2022-02-28', '2023-02-28']), ['2024-02-29', '2025-02-28']);
  assert.deepEqual(continueRow(['1/2/2024']), ['2/2/2024', '3/2/2024']);
  assert.deepEqual(continueRow(['1/2/2024'], 2, 'en'), ['1/3/2024', '1/4/2024']);
  assert.deepEqual(continueRow(['1/2/2024'], 2, 'en-GB'), ['2/2/2024', '3/2/2024']);
  assert.deepEqual(continueRow(['1/2/2024'], 2, 'fil-PH'), ['1/3/2024', '1/4/2024']);
  assert.deepEqual(continueRow(['12/31/2024'], 1, 'ru'), ['01/01/2025']);
  assert.deepEqual(continueRow(['31.02.2024']), ['31.02.2024', '31.02.2024']);
  assert.deepEqual(continueRow(['01.01.2024', '03.01.2024', '04.01.2024']), ['01.01.2024', '03.01.2024']);
});

test('local calendar labels, numbered text and unmatched cycles', () => {
  assert.deepEqual(continueRow(['Сб', 'Вс']), ['Пн', 'Вт']);
  assert.deepEqual(continueRow(['Январь', 'Март']), ['Май', 'Июль']);
  assert.deepEqual(continueRow(['Fri.', 'Sat.']), ['Sun.', 'Mon.']);
  assert.deepEqual(continueRow(['DECEMBER']), ['JANUARY', 'FEBRUARY']);
  assert.deepEqual(continueRow(['Этап 007', 'Этап 009']), ['Этап 011', 'Этап 013']);
  assert.deepEqual(continueRow(['Q1']), ['Q2', 'Q3']);
  assert.deepEqual(continueRow(['red', 'amber', 'green']), ['red', 'amber']);
  assert.deepEqual(continueRow(["'01", "'02"]), ["'01", "'02"]);
});

test('upward fill uses independent numeric/date/formula lanes, honors absolute refs and preserves sources', () => {
  const original = {A5: '10', A6: '12', B5: '2024-03-31', B6: '2024-04-30',
    C5: "=A5+$A$1+'Other'::$D5", C6: "=A6+$A$1+'Other'::$D6", F1: 'keep'};
  const result = autofillCells(sheet(original), rect(4, 0, 5, 2), rect(2, 0, 5, 2));
  assert.deepEqual(result, {...original, A3: '6', A4: '8', B3: '2024-01-31', B4: '2024-02-29',
    C3: "=A3+$A$1+'Other'::$D3", C4: "=A4+$A$1+'Other'::$D4"});
  assert.equal(original.A3, undefined);
});

test('reverse fill aligns mixed cyclic templates, blanks clear destination and formulas recalculate', () => {
  const original = {B1: 'leftover', D1: '=D2+1', F1: '—', D2: '2', E2: '4', F2: '6'};
  const data = sheet(original);
  const result = autofillCells(data, rect(0, 3, 1, 5), rect(0, 0, 1, 5));
  assert.deepEqual(result, { ...Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'B1')),
    A1: '=A2+1', C1: '—', A2: '-4', B2: '-2', C2: '0' });
  assert.equal(createWorkbook([{ ...data, cells: result }]).value('sheet', 'A1'), -3);
});

test('locked tables, unchanged fills, and invalid destinations preserve the original sparse map', () => {
  const data = sheet({A1: '1', A2: '2', A3: '3'});
  const source = rect(0, 0, 1, 0), target = rect(0, 0, 2, 0);
  for (const invalid of [source, rect(0, 0), rect(0, 0, 2, 1), rect(-1, 0, 2, 0), rect(0, 0, 500, 0)]) {
    assert.equal(autofillCells(data, source, invalid), data.cells);
  }
  assert.equal(autofillCells(data, source, target), data.cells);
  assert.equal(autofillCells({...data, locked: true}, source, rect(0, 0, 3, 0)), data.cells);
});

test('copy repeats original values, blanks and frozen formula results in either direction', () => {
  const data = sheet({A3: '001', A4: '002', B3: '2024-01-01', B4: '2024-01-02',
    C3: '=A3*5', C4: '=A4*5', D3: '="007"', D4: '="=2+3"', E4: "'=literal", E5: 'clear'});
  const book = createWorkbook([data]);
  const copy = addr => book.value(data.id, addr);
  const source = rect(2, 0, 3, 4);
  for (const [target, row] of [[rect(0, 0, 3, 4), 1], [rect(2, 0, 6, 4), 5]]) {
    const plan = planAutofill(data, source, target, 'ru', copy);
    const cells = plan.apply(), saved = createWorkbook([{...data, cells}]);
    assert.equal(cells['A' + row], '001');
    assert.equal(cells['B' + row], '2024-01-01');
    assert.equal(cells['C' + row], '5');
    assert.equal(cells['E' + row], undefined);
    assert.equal(saved.value(data.id, 'D' + row), '007');
    assert.equal(saved.value(data.id, 'D' + (row + 1)), '=2+3');
    assert.equal(saved.value(data.id, 'E' + (row + 1)), '=literal');
    for (let col = 0; col < 5; col++) {
      const last = addressOf(target.top ? target.bottom : target.top, col);
      assert.equal(book.previewValue(data.id, last, plan), saved.value(data.id, last));
    }
  }
  assert.equal(book.value(data.id, 'E5'), 'clear');
});

test('cursor preview evaluates pending ranges, newly added cells and back-references from another block', () => {
  const src = {...sheet({A1: '1', A2: '2', B1: '=A1+Report!$A$1', B2: '=A2+Report!$A$1',
    C1: '=SUM(A$1:A1)', C2: '=SUM(A$1:A2)'}), rows: 2};
  const peer = {...sheet({A1: '=SUM(Sheet!A1:A5)'}), name: 'Report'};
  const scope = noteWorkbooks();
  scope.workbook('second', [peer]);
  const book = scope.workbook('first', [src]);
  assert.equal(book.value(src.id, 'B1'), '#REF!');
  const plan = planAutofill({...src, rows: 5}, rect(0, 0, 1, 2), rect(0, 0, 4, 2));
  assert.equal(book.previewValue(src.id, 'B5', plan), 20);
  assert.equal(book.previewValue(src.id, 'C5', plan), 15);
  assert.equal(book.value(src.id, 'B1'), '#REF!');
  assert.equal(book.value(src.id, 'B5'), '#REF!');
  const applied = scope.workbook('first', [{...src, rows: 5, cells: plan.apply()}]);
  assert.equal(applied.value(src.id, 'B5'), 20);
  assert.equal(applied.value(src.id, 'C5'), 15);
});
