import { tr, getLanguage } from './i18n.js';
import { addressOf, formatValue, parseAddress } from './table-engine.js';
import { isProtectedNote } from './note-vault.js';
import { metricCatalogue, metricRange, metricSource, readMetric } from './map-metric-source.js';
export { resolveMapMetrics } from './map-metric-source.js';

const tau = Math.PI * 2;

function tracePortion(ctx, points, start, ratio, {ox, oy, zoom}) {
  const length = i => {
    const a = points[i], b = points[(i + 1) % points.length];
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) perimeter += length(i);
  let remaining = perimeter * ratio;
  ctx.moveTo(ox + points[start].x * zoom, oy + points[start].y * zoom);
  for (let n = 0; n < points.length && remaining > 0; n++) {
    const i = (start + n) % points.length, a = points[i], b = points[(i + 1) % points.length];
    const step = length(i);
    if (!step) continue;
    const t = Math.min(1, remaining / step);
    ctx.lineTo(ox + (a.x + (b.x - a.x) * t) * zoom, oy + (a.y + (b.y - a.y) * t) * zoom);
    remaining -= step;
  }
}

export function drawAreaMetric(ctx, group, metric, view) {
  if (!metric?.ratio) return;
  const {ox, oy, zoom} = view, {hull, gridBounds} = group;
  ctx.save();
  ctx.beginPath();
  if (group.grid && gridBounds) {
    const {left, top, right, bottom} = gridBounds;
    tracePortion(ctx, [{x:(left + right) / 2, y:top}, {x:right, y:top}, {x:right, y:bottom},
      {x:left, y:bottom}, {x:left, y:top}], 0, metric.ratio, view);
  } else if (hull?.points?.length) {
    // Contour samples run clockwise from the right-hand radius.
    tracePortion(ctx, hull.points, Math.round(hull.points.length * .75) % hull.points.length, metric.ratio, view);
  } else if (hull) {
    ctx.arc(ox + hull.x * zoom, oy + hull.y * zoom, hull.r * zoom, -Math.PI / 2, -Math.PI / 2 + tau * metric.ratio);
  }
  ctx.strokeStyle = 'rgba(' + (group.tint || '205,205,205') + ',.95)';
  ctx.lineWidth = 2.25;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

// Draw contiguous numeric runs separately. A blank or an error in a sheet
// leaves a visible break rather than manufacturing a zero or interpolated data.
function sparkline(ctx, values, x, y, width, height) {
  const numbers = values.filter(Number.isFinite);
  if (!numbers.length) return;
  const min = Math.min(...numbers), max = Math.max(...numbers);
  // Scaling first avoids overflow when the extreme values have opposite signs.
  const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const low = min / scale, high = max / scale;
  let previous = false;
  ctx.beginPath();
  values.forEach((value, i) => {
    if (!Number.isFinite(value)) { previous = false; return; }
    const px = values.length === 1 ? x + width / 2 : x + width * i / (values.length - 1);
    const py = y + height * (max === min ? .5 : (high - value / scale) / (high - low));
    if (previous) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
    if (!previous && !Number.isFinite(values[i + 1])) ctx.lineTo(px + .01, py);
    previous = true;
  });
  ctx.lineWidth = 1.65;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = '#d8dce7';
  ctx.stroke();
}

export function paintMetricPreview(canvas, metric, {width = 116, height = 24} = {}) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  if (metric?.values) sparkline(ctx, metric.values, 2, 3, width - 4, height - 6);
}

export function drawNoteMetric(ctx, metric, {x, y, r, tint, alpha = 1}) {
  if (!metric?.values?.length || alpha <= 0) return;
  const width = 57, height = 23, left = x - width / 2, top = y - r - height - 5;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, 6);
  ctx.fillStyle = '#232323'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = tint ? 'rgba(' + tint + ',.44)' : '#505156'; ctx.stroke();
  sparkline(ctx, metric.values, left + 7, top + 5, width - 14, height - 10);
  ctx.restore();
}

function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const numberText = value => formatValue(value, getLanguage());

