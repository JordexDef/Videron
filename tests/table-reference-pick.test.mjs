import test from 'node:test';
import assert from 'node:assert/strict';
import { referencePickParts } from '../frontend/table-reference-pick.js';
import { createWorkbook } from '../frontend/table-engine.js';

function pick(marked, references) {
  let start = marked.indexOf('|'), end = marked.lastIndexOf('|');
  let value = marked.replaceAll('|', '');
  if (start !== end) end--;
  let previous;
  for (const ref of references) {
    const {prefix, suffix} = referencePickParts(value, start, end, previous);
    value = prefix + ref + suffix;
    start = end = prefix.length + ref.length;
    previous = {from:prefix.length, to:end};
  }
  return value;
}

test('successive clicks add arguments and separate a following argument at the caret', () => {
  assert.equal(pick('=SUM(|)', ['A1','B1','C1']), '=SUM(A1,B1,C1)');
  assert.equal(pick('=SUM(|A3)', ['A1','B1']), '=SUM(A1,B1,A3)');
  assert.equal(pick('=MAX(A1,|C1)', ['B1']), '=MAX(A1,B1,C1)');
  assert.equal(pick('=SUM(ABS(A1)|)', ['B1']), '=SUM(ABS(A1),B1)');
  assert.equal(pick('=SUM(A1:B2|)', ['B1']), '=SUM(A1:B2,B1)');
});

test('dragging updates one argument and subsequent clicks accept local and qualified references', () => {
  const plan = referencePickParts('=SUM(A1)', 7, 7);
  assert.equal(plan.prefix + 'B1' + plan.suffix, '=SUM(A1,B1)');
  assert.equal(plan.prefix + 'B1:C2' + plan.suffix, '=SUM(A1,B1:C2)');
  const formula = pick('=SUM(|)', ['A1:B1', "'Rates'' 26'::A1"]);
  const book = createWorkbook([
    {id:'t',type:'table',name:'T',rows:2,cols:3,cells:{A1:'123', B1:'321', C1:formula}},
    {id:'r',type:'table',name:"Rates' 26",rows:1,cols:1,cells:{A1:'2'}},
  ]);
  assert.equal(book.value('t','C1'), 446);
});

test('respects selections, explicit operators, and decimal-comma formulas', () => {
  assert.equal(pick('=SUM(|A2|,A3)', ['B1']), '=SUM(B1,A3)');
  assert.equal(pick('=SUM($B|$12)', ['A1']), '=SUM(A1)');
  assert.equal(pick('=SUM(A1+|)', ['B1','C1']), '=SUM(A1+B1,C1)');
  assert.equal(pick('=SUM(A1:|)', ['B1','C1']), '=SUM(A1:B1,C1)');
  assert.equal(pick('=СУММ(1,5;|)', ['A1','B1']), '=СУММ(1,5;A1;B1)');
  assert.equal(pick("=COUNT('a;b'::A1|)", ['B1']), "=COUNT('a;b'::A1,B1)");
});

test('a single operand and functions with fixed arity replace an occupied slot', () => {
  assert.equal(pick('=|', ['A1','B1','C1']), '=C1');
  assert.equal(pick('=A1+|', ['A2','B1']), '=A1+B1');
  assert.equal(pick('=SUM((|))', ['A1','B1']), '=SUM((B1))');
  assert.equal(pick('=SUM(ABS(|))', ['C1','C2']), '=SUM(ABS(C2))');
  assert.equal(pick('=ОКРУГЛ(|)', ['A1','C1','C2']), '=ОКРУГЛ(A1,C2)');
});
