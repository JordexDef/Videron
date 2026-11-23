import { getLanguage, tr } from './i18n.js';
import { historyDirection, primaryCommand, shortcutLabel } from './shortcuts.js';
import { planAutofill } from './table-autofill.js';
import { mountTableControls } from './table-controls.js';
import { trackFill } from './table-fill-gesture.js';
import { clearReferenceColors, referenceFieldHost, refreshReferenceColors } from './table-references.js';
import { referencePickParts } from './table-reference-pick.js';
import { attachFormulaSuggestions } from './table-formula-suggestions.js';
import { canvasTableFooter } from './table-canvas-footer.js';
import {
  addressOf,
  parseAddress,
  referenceTo,
  shiftFormula,
  formatValue,
  TABLE_LIMITS
} from './table-engine.js';

const clipType = 'application/x-videron-cells+json';
const icons = {
  more: '<circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12" cy="8" r="1"/>',
  grip: '<path d="M4 5h8M4 8h8M4 11h8"/>',
  chart: '<path d="M2 2v11h12M5 10V7m3 3V4m3 6V6"/>'
};

function node(tag, cls, text) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(cls, title, graphic) {
  const b = node('button', cls);
  b.type = 'button';
  b.setAttribute('aria-label', title);
  b.title = title;
  if (graphic) b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' + icons[graphic] + '</svg>';
  return b;
}

function sortedRange(first, last) {
  const a = parseAddress(first),
    b = parseAddress(last);
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col)
  };
}

function axisRanges(item, axis, indices) {
  const rows = axis === 'rows', ranges = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (rows && last && last.bottom + 1 === i) last.bottom = i;
    else if (!rows && last && last.right + 1 === i) last.right = i;
    else ranges.push(rows
      ? {top: i, bottom: i, left: 0, right: item.cols - 1}
      : {top: 0, bottom: item.rows - 1, left: i, right: i});
  }
  return ranges;
}

function interval(from, to) {
  return Array.from({length: Math.abs(to - from) + 1}, (_, i) => i + Math.min(from, to));
}

function rangeLabel(range) {
  const start = addressOf(range.top, range.left), end = addressOf(range.bottom, range.right);
  return start === end ? start : start + ':' + end;
}

function isSelected(selection, bounds, row, col) {
  if (selection?.axis) return selection.indices.has(selection.axis === 'rows' ? row : col);
  return !!bounds && row >= bounds.top && row <= bounds.bottom && col >= bounds.left && col <= bounds.right;
}

function boundedCell(item, row, col) {
  return addressOf(Math.max(0, Math.min(item.rows - 1, row)), Math.max(0, Math.min(item.cols - 1, col)));
}

export function tabDestination(item, address, backwards) {
  const {row, col} = parseAddress(address);
  const index = row * item.cols + col + (backwards ? -1 : 1);
  if (index < 0 || index >= item.rows * item.cols) return null;
  return addressOf(Math.floor(index / item.cols), index % item.cols);
}

function rawAt(item, addr) {
  return item.cells[addr] ?? '';
}

// Move to the far end of a filled run, or across a gap to the next filled cell.
export function arrowDestination(item, address, key, jump = false) {
  const {row,col} = parseAddress(address);
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const step = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const limit = horizontal ? item.cols : item.rows;
  const cell = i => horizontal ? addressOf(row,i) : addressOf(i,col);
  let next = (horizontal ? col : row) + step;
  if (next < 0 || next >= limit) return address;
  if (jump) {
    const end = step > 0 ? limit - 1 : 0;
    const inRun = rawAt(item,address) !== '' && rawAt(item,cell(next)) !== '';
    while (next !== end && (inRun ? rawAt(item,cell(next+step)) !== '' : rawAt(item,cell(next)) === '')) next += step;
  }
  return cell(next);
}

function putCell(cells, address, value) {
  if (value === '') delete cells[address];
  else cells[address] = value;
}

function tsvField(value) {
  const text = String(value);
  return /["\r\n\t]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function parseTSV(text) {
  const rows = [];
  let row = [],
    value = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') quoted = false;
      else value += c;
    } else if (!value && c === '"') quoted = true;
    else if (c === '\t') {
      if (row.length < TABLE_LIMITS.cols) row.push(value);
      value = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (row.length < TABLE_LIMITS.cols) row.push(value);
      rows.push(row);
      if (rows.length === TABLE_LIMITS.rows) return rows;
      row = [];
      value = '';
    } else value += c;
  }
  if (row.length || value || !rows.length || !/[\r\n]$/.test(text)) {
    if (row.length < TABLE_LIMITS.cols) row.push(value);
    rows.push(row);
  }
  return rows;
}

export function pasteCellsAtRange(item, range, values, source) {
  const repeat = !source?.cut && values.length === 1 && values[0].length === 1;
  const height = repeat ? range.bottom - range.top + 1 : values.length;
  const cells = { ...item.cells };
  let bottom = range.top, right = range.left;
  for (let i = 0; i < Math.min(height, TABLE_LIMITS.rows - range.top); i++) {
    const sourceRow = repeat ? 0 : i;
    const width = repeat ? range.right - range.left + 1 : values[sourceRow].length;
    for (let j = 0; j < Math.min(width, TABLE_LIMITS.cols - range.left); j++) {
      const sourceCol = repeat ? 0 : j;
      const row = range.top + i, col = range.left + j;
      let value = values[sourceRow][sourceCol];
      if (source && !source.cut && value.startsWith('=')) {
        const fromRow = source.rowIndices?.[sourceRow];
        const fromCol = source.colIndices?.[sourceCol];
        value = shiftFormula(value, row - (Number.isInteger(fromRow) ? fromRow : source.row + sourceRow),
          col - (Number.isInteger(fromCol) ? fromCol : source.col + sourceCol));
      }
      putCell(cells, addressOf(row, col), value);
      bottom = Math.max(bottom, row);
      right = Math.max(right, col);
    }
  }
  return { patch: {cells, rows: Math.max(item.rows, bottom + 1), cols: Math.max(item.cols, right + 1)},
    last: addressOf(bottom, right) };
}

const showValue = (value) => formatValue(value, getLanguage());
const summaryFormats = new Map();
function shortValue(value) {
  if (value == null) return '—';
  if (value && (Math.abs(value) < 0.01 || Math.abs(value) > 1e12)) return showValue(value);
  const lang = getLanguage();
  if (!summaryFormats.has(lang))
    summaryFormats.set(lang, new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }));
  return summaryFormats.get(lang).format(value);
}

// The DOM node identifies the actual table even when two imported drawing
// blocks contain the same object id. The note editor routes only sibling blocks.
const referenceTargets = new WeakMap();

