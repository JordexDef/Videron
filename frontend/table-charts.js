import { getLanguage, tr } from './i18n.js';
import { historyDirection } from './shortcuts.js';
import { addressOf, parseAddress, formatValue } from './table-engine.js';

const svgNS = 'http://www.w3.org/2000/svg';
const font = 'Inter, "Segoe UI", sans-serif';
const seriesColors = {
  dark: ['#c3c9db', '#b59c84', '#a899b9', '#929fa6', '#b3aa98', '#a69496'],
  light: ['#4b5877', '#826849', '#786789', '#536974', '#736c58', '#82666a']
};
const chartViews = new WeakMap();
const dataCache = new WeakMap();
const errorCodes = new Set(['#DIV/0!', '#CYCLE!', '#REF!', '#NAME?', '#VALUE!', '#NUM!', '#ERROR!']);
const isLabel = (value) => typeof value === 'string' && value.trim() !== '' && !errorCodes.has(value);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const columnName = (index) => addressOf(0, index).slice(0, -1);
const categoryHeader =
  /^(date|day|month|quarter|year|week|period|category|name|дата|день|месяц|квартал|год|неделя|период|категория|название)$/iu;
const numbers = new Map();

function numberText(value, compact = false) {
  const size = Math.abs(value);
  const notation =
    size > 0 && (size < 0.0001 || size >= 1e15)
      ? 'scientific'
      : compact && size >= 10000
        ? 'compact'
        : 'standard';
  const key = [getLanguage(), notation, compact].join('-');
  if (!numbers.has(key)) {
    numbers.set(
      key,
      new Intl.NumberFormat(getLanguage(), { notation, maximumSignificantDigits: compact ? 4 : 11 })
    );
  }
  return numbers.get(key).format(value === 0 ? 0 : value);
}

// A two-row header/value selection has its categories across the page.
// Longer tables use records down the page, with an optional label column.
export function chartData(chart, workbook, elements) {
  const table = elements.find((element) => element.type === 'table' && element.id === chart.tableId);
  if (!table) return { missing: true, series: [], labels: [], title: tr('График', 'Chart') };
  let cache = dataCache.get(workbook);
  if (!cache) dataCache.set(workbook, (cache = new Map()));
  const key = JSON.stringify([table.id, table.name, chart.range, table.headerRows, table.headerCols, getLanguage()]);
  if (cache.has(key)) return cache.get(key);
  const result = readRange(table, chart.range, workbook);
  cache.set(key, result);
  return result;
}

function readRange(table, range, workbook) {
  const empty = { series: [], labels: [], title: table.name };
  const [start, end = start] = String(range).split(':');
  const a = parseAddress(start),
    b = parseAddress(end);
  if (!a || !b) return empty;
  const top = Math.min(a.row, b.row),
    left = Math.min(a.col, b.col);
  const bottom = Math.min(Math.max(a.row, b.row), table.rows - 1);
  const right = Math.min(Math.max(a.col, b.col), table.cols - 1);
  const rows = [];
  let lastColumn = -1,
    lastRow = -1;
  for (let r = top; r <= bottom; r++) {
    const data = [];
    for (let c = left; c <= right; c++) {
      const value = workbook.value(table.id, addressOf(r, c));
      data.push(value);
      if (isNumber(value) || isLabel(value)) {
        lastColumn = Math.max(lastColumn, c - left);
        lastRow = r - top;
      }
    }
    rows.push(data);
  }
  if (lastColumn < 0) return empty;
  rows.length = lastRow + 1;
  for (const row of rows) row.length = lastColumn + 1;
  const first = rows[0];
  const headerRows = new Set(table.headerRows);
  const headerCols = new Set(table.headerCols);
  const hasHeader = headerRows.has(top) || (rows.length > 1 && first.some(isLabel) &&
    (!first.some(isNumber) || (categoryHeader.test(first[0]) && rows[1].some(isLabel))));
  const recordRows = rows.map((_, i) => i).filter(i => !(hasHeader && i === 0) && !headerRows.has(top + i));
  const records = recordRows.map(i => rows[i]);
  const inferredCategories =
    first.length > 1 &&
    (records.some((row) => isLabel(row[0])) ||
      (hasHeader && (first[0] === '' || categoryHeader.test(first[0]))));
  const columns = first.map((_, i) => i);
  const category = columns.find(i => headerCols.has(left + i)) ?? (inferredCategories ? 0 : -1);
  const measures = columns.filter(i => i !== category && !headerCols.has(left + i));
  if (records.length === 1 && measures.length > 1) {
    const labels = measures.map(i => hasHeader && first[i] !== '' ? String(first[i]) : columnName(left + i));
    const values = measures.map(i => isNumber(records[0][i]) ? records[0][i] : null);
    const title = (category >= 0 && String(records[0][category])) || table.name;
    return { labels, series: values.some(isNumber) ? [{ name: title, values }] : [], title };
  }
  const labels = records.map((row, i) => {
    if (category >= 0 && (isNumber(row[category]) || isLabel(row[category]))) return String(row[category]);
    return String(top + recordRows[i] + 1);
  });
  const series = [];
  for (const c of measures) {
    const values = records.map((row) => (isNumber(row[c]) ? row[c] : null));
    if (!values.some(isNumber)) continue;
    const header = hasHeader && (isNumber(first[c]) || isLabel(first[c])) ? String(first[c]) : '';
    series.push({ name: header || columnName(left + c), values, header });
  }
  return { labels, series, title: (series.length === 1 && series[0].header) || table.name };
}

