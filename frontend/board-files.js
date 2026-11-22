import { getLanguage, tr } from './i18n.js';
import {
  handFont,
  sansFont,
  fontStyle,
  lineHeightFor,
  loadHandFont,
  wrappedSceneText
} from './board-fonts.js';
import { pressureSamples } from './freehand.js';
import { layoutShapeLabel } from './shape-label.js';
import { richBlocks, richFrameStyle, richPlain } from './board-rich-text.js';
import { magnets } from './board-connectors.js';
import { connectorSegments, segmentPoint } from './connector-path.js';
import { createWorkbook, normalizeTable } from './table-engine.js';
import { chartFields, isSheetObject } from './board-tables.js';
import { paintTablePreview, paintChartPreview } from './table-charts.js';

const fromType = new Map([
  ['rectangle', 'rect'],
  ['ellipse', 'ellipse'],
  ['diamond', 'diamond'],
  ['line', 'line'],
  ['arrow', 'arrow'],
  ['freedraw', 'pen'],
  ['image', 'image'],
  ['text', 'text']
]);
const toType = new Map([...fromType].map(([external, local]) => [local, external]));
const raster = /^data:image\/(?:png|jpeg|webp|gif|bmp|avif);base64,/i;
const point = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const bounded = (n) => Math.max(0, Math.min(1, n));
const invalid = () => new Error(tr('Некорректный файл Excalidraw.', 'Invalid Excalidraw file.'));

function color(value, fallback) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) return '#' + [...value.slice(1)].map((c) => c + c).join('');
  return fallback;
}

// Excalidraw sets roundness for a whole line. Represent a mix of smooth and
// sharp joins as a polyline there, and retain its editable knots for Videron.
function mixedCurvePoints(knots, smoothPoints) {
  const points = [knots[0]], knotIndices = [0];
  const secondDifference = (a, b, c) => Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]);
  for (const segment of connectorSegments(knots, smoothPoints)) {
    const { from, c1, c2, to } = segment;
    if (c1 && c2) {
      const curvature = Math.max(secondDifference(from, c1, c2), secondDifference(c1, c2, to));
      // Cubic interpolation error stays below half a scene pixel at normal sizes.
      const steps = Math.min(128, Math.ceil(Math.sqrt(1.5 * curvature)));
      for (let i = 1; i < steps; i++) points.push(segmentPoint(segment, i / steps));
    }
    points.push(to);
    knotIndices.push(points.length - 1);
  }
  return { points, knotIndices };
}

function curveFromScene(source, points) {
  if (source.elbowed) return { points };
  if (source.roundness) return {
    points, smoothPoints: Array.from({ length: Math.max(0, points.length - 2) }, (_, i) => i + 1)
  };
  const meta = source.customData?.videronCurve;
  if (meta?.version !== 1) return { points };
  const { knotIndices: indices, smoothPoints } = meta;
  if (!Array.isArray(indices) || indices.length < 3 || indices[0] !== 0 || indices.at(-1) !== points.length - 1 ||
      !indices.every((v, i) => Number.isInteger(v) && (!i || v > indices[i - 1]))) return { points };
  if (!Array.isArray(smoothPoints) || !smoothPoints.length ||
      !smoothPoints.every(i => Number.isInteger(i) && i > 0 && i < indices.length - 1)) return { points };
  const knots = indices.map(i => points[i]);
  // Honor changes made to individual sampled vertices in another editor.
  for (const [i, segment] of connectorSegments(knots, smoothPoints).entries()) {
    const count = indices[i + 1] - indices[i];
    for (let j = 1; j < count; j++) {
      const [x, y] = segmentPoint(segment, j / count), p = points[indices[i] + j];
      if (Math.hypot(x - p[0], y - p[1]) > 0.02) return { points };
    }
  }
  return { points: knots, smoothPoints };
}

