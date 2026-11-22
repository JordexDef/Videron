import assert from 'node:assert/strict';
import test from 'node:test';
import { noteWorkbooks } from '../frontend/board-tables.js';
import { formulaReferences } from '../frontend/table-references.js';

function table(id, name) {
  return { id, type: 'table', name, rows: 5, cols: 4, cells: {} };
}

test('color spans preserve source text, scoped names, reversed ranges and repeated references', () => {
  const note = noteWorkbooks();
  const a = [table('same', 'Rates'), table('local', 'Budget')];
  const b = [table('same', 'Rates'), table('extra', "June's")];
  note.workbook('a', a);
  const other = note.workbook('b', b),
    book = note.workbook('a', a);
  const raw = `=SUM('June''s'::$B$2 : A1; rates!B1; A2; Rates!$B$1; "A3"; C9)`;
  const result = formulaReferences(raw, (sheet) => book.referenceIdentity('local', sheet));
  assert.deepEqual(
    result.spans.map((r) => [raw.slice(r.start, r.end), r.color]),
    [
      ["'June''s'::$B$2 : A1", 0],
      ['rates!B1', 1],
      ['A2', 2],
      ['Rates!$B$1', 1]
    ]
  );
  assert.deepEqual(
    [...result.ranges.get(other.referenceIdentity('extra')).values()],
    [{ top: 0, bottom: 1, left: 0, right: 1, color: 0 }]
  );
  assert.ok(result.ranges.get(book.referenceIdentity('same')));
  assert.equal(result.ranges.get(other.referenceIdentity('same')), undefined);
  const mismatched = formulaReferences("=A1:'June''s'!C3", (sheet) =>
    book.referenceIdentity('local', sheet)
  );
  assert.equal(mismatched.spans.length, 0);
  assert.equal(
    formulaReferences('=A1 + "B2', (sheet) => book.referenceIdentity('local', sheet)).spans.length,
    1
  );
});
