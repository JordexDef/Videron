import { formulaFunctionNames, tokenize } from './table-engine.js';

const functions = new Map(formulaFunctionNames());
const endsOperand = new Set(['ref', 'literal', 'fault', ')', '%']);
const startsOperand = new Set(['ref', 'literal', 'fault', 'word', '(']);

// Work at the caret's own parenthesis level. An argument list nested inside
// another call, and a parenthesized arithmetic expression, have different slots.
function argumentSlot(tokens, caret, length) {
  const stack = [];
  for (const [i, token] of tokens.entries()) {
    if (token.end > caret) break;
    if (token.kind === '(') stack.push(i);
    if (token.kind === ')') stack.pop();
  }
  const open = stack.at(-1);
  if (open === undefined) return null;
  const fn = functions.get(tokens[open - 1]?.text);
  if (!fn) return null;
  let start = tokens[open].end, end = length, count = 1, depth = 0;
  for (let i = open + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === ')') {
      if (!depth) { end = Math.min(end, token.start); break; }
      depth--;
    } else if (token.kind === '(') depth++;
    else if (!depth && (token.kind === ',' || token.kind === ';')) {
      count++;
      if (token.end <= caret) start = token.end;
      else end = Math.min(end, token.start);
    }
  }
  const limit = fn === 'ABS' ? 1 : fn === 'ROUND' ? 2 : Infinity;
  return {start, end, canAdd:count < limit};
}

// Compute the surrounding text once on pointer-down. Dragging then changes
// only the reference in this gap; the next click starts a new gesture.
export function referencePickParts(value, start, end, previousPick) {
  start = Math.max(1, start);
  end = Math.max(start, end);
  let leading = '', trailing = '';
  if (start === end) {
    const tokens = tokenize(value);
    const inside = tokens.find(t => t.start < start && start < t.end);
    const left = tokens.findLast(t => t.end <= start);
    const right = tokens.find(t => t.start >= end);
    const slot = argumentSlot(tokens, start, value.length);
    const before = endsOperand.has(left?.kind), after = startsOperand.has(right?.kind);
    if (inside) {
      start = inside.start; end = inside.end;
    } else if (left?.kind === 'word' && left.end === start && right?.kind !== '(') {
      start = left.start;
    } else if (slot?.canAdd) {
      const separator = tokens.some(t => t.kind === ';') ? ';' : ',';
      if (before) leading = separator;
      if (after) trailing = separator;
    } else if (previousPick?.to === start) {
      start = previousPick.from;
    } else if (before || after) {
      if (slot) {
        start = slot.start; end = slot.end;
      } else if (before && left.kind === 'ref') start = left.start;
      else if (after && right.kind === 'ref') end = right.end;
    }
  }
  return {prefix:value.slice(0, start) + leading, suffix:trailing + value.slice(end)};
}
