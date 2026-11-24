import { boardIcon } from './board-icons.js';
import { pointsInBox, seedFromId } from './board-points.js';
import { boardInk } from './board-theme.js';
import { tr } from './i18n.js';
import { mapPalette } from './map-palette.js';
import { mountInkColor } from './map-ink-color.js';
import { mountMapTextEditor, newMapText, paintMapText } from './map-ink-text.js';
import { inkHandleAt, paintInkHandles, resizeMapInk } from './map-ink-resize.js';

const shapes = new Set(['pen', 'rect', 'ellipse', 'text']);
const defaultStroke = '#d4d4d4';

function drawable(item) {
  return item && shapes.has(item.type) && (item.type !== 'text' || typeof item.text === 'string') && typeof item.id === 'string' && item.id &&
    Number.isFinite(item.x) && Number.isFinite(item.y) &&
    Number.isFinite(item.w) && item.w > 0 && Number.isFinite(item.h) && item.h > 0;
}

function strokeMargin(item) {
  return 4 + Math.min(40, Math.max(1, Number(item.lineWidth) || 2)) * 3;
}

// The first pointer gesture can arrive before the drawing engine has loaded.
// A simple outline gives immediate feedback and hit testing in that brief interval.
function initialLayers(item) {
  const path = new Path2D(), width = Number(item.lineWidth) || 2;
  if (item.type === 'rect') path.rect(0, 0, item.w, item.h);
  else if (item.type === 'ellipse') path.ellipse(item.w / 2, item.h / 2, item.w / 2, item.h / 2, 0, 0, Math.PI * 2);
  else {
    let started = false;
    for (const point of Array.isArray(item.points) ? item.points : []) {
      if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
      const x = point[0] * item.w, y = point[1] * item.h;
      if (started) path.lineTo(x, y);
      else { path.moveTo(x, y); path.lineTo(x + .01, y); started = true; }
    }
  }
  return [{path, width, fill: false, stroke: true}];
}

export function inkIdsInRect(items, rect) {
  const ids = [];
  for (const item of items) {
    // Dragging inside a large hollow frame can still select its contents separately.
    if (drawable(item) && item.x >= rect.left && item.y >= rect.top &&
        item.x + item.w <= rect.right && item.y + item.h <= rect.bottom) ids.push(item.id);
  }
  return ids;
}

export function mapInkBounds(items, ids = null) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const item of items) {
    if (!drawable(item) || (ids && !ids.has(item.id))) continue;
    const pad = strokeMargin(item);
    left = Math.min(left, item.x - pad);
    top = Math.min(top, item.y - pad);
    right = Math.max(right, item.x + item.w + pad);
    bottom = Math.max(bottom, item.y + item.h + pad);
  }
  return left === Infinity ? null : {left, right, top, bottom};
}

