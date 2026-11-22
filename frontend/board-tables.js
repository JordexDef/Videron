import {
  TABLE_LIMITS,
  addressAfterInsert,
  createWorkbook,
  deletedAxis,
  formulaAfterDelete,
  parseAddress,
  rebaseFormula,
  rewriteTableReferences,
  tableNameAllocator,
  uniqueTableName
} from './table-engine.js';

export const isSheetObject = (item) => item.type === 'table' || item.type === 'chart';

export function chartFields(raw) {
  const parts = typeof raw.range === 'string' ? raw.range.toUpperCase().split(':') : [];
  const range =
    raw.range === '#REF!' ? '#REF!' :
    parts.length && parts.length <= 2 && parts.every((part) => parseAddress(part))
      ? parts.join(':')
      : 'A1';
  return {
    tableId: String(raw.tableId ?? ''),
    range,
    chartType: raw.chartType === 'bar' ? 'bar' : 'line'
  };
}

function sameSources(tables, previous) {
  return tables.length === previous.length && tables.every((table, i) => {
    const other = previous[i];
    return table.id === other.id && table.name === other.name && table.cells === other.cells &&
      table.rows === other.rows && table.cols === other.cols &&
      table.headerRows === other.headerRows && table.headerCols === other.headerCols;
  });
}

// Moving objects and dragging a selection must not recalculate spreadsheet formulas.
export function workbookCache() {
  let sources = [],
    workbook;
  return (elements) => {
    const tables = elements.filter((e) => e.type === 'table');
    if (!workbook || !sameSources(tables, sources)) {
      sources = tables;
      workbook = createWorkbook(tables);
    }
    return workbook;
  };
}

const foldedName = name => name.normalize('NFC').toLowerCase();

// Each board owns its saved IDs. Imported boards can have the same IDs and
// names as an existing block, so identities used by the calculator are private.
export function noteWorkbooks() {
  const groups = new Map();
  let revision = 0, cachedRevision = -1, uniqueNames = new Map();
  function rebuild() {
    const unique = new Map(), localNames = new Map();
    const tables = [];
    for (const group of groups.values()) {
      group.ids = new Map();
      group.names = new Map();
      for (const table of group.tables) {
        const id = Symbol(), name = foldedName(table.name);
        group.ids.set(table.id, id);
        group.names.set(name, id);
        unique.set(name, unique.has(name) ? null : id);
        localNames.set(id, group.names);
        tables.push({ ...table, id });
      }
    }
    const workbook = createWorkbook(tables, (id, name) => localNames.get(id).get(name) ?? unique.get(name));
    for (const group of groups.values()) {
      const ids = group.ids;
      group.view = {
        referenceIdentity: (id, sheet) => workbook.referenceIdentity(ids.get(id), sheet),
        value: (id, addr) => workbook.value(ids.get(id), addr),
        previewValue: (id, addr, projection) => workbook.previewValue(ids.get(id), addr, projection),
        summary: (id, first, last) => workbook.summary(ids.get(id), first, last)
      };
    }
    uniqueNames = unique;
    cachedRevision = revision;
  }
  function register(key, elements) {
    const tables = elements.filter(e => e.type === 'table');
    let group = groups.get(key);
    if (!group) {
      group = { tables };
      groups.set(key, group);
      revision++;
    } else if (!sameSources(tables, group.tables)) {
      group.tables = tables;
      revision++;
    }
    return group;
  }
  return {
    get revision() { return revision; },
    register,
    workbook(key, elements) {
      const group = register(key, elements);
      if (revision !== cachedRevision) rebuild();
      return group.view;
    },
    forget(key) { if (groups.delete(key)) revision++; },
    peers(key) {
      return [...groups].flatMap(([owner, group]) => owner === key ? [] : group.tables);
    },
    canReference(from, to, table) {
      if (revision !== cachedRevision) rebuild();
      const source = groups.get(from), target = groups.get(to);
      const id = target?.ids.get(table.id), name = foldedName(table.name);
      return id !== undefined && !!source && (source.names.get(name) ?? uniqueNames.get(name)) === id;
    }
  };
}