// A small window onto the actual table lets a user point at cells without
// knowing their address. A 500 x 52 sheet still mounts only visible cells.
function cellWindow(host, pick) {
  const gutter = 25, head = 19, width = 61, height = 22;
  const surface = element('div', 'metric-grid-surface');
  host.append(surface);
  let table, workbook, range, drag, frame;
  const left = col => gutter + col * width;
  const top = row => head + row * height;
  function paint() {
    frame = 0;
    if (!table) { surface.replaceChildren(); return; }
    const sx = host.scrollLeft, sy = host.scrollTop;
    const firstCol = Math.max(0, Math.floor(sx / width)), firstRow = Math.max(0, Math.floor(sy / height));
    const lastCol = Math.min(table.cols, firstCol + Math.ceil(host.clientWidth / width) + 1);
    const lastRow = Math.min(table.rows, firstRow + Math.ceil(host.clientHeight / height) + 1);
    const fragment = document.createDocumentFragment();
    function box(cls, text, x, y, w, h) {
      const item = element('span', cls, text);
      item.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px';
      fragment.append(item);
      return item;
    }
    for (let row = firstRow; row < lastRow; row++) {
      for (let col = firstCol; col < lastCol; col++) {
        const addr = addressOf(row, col);
        const selected = range && row >= range.row && row <= range.endRow && col >= range.col && col <= range.endCol;
        const item = box('metric-cell' + (selected ? ' picked' : ''), numberText(workbook.value(table.id, addr)),
          left(col), top(row), width, height);
        item.dataset.cell = addr;
        item.title = addr + '  ' + item.textContent;
      }
      box('metric-coord', row + 1, sx, top(row), gutter, height);
    }
    for (let col = firstCol; col < lastCol; col++) {
      box('metric-coord', addressOf(0, col).slice(0, -1), left(col), sy, width, head);
    }
    box('metric-coord', '', sx, sy, gutter, head);
    surface.replaceChildren(fragment);
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(paint); }
  function cellAt(e) {
    const rect = host.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x < gutter || y < head || x >= host.clientWidth || y >= host.clientHeight) return null;
    const col = Math.floor((host.scrollLeft + x - gutter) / width), row = Math.floor((host.scrollTop + y - head) / height);
    return table && col < table.cols && row < table.rows ? {row, col} : null;
  }
  host.onpointerdown = event => {
    const cell = cellAt(event);
    if (!cell || event.button !== 0 || event.pointerType === 'touch') return;
    event.preventDefault();
    const start = event.shiftKey && range ? {row:range.row, col:range.col} : cell;
    drag = {start, id:event.pointerId};
    host.setPointerCapture(event.pointerId);
    pick(start, cell);
  };
  host.onpointermove = event => {
    if (drag?.id !== event.pointerId) return;
    const cell = cellAt(event);
    if (cell) pick(drag.start, cell);
  };
  host.onlostpointercapture = () => { drag = null; };
  host.onclick = event => {
    if (event.pointerType === 'touch') {
      const cell = cellAt(event);
      if (cell) pick(cell, cell);
    }
  };
  host.onscroll = schedule;
  return {
    table(next, book) {
      table = next; workbook = book;
      surface.style.width = left(next?.cols || 0) + 'px';
      surface.style.height = top(next?.rows || 0) + 'px';
      host.scrollTo(0, 0);
      schedule();
    },
    select(next, reveal) {
      range = next;
      if (reveal && range) {
        const x = left(range.col), y = top(range.row);
        if (x < host.scrollLeft + gutter || x + width > host.scrollLeft + host.clientWidth) host.scrollLeft = x - gutter;
        if (y < host.scrollTop + head || y + height > host.scrollTop + host.clientHeight) host.scrollTop = y - head;
      }
      schedule();
    },
    dispose() { cancelAnimationFrame(frame); }
  };
}

function suggestedRange(table, book, isArea) {
  const cells = Object.keys(table.cells || {}).map(parseAddress).filter(Boolean)
    .filter(p => !table.headerRows?.includes(p.row) && !table.headerCols?.includes(p.col))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  const first = cells.find(p => Number.isFinite(book.value(table.id, addressOf(p.row, p.col))));
  if (!first) return isArea ? 'A1' : 'A1:A' + Math.min(5, table.rows);
  const start = addressOf(first.row, first.col);
  if (isArea) return start;
  const across = cells.filter(p => p.row === first.row && p.col >= first.col);
  const down = cells.filter(p => p.col === first.col && p.row >= first.row);
  const end = (across.length > down.length ? across : down).at(-1);
  return end.row === first.row && end.col === first.col ? start : start + ':' + addressOf(end.row, end.col);
}

