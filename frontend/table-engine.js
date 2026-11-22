export const TABLE_LIMITS = Object.freeze({ rows: 500, cols: 52 });
export const DEFAULT_ROWS = 5;
export const DEFAULT_COLS = 4;

const maxNameLength = 80;
const fold = (s) => s.normalize('NFC').toLowerCase();
const tableName = (name) => String(name || 'Table').trim().slice(0, maxNameLength) || 'Table';

export function addressOf(row, col) {
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    col < 0 ||
    row >= TABLE_LIMITS.rows ||
    col >= TABLE_LIMITS.cols
  )
    return '';
  let letters = '';
  for (let n = col + 1; n; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters + (row + 1);
}

export function parseAddress(s) {
  const m = typeof s === 'string' && /^\$?([A-Z]{1,2})\$?([1-9]\d{0,2})$/i.exec(s);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  const row = Number(m[2]);
  return row <= TABLE_LIMITS.rows && col <= TABLE_LIMITS.cols ? { row: row - 1, col: col - 1 } : null;
}

function dimension(n, fallback, max) {
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.trunc(n))) : fallback;
}

function headerIndices(indices, limit) {
  if (!Array.isArray(indices)) return [];
  return [...new Set(indices.filter(i => Number.isInteger(i) && i >= 0 && i < limit))].sort((a, b) => a - b);
}

export function normalizeTable(raw = {}) {
  raw ??= {};
  const name = tableName(raw.name);
  const rows = dimension(raw.rows, DEFAULT_ROWS, TABLE_LIMITS.rows);
  const cols = dimension(raw.cols, DEFAULT_COLS, TABLE_LIMITS.cols);
  const cells = {};
  for (const [key, entry] of Object.entries(raw.cells || {})) {
    const at = parseAddress(key);
    if (
      !at ||
      at.row >= rows ||
      at.col >= cols ||
      (typeof entry !== 'string' && !Number.isFinite(entry))
    )
      continue;
    if (entry !== '') cells[addressOf(at.row, at.col)] = String(entry);
  }
  return {
    name, rows, cols, cells,
    showName: raw.showName !== false,
    showRowNumbers: raw.showRowNumbers !== false,
    showColumnLetters: raw.showColumnLetters !== false,
    headerRows: headerIndices(raw.headerRows, rows),
    headerCols: headerIndices(raw.headerCols, cols)
  };
}

export function tableNameAllocator(elements = [], excludeId) {
  const used = new Set(), nextSuffix = new Map();
  for (const element of elements) {
    if (element.type === 'table' && element.id !== excludeId) used.add(fold(element.name || 'Table'));
  }
  return (preferred) => {
    const name = tableName(preferred);
    let candidate = name;
    if (used.has(fold(name))) {
      const suffix = /\s+(\d{1,8})$/.exec(name);
      const base = suffix ? name.slice(0, suffix.index) : name;
      let index = nextSuffix.get(name) ?? (suffix ? Number(suffix[1]) + 1 : 2);
      do {
        const ending = ' ' + index++;
        candidate = base.slice(0, maxNameLength - ending.length) + ending;
      } while (used.has(fold(candidate)));
      nextSuffix.set(name, index);
    }
    used.add(fold(candidate));
    return candidate;
  };
}

export function uniqueTableName(elements, preferred, excludeId) {
  return tableNameAllocator(elements, excludeId)(preferred);
}

const quoteName = (s) => "'" + s.replaceAll("'", "''") + "'::";

export function referenceTo(sourceTableId, targetTable, address) {
  return sourceTableId === targetTable.id ? address : quoteName(targetTable.name) + address;
}

const functions = new Map([
  ['SUM', 'SUM'],
  ['СУММ', 'SUM'],
  ['AVERAGE', 'AVERAGE'],
  ['СРЗНАЧ', 'AVERAGE'],
  ['MIN', 'MIN'],
  ['МИН', 'MIN'],
  ['MAX', 'MAX'],
  ['МАКС', 'MAX'],
  ['COUNT', 'COUNT'],
  ['СЧЁТ', 'COUNT'],
  ['СЧЕТ', 'COUNT'],
  ['ABS', 'ABS'],
  ['ROUND', 'ROUND'],
  ['ОКРУГЛ', 'ROUND']
]);

export function formulaFunctionNames() {
  return functions.entries();
}