export function makeTableUI({
  getTable,
  onChange,
  onRename,
  onInsert,
  onDeleteAxes,
  onRemoveTable,
  onFile,
  onSelect,
  onChart,
  onUndo,
  onReferenceError
}) {
  const views = new Map();
  let active = null,
    edit = null,
    renaming = null,
    drag = null;

  function isSelecting(v) {
    const board = v.root.closest('.vb');
    return (
      !board ||
      (board.dataset.active !== 'false' &&
        board.dataset.tool === 'select' &&
        !board.classList.contains('vb-space'))
    );
  }
  const isInteractive = (v) => !v.item.locked && isSelecting(v);

  function rowHeight(v) {
    const head = v.item.showName === false ? 0 : 33;
    const letters = v.item.showColumnLetters === false ? 0 : 24;
    return Math.max(26, (v.item.h - head - letters - 3) / v.item.rows || 26);
  }

  function buildGrid(v) {
    const item = v.item;
    const height = rowHeight(v);
    const showRows = item.showRowNumbers !== false, showCols = item.showColumnLetters !== false;
    const labelsHeight = showCols ? 24 : 0;
    const headerRows = new Set(item.headerRows || []), headerCols = new Set(item.headerCols || []);
    // Large pasted ranges keep the visible rows and a small overscan in the DOM.
    const start =
      item.rows <= 60 ? 0 : Math.max(0, Math.floor((v.scroller.scrollTop - labelsHeight) / height) - 4);
    const end =
      item.rows <= 60
        ? item.rows
        : Math.min(item.rows, start + Math.ceil((v.scroller.clientHeight || item.h) / height) + 10);
    const key = [item.rows, item.cols, start, end, item.rows > 60 ? height : 0,
      showRows, showCols, item.headerRows, item.headerCols].join('/');
    v.root.style.setProperty('--vt-row', height + 'px');
    if (v.gridKey === key) return;
    // The inline field belongs to a cell; preserve it during structural changes.
    const field = edit?.v === v && !edit.formula ? edit : null;
    if (field) moveField(field, v.footer);
    v.gridKey = key;
    v.cells.clear();
    v.grid.setAttribute('aria-rowcount', item.rows + Number(showCols));
    v.grid.setAttribute('aria-colcount', item.cols + Number(showRows));
    v.grid.style.minWidth = (showRows ? 30 : 0) + item.cols * 72 + 'px';
    const cols = document.createElement('colgroup');
    if (showRows) cols.append(node('col', 'vt-index-col'));
    for (let col = 0; col < item.cols; col++) cols.append(document.createElement('col'));
    const head = document.createElement('thead');
    const labels = head.insertRow();
    const corner = node('th', 'vt-corner');
    corner.dataset.vtAll = '';
    corner.setAttribute('aria-label', tr('Выделить всю таблицу', 'Select all cells'));
    if (showRows) labels.append(corner);
    for (let col = 0; col < item.cols; col++) {
      const th = node('th', 'vt-column', addressOf(0, col).slice(0, -1));
      th.scope = 'col';
      th.dataset.vtCol = col;
      labels.append(th);
    }
    const body = document.createElement('tbody');
    function spacer(count) {
      if (!count) return;
      const td = body.insertRow().insertCell();
      td.colSpan = item.cols + Number(showRows);
      td.className = 'vt-spacer';
      td.style.height = count * height + 'px';
      td.setAttribute('aria-hidden', 'true');
    }
    spacer(start);
    for (let row = start; row < end; row++) {
      const line = body.insertRow();
      line.setAttribute('aria-rowindex', row + 1 + Number(showCols));
      const number = node('th', 'vt-row-number', row + 1);
      number.scope = 'row';
      number.dataset.vtRow = row;
      if (showRows) line.append(number);
      for (let col = 0; col < item.cols; col++) {
        const address = addressOf(row, col);
        const cell = line.insertCell();
        cell.className = 'vt-cell';
        cell.dataset.vtAddr = address;
        cell.id = v.uid + '-' + address;
        const rowHeader = headerRows.has(row), colHeader = headerCols.has(col);
        if (rowHeader) cell.classList.add('vt-header-row');
        if (colHeader) cell.classList.add('vt-header-col');
        cell.setAttribute('role', rowHeader ? 'columnheader' : colHeader ? 'rowheader' : 'gridcell');
        cell.setAttribute('aria-label', address);
        const display = node('span', 'vt-value');
        cell.append(display);
        v.cells.set(address, { cell, display, row, col });
      }
    }
    spacer(item.rows - end);
    v.grid.replaceChildren(cols, ...(showCols ? [head] : []), body);
    if (field && v.cells.has(field.address)) moveField(field, v.cells.get(field.address).cell);
  }

  function refreshValues(v) {
    for (const [addr, { cell, display }] of v.cells) {
      const value = v.workbook.value(v.id, addr);
      const shown = showValue(value);
      if (display.textContent !== shown) display.textContent = shown;
      cell.setAttribute('aria-label', shown === '' ? addr : addr + ' · ' + shown);
      cell.classList.toggle('vt-number', typeof value === 'number');
      cell.classList.toggle(
        'vt-error',
        typeof value === 'string' && /^#(REF!|CYCLE!|DIV\/0!|VALUE!|NAME\?|ERROR!|NUM!)/.test(value)
      );
      const raw = rawAt(v.item, addr);
      cell.title = raw.startsWith('=') ? raw : shown;
    }
  }

  function fillAnchor(v, range, axis) {
    if (!axis) return v.cells.get(addressOf(range.bottom, range.right))?.cell;
    // An entire column can span hundreds of offscreen rows. Put its handle on
    // the sticky ruler, keeping it reachable even in a virtualized table.
    const labels = v.item.showRowNumbers === false ? 0 : 30;
    const header = v.item.showColumnLetters === false ? 0 : 24;
    const width = (v.grid.offsetWidth - labels) / v.item.cols;
    const visibleCol = Math.floor((v.scroller.scrollLeft + v.scroller.clientWidth - labels + .5) / width) - 1;
    const visibleRow = Math.floor((v.scroller.scrollTop + v.scroller.clientHeight - header + .5) / rowHeight(v)) - 1;
    const row = Math.max(range.top, Math.min(range.bottom, visibleRow));
    const col = Math.max(range.left, Math.min(range.right, visibleCol));
    if (axis === 'cols' && header) return v.grid.querySelector('[data-vt-col="' + col + '"]');
    if (axis === 'rows' && labels) return v.grid.querySelector('[data-vt-row="' + row + '"]');
    return v.cells.get(addressOf(row, col))?.cell;
  }

  function refreshSelection(v) {
    const own = active?.id === v.id;
    const range = own ? sortedRange(active.first, active.last) : null;
    const ranges = !own ? [] : active.axis ? axisRanges(v.item, active.axis, active.indices) : [range];
    const fill = drag?.kind === 'fill' && drag.v === v ? drag : null;
    const picking = drag?.kind === 'ref' && drag.v === v;
    const refRange = picking ? sortedRange(drag.first, drag.last) : null;
    v.root.classList.toggle('vt-active', !!own);
    for (const header of v.grid.querySelectorAll('[data-vt-row], [data-vt-col]')) {
      const row = header.hasAttribute('data-vt-row');
      const index = Number(row ? header.dataset.vtRow : header.dataset.vtCol);
      const selected = own && active.axis === (row ? 'rows' : 'cols') && active.indices.has(index);
      header.classList.toggle('vt-axis-selected', selected);
      header.classList.toggle('vt-range-header', own && !active.axis && (row
        ? index >= range.top && index <= range.bottom : index >= range.left && index <= range.right));
      header.setAttribute('aria-selected', String(!!selected));
    }
    for (const [addr, { cell, row, col }] of v.cells) {
      const selected = own && isSelected(active, range, row, col);
      if (selected || cell.classList.contains('vt-selected')) {
        cell.classList.toggle('vt-selection-top', selected && (row === 0 || !isSelected(active, range, row - 1, col)));
        cell.classList.toggle('vt-selection-bottom', selected && (row === v.item.rows - 1 || !isSelected(active, range, row + 1, col)));
        cell.classList.toggle('vt-selection-left', selected && (col === 0 || !isSelected(active, range, row, col - 1)));
        cell.classList.toggle('vt-selection-right', selected && (col === v.item.cols - 1 || !isSelected(active, range, row, col + 1)));
      }
      cell.classList.toggle('vt-selected', selected);
      cell.classList.toggle('vt-fill-preview', !!fill?.added && isSelected(null, fill.added, row, col));
      cell.classList.toggle('vt-anchor', own && addr === active.first);
      cell.classList.toggle(
        'vt-reference',
        !!refRange &&
          row >= refRange.top &&
          row <= refRange.bottom &&
          col >= refRange.left &&
          col <= refRange.right
      );
      cell.setAttribute('aria-selected', String(selected));
    }
    const corner = ranges.length === 1 && !edit && !renaming && isInteractive(v)
      ? fillAnchor(v, ranges[0], active.axis) : null;
    if (corner) {
      v.fillHandle.classList.toggle('vt-fill-table-corner',
        corner.dataset.vtAddr === addressOf(v.item.rows - 1, v.item.cols - 1));
      if (v.fillHandle.parentNode !== corner) corner.append(v.fillHandle);
    } else v.fillHandle.remove();
    if (own) v.root.setAttribute('aria-activedescendant', v.uid + '-' + active.first);
    else v.root.removeAttribute('aria-activedescendant');
    v.footer.hidden = !own;
    if (!own && v.floatingFooter) {
      v.floatingFooter.destroy();
      v.floatingFooter = null;
    }
    const formulaEdit = edit?.v === v && edit.formula ? edit : null;
    const selectedText = own && !active.axis && active.first === active.last ? rawAt(v.item, active.first) : '';
    refreshReferenceColors(
      v,
      formulaEdit ? formulaEdit.field.value : edit ? '' : selectedText,
      formulaEdit,
      () => refreshSelection(v)
    );
    if (!own || !v.workbook) return;
    const refs = ranges.map(rangeLabel);
    const many = !!active.axis || active.first !== active.last;
    if (active.axis) {
      const label = i => active.axis === 'rows' ? String(i + 1) : addressOf(0, i).slice(0, -1);
      v.address.textContent = ranges.map(part => {
        const a = active.axis === 'rows' ? part.top : part.left;
        const b = active.axis === 'rows' ? part.bottom : part.right;
        return a === b ? label(a) : label(a) + '–' + label(b);
      }).join(', ');
    } else v.address.textContent = refs[0];
    v.address.title = refs.join(', ');
    if (fill?.added) v.address.title = v.address.textContent = rangeLabel(fill.target);
    const isFormula = edit?.v === v && edit.formula;
    v.footer.classList.toggle('vt-formulating', !!isFormula);
    v.fx.hidden = many || !!isFormula || !!fill?.added;
    v.functions.hidden = many || !!fill?.added || !isInteractive(v);
    v.quick.hidden = many || !!edit || !!fill?.added;
    if (!v.quick.hidden) {
      const label = selectedText.startsWith('=') ? selectedText : '';
      if (v.quick.textContent !== label) v.quick.textContent = label;
    }
    v.stats.hidden = !many || !!isFormula || !!fill?.added;
    if (!v.stats.hidden) {
      let sum = 0, count = 0;
      for (const part of ranges) {
        const s = v.workbook.summary(v.id, addressOf(part.top, part.left), addressOf(part.bottom, part.right));
        sum += s.sum;
        count += s.count;
      }
      const result = [
        ['SUM', tr('Сумма', 'Sum'), sum],
        ['AVERAGE', tr('Среднее', 'Average'), count ? sum / count : null],
        ['COUNT', tr('Чисел', 'Count'), count]
      ];
      let row = range.bottom + 1;
      while (row < TABLE_LIMITS.rows && rawAt(v.item, addressOf(row, range.left)) !== '') row++;
      // Focus and scrolling refresh the selection between pointerdown and click.
      // Keep the three button nodes stable while updating their current actions.
      result.forEach(([fn, label, value], index) => {
          let action = v.stats.children[index];
          if (!action) {
            action = node('button', 'vt-result');
            v.stats.append(action);
          }
          action.textContent = label + ' ' + shortValue(value);
          action.type = 'button';
          action.disabled = value == null || row === TABLE_LIMITS.rows;
          const target = addressOf(Math.min(row, TABLE_LIMITS.rows - 1), range.left);
          action.title = label + ' ' + (value == null ? '—' : showValue(value));
          if (!action.disabled) {
            action.title += ' · ' + tr('Вставить формулу в ', 'Insert formula in ') + target;
            action.onclick = () => {
              const item = getTable(v.id);
              if (!item || item.locked || rawAt(item, target) !== '') return;
              const formula = '=' + fn + '(' + refs.join(';') + ')';
              onChange(v.id, {
                cells: { ...item.cells, [target]: formula },
                rows: Math.max(item.rows, row + 1)
              });
              focusCell(v.id, target);
            };
          }
      });
      // A chart has one rectangular source. Exclude gaps from every chart.
      v.chartButton.hidden = !count || ranges.length > 1;
    } else v.chartButton.hidden = true;
    if (v.root.isConnected) {
      v.floatingFooter ??= canvasTableFooter(v);
      v.floatingFooter?.update(v.cells.get(active.first)?.cell);
    }
  }

  function refresh(v) {
    if (!v.workbook) return;
    buildGrid(v);
    refreshValues(v);
    refreshSelection(v);
  }

  function selectRange(v, first, last = first, focus = true, axes) {
    const before = active && views.get(active.id);
    active = { id: v.id, first, last, ...axes };
    if (before && before !== v) {
      before.controls.closeMenu();
      refreshSelection(before);
    }
    onSelect?.(v.id);
    refreshSelection(v);
    if (focus) v.root.focus({ preventScroll: true });
  }

  function setAxes(v, axis, indices, pivot, edge, focus = true) {
    if (!indices.size) {
      active = null;
      refreshSelection(v);
      if (focus) v.root.focus({ preventScroll: true });
      return;
    }
    const rows = axis === 'rows', first = Math.min(...indices), last = Math.max(...indices);
    selectRange(v, addressOf(rows ? first : 0, rows ? 0 : first),
      addressOf(rows ? last : v.item.rows - 1, rows ? v.item.cols - 1 : last), focus,
      { axis, indices, pivot, edge });
  }

  function deleteAxes(v, axis, indices) {
    if (!isInteractive(v) || !indices.length || !onDeleteAxes) return;
    const at = parseAddress(active?.id === v.id ? active.first : 'A1');
    if (!onDeleteAxes(v.id, axis, indices)) return;
    const item = getTable(v.id);
    if (item) focusCell(v.id, boundedCell(item,
      axis === 'rows' ? indices[0] : at.row, axis === 'cols' ? indices[0] : at.col));
  }

  function reveal(v, addr) {
    const { row, col } = parseAddress(addr);
    const height = rowHeight(v);
    const labelHeight = v.item.showColumnLetters === false ? 0 : 24;
    const labelWidth = v.item.showRowNumbers === false ? 0 : 30;
    const y = row * height;
    if (y < v.scroller.scrollTop) v.scroller.scrollTop = y;
    else if (y + labelHeight + height > v.scroller.scrollTop + v.scroller.clientHeight)
      v.scroller.scrollTop = y + labelHeight + height - v.scroller.clientHeight;
    const width = (v.grid.offsetWidth - labelWidth) / v.item.cols;
    const x = col * width;
    if (x < v.scroller.scrollLeft) v.scroller.scrollLeft = x;
    else if (x + labelWidth + width > v.scroller.scrollLeft + v.scroller.clientWidth)
      v.scroller.scrollLeft = x + labelWidth + width - v.scroller.clientWidth;
    refresh(v);
  }

  function focusCell(id, addr = 'A1') {
    const v = views.get(id);
    if (!v || !isInteractive(v)) return;
    finishEdit();
    const { row, col } = parseAddress(addr) || { row: 0, col: 0 };
    const bounded = boundedCell(v.item, row, col);
    reveal(v, bounded);
    selectRange(v, bounded);
  }

  function moveField(session, host) {
    session.moving = true;
    const { field } = session;
    const start = field.selectionStart,
      end = field.selectionEnd;
    host.append(field);
    field.focus({ preventScroll: true });
    field.setSelectionRange(start, end);
    session.moving = false;
  }

  function positionEditor(session) {
    const formula = session.field.value.startsWith('=');
    const host = formula ? referenceFieldHost(session) : session.v.cells.get(session.address)?.cell;
    session.formula = formula;
    session.field.classList.toggle('vt-formula', formula);
    if (host && session.field.parentElement !== host) moveField(session, host);
    refreshSelection(session.v);
  }

  function startEdit(v, address, seed) {
    if (!isInteractive(v)) return;
    finishEdit();
    selectRange(v, address);
    reveal(v, address);
    const field = node('input', 'vt-editor');
    field.type = 'text';
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.setAttribute('aria-label', tr('Содержимое ячейки ', 'Cell contents ') + address);
    field.value = seed === undefined ? rawAt(v.item, address) : seed;
    const suggestions = attachFormulaSuggestions(field, v.root, v.uid, v.functions);
    const session = { v, address, field, suggestions, formula: false, moving: false, pick: null };
    edit = session;
    field.addEventListener('input', () => {
      field.setCustomValidity('');
      session.pick = null;
      positionEditor(session);
      suggestions.refresh();
    });
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'F3' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); suggestions.browse(false); return;
      }
      if (suggestions.keydown(e)) return;
      if (!['Escape', 'Tab', 'Enter'].includes(e.key)) return;
      const { row, col } = parseAddress(address);
      const next = e.key === 'Tab' ? tabDestination(v.item, address, e.shiftKey)
        : e.key === 'Enter' ? boundedCell(v.item, row + (e.shiftKey ? -1 : 1), col) : address;
      finishEdit(e.key === 'Escape');
      if (next) {
        e.preventDefault();
        focusCell(v.id, next);
      } else v.root.focus({ preventScroll: true }); // Let native Tab continue into the table controls or out.
    });
    field.addEventListener('blur', () => {
      if (edit === session && !session.moving) finishEdit();
    });
    field.addEventListener('pointerdown', (e) => {
      session.pick = null;
      e.stopPropagation();
    });
    positionEditor(session);
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
    suggestions.refresh();
  }

  function finishEdit(cancel = false) {
    if (renaming) finishRename(cancel);
    if (!edit) return;
    const { v, address, field, suggestions, stopPicking, refHost } = edit;
    edit = null;
    stopPicking?.();
    suggestions.destroy();
    field.remove();
    refHost?.remove();
    clearReferenceColors(v);
    if (!cancel) writeCell(v,address,field.value);
    refreshSelection(v);
  }

  function writeCell(v,address,value) {
    const item = getTable(v.id);
    if (item && !item.locked && rawAt(item, address) !== value) {
      const cells = { ...item.cells };
      putCell(cells, address, value);
      onChange(v.id, { cells });
    }
  }

  function commitDraft() {
    if (renaming) return finishRename(false,true);
    if (edit) writeCell(edit.v,edit.address,edit.field.value);
    return true;
  }

  function finishRename(cancel = false, report = false) {
    if (!renaming) return;
    const { v, field } = renaming;
    const name = field.value.trim();
    if (!cancel && name !== v.item.name && (!name || onRename(v.id, name) === false)) {
      const msg = name
        ? tr('Такое имя уже используется', 'This name is already in use')
        : tr('Введите имя таблицы', 'Enter a table name');
      if (report) {
        field.setCustomValidity(msg);
        field.reportValidity();
        return false;
      }
      v.name.title = msg;
    }
    renaming = null;
    field.remove();
    v.name.hidden = false;
    return true;
  }

  function rename(v) {
    if (!isInteractive(v)) return;
    finishEdit();
    const field = node('input', 'vt-rename');
    field.type = 'text';
    field.maxLength = 120;
    field.value = v.item.name;
    field.setAttribute('aria-label', tr('Имя таблицы', 'Table name'));
    v.name.hidden = true;
    v.head.insertBefore(field, v.actions);
    renaming = { v, field };
    field.addEventListener('pointerdown', (e) => e.stopPropagation());
    field.addEventListener('input', () => field.setCustomValidity(''));
    field.addEventListener('blur', () => {
      if (renaming?.field === field) finishRename();
    });
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        if (finishRename(e.key === 'Escape', true)) v.root.focus();
      }
    });
    field.focus({ preventScroll: true });
    field.select();
  }

  function referenceWriter(targetTable, external = false) {
    const session = edit;
    session.stopPicking?.();
    const { field, pick } = session;
    field.setCustomValidity('');
    const { prefix, suffix } = referencePickParts(field.value, field.selectionStart, field.selectionEnd, pick);
    return (first, last) => {
      if (edit !== session) return;
      let value = referenceTo(external ? null : session.v.id, targetTable, first);
      if (last !== first) value += ':' + last;
      field.value = prefix + value + suffix;
      const to = prefix.length + value.length;
      field.setSelectionRange(to, to);
      session.pick = { from:prefix.length, to };
      refreshSelection(session.v);
      session.suggestions.refresh();
    };
  }

  function pickExternalCell(event, targetName, allowed = true) {
    if (event.button !== 0 || !edit?.formula) return false;
    const cell = event.target.closest?.('[data-vt-addr]');
    const root = cell?.closest('.vt-table');
    const target = root && referenceTargets.get(root);
    if (!target || views.get(target.view.id)?.root === root) return false;
    event.preventDefault();
    event.stopPropagation();
    if (!allowed) {
      const msg = tr(
        'Дайте таблицам разные названия, чтобы сослаться на эту ячейку.',
        'Give the tables distinct names to reference this cell.'
      );
      if (onReferenceError) onReferenceError(msg);
      else {
        edit.field.setCustomValidity(msg);
        edit.field.reportValidity();
      }
      return true;
    }
    const item = target.view.item;
    const write = referenceWriter({ id: item.id, name: targetName || item.name }, true);
    edit.stopPicking = target.start(event, cell.dataset.vtAddr, write);
    return true;
  }

  function startDrag(v, event, addr, write, axis) {
    endDrag();
    let updateAxes;
    if (axis) {
      const prior = active?.id === v.id && active.axis === axis ? active : null;
      const additive = event.ctrlKey || event.metaKey;
      const pivot = event.shiftKey && prior ? prior.pivot : addr;
      const base = additive && prior ? prior.indices : [];
      const remove = additive && !event.shiftKey && prior?.indices.has(addr);
      updateAxes = (edge, focus) => {
        const indices = new Set(base);
        for (let i = Math.min(pivot, edge); i <= Math.max(pivot, edge); i++) {
          if (remove) indices.delete(i); else indices.add(i);
        }
        setAxes(v, axis, indices, pivot, edge, focus);
      };
      drag = { kind: 'axis', v, last: addr };
      updateAxes(addr, true);
    } else if (write) {
      drag = { kind: 'ref', v, first: addr, last: addr };
      write(addr, addr);
      refreshSelection(v);
    } else {
      const first = event.shiftKey && active?.id === v.id ? active.first : addr;
      selectRange(v, first, addr);
      drag = { kind: 'select', v, first, last: addr };
    }
    const id = event.pointerId;
    const cleanup = new AbortController();
    drag.cleanup = cleanup;
    function extend(x, y) {
      const target = document.elementFromPoint(x, y)?.closest('[data-vt-addr],[data-vt-row],[data-vt-col]');
      if (!target || !v.root.contains(target)) return;
      let next = target.dataset.vtAddr;
      if (axis) {
        const key = axis === 'rows' ? 'row' : 'col';
        const labelIndex = key === 'row' ? target.dataset.vtRow : target.dataset.vtCol;
        next = labelIndex !== undefined ? Number(labelIndex) : parseAddress(next)?.[key];
      }
      if (next === undefined) return;
      if (drag.last === next) return;
      drag.last = next;
      if (axis) updateAxes(next, false);
      else {
        if (write) write(drag.first, next);
        else active.last = next;
        refreshSelection(v);
      }
    }
    let x,
      y,
      frame = 0;
    function scrollEdge() {
      frame = 0;
      if (!drag) return;
      const rect = v.scroller.getBoundingClientRect();
      const scale = rect.width / Math.max(1, v.scroller.offsetWidth);
      const step = (d) => Math.ceil(Math.min(16, Math.max(0, d / scale)));
      const header = v.item.showColumnLetters === false ? 0 : 24 * scale,
        labels = v.item.showRowNumbers === false ? 0 : 30 * scale,
        inset = 12 * scale;
      const dx = axis === 'rows' ? 0 : step(x - rect.right + inset) - step(rect.left + labels + inset - x);
      const dy = axis === 'cols' ? 0 : step(y - rect.bottom + inset) - step(rect.top + header + inset - y);
      const left = v.scroller.scrollLeft,
        top = v.scroller.scrollTop;
      v.scroller.scrollBy(dx, dy);
      if (left === v.scroller.scrollLeft && top === v.scroller.scrollTop) return;
      refresh(v);
      extend(
        Math.max(rect.left + labels + 2, Math.min(rect.right - 10, x)),
        Math.max(rect.top + header + 2, Math.min(rect.bottom - 10, y))
      );
      frame = requestAnimationFrame(scrollEdge);
    }
    cleanup.signal.addEventListener('abort', () => cancelAnimationFrame(frame));
    window.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== id) return;
        x = e.clientX;
        y = e.clientY;
        extend(x, y);
        if (!frame) frame = requestAnimationFrame(scrollEdge);
      },
      { signal: cleanup.signal }
    );
    for (const type of ['pointercancel', 'pointerup'])
      window.addEventListener(
        type,
        (e) => {
          if (e.pointerId === id) endDrag();
        },
        { signal: cleanup.signal }
      );
    window.addEventListener('blur', endDrag, { signal: cleanup.signal });
    return () => {
      if (drag?.cleanup === cleanup) endDrag();
    };
  }

  function endDrag() {
    if (!drag) return;
    const prev = drag;
    drag = null;
    prev.cleanup?.abort();
    if (prev.kind === 'ref' || prev.kind === 'fill') refreshSelection(prev.v);
  }

  function startFill(v, event) {
    if (event.button !== 0 || !isInteractive(v) || active?.id !== v.id || edit) return;
    event.preventDefault();
    event.stopPropagation();
    endDrag();
    const initial = getTable(v.id), axis = active.axis;
    const ranges = axis ? axisRanges(initial, axis, active.indices) : [sortedRange(active.first, active.last)];
    if (ranges.length !== 1) return;
    const source = ranges[0], cleanup = new AbortController();
    let plan, copyMode, lastAddress, shown, workbook;
    drag = { kind: 'fill', v, cleanup, target: source };
    v.root.focus({ preventScroll: true });
    v.controls.closeMenu();
    trackFill(v, event, source, axis, {
      signal: cleanup.signal,
      cancel: endDrag,
      preview(target, added, address, copy) {
        const before = drag.target;
        const resized = target.top !== before.top || target.bottom !== before.bottom ||
          target.left !== before.left || target.right !== before.right;
        if (resized || copyMode !== copy || workbook !== v.workbook) {
          workbook = v.workbook;
          copyMode = copy;
          const rows = Math.max(initial.rows, target.bottom + 1), cols = Math.max(initial.cols, target.right + 1);
          plan = added && planAutofill({ ...initial, rows, cols }, source, target, getLanguage(),
            copy ? addr => workbook.value(v.id, addr) : undefined);
          lastAddress = null;
        }
        if (resized) {
          drag.target = target;
          drag.added = added;
          refreshSelection(v);
        }
        if (plan && address !== lastAddress) {
          lastAddress = address;
          shown = showValue(workbook.previewValue(v.id, address, plan));
        }
        return shown;
      },
      commit() {
        const target = drag.target;
        endDrag();
        const item = getTable(v.id);
        if (!plan || !item || !isInteractive(v) || item.cells !== initial.cells ||
            item.rows !== initial.rows || item.cols !== initial.cols) return;
        const { rows, cols } = plan;
        const cells = plan.apply();
        if (cells !== item.cells || rows !== item.rows || cols !== item.cols) {
          const patch = { cells, rows, cols };
          if (rows > item.rows) patch.h = Math.round(item.h + (rows - item.rows) * rowHeight(v));
          if (cols > item.cols) {
            const width = (v.grid.offsetWidth - (item.showRowNumbers === false ? 0 : 30)) / item.cols;
            patch.w = Math.round(item.w + (cols - item.cols) * width);
          }
          onChange(v.id, patch);
        }
        if (axis) {
          const first = axis === 'rows' ? target.top : target.left, last = axis === 'rows' ? target.bottom : target.right;
          setAxes(v, axis, new Set(interval(first, last)), first, last);
        } else selectRange(v, addressOf(target.top, target.left), addressOf(target.bottom, target.right));
      }
    });
  }

  function eraseCells(v) {
    const item = getTable(v.id);
    if (!item || !active || item.locked) return;
    const r = sortedRange(active.first, active.last);
    const cells = { ...item.cells };
    let changed = false;
    for (const addr of Object.keys(cells)) {
      const { row, col } = parseAddress(addr);
      if (isSelected(active, r, row, col)) {
        delete cells[addr];
        changed = true;
      }
    }
    if (changed) onChange(v.id, { cells });
  }

  function keydown(v, e) {
    if (!isInteractive(v) || e.target.tagName === 'INPUT') return;
    if (drag?.kind === 'fill') { e.stopPropagation(); e.preventDefault(); return; }
    if (e.target.closest('button') && !(e.ctrlKey || e.metaKey)) {
      e.stopPropagation();
      if (e.key === 'Escape') v.root.focus({preventScroll:true});
      return;
    }
    if (active?.id !== v.id) {
      // Ctrl-click can leave the focused table with no cells selected.
      if (e.target === v.root && ['Delete', 'Backspace'].includes(e.key)) {
        e.stopPropagation();
        e.preventDefault();
      }
      return;
    }
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229 || e.altKey) return;
    if (e.key === 'F3' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !v.functions.hidden) {
      e.preventDefault(); browseFunctions(v); return;
    }
    const cmd = primaryCommand(e);
    if (!cmd && (e.ctrlKey || e.metaKey)) return;
    const direction = historyDirection(e);
    const edge = e.shiftKey ? active.last : active.first;
    let next;
    if (cmd && ['KeyC', 'KeyX', 'KeyV'].includes(e.code)) return;
    if (cmd && !e.shiftKey && e.code === 'KeyA') selectRange(v, 'A1', addressOf(v.item.rows - 1, v.item.cols - 1));
    else if (e.code === 'Space' && cmd !== e.shiftKey) {
      const axis = cmd ? 'cols' : 'rows', r = sortedRange(active.first, active.last);
      const first = cmd ? r.left : r.top, last = cmd ? r.right : r.bottom;
      if (active.axis !== axis) setAxes(v, axis, new Set(interval(first, last)), first, last);
    } else if (active.axis && !cmd && e.shiftKey && (active.axis === 'rows'
      ? ['ArrowUp','ArrowDown'] : ['ArrowLeft','ArrowRight']).includes(e.key)) {
      const axis = active.axis, sign = ['ArrowUp','ArrowLeft'].includes(e.key) ? -1 : 1;
      const edge = Math.max(0, Math.min(v.item[axis] - 1, active.edge + sign));
      reveal(v, addressOf(axis === 'rows' ? edge : 0, axis === 'cols' ? edge : 0));
      setAxes(v, axis, new Set(interval(active.pivot, edge)), active.pivot, edge);
    } else if (direction) onUndo?.(direction === 'redo');
    else if (e.key === 'Escape') {
      clearSelection();
      v.root.closest('.vb-stage')?.focus({ preventScroll: true });
    } else if (e.key === 'Delete' && active.axis && !cmd && !e.shiftKey) {
      deleteAxes(v, active.axis, [...active.indices].sort((a, b) => a - b));
    } else if (!cmd && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) eraseCells(v);
    else if (!cmd && !e.shiftKey && (e.key === 'F2' || e.key === 'Enter')) startEdit(v, active.first);
    else if (!cmd && e.key === 'Tab') {
      next = tabDestination(v.item, edge, e.shiftKey);
      if (!next) return;
    }
    else if (e.key === 'Home') next = boundedCell(v.item, cmd ? 0 : parseAddress(edge).row, 0);
    else if (e.key === 'End') next = boundedCell(v.item, cmd ? v.item.rows - 1 : parseAddress(edge).row, v.item.cols - 1);
    else if (/^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
      next = arrowDestination(v.item,edge,e.key,cmd);
    } else if (e.key.length === 1 && !cmd && !e.altKey) startEdit(v, active.first, e.key);
    else return;
    if (next) {
      reveal(v, next);
      selectRange(v, e.shiftKey && e.key !== 'Tab' ? active.first : next, next);
    }
    e.preventDefault();
  }

  function clipboard(v, event) {
    if (!isInteractive(v)) return;
    event.stopPropagation();
    if (event.target.tagName === 'INPUT' || active?.id !== v.id || !event.clipboardData) return;
    const data = event.clipboardData;
    const item = getTable(v.id);
    const r = sortedRange(active.first, active.last);
    const picked = active.indices && [...active.indices].sort((a, b) => a - b);
    const separated = picked && picked.length < picked.at(-1) - picked[0] + 1;
    if (event.type !== 'paste') {
      const raw = [],
        plain = [];
      for (let row = r.top; row <= r.bottom; row++) {
        if (active.axis === 'rows' && !active.indices.has(row)) continue;
        const values = [],
          labels = [];
        for (let col = r.left; col <= r.right; col++) {
          if (active.axis === 'cols' && !active.indices.has(col)) continue;
          const addr = addressOf(row, col);
          values.push(rawAt(item, addr));
          labels.push(tsvField(v.workbook.value(v.id, addr)));
        }
        raw.push(values);
        plain.push(labels.join('\t'));
      }
      data.setData('text/plain', plain.join('\n'));
      data.setData(
        clipType,
        JSON.stringify({ row: r.top, col: r.left, raw, cut: event.type === 'cut',
          rowIndices: separated && active.axis === 'rows' ? picked : undefined,
          colIndices: separated && active.axis === 'cols' ? picked : undefined })
      );
      if (event.type === 'cut') eraseCells(v);
      event.preventDefault();
      return;
    }
    if (separated) {
      event.preventDefault();
      onReferenceError?.(tr('Для вставки выберите одну начальную ячейку.', 'Select a single starting cell to paste.'));
      return;
    }
    let source = null;
    try {
      source = JSON.parse(data.getData(clipType));
    } catch {
      /* External spreadsheet or plain text. */
    }
    if (
      !(
        Array.isArray(source?.raw) &&
        Number.isInteger(source.row) &&
        Number.isInteger(source.col) &&
        source.raw.every((row) => Array.isArray(row) && row.every((x) => typeof x === 'string'))
      )
    )
      source = null;
    if (!source && !Array.from(data.types).includes('text/plain')) return;
    const values = source?.raw || parseTSV(data.getData('text/plain'));
    const {patch, last} = pasteCellsAtRange(item, r, values, source);
    onChange(v.id, patch);
    selectRange(v, addressOf(r.top, r.left), last);
    event.preventDefault();
  }

  function browseFunctions(v) {
    if (active?.id !== v.id || !isInteractive(v)) return;
    const alreadyEditing = edit?.v === v;
    if (!alreadyEditing) startEdit(v, active.first);
    edit.suggestions.browse(!alreadyEditing);
  }

  function makeView(item) {
    const root = node('section', 'vt-table'),
      head = node('div', 'vt-head');
    root.tabIndex = 0;
    root.dataset.tableId = item.id;
    root.setAttribute('role', 'group');
    const grip = node('div', 'vt-grip'),
      name = node('span', 'vt-name', item.name);
    grip.title = tr('Переместить таблицу', 'Move table');
    grip.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16">' + icons.grip + '</svg>';
    grip.append(name);
    const actions = button('vt-more', tr('Действия с таблицей', 'Table actions'), 'more');
    head.append(grip, actions);
    const scroller = node('div', 'vt-scroll'),
      grid = node('table', 'vt-grid');
    grid.setAttribute('role', 'grid');
    scroller.append(grid);
    const footer = node('div', 'vt-footer'),
      address = node('span', 'vt-address');
    const fx = button('vt-fx', tr('Редактировать формулу', 'Edit formula'));
    fx.textContent = 'ƒx';
    const functions = button('vt-functions', tr('Все функции', 'All functions'));
    functions.textContent = tr('Функции', 'Functions');
    functions.title += ' (Shift+F3)';
    functions.setAttribute('aria-haspopup', 'listbox');
    functions.setAttribute('aria-expanded', 'false');
    const quick = node('span', 'vt-quick'),
      stats = node('div', 'vt-stats');
    const chartButton = button('vt-make-chart', tr('Построить график', 'Create chart'), 'chart');
    footer.append(address, fx, functions, quick, stats, chartButton);
    footer.hidden = true;
    const menu = node('div', 'vt-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const fillHandle = button('vt-fill-handle', tr('Автозаполнение', 'Autofill'));
    fillHandle.title = shortcutLabel(tr('Потяните, чтобы продолжить ряд. Ctrl — копировать значения.', 'Drag to continue the series. Hold Ctrl to copy values.'));
    fillHandle.tabIndex = -1;
    const fillOverflow = node('div', 'vt-fill-overflow');
    fillOverflow.hidden = true;
    fillOverflow.setAttribute('aria-hidden', 'true');
    root.append(head, scroller, footer, menu, fillOverflow);
    const v = {
      root,
      id: item.id,
      uid: 'vt-' + crypto.randomUUID(),
      head,
      name,
      actions,
      scroller,
      grid,
      fillHandle,
      fillOverflow,
      menu,
      footer,
      address,
      fx,
      functions,
      quick,
      stats,
      chartButton,
      cells: new Map(),
      item
    };
    views.set(item.id, v);
    fillHandle.addEventListener('pointerdown', event => startFill(v, event));
    fillHandle.addEventListener('dblclick', event => event.stopPropagation());
    referenceTargets.set(root, {
      view: v,
      start: (event, addr, write) => startDrag(v, event, addr, write)
    });
    v.controls = mountTableControls(v, {
      interactive: () => isInteractive(v),
      anchor: () => parseAddress(active?.id === v.id ? active.first : 'A1'),
      select: (address) => {
        if (address || active?.id !== v.id) selectRange(v, address || 'A1', address || 'A1', false);
      },
      contextAxes(axis, index) {
        if (active?.id !== v.id || active.axis !== axis || !active.indices.has(index))
          setAxes(v, axis, new Set([index]), index, index, false);
        return [...active.indices].sort((a, b) => a - b);
      },
      cellContext(location) {
        let bounds = active?.id === v.id ? sortedRange(active.first, active.last) : null;
        if (!bounds || !isSelected(active, bounds, location.row, location.col)) {
          const address = addressOf(location.row, location.col);
          selectRange(v, address, address, false);
          bounds = sortedRange(address, address);
        }
        if (active.axis) {
          const picked = [...active.indices].sort((a, b) => a - b);
          return active.axis === 'rows' ? {rows: picked, cols: [location.col]} : {rows: [location.row], cols: picked};
        }
        return {rows: interval(bounds.top, bounds.bottom), cols: interval(bounds.left, bounds.right)};
      },
      currentAxis: () => active?.id === v.id ? active.axis : undefined,
      deleteAxes: (axis, indices) => deleteAxes(v, axis, indices),
      finish: finishEdit, focusCell, insert: onInsert, change: onChange, rename,
      remove: onRemoveTable, file: onFile
    });
    fx.onclick = quick.onclick = () => {
      if (active?.id === v.id) startEdit(v, active.first, rawAt(v.item, active.first) || '=');
    };
    // Keep the active formula and its text selection while the button is pressed.
    functions.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
    functions.onclick = () => browseFunctions(v);
    chartButton.onclick = () => {
      if (!active || active.id !== v.id) return;
      const r = sortedRange(active.first, active.last);
      onChart(v.id, { start: addressOf(r.top, r.left), end: addressOf(r.bottom, r.right) });
    };
    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !isSelecting(v) || e.target.closest('.vt-grip')) return;
      const td = e.target.closest('[data-vt-addr]');
      if (edit?.formula && td && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        e.stopPropagation();
        const session = edit;
        session.stopPicking = startDrag(v, e, td.dataset.vtAddr, referenceWriter(v.item));
        return;
      }
      if (v.item.locked) return;
      e.stopPropagation();
      if (e.target.closest('.vt-menu,button,input,.vt-footer')) return;
      v.controls.closeMenu();
      e.preventDefault();
      finishEdit();
      if (td) startDrag(v, e, td.dataset.vtAddr);
      else if (e.target.closest('[data-vt-col]')) {
        const col = Number(e.target.closest('[data-vt-col]').dataset.vtCol);
        startDrag(v, e, col, null, 'cols');
      } else if (e.target.closest('[data-vt-row]')) {
        const row = Number(e.target.closest('[data-vt-row]').dataset.vtRow);
        startDrag(v, e, row, null, 'rows');
      } else if (e.target.closest('[data-vt-all]'))
        selectRange(v, 'A1', addressOf(v.item.rows - 1, v.item.cols - 1));
    });
    root.addEventListener('dblclick', (e) => {
      if (!isInteractive(v) || e.target.closest('.vt-grip')) return;
      e.stopPropagation();
      const td = e.target.closest('[data-vt-addr]');
      if (td && !edit) startEdit(v, td.dataset.vtAddr);
    });
    root.addEventListener('keydown', (e) => keydown(v, e));
    for (const type of ['copy', 'paste', 'cut']) root.addEventListener(type, (e) => clipboard(v, e));
    scroller.addEventListener('scroll', () => refresh(v));
    scroller.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey || !isInteractive(v)) return;
        const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
        const dy = e.shiftKey ? 0 : e.deltaY;
        const canScroll = (d, pos, size, total) => (d < 0 ? pos > 0 : d > 0 && pos + size < total - 1);
        if (
          canScroll(dx, scroller.scrollLeft, scroller.clientWidth, scroller.scrollWidth) ||
          canScroll(dy, scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight)
        )
          e.stopPropagation();
      },
      { passive: true }
    );
    return root;
  }

  function updateView(el, item, workbook) {
    const v = views.get(item.id);
    if (!v || v.root !== el) return;
    if (edit?.v === v && item.locked) finishEdit(true);
    if (drag?.kind === 'fill' && drag.v === v && item.locked) endDrag();
    const previous = v.item;
    v.item = item;
    v.name.textContent = item.name;
    v.root.setAttribute('aria-label', item.name);
    v.grid.setAttribute('aria-label', item.name);
    v.controls.update();
    v.root.classList.toggle('vt-no-name', item.showName === false);
    v.actions.disabled = !!item.locked;
    if (active?.id === v.id) {
      const clamp = (addr) => {
        const { row, col } = parseAddress(addr);
        return boundedCell(item, row, col);
      };
      active.first = clamp(active.first);
      active.last = clamp(active.last);
      if (active.axis && previous[active.axis] !== item[active.axis]) {
        const limit = item[active.axis];
        const kept = new Set([...active.indices].filter(i => i < limit));
        if (kept.size) {
          const first = Math.min(...kept), last = Math.max(...kept);
          const rows = active.axis === 'rows';
          active.indices = kept;
          active.pivot = Math.min(active.pivot, limit - 1);
          active.edge = Math.min(active.edge, limit - 1);
          active.first = addressOf(rows ? first : 0, rows ? 0 : first);
          active.last = addressOf(rows ? last : item.rows - 1, rows ? item.cols - 1 : last);
        } else active = null;
      }
    }
    const changed =
      previous.cells !== item.cells ||
      previous.rows !== item.rows ||
      previous.cols !== item.cols ||
      previous.showName !== item.showName ||
      previous.locked !== item.locked ||
      previous.showRowNumbers !== item.showRowNumbers ||
      previous.showColumnLetters !== item.showColumnLetters ||
      previous.headerRows?.join() !== item.headerRows?.join() ||
      previous.headerCols?.join() !== item.headerCols?.join() ||
      previous.h !== item.h ||
      workbook !== v.workbook;
    v.workbook = workbook;
    if (changed || !v.gridKey) refresh(v);
  }

  function clearSelection() {
    endDrag();
    finishEdit();
    const v = active && views.get(active.id);
    active = null;
    if (v) {
      v.controls.closeMenu();
      refreshSelection(v);
    }
  }

  function removeView(el) {
    const v = views.get(el.dataset.tableId);
    if (!v || v.root !== el) return;
    if (drag?.v === v) endDrag();
    if (edit?.v === v) finishEdit(true);
    if (renaming?.v === v) finishRename(true);
    if (active?.id === v.id) active = null;
    clearReferenceColors(v);
    v.floatingFooter?.destroy();
    v.controls.destroy();
    referenceTargets.delete(el);
    views.delete(v.id);
  }

  function destroy() {
    clearSelection();
    for (const v of views.values()) {
      v.floatingFooter?.destroy();
      v.controls.destroy();
      referenceTargets.delete(v.root);
    }
    views.clear();
  }
  return {
    makeView,
    updateView,
    focusCell,
    finishEdit,
    commitDraft,
    clearSelection,
    removeView,
    destroy,
    pickExternalCell
  };
}