export function importScene(scene) {
  if (scene?.type !== 'excalidraw' || scene.version !== 2 || !Array.isArray(scene.elements))
    throw invalid();
  const elements = [],
    ids = new Set(),
    oldBindings = [], labels = [];
  for (const source of scene.elements) {
    if (!source || typeof source !== 'object') throw invalid();
    if (source.isDeleted) continue;
    const sheet = source.customData?.videronSheet;
    const hasSheet =
      ['image', 'rectangle'].includes(source.type) &&
      sheet?.version === 1 &&
      (sheet.type === 'table' || sheet.type === 'chart');
    const type = hasSheet ? sheet.type : fromType.get(source.type);
    if (!type)
      throw new Error(
        tr('Этот тип объекта пока не поддерживается: ', 'Unsupported object type: ') +
          String(source.type)
      );
    const { id, x, y, width, height } = source;
    if (typeof id !== 'string' || !id || ids.has(id) || ![x, y, width, height].every(Number.isFinite))
      throw invalid();
    ids.add(id);
    const item = {
      id,
      type,
      x,
      y,
      w: Math.max(1, width),
      h: Math.max(1, height),
      angle: ((Number.isFinite(source.angle) ? source.angle : 0) * 180) / Math.PI,
      stroke: color(source.strokeColor, '#222222'),
      fill: color(source.backgroundColor, 'none'),
      lineWidth: Number.isFinite(source.strokeWidth) ? source.strokeWidth : 2,
      strokeStyle: source.strokeStyle,
      fillStyle: source.fillStyle,
      roughness: source.roughness,
      seed: source.seed
    };
    if (type === 'rect' || type === 'diamond') item.rounded = !!source.roundness;
    if (Array.isArray(source.groupIds)) {
      const groups = [...new Set(source.groupIds.filter((id) => typeof id === 'string' && id))];
      if (groups.length) item.groupIds = groups;
    }
    if (source.locked === true) item.locked = true;
    if (type === 'table') Object.assign(item, normalizeTable(sheet));
    else if (type === 'chart') Object.assign(item, chartFields(sheet));
    else if (['pen', 'arrow', 'line'].includes(type)) {
      let points = source.points;
      if (!Array.isArray(points) || !points.length || !points.every(point)) throw invalid();
      if (type !== 'pen') {
        const curve = curveFromScene(source, points);
        points = curve.points;
        if (curve.smoothPoints?.length) item.smoothPoints = curve.smoothPoints;
      }
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (const [px, py] of points) {
        left = Math.min(left, px);
        top = Math.min(top, py);
        right = Math.max(right, px);
        bottom = Math.max(bottom, py);
      }
      item.x = x + left;
      item.y = y + top;
      item.w = Math.max(1, right - left);
      item.h = Math.max(1, bottom - top);
      item.points = points.map(([px, py]) => [(px - left) / item.w, (py - top) / item.h]);
      if (type === 'pen' && source.customData?.videronStroke !== 'uniform') {
        item.strokeProfile = 'freehand';
        const pressures = pressureSamples(source.pressures, points.length);
        if (pressures && source.simulatePressure !== true) item.pressures = pressures;
      }
      for (const key of ['startBinding', 'endBinding']) {
        const binding = source[key];
        if (typeof binding?.elementId === 'string' && point(binding.fixedPoint)) {
          item[key] = {
            id: binding.elementId,
            u: bounded(binding.fixedPoint[0]),
            v: bounded(binding.fixedPoint[1])
          };
        } else if (typeof binding?.elementId === 'string')
          oldBindings.push({ item, key, target: binding.elementId });
      }
    } else if (type === 'text') {
      if (typeof source.text !== 'string') throw invalid();
      item.text =
        typeof source.originalText === 'string' && source.originalText.length
          ? source.originalText
          : source.text;
      item.autoResize = source.autoResize === true;
      const rich = source.customData?.videronRichText;
      if (rich?.version === 1 && Array.isArray(rich.body)) {
        const body = richBlocks(rich.body, { localFolders: false });
        // Edits made to the plain text in Excalidraw take precedence over an old snapshot.
        if (richPlain(body) === item.text) Object.assign(item, {body}, richFrameStyle(rich));
      }
      item.fontSize = Number.isFinite(source.fontSize) ? source.fontSize : 20;
      item.fontFamily =
        Number.isInteger(source.fontFamily) && source.fontFamily > 0 ? source.fontFamily : handFont;
      item.lineHeight = lineHeightFor({ ...item, lineHeight: source.lineHeight });
      item.textAlign = ['left', 'center', 'right'].includes(source.textAlign)
        ? source.textAlign
        : 'left';
      if (typeof source.containerId === 'string')
        labels.push({text:item, containerId:source.containerId, requestedSize:source.customData?.videronLabelFontSize});
    } else if (type === 'image') {
      const file = Object.hasOwn(scene.files || {}, source.fileId) ? scene.files[source.fileId] : null;
      if (!raster.test(file?.dataURL || ''))
        throw new Error(
          tr(
            'Изображение отсутствует или имеет неподдерживаемый формат.',
            'An image is missing or uses an unsupported format.'
          )
        );
      item.src = file.dataURL;
      item.alt = typeof source.customData?.alt === 'string' ? source.customData.alt : '';
    }
    elements.push(item);
  }
  // Older files describe arrow bindings by focus and gap. The stored endpoint
  // still gives the position of the attachment in the target's local space.
  const byId = new Map(elements.map((e) => [e.id, e]));
  const absorbedLabels = new Set();
  for (const {text, containerId, requestedSize} of labels) {
    const parent = byId.get(containerId);
    if (!parent || !['rect','ellipse','diamond'].includes(parent.type) || parent.label || !text.text) continue;
    parent.label = text.text;
    parent.fontSize = Number.isFinite(requestedSize) ? requestedSize : text.fontSize;
    parent.fontFamily = text.fontFamily;
    if (text.stroke !== parent.stroke) parent.labelColor = text.stroke;
    absorbedLabels.add(text.id);
  }
  if (oldBindings.length) {
    for (const { item, key, target } of oldBindings) {
      const shape = byId.get(target);
      if (!shape) continue;
      const p = key === 'startBinding' ? item.points[0] : item.points.at(-1);
      const a = (item.angle * Math.PI) / 180,
        b = (-shape.angle * Math.PI) / 180;
      const px = (p[0] - 0.5) * item.w,
        py = (p[1] - 0.5) * item.h;
      const dx = item.x + item.w / 2 + px * Math.cos(a) - py * Math.sin(a) - shape.x - shape.w / 2;
      const dy = item.y + item.h / 2 + px * Math.sin(a) + py * Math.cos(a) - shape.y - shape.h / 2;
      item[key] = {
        id: target,
        u: bounded(0.5 + (dx * Math.cos(b) - dy * Math.sin(b)) / shape.w),
        v: bounded(0.5 + (dx * Math.sin(b) + dy * Math.cos(b)) / shape.h)
      };
    }
  }
  // Excalidraw encodes an attachment as a coordinate. Recover exact magnetic
  // sites so a rounded corner can still follow the shape as its radius changes.
  for (const element of elements) {
    for (const binding of [element.startBinding, element.endBinding]) {
      const shape = binding && byId.get(binding.id);
      if (!shape) continue;
      const site = magnets(shape).findIndex(
        ([u, v]) => Math.abs(u - binding.u) < 1e-6 && Math.abs(v - binding.v) < 1e-6
      );
      if (site !== -1) binding.site = site;
    }
  }
  return {
    version: elements.some(isSheetObject) ? 2 : 1,
    background: color(scene.appState?.viewBackgroundColor, '#ffffff'),
    elements: elements.filter(item => !absorbedLabels.has(item.id))
  };
}