const qualified =
  /(?:'((?:[^']|'')*)'|([\p{L}_][\p{L}\p{N}_.]*(?:[ \t]+[\p{L}\p{N}_.]+)*))\s*(?:::|!)\s*(\$?[A-Za-z]+\$?[1-9]\d*)(?![\p{L}\p{N}_$])/uy;
const local = /\$?[A-Za-z]+\$?[1-9]\d*(?![\p{L}\p{N}_$])/uy;
const word = /[\p{L}_][\p{L}\p{N}_.]*/uy;
const numeric = /(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/y;
const decimal = /(?:\d+(?:\.\d*|,\d+)?|[.,]\d+)(?:[Ee][+-]?\d+)?/y;
const fault = /#(?:REF!|CYCLE!|DIV\/0!|VALUE!|NUM!|NAME\?|ERROR!)/iy;
const quotedText = /"((?:[^"]|"")*)"/y;
const spaces = /\s+/y;

function match(re, input, offset) {
  re.lastIndex = offset;
  return re.exec(input);
}

// A semicolon selects decimal-comma notation throughout a formula. Without
// one, comma separates arguments of variadic functions, as in SUM(1,2).
export function tokenize(input) {
  const tokens = [];
  const context = [];
  const usesSemicolons = input.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, '').includes(';');
  for (let i = 1; i < input.length; ) {
    const start = i;
    let m, token;
    if ((m = match(spaces, input, i))) {
      i += m[0].length;
      continue;
    }
    const ch = input[i];
    if ((ch === "'" || /[\p{L}_]/u.test(ch)) && (m = match(qualified, input, i))) {
      token = { kind: 'ref', sheet: m[1] !== undefined ? m[1].replaceAll("''", "'") : m[2], addr: m[3] };
    } else if ((ch === '$' || /[a-z]/i.test(ch)) && (m = match(local, input, i))) {
      token = { kind: 'ref', addr: m[0] };
    } else if ((m = match(word, input, i))) {
      token = { kind: 'word', text: m[0].toUpperCase() };
    } else if ((m = match(quotedText, input, i))) {
      token = { kind: 'literal', val: m[1].replaceAll('""', '"') };
    } else if ((m = match(fault, input, i))) {
      token = { kind: 'fault', code: m[0].toUpperCase() };
    } else if (
      (m = match(
        usesSemicolons || !context.at(-1) || context.at(-1) === 'ABS' ? decimal : numeric,
        input,
        i
      ))
    ) {
      token = { kind: 'literal', val: Number(m[0].replace(',', '.')) };
    } else {
      token = { kind: ch };
      if (ch === '(')
        context.push(tokens.at(-1)?.kind === 'word' ? functions.get(tokens.at(-1).text) || '?' : '');
      else if (ch === ')') context.pop();
    }
    i += m ? m[0].length : 1;
    tokens.push({ ...token, start, end: i });
  }
  return tokens;
}

function rewrite(formula, replace) {
  if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
  let output = '',
    end = 0;
  for (const token of tokenize(formula)) {
    if (token.kind !== 'ref') continue;
    const replacement = replace(token);
    if (replacement === undefined) continue;
    output += formula.slice(end, token.start) + replacement;
    end = token.end;
  }
  return end ? output + formula.slice(end) : formula;
}

export function rewriteTableReferences(formula, oldName, newName) {
  const updates = oldName instanceof Map ? oldName : new Map([[oldName, newName]]);
  const names = new Map(Array.from(updates, ([from, to]) => [fold(from), to]));
  return rewrite(formula, ({ sheet, addr }) => {
    if (sheet === undefined || !names.has(fold(sheet))) return;
    const to = names.get(fold(sheet));
    return to == null ? '#REF!' : quoteName(to) + addr;
  });
}

export function shiftFormula(formula, rowDelta, colDelta) {
  if (!rowDelta && !colDelta) return formula;
  return rewrite(formula, ({ sheet, addr }) => {
    const at = parseAddress(addr);
    if (!at) return '#REF!';
    const [, fixedCol, , fixedRow] = /^(\$?)([A-Z]+)(\$?)/i.exec(addr);
    const next = addressOf(at.row + (fixedRow ? 0 : rowDelta), at.col + (fixedCol ? 0 : colDelta));
    if (!next) return '#REF!';
    return (
      (sheet === undefined ? '' : quoteName(sheet)) +
      fixedCol +
      next.replace(/\d+$/, (n) => fixedRow + n)
    );
  });
}