function axisRange(series, bars) {
  let low = Infinity,
    high = -Infinity;
  for (const line of series)
    for (const value of line.values) {
      if (value !== null) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  if (bars) {
    low = Math.min(0, low);
    high = Math.max(0, high);
  }
  const magnitude = Math.max(Math.abs(low), Math.abs(high));
  // Scale first to also support data near the IEEE-754 limits.
  const divisor = magnitude > 1e100 || (magnitude > 0 && magnitude < 1e-100) ? magnitude : 1;
  low /= divisor;
  high /= divisor;
  if (low === high) {
    const pad = Math.abs(low) * 0.1 || 1;
    if (bars && low === 0) high = 1;
    else {
      low -= pad;
      high += pad;
    }
  }
  // Values that differ by just a few ULPs need a local origin. Tick indices
  // computed from the full offset would otherwise exceed safe integers.
  const offset = high - low < Math.max(Math.abs(low), Math.abs(high)) * 1e-8 ? low : 0;
  low -= offset;
  high -= offset;
  const rawStep = (high - low) / 3;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].find((n) => n >= rawStep / power - 1e-10) * power;
  const start = Math.floor(low / step + 1e-10);
  const end = Math.max(start + 1, Math.ceil(high / step - 1e-10));
  const ticks = [];
  for (let i = 0; i <= 8 && start + i <= end; i++) {
    const value = ((start + i) * step + offset) * divisor;
    if (Number.isFinite(value)) ticks.push({ value, fraction: i / (end - start) });
  }
  return { ticks, position: (v) => (v / divisor - offset - start * step) / ((end - start) * step) };
}

let measureContext;
function textWidth(s, size) {
  if (typeof document === 'undefined') return String(s).length * size * 0.58;
  measureContext ||= document.createElement('canvas').getContext('2d');
  measureContext.font = size + 'px ' + font;
  return measureContext.measureText(s).width;
}
function shorten(label, width, size) {
  const chars = Array.from(String(label));
  if (textWidth(label, size) <= width) return String(label);
  if (textWidth('…', size) > width) return '';
  let lo = 0,
    hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(chars.slice(0, mid).join('') + '…', size) <= width) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('') + '…';
}

