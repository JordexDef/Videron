import { icon } from './art.js';
import { getLanguage, tr } from './i18n.js';
import { addressOf, formatValue } from './table-engine.js';
import { noteWorkbooks } from './board-tables.js';
import { paintMetricPreview } from './map-metrics.js';

const textBlocks = new Set(['paragraph', 'heading', 'subheading', 'quote']);
const raster = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i;
const excerptLength = 960;
const clip = (value, limit) => value.length <= limit ? value : value.slice(0, limit - 1) + '…';
const labelFor = text => clip(text.trim().replace(/\s+/g, ' '), 46);
const isReadable = note => !!note && !Object.hasOwn(note, 'sealed');

// Text blocks do not have persistent IDs. A compact content fingerprint keeps
// a chosen passage attached to its text when another paragraph is inserted.
function fingerprint(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

export function readingFragments(note) {
  if (!isReadable(note)) return [];
  const fragments = [], counts = new Map(), tableGroups = new Map();
  let books;
  function add(base, path, content) {
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    fragments.push({key:count ? base + '/' + count : base, path, ...content});
  }
  function addText(block, path, base, target) {
    const code = block.type === 'code';
    const full = code ? block.text : block.runs?.map(run => run?.text || '').join('');
    if (typeof full !== 'string' || !full.trim()) return;
    const text = clip(full.trim(), excerptLength);
    add(base + '/' + fingerprint(text), path, {
      kind:code ? 'code' : 'text', text, label:labelFor(text), target,
      heading:block.type === 'heading' || block.type === 'subheading'
    });
  }
  function addImage(block, path, base) {
    if (typeof block.src !== 'string' || !raster.test(block.src)) return;
    const alt = String(block.alt || '').trim();
    const key = base || 'image/' + block.src.length + '/' + fingerprint(block.src.slice(-96));
    add(key, path, {kind:'image', src:block.src, alt, label:labelFor(alt) || tr('Изображение','Image')});
  }
  function tableRows(group, item) {
    if (!books) {
      books = noteWorkbooks();
      for (const [owner, tables] of tableGroups) books.register(owner, tables);
    }
    const workbook = books.workbook(group, tableGroups.get(group));
    return Array.from({length:Math.min(4, item.rows || 5)}, (_, row) =>
      Array.from({length:Math.min(4, item.cols || 4)}, (_, col) =>
        clip(formatValue(workbook.value(item.id, addressOf(row, col)), getLanguage()), 100)));
  }
  function addBoard(board, path, isCanvas = false) {
    const elements = (board?.elements || []).filter(Boolean);
    const tables = elements.filter(el => el.type === 'table' && typeof el.name === 'string');
    if (tables.length) tableGroups.set(path, tables);
    if (elements.some(el => !['text','image','table'].includes(el.type)) || board?.strokes?.length) {
      // Drawings can contain overlapping labels, shapes and connectors. Show the composition as drawn.
      add('drawing/' + (elements[0]?.id || path), path, {kind:'drawing', board, label:tr('Рисунок','Drawing')});
    }
    for (const [index, el] of elements.entries()) {
      const base = 'object/' + (el.id || path + '/' + index);
      const at = path + '/' + index;
      if (el.type === 'table' && typeof el.name === 'string') {
        add(base, at, {kind:'table', label:labelFor(el.name), rows:() => tableRows(path, el),
          headerRows:el.headerRows || [], headerCols:el.headerCols || []});
      } else if (el.type === 'image') addImage(el, at, base);
      else if (el.type === 'text' && Array.isArray(el.body)) {
        el.body.forEach((b, i) => {
          if (!b) return;
          if (b.type === 'image') return addImage(b, at + '/' + i, base + '/image/' + i);
          if (!textBlocks.has(b.type) && b.type !== 'code') return;
          const match = {kind:'body', ranges:[{index:i, start:0, end:1}]};
          addText(b, at + '/' + i, base, isCanvas ? {kind:'canvasText', id:el.id, match} : null);
        });
      } else if (el.type === 'text' || el.label) {
        const text = el.text || el.label;
        if (typeof text !== 'string' || !text.trim()) continue;
        add(base, at, {kind:'text', text:clip(text.trim(), excerptLength), label:labelFor(text),
          target:isCanvas && !el.folderPath ? {kind:'canvasLabel', id:el.id, start:0, end:1} : null});
      }
    }
  }
  if (note.type === 'data') {
    addText({type:'code',text:note.dataText.slice(0,excerptLength+1)},'data','data',{kind:'data',start:0,end:0});
  } else if (note.type === 'canvas') addBoard(note.board, 'canvas', true);
  else {
    const body = note.body?.length ? note.body : String(note.plain || '').split('\n').map(text => ({type:'paragraph', runs:[{text}]}));
    body.forEach((block, i) => {
      if (!block) return;
      const path = 'body/' + i;
      if (textBlocks.has(block.type) || block.type === 'code')
        addText(block, path, block.type, {kind:'body', ranges:[{index:i, start:0, end:1}]});
      else if (block.type === 'image') addImage(block, path);
      else if (block.type === 'drawing') addBoard(block.board || block, path);
    });
  }
  return fragments;
}

export function preferredFragment(fragments, preference, routeKey) {
  return fragments.find(f => f.key === routeKey) || fragments.find(f => f.key === preference?.key) ||
    fragments.find(f => f.path === preference?.path && f.kind === preference?.kind) ||
    fragments.find(f => !f.heading && (f.kind !== 'text' || !/^#[^\s]+(?:\s+#[^\s]+)*$/u.test(f.text))) ||
    fragments[0];
}

function screenNode(graph, n) {
  return {id:n.id, x:(n.x - graph.camera.x) * graph.zoom + graph.width / 2,
    y:(n.y - graph.camera.y) * graph.zoom + graph.height / 2, r:n.r * graph.zoom};
}

export function readingCandidate(graph, pointer, previous, hold, forced) {
  if (graph.drag?.moved || graph.linking || !graph.width || !graph.height) return null;
  if (!forced && (graph.view?.reading === false || graph.zoom < (previous ? 1.62 : 1.75))) return null;
  const visible = n => n.x >= -n.r && n.x <= graph.width + n.r && n.y >= -n.r && n.y <= graph.height + n.r;
  function byId(id) {
    const node = graph.nodes.get(id);
    if (!node) return null;
    const point = screenNode(graph, node);
    return visible(point) ? point : null;
  }
  if (forced) return byId(forced);
  if (hold && previous) return byId(previous);
  const hovered = byId(graph.hover);
  if (hovered && (!pointer || Math.hypot(hovered.x - pointer.x, hovered.y - pointer.y) <= hovered.r + 8)) return hovered;
  const center = {x:graph.width / 2, y:graph.height / 2};
  const score = (node, focus) => Math.max(0, Math.hypot(node.x - focus.x, node.y - focus.y) - node.r);
  const current = byId(previous);
  if (current && Math.min(score(current, center), pointer ? score(current, pointer) : Infinity) < 34) return current;
  let best = null, nearest = 40;
  for (const n of graph.nodes.values()) {
    const point = screenNode(graph, n);
    if (!visible(point)) continue;
    const distance = Math.min(score(point, center), pointer ? score(point, pointer) : Infinity);
    if (distance < nearest) { best = point; nearest = distance; }
  }
  return best;
}

function el(tag, cls) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  return element;
}
function button(name, handler) {
  const b = el('button');
  b.type = 'button';
  b.innerHTML = icon(name);
  b.onclick = handler;
  return b;
}
function describe(node, label) {
  node.title = label;
  node.setAttribute('aria-label', label);
}

function showFragment(container, fragment) {
  container.replaceChildren();
  if (!fragment) {
    container.textContent = tr('Пока пусто', 'Empty note');
  } else if (fragment.kind === 'image') {
    const img = el('img'); img.alt = fragment.alt; img.src = fragment.src;
    container.append(img);
  } else if (fragment.kind === 'drawing') {
    const canvas = el('canvas');
    canvas.width = 528; canvas.height = 230;
    canvas.setAttribute('aria-label', fragment.label);
    container.append(canvas);
    import('./board.js').then(({renderBoardPreview}) => {
      if (canvas.isConnected) return renderBoardPreview(canvas, fragment.board);
    }).catch(() => { canvas.replaceWith(document.createTextNode(fragment.label)); });
  } else if (fragment.kind === 'table') {
    const table = el('table');
    table.setAttribute('aria-label', fragment.label);
    fragment.rows().forEach((values, r) => {
      const row = table.insertRow();
      values.forEach((v, c) => {
        const cell = el(fragment.headerRows.includes(r) || fragment.headerCols.includes(c) ? 'th' : 'td');
        cell.textContent = v; row.append(cell);
      });
    });
    container.append(table);
  } else {
    const text = el(fragment.kind === 'code' ? 'pre' : 'p');
    text.textContent = fragment.text;
    container.append(text);
  }
}

export function mountMapReading({stage, getNote, getMetric, isActive = () => true, onOpen, onChange}) {
  const card = el('section', 'map-reading'), head = el('header'), body = el('div','map-reading-body');
  const title = el('button', 'map-reading-title'), foot = el('footer'), count = el('span');
  const series = el('figure','map-reading-series'), plot = el('div'), chart = el('canvas'), latest = el('figcaption');
  plot.append(chart); series.append(plot, latest); series.hidden = true;
  let graph, pointer, pointerEvent, id, note, fragments, fragment, closedId, route, lastPosition, needsContent = true;
  let metric = null, plotWidth = 0;
  let panelWidth = 290, panelHeight = 150;
  title.type = 'button';
  title.onclick = () => {
    if (isActive() && isReadable(getNote(id))) onOpen?.(id, fragment?.target || null);
  };
  const close = button('x', dismiss), prev = button('chevron', () => browse(-1)), next = button('chevron', () => browse(1));
  prev.className = 'map-reading-prev';
  const pin = button('pin', () => {
    if (!fragment || !isActive() || !isReadable(getNote(id))) return;
    if (isPinned()) delete note.mapExcerpt;
    else note.mapExcerpt = {key:fragment.key, path:fragment.path, kind:fragment.kind};
    paintControls();
    onChange?.();
  });
  head.append(title, close);
  foot.append(prev, count, next, pin);
  card.append(head, body, series, foot);
  card.hidden = true;
  stage.append(card);
  function isPinned() {
    return !!note?.mapExcerpt && preferredFragment(fragments, note.mapExcerpt)?.key === fragment?.key &&
      (note.mapExcerpt.key === fragment?.key || note.mapExcerpt.path === fragment?.path);
  }
  function paintControls() {
    const i = fragments.indexOf(fragment);
    count.textContent = (i + 1) + ' / ' + fragments.length;
    prev.disabled = i <= 0; next.disabled = i >= fragments.length - 1;
    foot.hidden = fragments.length < 2;
    pin.setAttribute('aria-pressed', String(isPinned()));
    describe(pin, isPinned() ? tr('Открепить фрагмент','Unpin excerpt') :
      tr('Показывать этот фрагмент при приближении','Show this excerpt when zooming in'));
  }
  function browse(delta) {
    if (!isActive() || !isReadable(getNote(id))) return hide();
    const choice = fragments[fragments.indexOf(fragment) + delta];
    if (!choice) return;
    fragment = choice;
    showFragment(body, fragment); paintControls(); graph?.repaint();
  }
  function dismiss() {
    closedId = id;
    hide();
    graph?.canvas.focus({preventScroll:true});
  }
  function paintSeries() {
    if (!metric || card.hidden) return;
    const width = plot.clientWidth;
    if (width > 0 && width !== plotWidth) {
      plotWidth = width;
      paintMetricPreview(chart, metric, {width, height:32});
    }
  }
  function refreshSeries(value) {
    metric = value ?? null;
    plotWidth = 0;
    const end = value?.values?.findLast(Number.isFinite);
    series.hidden = end === undefined;
    if (series.hidden) {
      metric = null; chart.width = 1; chart.removeAttribute('aria-label'); latest.replaceChildren();
      return;
    }
    latest.textContent = formatValue(end, getLanguage());
    chart.setAttribute('role','img');
    chart.setAttribute('aria-label', tr('Динамика, последнее значение ', 'Trend, latest value ') + latest.textContent);
    paintSeries();
  }
  function hide() {
    card.hidden = true;
    title.replaceChildren(); body.replaceChildren(); count.replaceChildren();
    title.removeAttribute('title'); title.removeAttribute('aria-label');
    refreshSeries(null);
    id = note = fragments = fragment = lastPosition = null;
    needsContent = true;
  }
  function sync(current) {
    graph = current;
    if (!isActive()) { if (note || !card.hidden) hide(); pointerEvent = pointer = closedId = route = null; return; }
    if (pointerEvent && !graph.drag?.moved && !graph.pinch && graph.view.reading && graph.zoom >= 1.62) {
      pointer = graph.local(pointerEvent);
      pointerEvent = null;
    }
    const hold = !card.hidden && (card.matches(':hover') || card.contains(document.activeElement));
    const point = readingCandidate(graph, pointer, id, hold, route?.id);
    if (point?.id !== closedId) closedId = null;
    const record = point && point.id !== closedId && getNote(point.id);
    if (!isReadable(record)) { if (note || !card.hidden) hide(); return; }
    if (record !== note || needsContent) {
      const oldKey = record === note ? fragment?.key : null;
      id = point.id; note = record; needsContent = false;
      fragments = readingFragments(note);
      fragment = preferredFragment(fragments, note.mapExcerpt, route?.key || oldKey);
      const linkedMetric = getMetric?.(id);
      if (!fragment && !route && !linkedMetric?.values?.some(Number.isFinite)) {
        hide(); id = point.id; note = record; needsContent = false; return;
      }
      describe(card, tr('Чтение на карте','Map reading'));
      describe(close, tr('Скрыть фрагмент','Hide excerpt'));
      describe(prev, tr('Предыдущий фрагмент','Previous excerpt'));
      describe(next, tr('Следующий фрагмент','Next excerpt'));
      title.textContent = note.title || tr('Без названия','Untitled');
      describe(title, tr('Открыть заметку','Open note') + ' · ' + title.textContent);
      showFragment(body, fragment); paintControls(); card.hidden = false;
      refreshSeries(linkedMetric);
      body.hidden = !fragment && !series.hidden;
      panelWidth = card.offsetWidth; panelHeight = card.offsetHeight;
    }
    if (card.hidden) return;
    const margin = 12, gap = Math.min(point.r, 100) + 8;
    const right = point.x + gap, left = point.x - gap - panelWidth;
    const x = Math.max(margin, Math.min(graph.width - panelWidth - margin,
      right + panelWidth + margin <= graph.width || left < margin ? right : left));
    const y = Math.max(8, Math.min(graph.height - panelHeight - 54, point.y - panelHeight / 2));
    const position = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
    if (lastPosition !== position) { card.style.transform = position; lastPosition = position; }
    const opacity = route ? 1 : Math.max(0, Math.min(1, (graph.zoom - 1.62) / .35));
    if (card.style.opacity !== opacity.toFixed(2)) card.style.opacity = opacity.toFixed(2);
  }
  const observer = new ResizeObserver(() => {
    if (card.hidden) return;
    paintSeries();
    panelWidth = card.offsetWidth; panelHeight = card.offsetHeight; graph?.repaint();
  });
  observer.observe(card);
  observer.observe(plot);
  const abort = new AbortController();
  const events = {signal:abort.signal};
  function remember(event) {
    if (event.target !== graph?.canvas) return;
    // Keep just the latest position until the reading card can use it. In
    // particular, dragging a note should never force a canvas layout read here.
    pointerEvent = {clientX:event.clientX, clientY:event.clientY};
  }
  stage.addEventListener('pointermove', remember, events);
  stage.addEventListener('wheel', remember, {...events, capture:true, passive:true});
  card.addEventListener('wheel', event => {
    if (!graph || !isActive()) return;
    // Keep zoom anchored under the cursor even after the excerpt opens beneath it.
    event.preventDefault();
    graph.canvas.dispatchEvent(new WheelEvent('wheel', {bubbles:true, cancelable:true,
      clientX:event.clientX, clientY:event.clientY, deltaX:event.deltaX, deltaY:event.deltaY,
      deltaMode:event.deltaMode, shiftKey:event.shiftKey, ctrlKey:event.ctrlKey}));
  }, {...events, passive:false});
  stage.addEventListener('pointerleave', () => { pointerEvent = pointer = null; graph?.repaint(); }, events);
  stage.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !card.hidden && !event.defaultPrevented && stage.dataset.routeMode !== 'play') {
      dismiss(); event.stopPropagation(); event.preventDefault();
    }
  }, events);
  return {
    sync, hide() { hide(); pointerEvent = pointer = closedId = route = null; },
    invalidate() { needsContent = true; if (graph) { if (!isActive()) hide(); graph.repaint(); } },
    present(current, noteId, key = null) {
      route = {id:noteId,key}; closedId = null; needsContent = true; sync(current); current.repaint();
    },
    release() { route = null; closedId = id; hide(); graph?.repaint(); },
    destroy() { abort.abort(); observer.disconnect(); hide(); card.remove(); }
  };
}