// A structural edit moves an absolute reference along with the cell it names.
// Copy/paste, in contrast, uses shiftFormula and keeps absolute coordinates.
export function addressAfterInsert(address, axis, index, count) {
  const at = parseAddress(address);
  if (!at) return address;
  const key = axis === 'rows' ? 'row' : 'col';
  if (at[key] < index) return address;
  at[key] += count;
  return formatStructuralAddress(address, at);
}

function formatStructuralAddress(address, at) {
  const shifted = addressOf(at.row, at.col);
  if (!shifted) return '#REF!';
  const parts = /^(\$?)([a-z]+)(\$?)(\d+)$/i.exec(address);
  const col = shifted.replace(/\d+$/, '');
  return parts[1] + (parts[2] === parts[2].toLowerCase() ? col.toLowerCase() : col) +
    parts[3] + (at.row + 1);
}

export function rebaseFormula(formula, ownTable, targetName, axis, index, count) {
  if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
  const tokens = tokenize(formula), target = fold(targetName);
  let result = '', last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const ref = tokens[i];
    if (ref.kind !== 'ref') continue;
    const startOfRange = tokens[i - 1]?.kind === ':' ? tokens[i - 2] : null;
    const sheet = ref.sheet ?? startOfRange?.sheet;
    if (sheet === undefined ? !ownTable : fold(sheet) !== target) continue;
    const shifted = addressAfterInsert(ref.addr, axis, index, count);
    if (shifted === ref.addr) continue;
    const start = shifted === '#REF!' ? ref.start : ref.end - ref.addr.length;
    result += formula.slice(last, start) + shifted;
    last = ref.end;
  }
  return last ? result + formula.slice(last) : formula;
}

// Coordinate maps are per edit. A range can keep its surviving cells even
// when one or both of the original endpoints were deleted.
export function deletedAxis(axis, indices, limit = TABLE_LIMITS[axis]) {
  if (!['rows', 'cols'].includes(axis) || !(Array.isArray(indices) || indices instanceof Set)) return null;
  const removed = new Set([...indices].filter(i => Number.isInteger(i) && i >= 0 && i < limit));
  if (!removed.size) return null;
  const size = TABLE_LIMITS[axis], key = axis === 'rows' ? 'row' : 'col';
  const positions = new Int16Array(size), previous = new Int16Array(size), following = new Int16Array(size);
  let next = 0, last = -1;
  for (let i = 0; i < size; i++) {
    positions[i] = removed.has(i) ? -1 : next++;
    if (positions[i] >= 0) last = i;
    previous[i] = last;
  }
  last = size;
  for (let i = size - 1; i >= 0; i--) {
    if (positions[i] >= 0) last = i;
    following[i] = last;
  }
  function mapped(original, at, survivingIndex) {
    if (positions[survivingIndex] === at[key]) return original;
    return formatStructuralAddress(original, { ...at, [key]: positions[survivingIndex] });
  }
  return {
    count: removed.size,
    position(index) { return positions[index]; },
    address(original) {
      const at = parseAddress(original);
      if (!at) return original;
      return positions[at[key]] < 0 ? null : mapped(original, at, at[key]);
    },
    range(first, last) {
      const a = parseAddress(first), b = parseAddress(last);
      if (!a || !b) return [first, last];
      const forward = a[key] <= b[key];
      const lo = following[Math.min(a[key], b[key])], hi = previous[Math.max(a[key], b[key])];
      if (lo > hi) return null;
      return [mapped(first, a, forward ? lo : hi), mapped(last, b, forward ? hi : lo)];
    }
  };
}