function colors(background) {
  const bg = /^#[a-f\d]{6}$/i.test(background) ? background : '#171717';
  const [r, g, b] = bg
    .slice(1)
    .match(/../g)
    .map((v) => parseInt(v, 16));
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
  return {
    bg,
    fg: light ? '#303034' : '#e0e0e3',
    muted: light ? '#646469' : '#a6a6aa',
    grid: light ? 'rgba(0,0,0,.1)' : 'rgba(255,255,255,.11)',
    axis: light ? 'rgba(0,0,0,.24)' : 'rgba(255,255,255,.23)',
    header: light ? 'rgba(0,0,0,.045)' : 'rgba(255,255,255,.045)',
    series: light ? seriesColors.light : seriesColors.dark
  };
}

// A chart's vector paths are shared by the interactive view and thumbnails.
function chartDrawing(item, data, theme) {
  const w = Math.max(1, item.w),
    h = Math.max(1, item.h);
  const marks = [];
  const text = (x, y, value, size, fill = theme.muted, anchor = 'start', weight = 400) =>
    marks.push({ kind: 'text', x, y, value, size, fill, anchor, weight });
  const path = (d, stroke, fill = 'none', width = 1) =>
    marks.push({ kind: 'path', d, stroke, fill, width });
  const dot = (x, y, fill) => marks.push({ kind: 'dot', x, y, fill });
  const dense = w < 245 || h < 145;
  const margin = dense ? 8 : 15;
  const titleSize = dense ? 12 : 14;
  text(
    margin,
    margin + titleSize,
    shorten(data.title, w - margin * 2 - 50, titleSize),
    titleSize,
    theme.fg,
    'start',
    600
  );
  if (!data.series.length) {
    let message = tr('В диапазоне нет чисел', 'No numbers in this range');
    if (data.missing) message = tr('Исходная таблица удалена', 'Source table was removed');
    else if (item.range === '#REF!') message = tr('Исходный диапазон удалён', 'Source range was deleted');
    text(w / 2, h / 2 + 5, shorten(message, w - margin * 2, 12), 12, theme.muted, 'middle');
    return { marks };
  }
  const strokeFor = (i) => theme.series[i % theme.series.length];
  let plotTop = margin + titleSize + (dense ? 10 : 18);
  if (data.series.length > 1 && !dense) {
    let x = margin;
    for (let i = 0; i < data.series.length; i++) {
      const label = shorten(data.series[i].name, w * 0.36, 10);
      const width = textWidth(label, 10) + 28;
      if (x + width > w - margin - (i + 1 < data.series.length ? 25 : 0)) {
        text(x, plotTop, '+' + (data.series.length - i), 10);
        break;
      }
      path('M' + x + ' ' + (plotTop - 3) + 'h10', strokeFor(i), 'none', 2);
      text(x + 15, plotTop, label, 10);
      x += width;
    }
    plotTop += 18;
  }
  const bars = item.chartType === 'bar';
  const axis = axisRange(data.series, bars);
  let tickLabels = axis.ticks.map((t) => numberText(t.value, true));
  if (new Set(tickLabels).size !== tickLabels.length)
    tickLabels = axis.ticks.map((t) => numberText(t.value));
  const left = margin + Math.min(w * 0.27, Math.max(0, ...tickLabels.map((v) => textWidth(v, 10)))) + 8;
  const right = Math.max(left + 1, w - margin);
  const bottom = Math.max(plotTop + 1, h - (dense ? 23 : 30));
  const yOf = (n) => bottom - n * (bottom - plotTop);
  const y = (n) => yOf(axis.position(n));
  for (let i = 0; i < axis.ticks.length; i++) {
    const t = axis.ticks[i],
      yy = yOf(t.fraction);
    path('M' + left + ' ' + yy + 'H' + right, t.value === 0 ? theme.axis : theme.grid);
    text(left - 7, yy + 3, shorten(tickLabels[i], left - 12, 10), 10, theme.muted, 'end');
  }
  const count = data.labels.length,
    step = (right - left) / Math.max(1, bars ? count : count - 1);
  const x = (i) => (count === 1 ? (left + right) / 2 : left + (bars ? i + 0.5 : i) * step);
  const maxLabels = Math.max(1, Math.floor((right - left) / (dense ? 48 : 66)));
  const labelCount = Math.min(count, maxLabels);
  for (let i = 0; i < labelCount; i++) {
    const index = Math.round((i * (count - 1)) / Math.max(1, labelCount - 1));
    const nearLeft = i === 0 && labelCount > 1,
      nearRight = i === labelCount - 1 && labelCount > 1;
    const anchor = bars ? 'middle' : nearLeft ? 'start' : nearRight ? 'end' : 'middle';
    const label = shorten(data.labels[index], (right - left) / labelCount - 4, 10);
    text(x(index), bottom + 16, label, 10, theme.muted, anchor);
  }
  const rk = (n) => Number(n.toFixed(2));
  for (let s = 0; s < data.series.length; s++) {
    const line = data.series[s],
      color = strokeFor(s);
    if (bars) {
      const band = Math.min(72, step * 0.72),
        barWidth = band / data.series.length;
      const base = rk(y(0));
      let d = '';
      line.values.forEach((v, i) => {
        if (v === null || v === 0) return;
        const xx = x(i) - band / 2 + barWidth * s;
        d +=
          'M' + rk(xx) + ' ' + base + 'V' + rk(y(v)) + 'H' + rk(xx + barWidth * 0.92) + 'V' + base + 'Z';
      });
      if (d) path(d, 'none', color);
    } else {
      let d = '',
        previous = null;
      line.values.forEach((v, i) => {
        if (v !== null) {
          d += (previous === null ? 'M' : 'L') + rk(x(i)) + ' ' + rk(y(v));
          if (previous === null && (i === count - 1 || line.values[i + 1] === null))
            dot(x(i), y(v), color);
        }
        previous = v;
      });
      if (d) path(d, color, 'none', 1.8);
    }
  }
  return { marks, x, y, left, right, plotTop, bottom, step, bars };
}

