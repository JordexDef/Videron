import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addressOf,
  parseAddress,
  normalizeTable,
  createWorkbook,
  referenceTo,
  rewriteTableReferences,
  shiftFormula,
  uniqueTableName,
  formatValue
} from '../frontend/table-engine.js';

function table(id, name, cells) {
  return { type: 'table', id, name, rows: 500, cols: 52, cells };
}

test('bounded sparse tables and case-insensitive, quoted table names', () => {
  assert.deepEqual(parseAddress('$az$500'), { row: 499, col: 51 });
  assert.equal(addressOf(499, 51), 'AZ500');
  assert.equal(parseAddress('BA1'), null);
  assert.equal(addressOf(-1, 0), '');
  assert.deepEqual(
    normalizeTable({
      name: '  Расходы ',
      rows: 2,
      cols: 2,
      cells: {
        a1: '4',
        B1: 0,
        B2: '',
        B3: 'discard',
        C1: 'discard',
        A2: ' =literal'
      }
    }),
    { name: 'Расходы', rows: 2, cols: 2, cells: { A1: '4', B1: '0', A2: ' =literal' },
      showName: true, showRowNumbers: true, showColumnLetters: true, headerRows: [], headerCols: [] }
  );
  const t = table('i', "Bob's table", {});
  assert.equal(referenceTo('i', t, 'A1'), 'A1');
  assert.equal(referenceTo('j', t, 'A1'), "'Bob''s table'::A1");
  assert.equal(uniqueTableName([t], "bob's table"), "bob's table 2");
  assert.equal(uniqueTableName([t], "bob's table", 'i'), "bob's table");
  assert.equal(
    uniqueTableName([table('1', 'Таблица 1', {}), table('2', 'Таблица 2', {})], 'Таблица 1'),
    'Таблица 3'
  );
});

test('operators, functions, editable raw text, English and Russian number entry', () => {
  const samples = [
    ['=2 + 3*4', 14],
    ['=-(2+3)^2', -25],
    ['=2^3^2', 512],
    ['=8/2/2', 2],
    ['=2^-3', 0.125],
    ['=200*15%', 30],
    ['=1,25*2', 2.5],
    ['=ABS(-2,75)', 2.75],
    ['=ROUND(-1.005,2)', -1.01],
    ['=ROUND(1234,-2)', 1200],
    ['=ОКРУГЛ(1,45;1)', 1.5],
    ['=SUM(1,2,3)', 6],
    ['=СУММ(3,5;2,5)', 6],
    ['=SUM(2,ABS(-1.5),3)', 6.5],
    ['=AVERAGE(12,24,0)', 12],
    ['=MIN(5,2)', 2],
    ['=MAX(-2,-9)', -2],
    ['=COUNT(1,"skip",2)', 2],
    ['1\u202f234,5', 1234.5],
    [' +1.2E-2 ', 0.012],
    ["'001", '001'],
    ["'=A1", '=A1'],
    ['a string', 'a string'],
    ["'1 000", '1 000'],
    ['1 23', '1 23'],
    ['   ', '   '],
    ['=SUM()', 0],
    ['=ABS(2,3;4)', '#VALUE!'],
    ['=AVERAGE()', '#DIV/0!'],
    ['=1e399', '#NUM!'],
    ['=1/0', '#DIV/0!'],
    ['=2+', '#ERROR!'],
    ['=PI()', '#NAME?'],
    ['=A0', '#NAME?'],
    ['=1+globalThis.alert(1)', '#NAME?'],
    ['=4^10000', '#NUM!']
  ];
  const cells = Object.fromEntries(samples.map(([raw], i) => [addressOf(i, 0), raw]));
  const workbook = createWorkbook([table('data', 'Data', cells)]);
  samples.forEach(([_, expected], i) =>
    assert.equal(workbook.value('data', addressOf(i, 0)), expected, samples[i][0])
  );
  assert.equal(formatValue(0.1 + 0.2, 'ru'), '0,3');
  assert.equal(formatValue(-0, 'en'), '0');
});