export function formulaAfterDelete(formula, ownTable, targetName, deletion) {
  if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
  const tokens = tokenize(formula), target = fold(targetName);
  const applies = sheet => sheet === undefined ? ownTable : fold(sheet) === target;
  let result = '', cursor = 0;
  function write(ref, address) {
    if (address === ref.addr) return;
    // A missing cell replaces the whole qualified reference. A surviving cell
    // keeps the original spelling and separator of its table qualifier.
    const from = address === null ? ref.start : ref.end - ref.addr.length;
    result += formula.slice(cursor, from) + (address ?? '#REF!');
    cursor = ref.end;
  }
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i];
    if (first.kind !== 'ref') continue;
    const last = tokens[i + 1]?.kind === ':' && tokens[i + 2]?.kind === 'ref' ? tokens[i + 2] : null;
    if (!last) {
      if (applies(first.sheet)) write(first, deletion.address(first.addr));
      continue;
    }
    i += 2;
    const includesFirst = applies(first.sheet), includesLast = applies(last.sheet ?? first.sheet);
    if (includesFirst && includesLast) {
      const range = deletion.range(first.addr, last.addr);
      if (range) { write(first, range[0]); write(last, range[1]); }
      else {
        result += formula.slice(cursor, first.start) + '#REF!';
        cursor = last.end;
      }
    } else {
      if (includesFirst) write(first, deletion.address(first.addr));
      if (includesLast) write(last, deletion.address(last.addr));
    }
  }
  return cursor ? result + formula.slice(cursor) : formula;
}

class FormulaError {
  constructor(code) {
    this.code = code;
  }
}
const fail = (code) => {
  throw new FormulaError(code);
};
const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 };

// Compile to postfix once. Long sums then evaluate without recursive calls.
function compile(raw) {
  if (raw.length > 32768) fail('#NUM!');
  const tokens = tokenize(raw);
  const code = [];
  let pos = 0;
  function need(kind) {
    if (tokens[pos++]?.kind !== kind) fail('#ERROR!');
  }
  function expression(min, depth) {
    if (depth > 128) fail('#NUM!');
    const token = tokens[pos++];
    if (!token) fail('#ERROR!');
    if (token.kind === '+' || token.kind === '-') {
      expression(3, depth + 1);
      code.push({ kind: 'unary', op: token.kind });
    } else if (token.kind === 'ref' || token.kind === 'fault') {
      if (tokens[pos]?.kind === ':') {
        pos++;
        const last = tokens[pos++];
        if (!last || (last.kind !== 'ref' && last.kind !== 'fault')) fail('#ERROR!');
        if (token.kind === 'fault' || last.kind === 'fault') code.push({ kind: 'fault', code: '#REF!' });
        else code.push({ kind: 'range', first: token, last });
      } else code.push(token);
    } else if (token.kind === 'literal') {
      code.push(token);
    } else if (token.kind === '(') {
      expression(0, depth + 1);
      need(')');
    } else if (token.kind === 'word') {
      const fn = functions.get(token.text);
      if (!fn) fail('#NAME?');
      need('(');
      let argc = 0;
      if (tokens[pos]?.kind !== ')') {
        for (;;) {
          expression(0, depth + 1);
          argc++;
          if (![',', ';'].includes(tokens[pos]?.kind)) break;
          pos++;
        }
      }
      need(')');
      code.push({ kind: 'call', fn, argc });
    } else fail('#ERROR!');
    while (pos < tokens.length) {
      const op = tokens[pos].kind;
      if (op === '%') {
        pos++;
        code.push({ kind: 'unary', op });
        continue;
      }
      const strength = precedence[op];
      if (strength === undefined || strength < min) break;
      pos++;
      expression(strength + (op === '^' ? 0 : 1), depth + 1);
      code.push({ kind: 'binary', op });
    }
  }
  expression(0, 0);
  if (pos !== tokens.length) fail('#ERROR!');
  return code;
}

function finite(n) {
  if (!Number.isFinite(n)) fail('#NUM!');
  return n === 0 ? 0 : n;
}
function scalar(value) {
  if (value instanceof FormulaError) throw value;
  if (value === '') return 0;
  if (typeof value !== 'number') fail('#VALUE!');
  return finite(value);
}
function binary(op, left, right) {
  const a = scalar(left),
    b = scalar(right);
  if (op === '/' && b === 0) fail('#DIV/0!');
  switch (op) {
    case '+':
      return finite(a + b);
    case '-':
      return finite(a - b);
    case '*':
      return finite(a * b);
    case '/':
      return finite(a / b);
    case '^':
      return finite(a ** b);
  }
}
function rounded(value, digits) {
  digits = Math.trunc(digits);
  if (value === 0 || digits > 308) return value;
  if (digits < -308) return 0;
  function scale(n, places) {
    const [mantissa, exponent = 0] = String(n).split('e');
    return Number(mantissa + 'e' + (Number(exponent) + places));
  }
  const scaled = scale(Math.abs(value), digits);
  return Number.isFinite(scaled) ? finite(Math.sign(value) * scale(Math.round(scaled), -digits)) : value;
}
function numericEntry(raw) {
  if (raw.startsWith("'")) return raw.slice(1);
  let text = raw.trim();
  if (/^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/.test(text)) {
    text = text.replace(/[ \u00a0\u202f]/g, '');
  }
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(text)) return raw;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? n : new FormulaError('#NUM!');
}