function svg(tag, attrs) {
  const element = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs || {})) element.setAttribute(key, value);
  return element;
}
function svgMark(mark) {
  if (mark.kind === 'path')
    return svg('path', {
      d: mark.d,
      stroke: mark.stroke,
      fill: mark.fill,
      'stroke-width': mark.width,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round'
    });
  if (mark.kind === 'dot') return svg('circle', { cx: mark.x, cy: mark.y, r: 2, fill: mark.fill });
  const node = svg('text', {
    x: mark.x,
    y: mark.y,
    fill: mark.fill,
    'text-anchor': mark.anchor,
    'font-family': font,
    'font-size': mark.size,
    'font-weight': mark.weight
  });
  node.textContent = mark.value;
  return node;
}

export function createChartView(onChangeType) {
  const root = document.createElement('div');
  root.className = 'vt-chart';
  const plot = svg('svg', { role: 'img', class: 'vt-chart-plot' });
  const controls = document.createElement('div');
  controls.className = 'vt-chart-controls';
  const buttons = [];
  for (const [type, d] of [
    ['line', 'M2 12 6 8l3 2 5-7'],
    ['bar', 'M3 13V9m5 4V4m5 9V7']
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.chartType = type;
    const icon = svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    icon.append(
      svg('path', {
        d,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': type === 'bar' ? 2.3 : 1.5
      })
    );
    button.append(icon);
    button.onclick = (event) => {
      event.stopPropagation();
      const { item } = chartViews.get(root);
      if (item && !item.locked && item.chartType !== type) onChangeType(item.id, type);
    };
    controls.append(button);
    buttons.push(button);
  }
  for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
    controls.addEventListener(type, (event) => event.stopPropagation());
  }
  // Keep button navigation local. Deletion and history belong to the owning chart or canvas.
  controls.addEventListener('keydown', event => {
    const history = historyDirection(event);
    if (!history && event.key !== 'Delete' && event.key !== 'Backspace') event.stopPropagation();
  });
  const tooltip = document.createElement('div');
  tooltip.className = 'vt-chart-tip';
  tooltip.hidden = true;
  // Tooltip stays anchored in chart space even when the board is zoomed or rotated.
  const inspect = (event) => {
    const state = chartViews.get(root),
      layout = state.layout;
    tooltip.hidden = true;
    if (!layout?.x || event.buttons || event.pointerType === 'touch') return;
    const matrix = plot.getScreenCTM();
    if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const { left, right, bottom, plotTop, bars, step } = layout;
    if (p.x < left - 4 || p.x > right + 4 || p.y < plotTop - 4 || p.y > bottom + 4) return;
    const last = state.data.labels.length - 1;
    const index = Math.max(0, Math.min(last, Math.round((p.x - left) / step - (bars ? 0.5 : 0))));
    const group = state.data.series;
    let chosen = -1,
      nearest = Infinity;
    const band = Math.min(72, step * 0.72);
    for (let s = 0; s < group.length; s++) {
      const value = group[s].values[index];
      if (value === null) continue;
      const distance = bars
        ? Math.abs(p.x - (layout.x(index) - band / 2 + (band * (s + 0.5)) / group.length))
        : Math.abs(p.y - layout.y(value));
      if (distance < nearest) {
        nearest = distance;
        chosen = s;
      }
    }
    if (chosen < 0) return;
    const series = group[chosen];
    const detail = [
      state.data.labels[index],
      group.length > 1 && series.name,
      numberText(series.values[index])
    ].filter(Boolean);
    tooltip.textContent = detail.join(' · ');
    tooltip.hidden = false;
    // The series uses SVG coordinates. The HTML tooltip uses layout pixels;
    // an inline chart can be much narrower than the size stored in the note.
    const local = p.matrixTransform(plot.getCTM());
    const tipHeight = tooltip.offsetHeight;
    const y = local.y < tipHeight + 12 ? local.y + 8 : local.y - tipHeight - 9;
    tooltip.style.left = Math.max(4,Math.min(local.x+9,root.clientWidth-tooltip.offsetWidth-4)) + 'px';
    tooltip.style.top = Math.max(2,Math.min(y,root.clientHeight-tipHeight-2)) + 'px';
  };
  plot.addEventListener('pointermove', inspect);
  plot.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
  });
  root.addEventListener('pointerdown', () => {
    tooltip.hidden = true;
  });
  root.append(plot, controls, tooltip);
  chartViews.set(root, { plot, controls, buttons, tooltip });
  return root;
}