export function rewriteCells(table, names) {
  let cells = table.cells;
  for (const [key, raw] of Object.entries(cells || {})) {
    if (typeof raw !== 'string' || !raw.startsWith('=')) continue;
    const changed = rewriteTableReferences(raw, names);
    if (changed === raw) continue;
    if (cells === table.cells) cells = { ...cells };
    cells[key] = changed;
  }
  return cells === table.cells ? table : { ...table, cells };
}

export function renamedTable(elements, id, name) {
  const source = elements.find((e) => e.id === id && e.type === 'table');
  const next = name.trim();
  if (!source || source.locked || !next || uniqueTableName(elements, next, id) !== next) return null;
  if (next === source.name) return elements;
  const names = new Map([[source.name, next]]);
  return elements.map((e) => {
    if (e.type !== 'table') return e;
    const updated = rewriteCells(e, names);
    return e.id === id ? { ...updated, name: next } : updated;
  });
}

export function withoutObjects(elements, removed) {
  const names = new Map(
    elements.filter((e) => e.type === 'table' && removed.has(e.id)).map((e) => [e.name, null])
  );
  return elements
    .filter((e) => !removed.has(e.id))
    .map((e) => (names.size && e.type === 'table' ? rewriteCells(e, names) : e));
}

// A cut briefly leaves dangling formulas. Restore only cells invalidated by that
// cut, so edits made between cutting a table and pasting it remain intact.
export function restoreCutFormulas(current, before, after, names) {
  const oldTables = new Map(before.filter((e) => e.type === 'table').map((e) => [e.id, e]));
  const cutTables = new Map(after.filter((e) => e.type === 'table').map((e) => [e.id, e]));
  return current.map((e) => {
    const old = oldTables.get(e.id),
      cut = cutTables.get(e.id);
    if (e.type !== 'table' || !old || !cut || old.cells === cut.cells) return e;
    let cells = e.cells;
    for (const [addr, raw] of Object.entries(old.cells)) {
      if (cut.cells[addr] === raw || cells[addr] !== cut.cells[addr]) continue;
      if (cells === e.cells) cells = { ...cells };
      cells[addr] = rewriteTableReferences(raw, names);
    }
    return cells === e.cells ? e : { ...e, cells };
  });
}

export function copiedSheetObjects(copies, originals, existing, ids) {
  const names = new Map(), allocateName = tableNameAllocator(existing);
  for (const e of originals) {
    if (e.type !== 'table') continue;
    names.set(e.name, allocateName(e.name));
  }
  return copies.map((e) => {
    if (e.type === 'chart') return { ...e, tableId: ids.get(e.tableId) || e.tableId };
    if (e.type === 'table') return { ...rewriteCells(e, names), name: names.get(e.name) };
    return e;
  });
}

function mapTableCells(table, move, update) {
  const original = table.cells || {};
  let cells = move ? {} : original;
  let changed = false;
  for (const [address, value] of Object.entries(original)) {
    const key = move ? move(address) : address;
    if (key === null) { changed = true; continue; }
    const next = update(value);
    if (key !== address || next !== value) {
      changed = true;
      if (cells === original) cells = { ...original };
    }
    if (move || next !== value) cells[key] = next;
  }
  return changed ? { ...table, cells } : table;
}

function rebaseTable(table, targetName, axis, index, count, moveCells) {
  return mapTableCells(table,
    moveCells ? address => addressAfterInsert(address, axis, index, count) : null,
    value => rebaseFormula(value, moveCells, targetName, axis, index, count));
}

// Callers resolve the target's name in the originating block before updating peers.
export function rebaseTableLinks(elements, targetName, axis, index, count) {
  const next = elements.map(item => item.type === 'table'
    ? rebaseTable(item, targetName, axis, index, count, false) : item);
  return next.some((item, i) => item !== elements[i]) ? next : elements;
}