const formats = new Map();
export function formatValue(value, locale = 'ru') {
  if (typeof value !== 'number') return value == null ? '' : String(value);
  const compact = value !== 0 && (Math.abs(value) < 1e-7 || Math.abs(value) >= 1e15);
  const key = locale + compact;
  if (!formats.has(key)) {
    formats.set(
      key,
      new Intl.NumberFormat(locale, {
        maximumSignificantDigits: 12,
        notation: compact ? 'scientific' : 'standard'
      })
    );
  }
  return formats.get(key).format(Object.is(value, -0) ? 0 : value);
}

function inTable(table, at) {
  return at && at.row < table.rows && at.col < table.cols;
}

function* nonempty(table, from, to) {
  const top = Math.min(from.row, to.row),
    left = Math.min(from.col, to.col);
  const bottom = Math.max(from.row, to.row),
    right = Math.max(from.col, to.col);
  if (!table.rawAt && (bottom - top + 1) * (right - left + 1) > table.keys.length * 2) {
    for (const key of table.keys) {
      const { row, col } = parseAddress(key);
      if (row >= top && row <= bottom && col >= left && col <= right) yield key;
    }
  } else {
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        const key = addressOf(r, c);
        if (table.rawAt ? table.rawAt(r, c) !== '' : Object.hasOwn(table.cells, key)) yield key;
      }
    }
  }
}

function emptyStats() {
  return { sum: 0, count: 0, min: null, max: null, average: null };
}
function accumulate(stats, value) {
  if (typeof value !== 'number') return;
  stats.sum += value;
  stats.min = stats.count ? Math.min(stats.min, value) : value;
  stats.max = stats.count ? Math.max(stats.max, value) : value;
  stats.count++;
}
function* aggregate(fn, args) {
  if (fn === 'ABS' || fn === 'ROUND') {
    if (!args.length || args.length > (fn === 'ABS' ? 1 : 2)) fail('#VALUE!');
    return fn === 'ABS' ? Math.abs(scalar(args[0])) : rounded(scalar(args[0]), scalar(args[1] ?? 0));
  }
  const stats = emptyStats();
  function include(v) {
    if (v instanceof FormulaError && (fn !== 'COUNT' || v.code === '#CYCLE!')) throw v;
    accumulate(stats, v);
  }
  for (const arg of args) {
    if (arg?.kind === 'range') {
      for (const key of nonempty(arg.table, arg.from, arg.to)) include(yield { table: arg.table, key });
    } else include(arg);
  }
  switch (fn) {
    case 'SUM':
      return finite(stats.sum);
    case 'COUNT':
      return stats.count;
    case 'AVERAGE':
      if (!stats.count) fail('#DIV/0!');
      return finite(stats.sum / stats.count);
    case 'MIN':
      return stats.min ?? 0;
    case 'MAX':
      return stats.max ?? 0;
  }
}