export function updateChartView(root, item, workbook, elements, background) {
  const state = chartViews.get(root);
  const data = chartData(item, workbook, elements),
    language = getLanguage();
  if (
    state.data === data &&
    state.item?.w === item.w &&
    state.item?.h === item.h &&
    state.item?.chartType === item.chartType &&
    state.item?.locked === item.locked &&
    state.bg === background &&
    state.language === language
  ) {
    state.item = item;
    return;
  }
  const theme = colors(background),
    layout = chartDrawing(item, data, theme);
  Object.assign(state, { item, data, layout, bg: background, language });
  state.tooltip.hidden = true;
  root.style.setProperty('--vt-chart-fg', theme.fg);
  root.style.setProperty('--vt-chart-muted', theme.muted);
  root.style.setProperty('--vt-chart-grid', theme.grid);
  root.style.setProperty('--vt-chart-bg', theme.bg);
  state.plot.setAttribute('viewBox', '0 0 ' + Math.max(1, item.w) + ' ' + Math.max(1, item.h));
  state.plot.setAttribute('aria-label', data.title + ' · ' + item.range);
  // The range in the accessible title also identifies plain numeric selections.
  const title = svg('title');
  title.textContent = data.title + ' · ' + item.range;
  state.plot.replaceChildren(title, ...layout.marks.map(svgMark));
  for (const button of state.buttons) {
    const type = button.dataset.chartType;
    button.setAttribute('aria-pressed', String(item.chartType === type));
    button.title = type === 'bar' ? tr('Столбцы', 'Column chart') : tr('Линии', 'Line chart');
    button.setAttribute('aria-label', button.title);
    button.disabled = !!item.locked;
  }
}