function sheetImage(item, workbook, doc) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(2, 1536 / Math.max(item.w, item.h));
  canvas.width = Math.max(1, Math.ceil(item.w * scale));
  canvas.height = Math.max(1, Math.ceil(item.h * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const background = doc.background || '#171717';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, item.w, item.h);
  if (item.type === 'table') paintTablePreview(ctx, item, workbook, background);
  else paintChartPreview(ctx, item, workbook, doc.elements, background);
  return canvas.toDataURL('image/png');
}

export function exportScene(doc, workbook) {
  if (!workbook && doc.elements.some(isSheetObject)) workbook = createWorkbook(doc.elements);
  const files = Object.create(null),
    boundById = new Map(),
    fileIds = new Map(),
    now = Date.now();
  function convertBinding(binding, arrowId) {
    if (!binding) return null;
    if (!boundById.has(binding.id)) boundById.set(binding.id, []);
    const attached = boundById.get(binding.id);
    if (!attached.some((b) => b.id === arrowId)) attached.push({ id: arrowId, type: 'arrow' });
    return {
      elementId: binding.id,
      fixedPoint: [binding.u, binding.v],
      mode: 'orbit',
      focus: 0,
      gap: 0
    };
  }
  const usedIds = new Set(doc.elements.map(item => item.id));
  const elements = doc.elements.flatMap((item) => {
    const sheet = isSheetObject(item);
    const type = sheet
      ? typeof document === 'undefined'
        ? 'rectangle'
        : 'image'
      : toType.get(item.type);
    if (!type)
      throw new Error(tr('Невозможно экспортировать объект: ', 'Cannot export object: ') + item.type);
    const e = {
      id: item.id,
      type,
      x: item.x,
      y: item.y,
      width: item.w,
      height: item.h,
      angle: ((item.angle || 0) * Math.PI) / 180,
      strokeColor: item.stroke,
      backgroundColor: item.fill === 'none' ? 'transparent' : item.fill,
      fillStyle: item.fillStyle || 'solid',
      strokeWidth: item.lineWidth || 2,
      strokeStyle: item.strokeStyle || 'solid',
      roughness: item.roughness || 0,
      opacity: 100,
      roundness:
        item.rounded && type === 'rectangle'
          ? { type: 3, value: 12 }
          : item.rounded && type === 'diamond'
            ? { type: 2 }
            : null,
      seed: item.seed || 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      groupIds: item.groupIds?.slice() ?? (item.groupId ? [item.groupId] : []),
      index: null,
      frameId: null,
      boundElements: [],
      created: now,
      updated: now,
      link: null,
      locked: item.locked === true
    };
    if (['arrow', 'line', 'freedraw'].includes(type)) {
      let points = (
        item.points?.length
          ? item.points
          : [
              [0, 0],
              [1, 1]
            ]
      ).map(([px, py]) => [px * item.w, py * item.h]);
      if (type !== 'freedraw' && item.smoothPoints?.length) {
        if (item.smoothPoints.length === points.length - 2) e.roundness = { type: 2 };
        else {
          const mixed = mixedCurvePoints(points, item.smoothPoints);
          points = mixed.points;
          e.customData = { videronCurve: { version: 1, knotIndices: mixed.knotIndices, smoothPoints: [...item.smoothPoints] } };
        }
      }
      const [ox, oy] = points[0];
      e.x += ox;
      e.y += oy;
      e.points = points.map(([px, py]) => [px - ox, py - oy]);
      if (type === 'freedraw') {
        const pressures = pressureSamples(item.pressures, points.length);
        Object.assign(e, {
          pressures: pressures || [],
          simulatePressure: !pressures,
          lastCommittedPoint: e.points.at(-1)
        });
        if (item.strokeProfile !== 'freehand') e.customData = { videronStroke: 'uniform' };
      } else
        Object.assign(e, {
          startBinding: convertBinding(item.startBinding, item.id),
          endBinding: convertBinding(item.endBinding, item.id),
          startArrowhead: null,
          endArrowhead: type === 'arrow' ? 'arrow' : null,
          elbowed: false,
          lastCommittedPoint: null
        });
    } else if (type === 'text') {
      if (Array.isArray(item.body)) {
        e.customData = { videronRichText: { version: 1, body: richBlocks(item.body, { localFolders: false }), ...richFrameStyle(item) } };
      }
      Object.assign(e, {
        text: wrappedSceneText(item),
        originalText: item.text,
        fontSize: item.fontSize,
        fontFamily: item.fontFamily || sansFont,
        textAlign: item.textAlign || 'left',
        verticalAlign: 'top',
        containerId: null,
        autoResize: item.autoResize === true,
        lineHeight: lineHeightFor(item),
        baseline: Math.round(item.fontSize)
      });
    } else if (type === 'image') {
      const src = sheet ? sheetImage(item, workbook, doc) : item.src;
      let fileId = fileIds.get(src);
      if (!fileId) {
        fileId = crypto.randomUUID();
        fileIds.set(src, fileId);
        files[fileId] = {
          id: fileId,
          mimeType: src.slice(5, src.indexOf(';')),
          dataURL: src,
          created: now
        };
      }
      Object.assign(e, {
        fileId,
        status: 'saved',
        scale: [1, 1],
        crop: null,
        customData: { alt: item.alt || '' }
      });
    }
    if (sheet) {
      const data = item.type === 'table' ? normalizeTable(item) : chartFields(item);
      e.customData = { videronSheet: { version: 1, type: item.type, ...data } };
    }
    if (['rect','ellipse','diamond'].includes(item.type) && item.label) {
      const box = layoutShapeLabel(item);
      let id = item.id + '-label';
      while (usedIds.has(id)) id += '-';
      usedIds.add(id);
      const links = boundById.get(item.id) || [];
      links.push({id, type:'text'});
      boundById.set(item.id, links);
      const label = {
        ...e, id, type:'text', containerId:item.id, x:item.x + box.x, y:item.y + box.y,
        width:box.w, height:box.h, strokeColor:box.color, backgroundColor:'transparent',
        fillStyle:'solid', strokeStyle:'solid', roundness:null,
        text:box.lines.join('\n'), originalText:item.label, textAlign:'center', verticalAlign:'middle',
        fontSize:box.size, fontFamily:box.family, lineHeight:box.leading, baseline:Math.round(box.size),
        autoResize:false, boundElements:[]
      };
      if ((item.fontSize || 20) !== box.size) label.customData = {videronLabelFontSize:item.fontSize || 20};
      return [e, label];
    }
    return e;
  });
  for (const e of elements) e.boundElements = boundById.get(e.id) || [];
  return {
    type: 'excalidraw',
    version: 2,
    source: 'Videron',
    elements,
    appState: { viewBackgroundColor: doc.background || '#171717' },
    files
  };
}