export function mountMapInk({ graph, stage = graph.canvas.parentElement, canvas = graph.canvas,
                             getItems, onChange, onExit }) {
  const doc = stage.ownerDocument;
  let hitCanvas;
  const controller = new AbortController();
  let geometry = new WeakMap(), engine, loading;
  const bar = doc.createElement('div');
  bar.className = 'dock map-ink-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  stage.append(bar);
  let active = false, tool = 'pen', selectedId = null, gesture = null, quickSelection = false;
  let style = {stroke: defaultStroke, lineWidth: 2, glow: false};
  const buttons = new Map();
  const labels = [];
  const listen = (node, event, handler, capture = false) =>
    node.addEventListener(event, handler, {capture, signal: controller.signal});
  const textEditor = mountMapTextEditor({stage, canvas, graph, onFinish(original, after, save) {
    let selection = original?.id ?? null;
    if (save && original !== after && (!original || getItems().includes(original)) &&
        onChange((original || after).id, original, after) !== false) selection = after?.id ?? null;
    selectedId = selection;
    if (tool === 'text' && selection) tool = 'select';
    updateControls();
    graph.repaint();
  }});

  function label(node, getLabel) {
    labels.push(() => {
      node.title = getLabel();
      node.setAttribute('aria-label', node.title);
    });
  }
  function button(key, icon, getLabel, action) {
    const el = doc.createElement('button');
    el.className = 'icon-button';
    el.type = 'button';
    el.dataset.inkAction = key;
    el.innerHTML = boardIcon(icon);
    buttons.set(key, el);
    label(el, getLabel);
    listen(el, 'click', () => { action(); canvas.focus({preventScroll: true}); });
    bar.append(el);
    return el;
  }
  const toolEntries = [
    ['select', 'pointer', () => tr('Выбрать штрих или фигуру', 'Select a stroke or shape')],
    ['pen', 'pen', () => tr('Перо', 'Pen')],
    ['rect', 'rect', () => tr('Прямоугольник', 'Rectangle')],
    ['ellipse', 'circle', () => tr('Эллипс', 'Ellipse')],
    ['text', 'text', () => tr('Текст', 'Text')],
    ['erase', 'erase', () => tr('Ластик', 'Eraser')]
  ];
  for (const [key, icon, text] of toolEntries) button(key, icon, text, () => {
    cancel();
    quickSelection = false;
    tool = key;
    selectedId = null;
    updateControls();
    graph.repaint();
  });
  bar.append(doc.createElement('span'));
  const palette = mountInkColor({bar,canvas,signal:controller.signal,target:currentStyle,
    commit:stroke=>changeStyle({stroke,fixedStroke:true}),repaint:()=>graph.repaint()});
  const width = doc.createElement('input');
  width.type = 'range';
  width.className = 'map-ink-width';
  width.min = '1'; width.max = '8'; width.step = '0.5';
  label(width, () => tr('Толщина штриха', 'Stroke width'));
  listen(width, 'change', () => changeStyle({lineWidth: Number(width.value)}));
  bar.append(width);
  button('glow', 'agent', () => tr('Свечение', 'Glow'), () => changeStyle({glow: !currentStyle().glow}));
  button('done', 'check', () => tr('Завершить рисование', 'Finish drawing'), () => onExit());

  function refreshLanguage() {
    palette.refreshLanguage();
    bar.setAttribute('aria-label', tr('Рисование на карте', 'Map drawing'));
    for (const translate of labels) translate();
    updateControls();
  }
  function currentSelection() {
    return selectedId ? getItems().find(item => item.id === selectedId) : null;
  }
  function selectItem(id, {fromMap = false} = {}) {
    if (!active || !getItems().some(item => item.id === id)) return false;
    cancel();
    quickSelection = fromMap;
    tool = 'select';
    selectedId = id;
    updateControls();
    graph.repaint();
    return true;
  }
  function currentStyle() { return currentSelection() || style; }
  function updateControls() {
    const current = currentStyle();
    width.value = String(current.lineWidth || 2);
    for (const [key] of toolEntries) {
      const el = buttons.get(key);
      el.classList.toggle('active', tool === key);
      el.setAttribute('aria-pressed', String(tool === key));
    }
    buttons.get('glow').classList.toggle('active', !!current.glow);
    buttons.get('glow').setAttribute('aria-pressed', String(!!current.glow));
    const editing = tool !== 'erase' && (tool !== 'select' || !!currentSelection());
    palette.sync(!editing);
    width.disabled = !editing || tool==='text' || current.type==='text';
    buttons.get('glow').disabled = !editing;
    canvas.dataset.inkTool = active ? tool : '';
  }
  function changeStyle(patch) {
    const item = currentSelection();
    if (item) {
      if (Object.entries(patch).some(([k, v]) => item[k] !== v)) onChange(item.id, item, {...item, ...patch});
    } else style = {...style, ...patch};
    updateControls();
    graph.repaint();
  }
  function loadEngine() {
    if (loading) return;
    loading = import('./board.js').then(module => {
      if (controller.signal.aborted) return;
      engine = module;
      geometry = new WeakMap();
      graph.repaint();
    }).catch(error => console.error('Could not load the drawing engine', error));
  }
  function layers(item) {
    loadEngine();
    let result = geometry.get(item);
    if (!result) {
      // Loaded and local strokes share the board renderer, including its seeded
      // double outlines and pressure-sensitive filled paths. Colours resolve at paint time.
      const e = engine?.normalizeBoard({elements: [item]}).elements[0];
      result = e ? engine.paintLayers(e).map(layer => ({
        path: new Path2D(layer.d), fill: layer.fill !== 'none' && !!layer.fill,
        stroke: layer.stroke !== 'none' && !!layer.stroke, width: layer.strokeWidth || 0
      })) : initialLayers(item);
      geometry.set(item, result);
    }
    return result;
  }
  function hit(point) {
    const items = getItems(), tolerance = 6 / graph.zoom;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (!drawable(item)) continue;
      const x = point.x - item.x, y = point.y - item.y, margin = strokeMargin(item) + tolerance;
      if (x < -margin || y < -margin || x > item.w + margin || y > item.h + margin) continue;
      if (item.type === 'text') {
        if (x >= -tolerance && y >= -tolerance && x <= item.w + tolerance && y <= item.h + tolerance) return item;
        continue;
      }
      hitCanvas ??= doc.createElement('canvas').getContext('2d');
      for (const layer of layers(item)) {
        hitCanvas.lineWidth = layer.width + tolerance * 2;
        if ((layer.fill && hitCanvas.isPointInPath(layer.path, x, y)) || hitCanvas.isPointInStroke(layer.path, x, y)) return item;
      }
    }
    return null;
  }

  function draw(ctx, {ox, oy, zoom, width, height}) {
    textEditor.sync();
    const items = getItems();
    if (!items.length && !gesture) return;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(zoom, zoom);
    ctx.lineJoin = ctx.lineCap = 'round';
    const paint = (item, x, y) => {
      const padding = strokeMargin(item) * zoom + 24;
      if (ox + (x + item.w) * zoom < -padding || oy + (y + item.h) * zoom < -padding ||
          ox + x * zoom > width + padding || oy + y * zoom > height + padding) return;
      ctx.save();
      ctx.translate(x, y);
      const ink = palette.previewFor(item) || boardInk(item).stroke || defaultStroke;
      ctx.strokeStyle = ctx.fillStyle = ink;
      if (item.glow) {
        ctx.shadowColor = /^#[\da-f]{6}$/i.test(ink) ? ink + 'ab' : ink;
        ctx.shadowBlur = (graph.dpr || 1) * Math.min(18, Math.max(4, 7 * Math.sqrt(zoom)));
      }
      if (item.type === 'text') paintMapText(ctx, item);
      else for (const layer of layers(item)) {
        if (layer.fill) ctx.fill(layer.path);
        if (layer.stroke) { ctx.lineWidth = layer.width; ctx.stroke(layer.path); }
      }
      ctx.restore();
    };
    const movingGroup = graph.drag?.composition;
    for (const item of items) {
      if (!drawable(item) || textEditor.item?.id === item.id) continue;
      const moving = movingGroup?.inkIds.has(item.id) ? movingGroup :
        gesture?.kind === 'move' && gesture.item === item ? gesture : null;
      const shown = gesture?.kind === 'resize' && gesture.item === item ? gesture.draft : item;
      paint(shown, shown.x + (moving?.dx ?? 0), shown.y + (moving?.dy ?? 0));
    }
    if (gesture?.kind === 'draw') {
      const draft = draftItem(gesture);
      paint(draft, draft.x, draft.y);
    }
    ctx.restore();
  }

  function drawSelection(ctx, view) {
    const ids = graph.drag?.previewInkIds ?? graph.selectedInkIds;
    if (ids?.size) {
      const {ox, oy, zoom} = view, move = graph.drag?.composition;
      ctx.save();
      ctx.strokeStyle = mapPalette().caption;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      for (const item of getItems()) {
        if (!drawable(item) || !ids.has(item.id)) continue;
        const moving = move?.inkIds.has(item.id);
        const x = ox + (item.x + (moving ? move.dx : 0)) * zoom;
        const y = oy + (item.y + (moving ? move.dy : 0)) * zoom;
        ctx.strokeRect(x - 4, y - 4, item.w * zoom + 8, item.h * zoom + 8);
      }
      ctx.restore();
    }
    if (!active || tool !== 'select' || textEditor.item) return;
    let item = currentSelection();
    if (!drawable(item)) return;
    if (gesture?.item === item) {
      if (gesture.kind === 'resize') item = gesture.draft;
      if (gesture.kind === 'move') item = {...item, x:item.x + gesture.dx, y:item.y + gesture.dy};
    }
    paintInkHandles(ctx, item, view, mapPalette());
  }

  function draftItem(g) {
    if (!g.draft) {
      if (g.base.type === 'pen') {
        g.draft = {...g.base, ...pointsInBox(g.points), strokeProfile: 'freehand'};
        if (g.pressures) g.draft.pressures = g.pressures.slice();
      } else {
        const {x, y} = g.start, dx = g.end.x - x, dy = g.end.y - y;
        const w = g.square ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx);
        const h = g.square ? w : Math.abs(dy);
        g.draft = {...g.base, x: dx < 0 ? x - w : x, y: dy < 0 ? y - h : y, w: Math.max(1, w), h: Math.max(1, h)};
      }
    }
    return g.draft;
  }
  function pointerDown(e) {
    if (!active || e.button !== 0 || graph.spacePan || graph.drag || graph.pinch) return;
    if (gesture) {
      // Transfer the first contact to the map's existing pinch handler.
      if (e.pointerType === 'touch' && gesture.pointerType === 'touch') {
        graph.contacts.set(gesture.id, gesture.lastLocal);
        gesture = null;
        graph.repaint();
        return;
      }
      e.stopImmediatePropagation();
      return;
    }
    const local = graph.local(e), point = graph.world(local);
    const selected = tool === 'select' ? currentSelection() : null;
    const handle = inkHandleAt(selected, point, graph.zoom, e.pointerType === 'touch');
    const target = !handle && (tool === 'select' || tool === 'erase' || tool === 'text') ? hit(point) : null;
    const extend = e.shiftKey || e.ctrlKey || e.metaKey;
    // Transfer the first selected stroke when switching from editing one drawing to selecting several.
    if (tool === 'select' && !handle && (extend || !target || graph.handlesInk?.(target.id) ||
        (quickSelection && (e.altKey || graph.hit(local) || graph.gridSurface(local).area)))) {
      onExit();
      if (extend && selected) graph.changeSelection(graph.selectedIds, null, new Set([...graph.selectedInkIds, selected.id]));
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    graph.target = null;
    canvas.focus({preventScroll: true});
    if (tool === 'text') {
      const original = target?.type === 'text' ? target : null;
      selectedId = original?.id ?? null;
      textEditor.open(original || newMapText(point, style), original);
      return;
    }
    const common = {id: e.pointerId, pointerType: e.pointerType, start: point, lastLocal: local};
    if (handle) {
      gesture = {...common, kind: 'resize', handle, item:selected, draft:selected};
      canvas.style.setProperty('--map-ink-select-cursor', handle.cursor);
    } else if (tool === 'select' || tool === 'erase') {
      const item = target;
      selectedId = tool === 'select' ? item?.id : null;
      gesture = {...common, kind: tool === 'erase' ? 'erase' : 'move', item, dx: 0, dy: 0};
      updateControls();
    } else {
      const id = crypto.randomUUID();
      const base = {id, type: tool, seed: seedFromId(id), ...style, roughness: 1, fill: 'none', strokeStyle: 'solid', fillStyle: 'solid'};
      if (tool === 'rect') base.rounded = true;
      gesture = {...common, kind: 'draw', base, points: [[point.x, point.y]], end: point,
        pressures: tool === 'pen' && e.pointerType === 'pen' ? [e.pressure] : null};
    }
    canvas.setPointerCapture(e.pointerId);
    graph.repaint();
  }
  function sample(g, e) {
    g.lastLocal = graph.local(e);
    const p = graph.world(g.lastLocal);
    if (g.kind === 'move') {
      g.dx = p.x - g.start.x;
      g.dy = p.y - g.start.y;
    } else if (g.kind === 'resize') {
      g.draft = resizeMapInk(g.item, g.handle.name, p.x - g.start.x, p.y - g.start.y, e.shiftKey);
    } else if (g.kind === 'draw') {
      if (g.base.type === 'pen') {
        const [x, y] = g.points.at(-1);
        if (Math.hypot(x - p.x, y - p.y) * graph.zoom < 0.9) return;
        g.points.push([p.x, p.y]);
        if (g.pressures) g.pressures.push(e.type === 'pointerup' ? g.pressures.at(-1) : e.pressure);
      }
      g.end = p;
      g.square = e.shiftKey;
      g.draft = null;
    }
  }
  function pointerMove(e) {
    if (!active || graph.drag || graph.pinch || graph.spacePan && !gesture) return;
    if (gesture && gesture.id !== e.pointerId) return;
    e.stopImmediatePropagation();
    if (!gesture) {
      if (tool === 'select') {
        const handle = inkHandleAt(currentSelection(), graph.world(graph.local(e)), graph.zoom);
        canvas.style.setProperty('--map-ink-select-cursor', handle?.cursor || 'default');
      }
      return;
    }
    const samples = gesture.kind === 'draw' && gesture.base.type === 'pen' ? e.getCoalescedEvents?.() : null;
    for (const event of samples?.length ? samples : [e]) sample(gesture, event);
    graph.repaint();
  }
  function release(id) {
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function cancel() {
    if (!gesture) return false;
    const id = gesture.id;
    gesture = null;
    release(id);
    graph.repaint();
    return true;
  }
  function pointerEnd(e) {
    const g = gesture;
    if (!g || g.id !== e.pointerId) return;
    e.stopImmediatePropagation();
    if (e.type !== 'pointerup') { cancel(); return; }
    sample(g, e);
    gesture = null;
    release(g.id);
    // A sync or undo may already have replaced the selected stroke.
    if (g.kind === 'draw') {
      if (g.base.type === 'pen' || Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) * graph.zoom >= 3) {
        const item = draftItem(g);
        if (onChange(item.id, null, item) !== false && (item.type === 'rect' || item.type === 'ellipse')) selectItem(item.id);
      }
    } else if (g.item && getItems().includes(g.item)) {
      if (g.kind === 'erase' && hit(graph.world(g.lastLocal)) === g.item) onChange(g.item.id, g.item, null);
      if (g.kind === 'resize' && g.draft !== g.item) onChange(g.item.id, g.item, g.draft);
      if (g.kind === 'move' && Math.hypot(g.dx, g.dy) * graph.zoom > 2)
        onChange(g.item.id, g.item, {...g.item, x: g.item.x + g.dx, y: g.item.y + g.dy});
    }
    graph.repaint();
  }
  function reset() {
    quickSelection = false;
    palette.close();
    textEditor.finish(false);
    cancel();
    selectedId = null;
    canvas.style.removeProperty('--map-ink-select-cursor');
    updateControls();
    graph.repaint();
  }
  function setActive(next) {
    if (active === next) return;
    active = next;
    bar.hidden = !next;
    reset();
    if (next) {
      loadEngine();
      canvas.focus({preventScroll: true});
    }
  }
  function deleteSelection() {
    const item = currentSelection();
    if (!active || !item || gesture) return false;
    selectedId = null;
    onChange(item.id, item, null);
    updateControls();
    graph.repaint();
    return true;
  }
  listen(canvas, 'pointerdown', pointerDown, true);
  listen(canvas, 'pointermove', pointerMove, true);
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, event, pointerEnd, true);
  listen(canvas, 'dblclick', e => {
    if (!active) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (tool !== 'select') return;
    const item = hit(graph.world(graph.local(e)));
    if (item?.type === 'text') textEditor.open(item, item);
  }, true);
  listen(canvas, 'contextmenu', e => {
    if (quickSelection) { onExit(); return; }
    if (active) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  listen(canvas, 'keydown', e => {
    if (!active || tool !== 'select' || e.key !== 'Enter' || e.isComposing || e.repeat ||
        e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const item = currentSelection();
    if (item?.type === 'text') {
      e.preventDefault(); e.stopPropagation(); textEditor.open(item, item);
    }
  });
  listen(doc.defaultView, 'blur', cancel);
  listen(doc.defaultView, 'videron:themechange', updateControls);
  refreshLanguage();
  return {
    draw, drawSelection, itemAt: hit, selectItem, bounds: () => mapInkBounds(getItems()),
    idsInRect: rect => inkIdsInRect(getItems(), rect), selectionBounds: ids => mapInkBounds(getItems(), ids),
    setActive, reset, refreshLanguage, deleteSelection, cancel,
    refreshSelection: updateControls,
    flushText: () => textEditor.finish(true),
    get editingText() { return !!textEditor.item; },
    get busy() { return !!gesture || !!textEditor.item; }, get active() { return active; },
    destroy() { setActive(false); controller.abort(); bar.remove(); }
  };
}