function canvasMark(ctx, mark) {
  if (mark.kind === 'path') {
    const path = new Path2D(mark.d);
    if (mark.fill !== 'none') {
      ctx.fillStyle = mark.fill;
      ctx.fill(path);
    }
    if (mark.stroke !== 'none') {
      ctx.strokeStyle = mark.stroke;
      ctx.lineWidth = mark.width;
      ctx.stroke(path);
    }
  } else if (mark.kind === 'dot') {
    ctx.fillStyle = mark.fill;
    ctx.beginPath();
    ctx.arc(mark.x, mark.y, 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = mark.fill;
    ctx.font = mark.weight + ' ' + mark.size + 'px ' + font;
    ctx.textAlign = mark.anchor === 'middle' ? 'center' : mark.anchor;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(mark.value, mark.x, mark.y);
  }
}

export function paintChartPreview(ctx, item, workbook, elements, background) {
  const theme = colors(background);
  const drawing = chartDrawing(item, chartData(item, workbook, elements), theme);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, item.w, item.h, 7);
  ctx.clip();
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, item.w, item.h);
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.setLineDash([]);
  for (const mark of drawing.marks) canvasMark(ctx, mark);
  ctx.restore();
}

export function paintTablePreview(ctx, item, workbook, background) {
  const { w, h, name } = item;
  const theme = colors(background);
  const head = item.showName === false ? 0 : 34;
  const colHead = item.showColumnLetters === false ? 0 : 24;
  const gutter = item.showRowNumbers === false ? 0 : 30;
  const rowH = Math.max(26, (h - head - colHead - 2) / item.rows);
  const cellWidth = Math.max(72, (w - gutter) / item.cols);
  const rows = Math.max(0, Math.min(item.rows, Math.ceil((h - head - colHead) / rowH)));
  const cols = Math.max(0, Math.min(item.cols, Math.ceil((w - gutter) / cellWidth)));
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 6);
  ctx.clip();
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = theme.axis;
  ctx.stroke();
  ctx.fillStyle = theme.header;
  ctx.fillRect(0, 0, w, head + colHead);
  ctx.fillRect(0, head + colHead, gutter, h);
  const headerRows = new Set(item.headerRows), headerCols = new Set(item.headerCols);
  for (const r of headerRows) ctx.fillRect(gutter, head + colHead + r * rowH, w - gutter, rowH);
  for (const c of headerCols) ctx.fillRect(gutter + c * cellWidth, head + colHead, cellWidth, h - head - colHead);
  ctx.fillStyle = theme.fg;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = '600 12px ' + font;
  if (head) ctx.fillText(shorten(name, w - 25, 12), 12, head / 2);
  const dataTop = head + colHead;
  ctx.strokeStyle = theme.grid;
  ctx.beginPath();
  ctx.moveTo(0, head);
  ctx.lineTo(w, head);
  for (let c = 0; c <= cols; c++) {
    const x = gutter + c * cellWidth;
    ctx.moveTo(x, head);
    ctx.lineTo(x, Math.min(h, dataTop + rows * rowH));
  }
  for (let r = 0; r <= rows; r++) {
    const y = dataTop + r * rowH;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'center';
  ctx.font = '10px ' + font;
  if (colHead) for (let c = 0; c < cols; c++)
    ctx.fillText(columnName(c), gutter + (c + 0.5) * cellWidth, head + colHead / 2);
  if (gutter) for (let r = 0; r < rows; r++) ctx.fillText(String(r + 1), gutter / 2, dataTop + (r + 0.5) * rowH);
  ctx.fillStyle = theme.fg;
  ctx.font = '12px ' + font;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const value = workbook.value(item.id, addressOf(r, c));
      if (value === '') continue;
      const numeric = isNumber(value);
      ctx.font = (headerRows.has(r) || headerCols.has(c) ? '600 ' : '') + '12px ' + font;
      ctx.textAlign = numeric ? 'right' : 'left';
      const x = numeric ? gutter + (c + 1) * cellWidth - 7 : gutter + c * cellWidth + 7;
      ctx.fillText(
        shorten(formatValue(value, getLanguage()), cellWidth - 14, 12),
        x,
        dataTop + (r + 0.5) * rowH
      );
    }
  ctx.restore();
}