export function insertTableCells(elements, id, axis, index, count = 1) {
  const table = elements.find(e => e.type === 'table' && e.id === id);
  if (!table || table.locked || !['rows', 'cols'].includes(axis) || !Number.isInteger(index) ||
      index < 0 || index > table[axis] || !Number.isInteger(count) || count < 1 ||
      table[axis] + count > TABLE_LIMITS[axis]) return elements;
  const middle = index < table[axis];
  const row = axis === 'rows';
  const headerKey = row ? 'headerRows' : 'headerCols';
  const sizeKey = row ? 'h' : 'w';
  const chrome = row ? (table.showName === false ? 0 : 34) + (table.showColumnLetters === false ? 0 : 24)
                     : (table.showRowNumbers === false ? 0 : 30);
  const size = table[sizeKey] ?? (row ? 225 : 410);
  const step = Math.max(row ? 26 : 72, (size - chrome) / table[axis]);
  return elements.map(item => {
    if (item === table) {
      const next = middle ? rebaseTable(table, table.name, axis, index, count, true) : table;
      const headers = table[headerKey] || [];
      return { ...next, [axis]: table[axis] + count, [sizeKey]: Math.round(size + count * step),
        [headerKey]: headers.map(i => i >= index ? i + count : i) };
    }
    if (!middle) return item;
    if (item.type === 'table') return rebaseTable(item, table.name, axis, index, count, false);
    if (item.type === 'chart' && item.tableId === id) {
      const range = item.range.split(':').map(addr => addressAfterInsert(addr, axis, index, count)).join(':');
      if (range !== item.range) return { ...item, range };
    }
    return item;
  });
}

export function rebaseTableLinksAfterDelete(elements, targetName, axis, indices) {
  const deletion = deletedAxis(axis, indices);
  if (!deletion) return elements;
  const update = value => formulaAfterDelete(value, false, targetName, deletion);
  const next = elements.map(item => item.type === 'table' ? mapTableCells(item, null, update) : item);
  return next.some((item, i) => item !== elements[i]) ? next : elements;
}

export function deleteTableAxes(elements, id, axis, indices) {
  const source = elements.find(item => item.type === 'table' && item.id === id);
  if (!source || source.locked) return elements;
  const deletion = deletedAxis(axis, indices, source[axis]);
  if (!deletion) return elements;
  const rows = axis === 'rows', headers = rows ? 'headerRows' : 'headerCols', extent = rows ? 'h' : 'w';
  const chrome = rows ? (source.showName === false ? 0 : 34) + (source.showColumnLetters === false ? 0 : 24)
                      : (source.showRowNumbers === false ? 0 : 30);
  const size = source[extent] ?? (rows ? 225 : 410), remaining = Math.max(1, source[axis] - deletion.count);
  const reduced = chrome + (size - chrome) * remaining / source[axis];
  const updateExternal = value => formulaAfterDelete(value, false, source.name, deletion);
  return elements.map(item => {
    if (item === source) {
      const next = mapTableCells(item, deletion.address, value => formulaAfterDelete(value, true, source.name, deletion));
      return { ...next, [axis]: remaining,
        [headers]: (source[headers] || []).map(deletion.position).filter(i => i >= 0),
        [extent]: Math.round(Math.min(size, Math.max(chrome + (rows ? 26 : 72), reduced)))
      };
    }
    if (item.type === 'table') return mapTableCells(item, null, updateExternal);
    if (item.type === 'chart' && item.tableId === id && item.range !== '#REF!') {
      const [first, last] = item.range.split(':');
      const range = (last ? deletion.range(first, last)?.join(':') : deletion.address(first)) ?? '#REF!';
      if (range !== item.range) return { ...item, range };
    }
    return item;
  });
}