export function createWorkbook(elements, resolveQualified) {
  const tables = new Map(),
    names = new Map(),
    compiled = new Map();
  for (const e of elements) {
    if (e.type !== 'table') continue;
    const table = { ...normalizeTable(e), id: e.id, cache: new Map() };
    table.identity = Object.freeze({ rows: table.rows, cols: table.cols });
    table.keys = Object.keys(table.cells);
    tables.set(e.id, table);
    const name = fold(table.name);
    names.set(name, names.has(name) ? null : table);
  }

  function lookup(sheet, origin) {
    return sheet === undefined ? origin : resolveQualified
      ? tables.get(resolveQualified(origin.id, fold(sheet)))
      : names.get(fold(sheet));
  }
  function reference(sheet, origin, view) {
    const table = lookup(sheet, origin);
    if (!table) fail('#REF!');
    return view ? view(table) : table;
  }
  function* evaluate(raw, origin, view) {
    if (!compiled.has(raw)) compiled.set(raw, compile(raw));
    const stack = [];
    for (const t of compiled.get(raw)) {
      switch (t.kind) {
        case 'fault':
          fail(t.code);
          break;
        case 'literal':
          stack.push(typeof t.val === 'number' ? finite(t.val) : t.val);
          break;
        case 'ref': {
          const table = reference(t.sheet, origin, view),
            at = parseAddress(t.addr);
          if (!inTable(table, at)) fail('#REF!');
          stack.push(yield { table, key: addressOf(at.row, at.col) });
          break;
        }
        case 'range': {
          const table = reference(t.first.sheet, origin, view);
          if (t.last.sheet !== undefined && reference(t.last.sheet, origin, view) !== table) fail('#REF!');
          const from = parseAddress(t.first.addr),
            to = parseAddress(t.last.addr);
          if (!inTable(table, from) || !inTable(table, to)) fail('#REF!');
          stack.push({ kind: 'range', table, from, to });
          break;
        }
        case 'unary': {
          const n = scalar(stack.pop());
          stack.push(t.op === '-' ? -n : t.op === '%' ? n / 100 : n);
          break;
        }
        case 'binary': {
          const right = stack.pop();
          stack.push(binary(t.op, stack.pop(), right));
          break;
        }
        case 'call':
          stack.push(yield* aggregate(t.fn, stack.splice(stack.length - t.argc)));
          break;
      }
    }
    const result = stack[0];
    if (result?.kind === 'range') fail('#VALUE!');
    return result;
  }

  // Explicit dependency frames keep long chains off the JavaScript call stack.
  const pending = Symbol('pending');
  function resolve(table, key, view) {
    const frames = [];
    function load(table, key) {
      if (table.cache.has(key)) {
        const cached = table.cache.get(key);
        return cached === pending ? new FormulaError('#CYCLE!') : cached;
      }
      let raw;
      if (table.rawAt) {
        const at = parseAddress(key);
        raw = table.rawAt(at.row, at.col);
      } else raw = table.cells[key];
      if (raw === undefined || raw === '') return '';
      if (!raw.startsWith('=')) {
        const value = numericEntry(raw);
        table.cache.set(key, value);
        return value;
      }
      table.cache.set(key, pending);
      frames.push({ table, key, iter: evaluate(raw, table, view) });
    }
    let reply = load(table, key);
    while (frames.length) {
      const frame = frames.at(-1);
      let step;
      try {
        step = frame.iter.next(reply);
      } catch (error) {
        if (!(error instanceof FormulaError)) throw error;
        step = { done: true, value: error };
      }
      if (step.done) {
        reply = step.value;
        frame.table.cache.set(frame.key, reply);
        frames.pop();
      } else reply = load(step.value.table, step.value.key);
    }
    return reply;
  }

  function value(id, address) {
    const table = tables.get(id),
      at = parseAddress(address);
    if (!table || !inTable(table, at)) return '#REF!';
    const result = resolve(table, addressOf(at.row, at.col));
    return result instanceof FormulaError ? result.code : result;
  }
  function previewValue(id, address, projection) {
    const table = tables.get(id), at = parseAddress(address);
    if (!table || !inTable(projection, at)) return '#REF!';
    const raw = projection.rawAt(at.row, at.col);
    let result;
    if (raw.startsWith('=')) {
      // Dependent tables can refer back into the pending fill. Give only the
      // tables actually visited fresh calculation caches, never mutating live ones.
      const transient = new Map();
      function view(source) {
        if (!transient.has(source.id)) {
          const next = { ...source, cache: new Map() };
          if (source.id === id) Object.assign(next, {
            rows: projection.rows, cols: projection.cols, rawAt: projection.rawAt
          });
          transient.set(source.id, next);
        }
        return transient.get(source.id);
      }
      result = resolve(view(table), addressOf(at.row, at.col), view);
    } else result = numericEntry(raw);
    return result instanceof FormulaError ? result.code : result;
  }
  function summary(id, first, last = first) {
    const table = tables.get(id),
      from = parseAddress(first),
      to = parseAddress(last);
    const stats = emptyStats();
    if (table && inTable(table, from) && inTable(table, to)) {
      for (const key of nonempty(table, from, to)) accumulate(stats, resolve(table, key));
      if (stats.count) stats.average = stats.sum / stats.count;
    }
    return stats;
  }
  function referenceIdentity(id, sheet) {
    const origin = tables.get(id);
    return origin && lookup(sheet, origin)?.identity;
  }
  return { value, previewValue, summary, referenceIdentity };
}
