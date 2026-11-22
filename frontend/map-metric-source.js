import { noteWorkbooks } from './board-tables.js';
import { addressOf, normalizeTable, parseAddress, uniqueTableName } from './table-engine.js';
import { isProtectedNote } from './note-vault.js';

// Table IDs belong to a board. Two independently imported blocks can have the
// same table ID and name, and moving a block changes its index in the note.
export function tableSources(note) {
  if (!note || isProtectedNote(note)) return [];
  const blocks = note.type === 'canvas' ? [note] : (note.body || []).filter(b => b?.type === 'drawing');
  return blocks.flatMap(block => {
    const tables = [];
    for (const raw of block.board?.elements || []) {
      if (raw?.type !== 'table' || typeof raw.id !== 'string' || !raw.id || tables.some(t => t.id === raw.id)) continue;
      const {name, rows, cols} = normalizeTable({name: raw.name, rows: raw.rows, cols: raw.cols});
      tables.push({...raw, name: uniqueTableName(tables, name), rows, cols});
    }
    return tables.length ? [{block, tables, canvas: note.type === 'canvas'}] : [];
  });
}

function sourceEntries(note) {
  return tableSources(note).flatMap(group => group.tables.map(table => ({group, table})));
}

export function metricCatalogue(space) {
  const entries = new Map();
  const books = new Map();
  const notes = new Map(space.notes.filter(n => !isProtectedNote(n)).map(n => [n.id, n]));
  function tables(id) {
    if (!entries.has(id)) entries.set(id, sourceEntries(notes.get(id)));
    return entries.get(id);
  }
  function workbook(id, group) {
    if (!books.has(id)) {
      const book = noteWorkbooks();
      for (const g of new Set(tables(id).map(entry => entry.group))) book.register(g, g.tables);
      books.set(id, book);
    }
    return books.get(id).workbook(group, group.tables);
  }
  return {notes, tables, workbook};
}

export function metricSource(catalogue, binding) {
  const candidates = catalogue.tables(binding.sourceId).filter(({group, table}) =>
    table.id === binding.tableId && (!binding.blockId || (!group.canvas && group.block.mapMetricSource === binding.blockId)));
  return candidates.length === 1 ? candidates[0] : null;
}

export function metricRange(text, table, kind) {
  if (typeof text !== 'string') return null;
  const parts = text.trim().split(':').map(s => parseAddress(s.trim()));
  if (parts.length > (kind === 'area' ? 1 : 2) || parts.some(p => !p || p.row >= table.rows || p.col >= table.cols)) return null;
  const [a, b = a] = parts;
  if (a.row !== b.row && a.col !== b.col) return null;
  const row = Math.min(a.row, b.row), col = Math.min(a.col, b.col);
  const endRow = Math.max(a.row, b.row), endCol = Math.max(a.col, b.col);
  const first = addressOf(row, col), last = addressOf(endRow, endCol);
  return {row, col, endRow, endCol, text: first === last ? first : first + ':' + last};
}

export function readMetric(binding, kind, entry, workbook) {
  if (!entry) return null;
  const {table} = entry, range = metricRange(binding.range, table, kind);
  if (!range) return null;
  const read = (row, col) => workbook.value(table.id, addressOf(row, col));
  if (kind === 'area') {
    const value = read(range.row, range.col), goal = binding.goal;
    if (!Number.isFinite(value) || !Number.isFinite(goal) || goal <= 0) return null;
    return {value, goal, ratio: Math.max(0, Math.min(1, value / goal))};
  }
  const values = [];
  for (let row = range.row; row <= range.endRow; row++) {
    for (let col = range.col; col <= range.endCol; col++) {
      const value = read(row, col);
      values.push(Number.isFinite(value) ? value : null);
    }
  }
  return values.some(Number.isFinite) ? {values} : null;
}

export function resolveMapMetrics(space) {
  const areas = new Map(), notes = new Map();
  let catalogue;
  function resolve(target, kind, destination) {
    const binding = target.mapMetric;
    if (!binding || typeof binding.sourceId !== 'string' || typeof binding.tableId !== 'string') return;
    catalogue ??= metricCatalogue(space);
    const entry = metricSource(catalogue, binding);
    if (!entry) return;
    const result = readMetric(binding, kind, entry, catalogue.workbook(binding.sourceId, entry.group));
    if (result) destination.set(target.id, result);
  }
  for (const area of space.areas) resolve(area, 'area', areas);
  for (const note of space.notes) if (!isProtectedNote(note)) resolve(note, 'note', notes);
  return {areas, notes};
}