async function saveScene(doc, workbook) {
  if (doc.elements.some((e) => (e.type === 'text' || e.label) && fontStyle(e.fontFamily || handFont) === handFont))
    await loadHandFont();
  const json = JSON.stringify(exportScene(doc, workbook));
  if (window.go?.main?.App) return window.go.main.App.SaveDrawing(json, getLanguage());
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const download = document.createElement('a');
  download.href = url;
  download.download = 'Videron.excalidraw';
  document.body.append(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function openBoardFiles({ anchor, getDocument, getWorkbook, replaceDocument, addFolder, onClose }) {
  const board = anchor.closest('.vb') || anchor.closest('.vt-table, .vt-chart');
  const menu = document.createElement('div');
  menu.className = 'diagram-files vb-file-menu';
  const floating = !board.classList.contains('vb') && typeof menu.showPopover === 'function';
  if (floating) menu.setAttribute('popover', 'manual');
  menu.id = 'drawing-files-' + crypto.randomUUID();
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', tr('Файл рисунка', 'Drawing file'));
  const events = new AbortController();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.excalidraw,.json';
  input.hidden = true;
  const info = document.createElement('p');
  info.setAttribute('role', 'status');
  const actions = document.createElement('div');
  function close(restoreFocus = false) {
    if (events.signal.aborted) return;
    events.abort();
    menu.remove();
    anchor.removeAttribute('aria-controls');
    anchor.setAttribute('aria-expanded', 'false');
    onClose?.();
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  }
  function action(label, fn) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = async () => {
      try {
        await fn();
      } catch (error) {
        info.textContent = String(error?.message || error);
      }
    };
    return button;
  }
  const open = action(tr('Открыть .excalidraw…', 'Open .excalidraw…'), () => input.click());
  const save = action(tr('Сохранить .excalidraw…', 'Save .excalidraw…'), async () => {
    if (await saveScene(getDocument(), getWorkbook?.())) close(true);
  });
  actions.append(open, save);
  if (addFolder) {
    actions.append(action(tr('Ссылка на папку…', 'Link to folder…'), () => {
      close(true);
      return addFolder();
    }));
  }
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw invalid();
      }
      const doc = importScene(parsed);
      if (events.signal.aborted || !anchor.isConnected) return;
      const apply = () => {
        replaceDocument(doc);
        close(true);
      };
      if (!getDocument().elements.length) return apply();
      info.textContent = tr('Заменить содержимое этого холста?', 'Replace the contents of this canvas?');
      const cancel = action(tr('Отмена', 'Cancel'), () => close(true));
      actions.replaceChildren(cancel, action(tr('Заменить', 'Replace'), apply));
      cancel.focus({ preventScroll: true });
    } catch (error) {
      info.textContent = String(error?.message || error);
    } finally {
      input.value = '';
    }
  };
  menu.append(info, actions, input);
  board.append(menu);
  if (floating) menu.showPopover();
  anchor.setAttribute('aria-controls', menu.id);
  anchor.setAttribute('aria-expanded', 'true');
  function position() {
    const target = anchor.getBoundingClientRect(), bounds = board.getBoundingClientRect();
    if (floating) {
      const below = target.bottom + 5;
      const y = below + menu.offsetHeight <= window.innerHeight - 4 ? below : target.top - menu.offsetHeight - 5;
      menu.style.left = Math.max(4, Math.min(window.innerWidth - menu.offsetWidth - 4, target.right - menu.offsetWidth)) + 'px';
      menu.style.top = Math.max(4, y) + 'px';
      return;
    }
    menu.style.left = Math.max(4, Math.min(board.clientWidth - menu.offsetWidth - 4, target.right - bounds.left - menu.offsetWidth)) + 'px';
    menu.style.top = Math.max(4, Math.min(board.clientHeight - menu.offsetHeight - 4, target.bottom - bounds.top + 5)) + 'px';
  }
  position();
  const resize = new ResizeObserver(position);
  resize.observe(board);
  resize.observe(menu);
  if (floating) document.addEventListener('scroll', position, { capture: true, signal: events.signal });
  events.signal.addEventListener('abort', () => resize.disconnect(), { once: true });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  }, { capture: true, signal: events.signal });
  document.addEventListener('focusin', (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  }, { signal: events.signal });
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const buttons = [...actions.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + buttons.length + (e.key === 'ArrowDown' ? 1 : -1)) % buttons.length]?.focus();
    }
  });
  open.focus({ preventScroll: true });
  return close;
}