test('references cross tables in either direction; ranges skip blanks and text and preserve zero', () => {
  const source = table('a', "Plan d'été", {
    A1: '10',
    B1: '0',
    A2: 'ignored',
    B2: '30',
    C1: "='Итог'::C2+5"
  });
  const target = table('b', 'Итог', {
    A1: "=SUM('PLAN D''ÉTÉ'::B2:A1)",
    A2: "=СРЗНАЧ('Plan d''été'::A1:B2)",
    B1: "=COUNT('Plan d''été'::A1:B2)",
    B2: "=MIN('Plan d''été'::A1:B2)",
    C2: '=A1/B1',
    C3: '=Третья таблица::B1^2',
    D3: '=ZZ1',
    E4: '=D3 + 2'
  });
  const book = createWorkbook([source, target, table('c', 'Третья таблица', { B1: '-4' })]);
  assert.equal(book.value('b', 'A1'), 40);
  assert.equal(book.value('b', 'A2'), 40 / 3);
  assert.equal(book.value('b', 'B1'), 3);
  assert.equal(book.value('b', 'B2'), 0);
  assert.equal(book.value('a', 'C1'), 40 / 3 + 5);
  assert.equal(book.value('b', 'C3'), 16);
  assert.equal(book.value('b', 'E4'), '#REF!');
  assert.equal(book.value('b', 'F5'), '');
  assert.deepEqual(book.summary('a', 'B2', 'A1'), {
    count: 3,
    sum: 40,
    average: 40 / 3,
    min: 0,
    max: 30
  });
  assert.deepEqual(book.summary('a', 'E1', 'E2'), {
    count: 0,
    sum: 0,
    average: null,
    min: null,
    max: null
  });
  assert.equal(book.value('missing', 'A1'), '#REF!');
});

test('formula updates, circular errors across tables, dependencies and unrelated cells', () => {
  const a = table('a', 'First', {
    A1: '=Second::B1',
    A2: '=A1/4',
    A3: '=8',
    A4: '=Second::A4',
    A5: '=COUNT(A5:A6)'
  });
  const b = table('b', 'Second', { B1: '=SUM(First::A1:A2)', A4: '=1/0', A5: '=COUNT(A4:A4)' });
  const cyclic = createWorkbook([a, b]);
  for (const [id, key] of [
    ['a', 'A1'],
    ['b', 'B1'],
    ['a', 'A2'],
    ['a', 'A5']
  ])
    assert.equal(cyclic.value(id, key), '#CYCLE!');
  assert.equal(cyclic.value('a', 'A3'), 8);
  assert.equal(cyclic.value('a', 'A4'), '#DIV/0!');
  assert.equal(cyclic.value('b', 'A5'), 0);
  const corrected = createWorkbook([a, { ...b, cells: { ...b.cells, B1: '20' } }]);
  assert.equal(corrected.value('a', 'A2'), 5);
  assert.equal(cyclic.value('a', 'A2'), '#CYCLE!');
});

test('rename, duplicate, shift and delete references without altering quoted text or raw entries', () => {
  const f = '=SUM(One::A1:$B3;\'Two words\'!C$2;"One::A1")';
  assert.equal(
    rewriteTableReferences(
      f,
      new Map([
        ['one', 'Two words'],
        ['Two words', "It's new"]
      ])
    ),
    "=SUM('Two words'::A1:$B3;'It''s new'::C$2;\"One::A1\")"
  );
  assert.equal(shiftFormula(f, 1, 2), "=SUM('One'::C2:$B4;'Two words'::E$2;\"One::A1\")");
  assert.equal(shiftFormula('=A1+$B$2', -1, -1), '=#REF!+$B$2');
  assert.equal(rewriteTableReferences('One::A1', 'One', 'Two'), 'One::A1');
  const deleted = rewriteTableReferences('=SUM(One::A1:B3)', 'One', null);
  assert.equal(createWorkbook([table('a', 'One', { A1: deleted })]).value('a', 'A1'), '#REF!');
});

test('long dependency chains and reverse-ordered references evaluate without overflowing the call stack', () => {
  const cells = {};
  const keys = Array.from({ length: 3200 }, (_, i) => addressOf(Math.floor(i / 52), i % 52));
  for (let i = 0; i < keys.length; i++)
    cells[keys[i]] = i + 1 < keys.length ? '=' + keys[i + 1] + '+1' : '1';
  assert.equal(createWorkbook([table('data', 'Data', cells)]).value('data', 'A1'), 3200);
});