export function openMetricPicker({target, kind, space, anchor, onChange, onClose}) {
  const isArea = kind === 'area', saved = target.mapMetric;
  const catalogue = metricCatalogue(space);
  const sources = [...catalogue.notes.values()].filter(note => catalogue.tables(note.id).length);
  const box = element('form', 'map-metric-picker');
  box.setAttribute('role', 'dialog');
  const heading = isArea ? tr('Прогресс области', 'Area progress') : tr('График заметки', 'Note trend');
  box.setAttribute('aria-label', heading);
  box.anchor = anchor instanceof Element ? anchor : null;
  const header = element('header'), closeButton = element('button', 'metric-close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', tr('Закрыть', 'Close'));
  header.append(element('strong', '', heading), closeButton);
  box.append(header);
  function close() {
    if (onClose) onClose();
    else { box.dispose(); box.remove(); }
  }
  closeButton.onclick = close;
  const noteSelect = element('select'), tableSelect = element('select');
  const address = element('input'), goal = element('input');
  address.autocomplete = 'off'; address.spellcheck = false; address.maxLength = 16;
  address.placeholder = isArea ? 'A1' : 'A1:A5';
  goal.type = 'number'; goal.step = 'any'; goal.value = String(saved?.goal ?? 100);
  const fields = element('div', 'metric-fields'), coordinates = element('div', 'metric-address-row');
  function field(label, control) {
    const wrap = element('label');
    wrap.append(element('span', '', label), control);
    return wrap;
  }
  fields.append(field(tr('Заметка', 'Note'), noteSelect), field(tr('Таблица', 'Table'), tableSelect));
  coordinates.append(field(isArea ? tr('Ячейка', 'Cell') : tr('Ряд', 'Range'), address));
  if (isArea) coordinates.append(field(tr('Цель', 'Goal'), goal));
  const viewport = element('div', 'metric-grid');
  viewport.title = isArea ? tr('Выберите ячейку', 'Choose a cell')
    : tr('Потяните вдоль строки или столбца', 'Drag along a row or column');
  const preview = element('output', 'metric-preview'), graph = element('canvas');
  graph.setAttribute('aria-hidden', 'true');
  const footer = element('footer'), unlink = element('button', 'metric-unlink', tr('Отвязать', 'Unlink'));
  unlink.type = 'button'; unlink.hidden = !saved;
  unlink.onclick = () => { close(); onChange(null); };
  const submit = element('button', 'metric-apply', tr('Применить', 'Apply')); submit.type = 'submit';
  footer.append(unlink, submit);
  box.append(fields, viewport, coordinates, preview, footer);

  let choices = [], entry, book;
  const grid = cellWindow(viewport, (start, end) => {
    if (isArea) address.value = addressOf(end.row, end.col);
    else {
      if (Math.abs(end.row - start.row) >= Math.abs(end.col - start.col)) end = {...end, col:start.col};
      else end = {...end, row:start.row};
      const a = addressOf(start.row, start.col), b = addressOf(end.row, end.col);
      address.value = a === b ? a : a + ':' + b;
    }
    update();
  });
  function update(reveal = false) {
    const range = entry && metricRange(address.value, entry.table, kind);
    const goalOK = !isArea || (Number.isFinite(goal.valueAsNumber) && goal.valueAsNumber > 0);
    const valid = !!range && goalOK;
    grid.select(range, reveal);
    address.setAttribute('aria-invalid', String(!!entry && !range));
    goal.setAttribute('aria-invalid', String(!goalOK));
    submit.disabled = !valid;
    preview.replaceChildren();
    if (!entry) {
      preview.textContent = sources.length ? tr('Выберите таблицу с данными.', 'Choose a source table.')
        : tr('Добавьте таблицу в любую заметку этого пространства.', 'Add a table to a note in this workspace.');
      return;
    }
    if (!valid) {
      preview.textContent = !goalOK ? tr('Цель должна быть больше нуля.', 'Enter a goal greater than zero.')
        : isArea ? tr('Укажите ячейку в этой таблице.', 'Enter a cell in this table.')
        : tr('Выберите одну строку или столбец, например A1:A5.', 'Choose a row or column, such as A1:A5.');
      return;
    }
    const value = readMetric({range:range.text, goal:goal.valueAsNumber}, kind, entry, book);
    if (!value) {
      preview.textContent = tr('Здесь появятся данные, когда в ячейках будут числа.', 'The preview appears when the cells contain numbers.');
    } else if (isArea) {
      const meter = element('span', 'metric-meter'), bar = element('i');
      bar.style.width = value.ratio * 100 + '%'; meter.append(bar);
      preview.append(element('span', '', numberText(value.value) + ' / ' + numberText(value.goal)), meter);
    } else {
      const latest = value.values.findLast(Number.isFinite);
      preview.append(graph, element('span', '', numberText(latest)));
      paintMetricPreview(graph, value);
    }
  }
  function showTable(restore = false) {
    entry = tableSelect.value === '' ? null : choices[Number(tableSelect.value)];
    book = entry ? catalogue.workbook(noteSelect.value, entry.group) : null;
    grid.table(entry?.table, book);
    address.value = entry ? (restore ? saved.range : suggestedRange(entry.table, book, isArea)) : '';
    update(true);
  }
  function showNote(restore = false) {
    choices = catalogue.tables(noteSelect.value);
    tableSelect.replaceChildren();
    const chosen = restore && saved ? metricSource(catalogue, saved) : null;
    const labels = new Set(), duplicates = new Set();
    for (const {table} of choices) {
      if (labels.has(table.name)) duplicates.add(table.name);
      labels.add(table.name);
    }
    const groups = [...new Set(choices.map(e => e.group))];
    for (const [index, item] of choices.entries()) {
      const name = duplicates.has(item.table.name) ? item.table.name + ' · ' + (groups.indexOf(item.group) + 1) : item.table.name;
      tableSelect.add(new Option(name, String(index)));
    }
    if (restore && !chosen && choices.length) {
      tableSelect.add(new Option(tr('Выберите таблицу…', 'Choose a table…'), ''), 0);
      tableSelect.value = '';
    } else if (chosen) tableSelect.value = String(choices.indexOf(chosen));
    tableSelect.disabled = !choices.length;
    showTable(!!chosen);
  }
  for (const note of sources) noteSelect.add(new Option(note.title || tr('Без названия', 'Untitled'), note.id));
  if (saved && !sources.some(note => note.id === saved.sourceId)) {
    noteSelect.add(new Option(tr('Источник недоступен', 'Source unavailable'), ''), 0);
    noteSelect.value = '';
  } else if (saved) noteSelect.value = saved.sourceId;
  else if (!isArea && sources.some(note => note.id === target.id)) noteSelect.value = target.id;
  noteSelect.disabled = !sources.length;
  fields.hidden = viewport.hidden = coordinates.hidden = !sources.length;
  submit.hidden = !sources.length;
  noteSelect.onchange = () => showNote();
  tableSelect.onchange = () => showTable();
  address.oninput = () => update(true);
  goal.oninput = () => update();
  box.onsubmit = event => {
    event.preventDefault();
    if (!entry || submit.disabled) return;
    const source = space.notes.find(note => note.id === noteSelect.value);
    if (isProtectedNote(target) || !source || isProtectedNote(source)) { close(); return; }
    const binding = {sourceId:source.id, tableId:entry.table.id, range:metricRange(address.value, entry.table, kind).text};
    if (!entry.group.canvas) {
      if (!source.body.includes(entry.group.block)) { close(); return; }
      binding.blockId = entry.group.block.mapMetricSource ||= crypto.randomUUID();
    }
    if (isArea) binding.goal = goal.valueAsNumber;
    close(); onChange(binding);
  };
  box.onkeydown = event => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault(); event.stopPropagation(); close(); box.anchor?.focus({preventScroll:true});
  };
  function place() {
    const gap = 8, rect = box.anchor ? box.anchor.getBoundingClientRect() : anchor;
    const x = rect.left ?? rect.x, y = rect.bottom ?? rect.y;
    const top = y + gap + box.offsetHeight <= innerHeight ? y + gap : (rect.top ?? y) - gap - box.offsetHeight;
    box.style.left = Math.max(gap, Math.min(x, innerWidth - box.offsetWidth - gap)) + 'px';
    box.style.top = Math.max(gap, Math.min(top, innerHeight - box.offsetHeight - gap)) + 'px';
  }
  const size = new ResizeObserver(place), events = new AbortController();
  box.dispose = () => { size.disconnect(); events.abort(); grid.dispose(); };
  document.body.append(box);
  size.observe(box);
  window.addEventListener('resize', place, {signal:events.signal});
  showNote(!!saved); place();
  (sources.length ? noteSelect : closeButton).focus({preventScroll:true});
  return box;
}
