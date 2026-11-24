import { formulaFunctionNames, tokenize } from './table-engine.js';
import { translateFor } from './i18n.js';

const descriptions = {
  SUM: ['Сумма чисел и диапазонов', 'Sum of numbers and ranges'],
  AVERAGE: ['Среднее арифметическое чисел', 'Arithmetic mean of the numbers'],
  MIN: ['Наименьшее число', 'Smallest number'],
  MAX: ['Наибольшее число', 'Largest number'],
  COUNT: ['Количество числовых значений', 'Count of numeric values'],
  ABS: ['Модуль числа', 'Absolute value of a number'],
  ROUND: ['Округление до указанного разряда', 'Round to the specified number of digits'],
};

const names = new Map(formulaFunctionNames());
const operandStarts = new Set(['(', '+', '-', '*', '/', '^', ';', ',']);

function usableCursor(value, caret) {
  return typeof value === 'string' && value.startsWith('=') && value.length <= 32768 &&
    Number.isInteger(caret) && caret >= 1 && caret <= value.length;
}

// The evaluator tokenizes complete strings and qualified cell references. While
// typing, an unmatched quote can also contain operators and partial function names.
function insideQuote(value, caret) {
  let quote = '';
  for (let i = 1; i < caret; i++) {
    const ch = value[i];
    if (quote && ch === quote) {
      if (value[i + 1] === quote) i++;
      else quote = '';
    } else if (!quote && (ch === '"' || ch === "'")) quote = ch;
  }
  return Boolean(quote);
}

function help(name, language, separator) {
  const fn = names.get(name);
  let args;
  if (fn === 'ABS') args = translateFor(language, 'число', 'number');
  else if (fn === 'ROUND') args = translateFor(language, 'число', 'number') + separator + translateFor(language, '[разряды]', '[digits]');
  else args = translateFor(language, 'значение', 'value') + separator + '…';
  return { name, signature: name + '(' + args + ')', description: translateFor(language, ...descriptions[fn]) };
}

function argumentSeparator(tokens, language) {
  if (tokens.some(t => t.kind === ';')) return '; ';
  if (tokens.some(t => t.kind === ',')) return ', ';
  return language === 'ru' ? '; ' : ', ';
}

export function functionCatalog(value, language = 'ru') {
  const tokens = value.startsWith('=') ? tokenize(value) : [];
  const separator = argumentSeparator(tokens, language);
  return [...new Set(names.values())].map(name => help(name, language, separator));
}

export function formulaCompletions(value, caret, language = 'ru') {
  if (!usableCursor(value, caret) || !/\p{L}/u.test(value[caret - 1]) || insideQuote(value, caret)) return null;
  const tokens = tokenize(value);
  const i = tokens.findIndex(t => t.kind === 'word' && t.start < caret && caret <= t.end);
  if (i < 0 || (i > 0 && !operandStarts.has(tokens[i - 1].kind))) return null;
  const { start, end, text } = tokens[i];
  // Do not replace a table qualifier while its cell address is still incomplete.
  if (!/^\p{L}+$/u.test(text) || /^(?:[ \t]+[\p{L}\p{N}_.]+)*\s*(?:::|!)/u.test(value.slice(end))) return null;
  const prefix = value.slice(start, caret).toUpperCase();
  const items = [], seen = new Set();
  const separator = argumentSeparator(tokens, language);
  for (const [name, fn] of names) {
    if (name.startsWith(prefix) && !seen.has(fn)) {
      items.push(help(name, language, separator));
      seen.add(fn);
    }
  }
  return items.length ? { start, end, items } : null;
}

// A function chosen for an existing value wraps the value. During an edit,
// keep the operation at the selection, including qualified ranges and calls.
export function catalogTarget(value, start, end, wholeCell = false) {
  if (!value.startsWith('=')) {
    const numeric = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(value.trim());
    const argument = numeric ? value.trim().replace(',', '.') : value && '"' + value.replaceAll('"', '""') + '"';
    return {start:0, end:value.length, prefix:'=', argument};
  }
  start = Math.max(1, start); end = Math.max(start, end);
  const tokens = tokenize(value);
  const word = tokens.find(t => t.kind === 'word' && t.start <= start && end <= t.end);
  if (word && (start !== word.start || end > start || !wholeCell)) return {start:word.start, end:word.end};
  if (wholeCell) { start = 1; end = value.length; }
  if (start === end) {
    const at = tokens.findIndex(t => t.start <= start && start <= t.end && ['ref','literal','fault',')'].includes(t.kind));
    if (at >= 0 && !(tokens[at].kind === ')' && tokens[at].start === start)) {
      let first = at, last = at;
      if (tokens[at].kind === ')') {
        let depth = 1;
        while (first > 0 && depth) {
          const kind = tokens[--first].kind;
          if (kind === '(') depth--;
          if (kind === ')') depth++;
        }
        if (first > 0 && tokens[first - 1].kind === 'word') first--;
      } else {
        if (tokens[at - 1]?.kind === ':' && at >= 2) first -= 2;
        if (tokens[at + 1]?.kind === ':' && tokens[at + 2]) last += 2;
      }
      start = tokens[first].start; end = tokens[last].end;
    }
  }
  return {start, end, argument:value.slice(start, end)};
}

export function applyFormulaCompletion(value, { start, end, prefix = '', argument }, { name }) {
  const after = value.slice(end);
  if (argument !== undefined) {
    const call = prefix + name + '(' + argument + ')';
    return {value:value.slice(0, start) + call + after, caret:start + call.length - 1};
  }
  const opening = /^\s*\(/.exec(after);
  const before = value.slice(0, start) + name;
  return {
    value: before + (opening ? '' : '()') + after,
    caret: before.length + (opening ? opening[0].length : 1),
  };
}

export function formulaSignature(value, caret, language = 'ru') {
  if (!usableCursor(value, caret) || insideQuote(value, caret)) return null;
  const calls = [], tokens = tokenize(value);
  for (let i = 0; i < tokens.length && tokens[i].end <= caret; i++) {
    if (tokens[i].kind === '(') calls.push(tokens[i - 1]?.text);
    else if (tokens[i].kind === ')') calls.pop();
  }
  for (let i = calls.length - 1; i >= 0; i--) {
    if (names.has(calls[i])) return help(calls[i], language, argumentSeparator(tokens, language));
  }
  return null;
}

export function canSkipFormulaClosing(value, caret) {
  if (!usableCursor(value, caret) || value[caret] !== ')' || insideQuote(value, caret)) return false;
  let depth = 0, paired = false;
  for (const token of tokenize(value)) {
    if (token.kind === '(') depth++;
    else if (token.kind === ')') {
      if (!depth) return false;
      if (token.start === caret) paired = true;
      depth--;
    }
  }
  return paired && depth === 0;
}
