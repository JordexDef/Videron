import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbook, formulaFunctionNames } from '../frontend/table-engine.js';
import {
  applyFormulaCompletion, canSkipFormulaClosing, catalogTarget, formulaCompletions, formulaSignature, functionCatalog,
} from '../frontend/formula-completion.js';

// The vertical bar marks the caret within the draft.
function atCaret(marked, action, language = 'en') {
  return action(marked.replace('|', ''), marked.indexOf('|'), language);
}

function complete(marked, name, language) {
  const result = atCaret(marked, formulaCompletions, language);
  const item = result?.items.find(item => item.name === name);
  assert.ok(item, 'missing suggestion for ' + marked);
  const { value, caret } = applyFormulaCompletion(marked.replace('|', ''), result, item);
  return value.slice(0, caret) + '|' + value.slice(caret);
}

test('the function catalog lists each operation once and matches the current argument separator', () => {
  const entries = functionCatalog('=SUM(A1,B1)', 'ru');
  const all = new Set([...formulaFunctionNames()].map(([, canonical]) => canonical));
  assert.deepEqual(entries.map(item => item.name), [...all]);
  assert.equal(entries.find(item => item.name === 'ROUND').signature, 'ROUND(число, [разряды])');
  assert.ok(entries.every(item => item.description));
  assert.equal(functionCatalog('=SUM(A1;B1)', 'en')[0].signature, 'SUM(value; …)');
});

test('catalog insertion wraps values and selections, and keeps surrounding formula syntax', () => {
  for (const [original, start, end, whole, expected] of [
    ['', 0, 0, true, '=SUM()'],
    ['1,25', 4, 4, true, '=SUM(1.25)'],
    ['а"б', 3, 3, true, '=SUM("а""б")'],
    ['=A1*B2', 6, 6, true, '=SUM(A1*B2)'],
    ['=A1+B2*C3', 4, 9, false, '=A1+SUM(B2*C3)'],
    ['=2+s', 4, 4, false, '=2+SUM()'],
    ['=A1:B2+3', 5, 5, false, '=SUM(A1:B2)+3'],
    ['=ABS(A1)+2', 8, 8, false, '=SUM(ABS(A1))+2'],
    ['=ROUND(,2)', 7, 7, false, '=ROUND(SUM(),2)'],
  ]) {
    const result = applyFormulaCompletion(original, catalogTarget(original, start, end, whole), {name:'SUM'});
    assert.equal(result.value, expected);
    assert.equal(result.value[result.caret], ')');
  }
});

test('every displayed English or Russian function is supported by the evaluator', () => {
  for (const [name, fn] of formulaFunctionNames()) {
    const { items } = formulaCompletions('=' + name.toLowerCase(), name.length + 1, 'ru');
    assert.equal(items[0].name, name);
    assert.match(items[0].signature, new RegExp('^' + name + '\\(.+\\)$'));
    const workbook = createWorkbook([{ id: 't', type: 'table', cells: { A1: '=' + name + '(5)' } }]);
    assert.equal(workbook.value('t', 'A1'), fn === 'COUNT' ? 1 : 5, name);
  }
  const english = atCaret('=a|', formulaCompletions);
  assert.deepEqual(english.items.map(i => i.name).sort(), ['ABS', 'AVERAGE']);
  assert.equal(english.items.find(i => i.name === 'ABS').signature, 'ABS(number)');
  const russian = atCaret('=с|', formulaCompletions, 'ru');
  assert.deepEqual(russian.items.map(i => i.name).sort(), ['СРЗНАЧ', 'СУММ', 'СЧЁТ']);
  assert.equal(russian.items.find(i => i.name === 'СУММ').signature, 'СУММ(значение; …)');
});

test('only function names starting an expression can be completed', () => {
  for (const marked of [
    's|', ' =s|', '=|', '="x+s|', '="x""+s|"', "='Bob''s +s|", "='my s| table'!A1",
    '=s|!A1', '=s| total::', '=s|::', '=sales::s|', "='T'!s|", '=A1:s|',
    '=$s|', '=s|$1', '=s|1', '=s.|', '=A1 s|', '=1s|', '=A1+s|2x',
  ]) assert.equal(atCaret(marked, formulaCompletions), null, marked);
  assert.equal(complete('=s|', 'SUM'), '=SUM(|)');
  assert.equal(complete('=1+(-av|*4)', 'AVERAGE'), '=1+(-AVERAGE(|)*4)');
  assert.equal(complete('=MAX(0,s|)', 'SUM'), '=MAX(0,SUM(|))');
  assert.equal(complete('=МАКС(0;ср|)', 'СРЗНАЧ'), '=МАКС(0;СРЗНАЧ(|))');
});

test('completion replaces the entire identifier and preserves existing arguments and surroundings', () => {
  assert.equal(complete('=2+r|ound (A1,2)*4', 'ROUND'), '=2+ROUND (|A1,2)*4');
  assert.equal(complete('=a|bs', 'AVERAGE'), '=AVERAGE(|)');
  assert.equal(complete('=s|um(', 'SUM'), '=SUM(|');
  assert.equal(complete("=abs('S 1'!A1)+сче|", 'СЧЕТ'), "=abs('S 1'!A1)+СЧЕТ(|)");
  assert.equal(complete('=1+счё|', 'СЧЁТ'), '=1+СЧЁТ(|)');
});

test('the syntax hint follows the innermost function and existing argument notation', () => {
  assert.equal(atCaret('=SUM(ABS((|A1)), 3)', formulaSignature).name, 'ABS');
  assert.equal(atCaret('=SUM(ABS(A1)|, 3)', formulaSignature).name, 'SUM');
  assert.equal(atCaret('=ROUND(A1;|2)', formulaSignature).signature, 'ROUND(number; [digits])');
  assert.equal(atCaret('=ОКРУГЛ(|)', formulaSignature, 'ru').signature, 'ОКРУГЛ(число; [разряды])');
  assert.equal(atCaret("=SUM('Totals (2026)'!A1;|)", formulaSignature).name, 'SUM');
  for (const marked of ['=SUM(A1)|', '=SUM("(|")', "='s|um'!A1", '=|(A1)', '=unknown(|)'])
    assert.equal(atCaret(marked, formulaSignature), null, marked);
});

test('typing over a paired closing parenthesis leaves necessary new parentheses available', () => {
  assert.equal(atCaret('=SUM(1|)', canSkipFormulaClosing), true);
  assert.equal(atCaret("=SUM('tmp ) sheet'::A1;ABS(1|))", canSkipFormulaClosing), true);
  for (const marked of ['=SUM((1|)', '=SUM("|)")', '=A1+1|)', '=(1)|', '=1|2', 'sum(1|)'])
    assert.equal(atCaret(marked, canSkipFormulaClosing), false, marked);
});
