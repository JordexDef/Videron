import { tr } from './i18n.js';
import { boardPaper, boardInk, lightPaper } from './board-theme.js';
import { historyDirection, primaryCommand, shortcutLabel } from './shortcuts.js';
import { icon } from './art.js';
import { canPickFolder, folderError, folderLabel, isFolderPath, openFolder, pickFolder } from './folder-links.js';
import { bindingPoint, magnets, roundedCorners } from './board-connectors.js';
import { createShapeLabel, paintShapeLabel } from './shape-label.js';
import { connectorPath, connectorSegments, segmentExtrema, segmentPoint } from './connector-path.js';
import rough from './vendor/roughjs/rough.esm.js';
import {
  handFont,
  sansFont,
  monoFont,
  fontStyle,
  fontStack,
  lineHeightFor,
  loadHandFont,
  textLines
} from './board-fonts.js';
import { freehandPath, pressureSamples } from './freehand.js';
import { alignDrag } from './board-alignment.js';
import { richBlocks, richBlockText, richFrameStyle, richPlain } from './board-rich-text.js';
import { taskMarker, taskStateOf } from './note-lists.js';
import { taskTextContainer } from './task-preview.js';
import { boardShapes as shapes } from './board-summary.js';
export { boardSummary } from './board-summary.js';
import { normalizeTable, tableNameAllocator, uniqueTableName, createWorkbook } from './table-engine.js';
import { makeTableUI } from './table-view.js';
import {
  createChartView,
  updateChartView,
  paintTablePreview,
  paintChartPreview
} from './table-charts.js';
import {
  chartFields,
  deleteTableAxes,
  isSheetObject,
  insertTableCells,
  workbookCache,
  renamedTable,
  withoutObjects,
  copiedSheetObjects,
  restoreCutFormulas
} from './board-tables.js';

const kinds = new Set([
  'rect',
  'ellipse',
  'diamond',
  'arrow',
  'line',
  'pen',
  'text',
  'image',
  'table',
  'chart'
]);
const strokeStyles = new Set(['solid', 'dashed', 'dotted']);
const fillStyles = new Set(['solid', 'hachure', 'cross-hatch']);
const textAlignments = new Set(['left', 'center', 'right']);
const richTextWidth = 360, richTextHeight = 160;
const generator = rough.generator();
const uid = () => crypto.randomUUID();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const validColor = (c) => /^#[0-9a-f]{6}$/i.test(c);
const safeImage = (src) =>
  typeof src === 'string' && /^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,/i.test(src);
const pointOK = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const isConnector = (e) => e.type === 'line' || e.type === 'arrow';
// Inner groups come first, so removing an outer group preserves its subgroups.
function groupPath(e) {
  return e.groupIds || (e.groupId ? [e.groupId] : []);
}
function setGroupPath(e, path) {
  const next = { ...e };
  delete next.groupId;
  if (path.length) next.groupIds = path;
  else delete next.groupIds;
  return next;
}
function pruneSingletonGroups(items) {
  const counts = new Map();
  for (const item of items) for (const id of groupPath(item)) counts.set(id, (counts.get(id) || 0) + 1);
  return items.map((item) => {
    const path = groupPath(item);
    return path.some((id) => counts.get(id) === 1)
      ? setGroupPath(
          item,
          path.filter((id) => counts.get(id) > 1)
        )
      : item;
  });
}
const plainDoc = (elements, background) => {
  const doc = { version: elements.some(isSheetObject) ? 2 : 1, elements };
  if (validColor(background)) doc.background = background;
  return doc;
};
export const emptyBoard = () => plainDoc([]);

function seedFromId(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash & 0x7fffffff || 1;
}

function boxFromPoints(points) {
  let l = Infinity,
    t = Infinity,
    r = -Infinity,
    b = -Infinity;
  for (const [x, y] of points) {
    l = Math.min(l, x);
    t = Math.min(t, y);
    r = Math.max(r, x);
    b = Math.max(b, y);
  }
  return points.length
    ? { x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, b - t) }
    : { x: 0, y: 0, w: 1, h: 1 };
}
function pointsInBox(points) {
  const box = boxFromPoints(points);
  return { ...box, points: points.map(([x, y]) => [(x - box.x) / box.w, (y - box.y) / box.h]) };
}
function legacyElements(strokes) {
  return strokes.flatMap((s) => {
    const pts = (s?.points || []).filter(pointOK);
    if (!pts.length) return [];
    const type = kinds.has(s.tool) ? s.tool : 'pen';
    return [
      {
        id: uid(),
        type,
        ...pointsInBox(type === 'pen' ? pts : [pts[0], pts.at(-1)]),
        stroke: s.color,
        lineWidth: s.width
      }
    ];
  });
}
export function normalizeBoard(input) {
  const source = input?.board ?? input;
  const entries = Array.isArray(source?.elements)
    ? source.elements
    : legacyElements(source?.strokes || []);
  const seen = new Set();
  let allocateName;
  return plainDoc(
    entries.flatMap((raw) => {
      if (!raw || !kinds.has(raw.type)) return [];
      const id = typeof raw.id === 'string' && raw.id && !seen.has(raw.id) ? raw.id : uid();
      seen.add(id);
      const e = {
        id,
        type: raw.type,
        x: num(raw.x),
        y: num(raw.y),
        w: Math.max(1, num(raw.w, 100)),
        h: Math.max(1, num(raw.h, 64)),
        angle: num(raw.angle),
        stroke: validColor(raw.stroke) ? raw.stroke : '#d4d4d4',
        fill: validColor(raw.fill) ? raw.fill : 'none',
        lineWidth: clamp(num(raw.lineWidth, 2), 0.4, 40)
      };
      if (raw.fixedStroke === true && e.stroke === '#d4d4d4') e.fixedStroke = true;
      if (shapes.has(e.type) || isConnector(e) || e.type === 'pen') {
        e.seed =
          Number.isInteger(raw.seed) && raw.seed > 0 && raw.seed <= 0x7fffffff
            ? raw.seed
            : seedFromId(id);
        e.roughness = clamp(num(raw.roughness), 0, 3);
        e.strokeStyle = strokeStyles.has(raw.strokeStyle) ? raw.strokeStyle : 'solid';
        e.fillStyle = fillStyles.has(raw.fillStyle) ? raw.fillStyle : 'solid';
      }
      if (e.type === 'rect' || e.type === 'diamond') e.rounded = raw.rounded === true;
      const path = Array.isArray(raw.groupIds) ? raw.groupIds : [raw.groupId];
      const groups = [...new Set(path.filter((id) => typeof id === 'string' && id))];
      if (groups.length) e.groupIds = groups;
      if (raw.locked === true) e.locked = true;
      if (shapes.has(e.type) && typeof raw.label === 'string' && raw.label) {
        e.label = raw.label;
        if (Number.isFinite(raw.fontSize)) e.fontSize = clamp(raw.fontSize, 8, 180);
        if (Number.isInteger(raw.fontFamily) && raw.fontFamily > 0) e.fontFamily = raw.fontFamily;
        if (validColor(raw.labelColor)) e.labelColor = raw.labelColor;
      }
      if (e.type === 'table') {
        allocateName ??= tableNameAllocator();
        Object.assign(e, normalizeTable(raw));
        e.name = allocateName(e.name);
      }
      if (e.type === 'chart') Object.assign(e, chartFields(raw));
      if (e.type === 'text') {
        e.text = String(raw.text ?? '');
        if (isFolderPath(raw.folderPath)) {
          e.folderPath = raw.folderPath;
          e.text = folderLabel(raw.folderPath);
        } else if (Array.isArray(raw.body)) {
          e.body = richBlocks(raw.body);
          e.text = richPlain(e.body);
          Object.assign(e, richFrameStyle(raw));
        }
        e.fontSize = clamp(num(raw.fontSize, 22), 8, 180);
        e.autoResize = !e.body && raw.autoResize === true;
        // Videron 0.3 stored its sans-serif text without a family.
        e.fontFamily =
          Number.isInteger(raw.fontFamily) && raw.fontFamily > 0 ? raw.fontFamily : sansFont;
        e.lineHeight = lineHeightFor({ ...e, lineHeight: raw.lineHeight });
        e.textAlign = textAlignments.has(raw.textAlign) ? raw.textAlign : 'left';
      }
      if (e.type === 'image') {
        if (!safeImage(raw.src)) return [];
        e.src = raw.src;
        e.alt = String(raw.alt ?? '');
      }
      if (e.type === 'pen' || isConnector(e)) {
        e.points = Array.isArray(raw.points) ? raw.points.filter(pointOK).map((p) => p.slice()) : [];
        if (!e.points.length)
          e.points = [
            [0, 0],
            [1, 1]
          ];
        if (isConnector(e) && e.points.length === 1) e.points.push([...e.points[0]]);
        if (isConnector(e) && Array.isArray(raw.smoothPoints) && Array.isArray(raw.points)) {
          const requested = new Set(raw.smoothPoints);
          const indices = [];
          let valid = 0;
          raw.points.forEach((p, i) => {
            if (!pointOK(p)) return;
            if (valid > 0 && valid < e.points.length - 1 && requested.has(i)) indices.push(valid);
            valid++;
          });
          if (indices.length) e.smoothPoints = indices;
        }
        if (e.type === 'pen' && raw.strokeProfile === 'freehand') {
          e.strokeProfile = 'freehand';
          const pressures = pressureSamples(raw.pressures, e.points.length);
          if (pressures) e.pressures = pressures;
        }
      }
      if (isConnector(e))
        for (const key of ['startBinding', 'endBinding']) {
          const b = raw[key];
          if (b && typeof b.id === 'string' && Number.isFinite(b.u) && Number.isFinite(b.v)) {
            e[key] = { id: b.id, u: b.u, v: b.v };
            if (Number.isInteger(b.site) && b.site >= 0 && b.site < 8) e[key].site = b.site;
          }
        }
      return [e];
    }),
    source?.background
  );
}
function rotate(x, y, degrees) {
  const rad = (degrees * Math.PI) / 180,
    c = Math.cos(rad),
    s = Math.sin(rad);
  return { x: x * c - y * s, y: x * s + y * c };
}
function at(e, u, v) {
  const p = rotate((u - 0.5) * e.w, (v - 0.5) * e.h, e.angle);
  return { x: e.x + e.w / 2 + p.x, y: e.y + e.h / 2 + p.y };
}
function relative(e, p) {
  const q = rotate(p.x - e.x - e.w / 2, p.y - e.y - e.h / 2, -e.angle);
  return { u: q.x / e.w + 0.5, v: q.y / e.h + 0.5 };
}
function extents(items) {
  const points = [];
  for (const e of items) {
    if (isConnector(e) && e.smoothPoints?.length) {
      const knots = e.points.map(([u, v]) => {
        const p = at(e, u, v);
        return [p.x, p.y];
      });
      for (const p of knots) points.push(p);
      for (const segment of connectorSegments(knots, e.smoothPoints)) points.push(...segmentExtrema(segment));
      continue;
    }
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    ]) {
      const p = at(e, u, v);
      points.push([p.x, p.y]);
    }
  }
  return { ...boxFromPoints(points), angle: 0 };
}
function withSmoothPoints(line, indices) {
  const next = { ...line };
  if (indices.length) next.smoothPoints = indices;
  else delete next.smoothPoints;
  return next;
}
function selectionBox(items) {
  return items.length === 1 ? items[0] : extents(items);
}
function boundConnectors(elements) {
  const targets = new Map(elements.map((e) => [e.id, e]));
  return elements.map((e) => {
    if (!isConnector(e) || (!e.startBinding && !e.endBinding)) return e;
    const points = e.points.map(([u, v]) => at(e, u, v));
    const next = { ...e };
    let changed = false;
    for (const [i, key] of ['startBinding', 'endBinding'].entries()) {
      const binding = e[key];
      if (!binding) continue;
      const target = targets.get(binding.id);
      if (!target) {
        delete next[key];
        changed = true;
        continue;
      }
      const site = binding.site == null ? null : magnets(target)[binding.site];
      if (site && (binding.u !== site[0] || binding.v !== site[1])) {
        next[key] = { ...binding, u: site[0], v: site[1] };
        changed = true;
      }
      const p = at(target, next[key].u, next[key].v);
      const index = i ? points.length - 1 : 0;
      if (Math.hypot(p.x - points[index].x, p.y - points[index].y) > 0.001) {
        points[index] = p;
        changed = true;
      }
    }
    return changed ? { ...next, ...pointsInBox(points.map((p) => [p.x, p.y])), angle: 0 } : e;
  });
}
function roundedOutline(corners) {
  let path = '';
  roundedCorners(corners).forEach(({ before, corner, after }, i) => {
    path += (i ? 'L' : 'M') + before.join(' ');
    path += 'Q' + corner.join(' ') + ' ' + after.join(' ');
  });
  return path + 'Z';
}

const lineGeometry = new WeakMap();
function segmentsOf(line) {
  let segments = lineGeometry.get(line);
  if (!segments) {
    const knots = line.points.map(([u, v]) => [u * line.w, v * line.h]);
    segments = connectorSegments(knots, line.smoothPoints);
    lineGeometry.set(line, segments);
  }
  return segments;
}

function pathData(e) {
  const { w, h } = e;
  if (e.rounded && e.type === 'rect')
    return roundedOutline([
      [0, 0],
      [w, 0],
      [w, h],
      [0, h]
    ]);
  if (e.rounded && e.type === 'diamond')
    return roundedOutline([
      [w / 2, 0],
      [w, h / 2],
      [w / 2, h],
      [0, h / 2]
    ]);
  if (e.type === 'rect') return 'M0 0H' + w + 'V' + h + 'H0Z';
  if (e.type === 'ellipse')
    return (
      'M0 ' +
      h / 2 +
      'a' +
      w / 2 +
      ' ' +
      h / 2 +
      ' 0 1 0 ' +
      w +
      ' 0a' +
      w / 2 +
      ' ' +
      h / 2 +
      ' 0 1 0 -' +
      w +
      ' 0Z'
    );
  if (e.type === 'diamond')
    return 'M' + w / 2 + ' 0L' + w + ' ' + h / 2 + ' ' + w / 2 + ' ' + h + ' 0 ' + h / 2 + 'Z';
  if (isConnector(e)) return connectorPath(segmentsOf(e), e.type === 'arrow' ? e.lineWidth : undefined);
  const points = e.points.map(([x, y]) => [x * w, y * h]);
  const pos = (p) => p[0] + ' ' + p[1];
  let path = 'M' + pos(points[0]);
  if (points.length === 1) return path + 'l.01 .01';
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i],
      q = points[i + 1];
    path += 'Q' + pos(p) + ' ' + (p[0] + q[0]) / 2 + ' ' + (p[1] + q[1]) / 2;
  }
  return path + 'L' + pos(points.at(-1));
}

// On a retraced arc the pen passes near the bend instead of landing on the
// exact same pixel twice. Keep the first trace on the edited curve, and keep
// both ends and any intentionally sharp corners in place on the second.
function retracedBend(e) {
  const points = e.points.map(([x, y]) => [x * e.w, y * e.h]);
  const retraced = points.slice();
  for (const index of e.smoothPoints) {
    const [px, py] = points[index - 1], [x, y] = points[index], [nx, ny] = points[index + 1];
    const a = Math.hypot(x - px, y - py), b = Math.hypot(nx - x, ny - y);
    const dx = nx - px, dy = ny - py, length = Math.hypot(dx, dy);
    if (!length) continue;
    const noise = Math.imul(e.seed ^ Math.imul(index, 0x9e3779b1), 0x85ebca6b) >>> 0;
    const width = (1.5 + (noise & 255) / 255) * e.roughness;
    const offset = Math.min(width, a * 0.05, b * 0.05) * (noise & 256 ? 1 : -1) / length;
    retraced[index] = [x - dy * offset, y + dx * offset];
  }
  return connectorPath(connectorSegments(retraced, e.smoothPoints), e.type === 'arrow' ? e.lineWidth : undefined);
}

// Both renderers consume the same seeded geometry, including for hatched fills.
function paintLayers(e, d = pathData(e)) {
  if (e.type === 'pen' && e.strokeProfile === 'freehand' && e.strokeStyle === 'solid') {
    return [{ d: freehandPath(e), fill: e.stroke, stroke: 'none', strokeWidth: 0, dash: [] }];
  }
  const fill = shapes.has(e.type) ? e.fill : 'none';
  const dash =
    e.strokeStyle === 'dashed'
      ? [8, 8 + e.lineWidth]
      : e.strokeStyle === 'dotted'
        ? [1.5, 6 + e.lineWidth]
        : [];
  const outline = { d, stroke: e.stroke, strokeWidth: e.lineWidth, fill, dash };
  if (e.type === 'pen' || (!e.roughness && (fill === 'none' || e.fillStyle === 'solid')))
    return [outline];
  // Both ink passes follow the edited path. Let their independent controls
  // vary the stroke weight while keeping bends, bindings and arrow tips joined.
  const longSide = Math.max(e.w, e.h);
  const shortSide = Math.min(e.w, e.h);
  const detail = longSide < 10 ? 1 / 3 : longSide < 50 || (shortSide < 20 && !isConnector(e)) ? 0.5 : 1;
  const config = {
    seed: e.seed,
    roughness: e.roughness * detail,
    preserveVertices: isConnector(e) || !!e.rounded || e.roughness < 2,
    bowing: 1.35,
    maxRandomnessOffset: 2.7 + Math.min(1.3, e.lineWidth * 0.15),
    curveFitting: 1,
    stroke: e.stroke,
    strokeWidth: e.lineWidth + (dash.length ? 0.5 : 0),
    fill: fill === 'none' ? undefined : fill,
    fillStyle: e.fillStyle,
    fillWeight: Math.max(0.5, e.lineWidth / 2),
    hachureGap: Math.max(3, e.lineWidth * 4, longSide / 600),
    disableMultiStroke: dash.length > 0,
    fixedDecimalPlaceDigits: 2
  };
  if (isConnector(e) && e.smoothPoints?.length && !dash.length) {
    const first = generator.path(d, { ...config, disableMultiStroke: true });
    const second = generator.path(retracedBend(e), {
      ...config, seed: (e.seed ^ 0x5bd1e995) || 1, disableMultiStroke: true, strokeWidth: e.lineWidth * 0.8
    });
    return [first, second].map(drawing => ({ ...generator.toPaths(drawing)[0], dash }));
  }
  let drawing;
  if (e.rounded && (e.type === 'rect' || e.type === 'diamond')) drawing = generator.path(d, config);
  else if (e.type === 'rect') drawing = generator.rectangle(0, 0, e.w, e.h, config);
  else if (e.type === 'ellipse') drawing = generator.ellipse(e.w / 2, e.h / 2, e.w, e.h, config);
  else if (e.type === 'diamond')
    drawing = generator.polygon(
      [
        [e.w / 2, 0],
        [e.w, e.h / 2],
        [e.w / 2, e.h],
        [0, e.h / 2]
      ],
      config
    );
  else drawing = generator.path(d, config);
  return generator.toPaths(drawing).map((layer, i) => {
    if (drawing.sets[i].type === 'path')
      return e.roughness ? { ...layer, dash } : { ...outline, fill: 'none' };
    return { ...layer, dash: [] };
  });
}

const previewJobs = new WeakMap();
function frameNeedsDarkText(item, canvasBackground) {
  return lightPaper(validColor(item.frameBackground) ? item.frameBackground : canvasBackground);
}
export async function renderBoardPreview(canvas, input) {
  const { elements, background } = normalizeBoard(input);
  const task = {};
  previewJobs.set(canvas, task);
  const images = new Map();
  const workbook = elements.some(isSheetObject) ? createWorkbook(elements) : null;
  const fontsReady = elements.some((e) => (e.type === 'text' || e.label) && fontStyle(e.fontFamily || handFont) === handFont)
    ? loadHandFont()
    : undefined;
  await Promise.all(
    elements
      .filter((e) => e.type === 'image')
      .map(async (e) => {
        const img = new Image();
        img.src = e.src;
        try {
          await img.decode();
          images.set(e.id, img);
        } catch {
          /* An unreadable image cannot be drawn. */
        }
      })
  );
  await fontsReady;
  if (previewJobs.get(canvas) !== task) return;
  const ctx = canvas.getContext('2d'),
    w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  if (!elements.length) return;
  const b = extents(elements),
    padding = Math.min(w, h) * 0.07;
  const z = Math.min((w - padding * 2) / b.w, (h - padding * 2) / b.h, 3);
  ctx.save();
  ctx.translate((w - b.w * z) / 2 - b.x * z, (h - b.h * z) / 2 - b.y * z);
  ctx.scale(z, z);
  const paper = boardPaper(background);
  for (const item of elements) {
    const e = boardInk(item, background, paper);
    ctx.save();
    ctx.translate(e.x + e.w / 2, e.y + e.h / 2);
    ctx.rotate((e.angle * Math.PI) / 180);
    ctx.translate(-e.w / 2, -e.h / 2);
    ctx.strokeStyle = e.stroke;
    ctx.fillStyle = e.stroke;
    ctx.lineWidth = e.lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (e.type === 'table') {
      paintTablePreview(ctx, e, workbook, paper);
    } else if (e.type === 'chart') {
      paintChartPreview(ctx, e, workbook, elements, paper);
    } else if (e.type === 'image') {
      const img = images.get(e.id);
      if (img) {
        const pixels = ctx.createPattern(img, 'no-repeat');
        pixels.setTransform(new DOMMatrix().scale(e.w / img.naturalWidth, e.h / img.naturalHeight));
        ctx.beginPath();
        ctx.roundRect(0, 0, e.w, e.h, 6);
        ctx.fillStyle = pixels;
        ctx.shadowColor = 'rgba(0,0,0,.16)';
        ctx.shadowOffsetY = 2 * z;
        ctx.shadowBlur = 3 * z;
        ctx.fill();
      }
    } else if (e.type === 'text') {
      if (e.body) {
        ctx.beginPath();
        ctx.roundRect(0, 0, e.w, e.h, 5);
        if (e.frameBackground !== 'none') {
          ctx.fillStyle = e.frameBackground || paper;
          ctx.fill();
        }
        if (e.frameBorder !== 'none') {
          ctx.lineWidth = 1;
          ctx.strokeStyle = e.frameBorder || (lightPaper(paper) ? '#5659633b' : '#b8bbc33b');
          ctx.stroke();
        }
        ctx.clip();
        ctx.translate(12, 9);
        ctx.fillStyle = frameNeedsDarkText(e, paper) ? '#242424' : '#dedede';
      }
      ctx.font = e.fontSize + 'px ' + fontStack(e.fontFamily);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = e.textAlign;
      const x = e.textAlign === 'center' ? e.w / 2 : e.textAlign === 'right' ? e.w : 0;
      const lineHeight = e.fontSize * lineHeightFor(e);
      const metrics = ctx.measureText('Hg');
      const baseline = (lineHeight + metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
      const width = e.body ? Math.max(1, e.w - 24) : e.w;
      const wrap = text => e.autoResize ? text.split('\n') : textLines(ctx, text, width);
      if (e.body) {
        let y = baseline;
        for (const block of e.body) {
          if (block.type === 'divider') {
            ctx.save();
            ctx.globalAlpha *= .45;
            ctx.fillRect(0, y - baseline + .5 * lineHeight, width, 1);
            ctx.restore();
            y += lineHeight;
            continue;
          }
          const state = taskStateOf(block);
          let prefix = state ? taskMarker(state) + ' ' : '';
          for (const line of wrap(prefix + richBlockText(block))) {
            ctx.fillText(line, x, y);
            if (state === 'done' || state === 'cancelled') {
              const span = ctx.measureText(line).width;
              const skip = prefix ? Math.min(span, ctx.measureText(prefix).width) : 0;
              const left = e.textAlign === 'center' ? x - span / 2 : e.textAlign === 'right' ? x - span : x;
              ctx.fillRect(left + skip, y - e.fontSize * .3, span - skip, Math.max(1, e.fontSize / 16));
            }
            prefix = '';
            y += lineHeight;
          }
        }
      } else {
        wrap(e.text).forEach((line, i) => ctx.fillText(line, x, baseline + i * lineHeight));
      }
    } else {
      for (const layer of paintLayers(e)) {
        const path = new Path2D(layer.d);
        if (layer.fill !== 'none') {
          ctx.fillStyle = layer.fill;
          ctx.fill(path);
        }
        if (layer.stroke !== 'none') {
          ctx.strokeStyle = layer.stroke;
          ctx.lineWidth = layer.strokeWidth;
          ctx.setLineDash(layer.dash);
          ctx.stroke(path);
        }
      }
      if (e.label) paintShapeLabel(ctx, e);
    }
    ctx.restore();
  }
  ctx.restore();
}

const svgNS = 'http://www.w3.org/2000/svg';
const node = (tag, cls) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
};
const extraIcons = {
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11"/>',
  rect: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  diamond: '<path d="m12 2 10 10-10 10L2 12z"/>',
  line: '<path d="m4 20 16-16"/>',
  pen: '<path d="M3 20c3-9 7 5 11-4m-5-2 1-4L18 2l4 4-8 8-5 1z"/>',
  drawingTools: '<path d="m3 14 5-9 5 9z"/><circle cx="16.5" cy="15" r="4.5"/>',
  erase:
    '<path d="m4 12 9-9a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-9 9H9l-5-5a2 2 0 0 1 0-3zm4-4 8 8m-7 4h12"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 4-5 4 5"/>',
  undo: '<path d="M8 5 3 10l5 5m-5-5h11a6 6 0 0 1 0 12"/>',
  redo: '<path d="m16 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>',
  duplicate:
    '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  front: '<rect x="3" y="3" width="12" height="12" rx="2"/><path d="M9 16v4h11V9h-4"/>',
  backLayer: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M8 15H3V3h12v5"/>',
  group:
    '<rect x="2" y="2" width="20" height="20" rx="3" stroke-dasharray="2 3"/><rect x="6" y="6" width="6" height="6"/><path d="M11 14v4h7v-7h-4"/>',
  rotate: '<path d="M20 10a8 8 0 1 0-2 8m2-14v6h-6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  unlock:
    '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.6-1.7M12 15v2"/>',
  move: '<path d="M12 2v20M2 12h20M9 5l3-3 3 3m4 4 3 3-3 3M5 9l-3 3 3 3m4 4 3 3 3-3"/>',
  styles:
    '<circle cx="12" cy="12" r="8"/><path d="M12 4v16a8 8 0 0 1 0-16" fill="currentColor" stroke="none"/>'
};
function pict(key) {
  return extraIcons[key]
    ? '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + extraIcons[key] + '</svg>'
    : icon(key);
}

const maxHistory = 70;
const copyPrefix = 'Videron canvas objects\n';
function copyObjects(items, offset, existing, restoreIds = false) {
  const ids = new Map(items.map((e) => [e.id, restoreIds ? e.id : uid()])),
    groups = new Map();
  const copies = pruneSingletonGroups(items).map((e) => {
    const path = groupPath(e).map((id) => {
      if (!groups.has(id)) groups.set(id, uid());
      return groups.get(id);
    });
    const next = setGroupPath({ ...e, id: ids.get(e.id), x: e.x + offset.x, y: e.y + offset.y }, path);
    for (const key of ['startBinding', 'endBinding']) {
      if (e[key] && ids.has(e[key].id)) next[key] = { ...e[key], id: ids.get(e[key].id) };
      else delete next[key];
    }
    return next;
  });
  return copiedSheetObjects(copies, items, existing, ids);
}

export function mountBoard(container, options = {}) {
  let { elements, background } = normalizeBoard(options.document);
  let defaultFrameStyle = richFrameStyle(options.textAreaDefaults?.style || {});
  const inline = options.inline === true;
  let active = !inline;
  let checkpoint = false;
  let manualCamera = false;
  let closeFileMenu;
  let folderPicker;
  const currentWorkbook = options.workbook || workbookCache();
  function tableScope() {
    return options.peerTables ? [...elements, ...options.peerTables()] : elements;
  }
  const tableUI = makeTableUI({
    getTable: (id) => elements.find((e) => e.id === id && e.type === 'table'),
    getZoom: () => z,
    onReferenceError: message,
    onSelect(id) {
      if (selection.size === 1 && selection.has(id)) return;
      selection = new Set([id]);
      updateUI();
    },
    onChange(id, patch) {
      const item = elements.find((e) => e.id === id && e.type === 'table');
      if (!item || item.locked) return;
      const next = { ...item, ...patch };
      if (next.cols > item.cols && patch.w === undefined)
        next.w = Math.max(next.w, Math.min(750, item.w + (next.cols - item.cols) * 86));
      if (next.rows > item.rows && patch.h === undefined)
        next.h = Math.max(next.h, Math.min(420, item.h + (next.rows - item.rows) * 26));
      if (item.angle && (patch.w !== undefined || patch.h !== undefined)) {
        // A rotated table grows from its top-left cell in the board's coordinates.
        const before = at(item, 0, 0), after = at(next, 0, 0);
        next.x += before.x - after.x;
        next.y += before.y - after.y;
      }
      commit(elements.map((e) => (e === item ? next : e)));
    },
    onInsert(id, axis, index, count) {
      const next = insertTableCells(elements, id, axis, index, count);
      if (next === elements) return false;
      const previous = elements.find(e => e.type === 'table' && e.id === id);
      const structure = index < previous[axis] ? { kind: 'insert', id, axis, index, count } : undefined;
      commit(next, null, background, structure);
      return true;
    },
    onDeleteAxes(id, axis, indices) {
      const next = deleteTableAxes(elements, id, axis, indices);
      if (next === elements) return false;
      commit(next, null, background, { kind: 'delete', id, axis, indices });
      return true;
    },
    onRename(id, name) {
      if (options.canRenameTable && !options.canRenameTable(id, name)) return false;
      const next = renamedTable(elements, id, name);
      if (next) commit(next);
      return !!next;
    },
    onUndo: (redo) => undo(redo),
    onChart: addChart
  });
  let tool = 'select',
    selection = new Set(),
    gesture = null,
    lastTyping = null;
  let z = 1,
    tx = 0,
    ty = 0,
    hasView = false,
    dead = false,
    spaceDown = false;
  let defaults = {
    stroke: '#d4d4d4',
    fill: 'none',
    lineWidth: 2,
    fontSize: 22,
    fontFamily: handFont,
    rounded: true,
    textAlign: 'left',
    roughness: 1,
    strokeStyle: 'solid',
    fillStyle: 'hachure'
  };
  if (background && lightPaper(background)) defaults.stroke = '#232323';
  const pending = new Set(),
    past = [],
    future = [],
    views = new Map(),
    controller = new AbortController();
  const earlyText = new Set();
  let fontReady = document.fonts.check('20px Excalifont');
  if (!fontReady) {
    const loading = loadHandFont()
      .then(() => {
        fontReady = true;
        if (!dead && earlyText.size) updateTextHeights(elements.filter((e) => earlyText.has(e.id)));
        if (!dead) for (const view of views.values()) if (view.caption && view.last) shapeCaption(view, view.last);
        earlyText.clear();
      })
      .finally(() => pending.delete(loading));
    pending.add(loading);
  }
  const listen = (el, event, fn, extra = {}) =>
    el.addEventListener(event, fn, { ...extra, signal: controller.signal });
  const root = node('div', 'vb'),
    stage = node('div', 'vb-stage'),
    world = node('div', 'vb-world'),
    objects = node('div', 'vb-objects');
  if (inline) {
    root.classList.add('vb-inline');
    root.dataset.active = 'false';
    // Activate before the original pointer event reaches the cell or drawing.
    const engage = () => {
      if (active || dead) return;
      setActive(true);
      options.onActivate?.();
    };
    listen(root, 'pointerdown', engage, { capture: true });
    listen(root, 'focusin', engage, { capture: true });
  }
  const overlay = node('div', 'vb-selection-layer'),
    bounds = node('div', 'vb-bounds'),
    marquee = node('div', 'vb-marquee'),
    hint = node('div', 'vb-hint');
  stage.tabIndex = 0;
  stage.setAttribute('role', 'group');
  stage.setAttribute('aria-label', tr('Холст для рисования', 'Drawing canvas'));
  hint.textContent = tr('Двойной щелчок — добавить текст', 'Double-click to add text');
  bounds.hidden = marquee.hidden = true;
  const guides = [node('div', 'vb-guide vb-guide-x'), node('div', 'vb-guide vb-guide-y')];
  for (const guide of guides) guide.hidden = true;
  overlay.append(...guides, bounds, marquee);
  world.append(objects, overlay);
  stage.append(world, hint);
  const top = node('div', 'vb-dock vb-tools'),
    swatches = node('div', 'vb-dock vb-settings'),
    actions = node('div', 'vb-dock vb-actions'),
    zoom = node('div', 'vb-dock vb-zoom');
  const panel = node('div', 'vb-props'),
    file = node('input'),
    alert = node('div', 'vb-alert');
  alert.setAttribute('role', 'status');
  alert.hidden = panel.hidden = file.hidden = true;
  file.type = 'file';
  file.multiple = true;
  file.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/avif';
  root.append(stage, top, swatches, actions, zoom, panel, file, alert);
  const textRuler = node('span', 'vb-text-measure');
  textRuler.setAttribute('aria-hidden', 'true');
  root.append(textRuler);
  container.append(root);
  let alertTimer = 0;
  function message(value) {
    alert.textContent = value;
    alert.hidden = false;
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => {
      alert.hidden = true;
    }, 4400);
  }
  function button(host, key, label, fn, shortcut = '') {
    const b = node('button', 'vb-button');
    b.type = 'button';
    b.title = label + (shortcut ? ' (' + shortcutLabel(shortcut) + ')' : '');
    b.setAttribute('aria-label', label);
    b.innerHTML = pict(key);
    b.onclick = fn;
    host.append(b);
    return b;
  }
  const toolButtons = new Map();
  let expandedTools = false;
  function toggleDrawingTools() {
    expandedTools = !expandedTools;
    if (!expandedTools) {
      panel.hidden = true;
      if (tool !== 'select' && tool !== 'hand') setTool('select');
    }
    updateUI();
  }
  for (const [name, key, label, shortcut] of [
    ['select', 'pointer', tr('Выбрать', 'Select'), 'V'],
    ['hand', 'hand', tr('Рука', 'Hand'), 'H'],
    ['rect', 'rect', tr('Прямоугольник', 'Rectangle'), 'R'],
    ['diamond', 'diamond', tr('Ромб', 'Diamond'), 'D'],
    ['ellipse', 'circle', tr('Эллипс', 'Ellipse'), 'O'],
    ['arrow', 'arrowUpRight', tr('Стрелка', 'Arrow'), 'A'],
    ['line', 'line', tr('Линия', 'Line'), 'L'],
    ['pen', 'pen', tr('Перо', 'Pen'), 'P'],
    ['text', 'text', tr('Текст', 'Text'), 'T'],
    ['erase', 'erase', tr('Ластик', 'Eraser'), 'E']
  ]) {
    const b = button(top, key, label, () => setTool(name), shortcut);
    b.dataset.tool = name;
    toolButtons.set(name, b);
    if (name === 'hand') top.append(node('span', 'vb-divider'));
  }
  const imageButton = button(top, 'image', tr('Вставить изображение', 'Insert image'), () => file.click());
  button(top, 'table', tr('Добавить таблицу', 'Add table'), () => addTable());
  const toolsToggle = inline && button(top, 'drawingTools', tr('Инструменты рисования', 'Drawing tools'), toggleDrawingTools);
  const compactFit = inline && button(top, 'fit', tr('Показать весь холст', 'Fit canvas'), fit, 'F');
  if (options.onFileMenu) {
    const b = button(top, 'more', tr('Файл', 'File'), () => {
      tableUI.finishEdit();
      finishChain();
      if (closeFileMenu) { closeFileMenu(true); return; }
      closeFileMenu = options.onFileMenu({
        anchor: b, getDocument, getWorkbook: () => currentWorkbook(elements), replaceDocument,
        addFolder: canPickFolder() ? addFolder : null,
        onClose() { closeFileMenu = null; }
      });
    });
    b.setAttribute('aria-expanded', 'false');
  }
  const styleButton = button(swatches, 'styles', tr('Стиль объектов', 'Object style'), () => {
    panel.hidden = !panel.hidden;
    updateUI();
  });
  swatches.append(node('span', 'vb-divider'));
  const undoBtn = button(swatches, 'undo', tr('Отменить', 'Undo'), () => undo(false), 'Ctrl+Z');
  const redoBtn = button(swatches, 'redo', tr('Повторить', 'Redo'), () => undo(true), 'Ctrl+Shift+Z');
  const duplicateBtn = button(actions, 'duplicate', tr('Дублировать', 'Duplicate'), duplicate, 'Ctrl+D');
  const groupBtn = button(
    actions,
    'group',
    tr('Сгруппировать', 'Group'),
    () => groupSelected(isWholeGroup(selected())),
    'Ctrl+G'
  );
  const lockBtn = button(actions, 'lock', tr('Закрепить', 'Lock'), toggleLock, 'Ctrl+Shift+L');
  const backBtn = button(actions, 'backLayer', tr('На задний план', 'Send to back'), () => stack(false));
  const frontBtn = button(actions, 'front', tr('На передний план', 'Bring to front'), () => stack(true));
  const deleteBtn = button(actions, 'trash', tr('Удалить', 'Delete'), removeSelected, 'Del');
  button(zoom, 'minus', tr('Уменьшить', 'Zoom out'), () => zoomAt(z / 1.2));
  const readout = node('button', 'vb-readout');
  readout.type = 'button';
  readout.title = tr('Масштаб 100%', 'Actual size');
  readout.onclick = () => zoomAt(1);
  zoom.append(readout);
  button(zoom, 'plus', tr('Увеличить', 'Zoom in'), () => zoomAt(z * 1.2));
  zoom.append(node('span', 'vb-divider'));
  button(zoom, 'fit', tr('Показать весь холст', 'Fit canvas'), fit, 'F');
  listen(zoom, 'pointerdown', (event) => {
    // Keep the formula caret while bringing a distant reference into view.
    if (document.activeElement?.matches('.vt-editor')) event.preventDefault();
  });
  const objectProperties = node('div'), frameProperties = node('div', 'vb-frame-properties');
  panel.append(objectProperties, frameProperties);
  function property(name, input) {
    const row = node('label', 'vb-property'),
      label = node('span');
    label.textContent = name;
    row.append(label, input);
    objectProperties.append(row);
    return input;
  }
  const stroke = property(tr('Обводка / текст', 'Stroke / text'), node('input'));
  stroke.type = 'color';
  const fill = property(tr('Заливка', 'Fill'), node('input'));
  fill.type = 'color';
  const noFill = node('button', 'vb-no-fill');
  noFill.type = 'button';
  noFill.textContent = tr('Без заливки', 'No fill');
  objectProperties.append(noFill);
  const thickness = property(tr('Толщина', 'Stroke width'), node('input'));
  thickness.type = 'range';
  thickness.min = 1;
  thickness.max = 14;
  const size = property(tr('Размер текста', 'Font size'), node('input'));
  size.type = 'number';
  size.min = 8;
  size.max = 180;
  const choices = [];
  function styleChoices(key, title, options) {
    const row = node('div', 'vb-property'),
      heading = node('span'),
      group = node('div', 'vb-choices');
    heading.textContent = title;
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', title);
    row.append(heading, group);
    objectProperties.append(row);
    for (const [value, label, graphic] of options) {
      const b = node('button', 'vb-choice');
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      if (key === 'fontFamily') {
        b.textContent = 'Aa';
        b.style.fontFamily = fontStack(value);
        b.style.fontSize = '16px';
      } else b.innerHTML = '<svg aria-hidden="true" viewBox="0 0 21 16">' + graphic + '</svg>';
      b.onclick = () => setStyle(key, value);
      group.append(b);
      choices.push({ key, value, b });
    }
  }
  styleChoices('roughness', tr('Контур', 'Outline'), [
    [0, tr('Точный контур', 'Precise outline'), '<path d="m2 12 6-8 5 7 6-8"/>'],
    [1, tr('От руки', 'Hand-drawn outline'), '<path d="M2 12Q4 8 8 4q2 3 5 7 4-5 6-8m-17 9Q5 7 8 5"/>'],
    [
      2,
      tr('Эскизный контур', 'Sketchy outline'),
      '<path d="M1 13Q5 9 8 4q2 2 5 8 2-6 7-9M3 13Q6 5 9 3q1 5 5 8 2-6 4-7"/>'
    ]
  ]);
  styleChoices('rounded', tr('Углы', 'Corners'), [
    [false, tr('Острые углы', 'Sharp corners'), '<path d="M4 13V3h13"/>'],
    [true, tr('Скруглённые углы', 'Rounded corners'), '<path d="M4 13V9q0-6 6-6h7"/>']
  ]);
  styleChoices('strokeStyle', tr('Линия', 'Line'), [
    ['solid', tr('Сплошная линия', 'Solid line'), '<path d="M2 8h17"/>'],
    ['dashed', tr('Штриховая линия', 'Dashed line'), '<path d="M2 8h17" stroke-dasharray="4 3"/>'],
    ['dotted', tr('Точечная линия', 'Dotted line'), '<path d="M2 8h17" stroke-dasharray=".1 4"/>']
  ]);
  styleChoices('fillStyle', tr('Узор заливки', 'Fill pattern'), [
    [
      'solid',
      tr('Сплошная заливка', 'Solid fill'),
      '<rect x="4" y="2" width="13" height="12" fill="currentColor" stroke="none"/>'
    ],
    ['hachure', tr('Штриховка', 'Hatched fill'), '<path d="m4 7 5-5m-5 10 10-10m-6 12 9-9m-4 9 4-4"/>'],
    [
      'cross-hatch',
      tr('Перекрёстная штриховка', 'Crosshatched fill'),
      '<path d="m4 8 6-6m-5 12L17 2m-6 12 6-6M4 8l6 6M5 2l12 12M11 2l6 6"/>'
    ]
  ]);
  styleChoices('fontFamily', tr('Шрифт', 'Font'), [
    [handFont, tr('Рукописный · Excalifont', 'Handwritten · Excalifont')],
    [sansFont, tr('Печатный', 'Sans serif')],
    [monoFont, tr('Моноширинный', 'Monospace')]
  ]);
  styleChoices('textAlign', tr('Текст', 'Text alignment'), [
    ['left', tr('Выровнять по левому краю', 'Align text left'), '<path d="M3 4h15M3 8h9M3 12h13"/>'],
    ['center', tr('Выровнять по центру', 'Center text'), '<path d="M3 4h15M6 8h9M4 12h13"/>'],
    ['right', tr('Выровнять по правому краю', 'Align text right'), '<path d="M3 4h15M9 8h9M5 12h13"/>']
  ]);
  stroke.onchange = () => setStyle('stroke', stroke.value);
  fill.onchange = () => setStyle('fill', fill.value);
  noFill.onclick = () => setStyle('fill', 'none');
  thickness.onchange = () => setStyle('lineWidth', +thickness.value);
  size.onchange = () => setStyle('fontSize', clamp(+size.value || 22, 8, 180));

  function setFrameStyle(patch) {
    const next = elements.map(item => {
      if (!selection.has(item.id) || item.locked || !item.body ||
          Object.keys(patch).every(key => item[key] === patch[key])) return item;
      const changed = {...item, ...patch};
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete changed[key];
      return changed;
    });
    if (next.some((item, index) => item !== elements[index])) commit(next);
  }
  function frameColor(key, title, colorLabel, autoLabel, noneLabel) {
    const row = node('div', 'vb-property'), name = node('span'), group = node('div', 'vb-frame-colors');
    name.textContent = title;
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', title);
    const color = node('input');
    color.type = 'color';
    color.setAttribute('aria-label', colorLabel);
    color.title = colorLabel;
    color.onchange = () => setFrameStyle({[key]:color.value});
    const auto = node('button'), none = node('button');
    auto.type = none.type = 'button';
    auto.title = autoLabel; auto.setAttribute('aria-label', autoLabel);
    auto.textContent = tr('Авто', 'Auto');
    none.title = noneLabel; none.setAttribute('aria-label', noneLabel);
    none.textContent = tr('Нет', 'None');
    auto.onclick = () => setFrameStyle({[key]:undefined});
    none.onclick = () => setFrameStyle({[key]:'none'});
    group.append(color, auto, none);
    row.append(name, group); frameProperties.append(row);
    return (items, locked) => {
      const last = items.at(-1)[key];
      const paper = boardPaper(background);
      color.value = validColor(last) ? last : key === 'frameBackground' ? paper : lightPaper(paper) ? '#888888' : '#515151';
      for (const control of [color, auto, none]) control.disabled = locked;
      auto.setAttribute('aria-pressed', String(items.every(item => item[key] === undefined)));
      none.setAttribute('aria-pressed', String(items.every(item => item[key] === 'none')));
    };
  }
  const syncFrameBackground = frameColor('frameBackground', tr('Фон', 'Background'), tr('Цвет фона', 'Background color'),
    tr('Фон холста', 'Canvas background'), tr('Без фона', 'No background'));
  const syncFrameBorder = frameColor('frameBorder', tr('Рамка', 'Border'), tr('Цвет рамки', 'Border color'),
    tr('Автоматический цвет рамки', 'Automatic border color'), tr('Без рамки', 'No border'));
  const textOnly = node('button', 'vb-frame-text-only');
  textOnly.type = 'button';
  textOnly.textContent = tr('Только текст', 'Text only');
  textOnly.onclick = () => setFrameStyle({frameBackground:'none', frameBorder:'none'});
  const saveFrameDefault = node('button', 'vb-frame-default');
  saveFrameDefault.type = 'button';
  saveFrameDefault.title = tr('Фон и рамка новых текстовых областей во всех холстах проекта', 'Background and border for new text areas on every canvas in this project');
  saveFrameDefault.onclick = () => {
    const item = elements.find(item => selection.has(item.id));
    if (!item?.body || selection.size !== 1) return;
    defaultFrameStyle = richFrameStyle(item);
    options.textAreaDefaults.save(defaultFrameStyle);
    updateUI();
    message(tr('Вид сохранён для новых текстовых областей', 'Appearance saved for new text areas'));
  };
  frameProperties.append(textOnly, saveFrameDefault);

  function selected() {
    return elements.filter((e) => selection.has(e.id));
  }
  function setTool(next, focus = true) {
    tableUI.clearSelection();
    finishGesture();
    finishChain();
    markSnap(null);
    hoverVertex.hidden = true;
    tool = next;
    if (inline && next !== 'select' && next !== 'hand') expandedTools = true;
    if (next !== 'select') selection.clear();
    if (focus) stage.focus({ preventScroll: true });
    updateUI();
  }
  function groupIds(e) {
    const outer = groupPath(e).at(-1);
    return outer ? elements.filter((a) => groupPath(a).at(-1) === outer).map((a) => a.id) : [e.id];
  }
  function isWholeGroup(items) {
    const outer = items.length && groupPath(items[0]).at(-1);
    return (
      !!outer &&
      items.every((e) => groupPath(e).at(-1) === outer) &&
      elements.every((e) => groupPath(e).at(-1) !== outer || selection.has(e.id))
    );
  }
  function containsPartialGroup(items) {
    const outerIds = new Set(items.map((e) => groupPath(e).at(-1)).filter(Boolean));
    return elements.some((e) => outerIds.has(groupPath(e).at(-1)) && !selection.has(e.id));
  }
  function toggleLock() {
    const items = selected();
    if (!items.length) return;
    const locked = !items.some((e) => e.locked);
    stage.focus({ preventScroll: true });
    commit(elements.map((e) => (selection.has(e.id) ? { ...e, locked } : e)));
  }
  function supportsStyle(e, key) {
    if (isSheetObject(e) || e.body) return false;
    if (key === 'fontSize' || key === 'fontFamily') return e.type === 'text' || (shapes.has(e.type) && !!e.label);
    if (key === 'textAlign') return e.type === 'text';
    if (key === 'fill' || key === 'fillStyle') return shapes.has(e.type);
    if (key === 'roughness') return shapes.has(e.type) || isConnector(e);
    if (key === 'rounded') return e.type === 'rect' || e.type === 'diamond' || (isConnector(e) && e.points.length > 2);
    if (key === 'lineWidth' || key === 'strokeStyle') return !['text', 'image'].includes(e.type);
    return e.type !== 'image';
  }
  function setStyle(key, value) {
    function applied(style) {
      if (key === 'rounded' && isConnector(style)) {
        const indices = value ? Array.from({ length: style.points.length - 2 }, (_, i) => i + 1) : [];
        return withSmoothPoints(style, indices);
      }
      const next = { ...style, [key]: value };
      if (key === 'stroke') {
        if (value === '#d4d4d4') next.fixedStroke = true;
        else delete next.fixedStroke;
      }
      if (key === 'fontFamily') next.lineHeight = lineHeightFor({ fontFamily: value });
      if (key === 'fillStyle' && style.fill === 'none') next.fill = fill.value;
      return next;
    }
    defaults = applied(defaults);
    const apply = (e) => selection.has(e.id) && !e.locked && supportsStyle(e, key);
    if (elements.some(apply)) {
      commit(elements.map((e) => (apply(e) ? applied(e) : e)));
      if (key === 'fontSize' || key === 'fontFamily') updateTextHeights();
    }
    updateUI();
  }
  function state() {
    return { elements, background, selection: [...selection] };
  }
  function remember(s) {
    if (options.onUndo) {
      checkpoint = true;
      return;
    }
    past.push(s);
    if (past.length > maxHistory) past.shift();
    future.length = 0;
  }
  function emit(structure) {
    if (dead) return;
    const record = checkpoint || !options.onUndo;
    checkpoint = false;
    options.onChange?.(getDocument(), { checkpoint: record, structure });
  }
  function commit(next, ids = null, newBackground = background, structure) {
    if (next === elements) return;
    remember(state());
    lastTyping = null;
    if (ids) selection = new Set(ids);
    if (newBackground !== background) {
      defaults.stroke = newBackground && lightPaper(newBackground) ? '#232323' : '#d4d4d4';
      delete defaults.fixedStroke;
    }
    background = newBackground;
    elements = boundConnectors(next);
    draw();
    emit(structure);
  }
  function replaceDocument(input) {
    tableUI.clearSelection();
    finishGesture();
    finishChain(true);
    const next = normalizeBoard(input);
    commit(next.elements, [], next.background || null);
    fit();
  }
  function getDocument() {
    return plainDoc(elements, background);
  }
  function syncDocument(doc) {
    tableUI.finishEdit(true);
    finishGesture(true);
    finishChain(true);
    tableUI.clearSelection();
    const next = normalizeBoard(doc);
    elements = next.elements;
    background = next.background;
    selection = new Set([...selection].filter((id) => elements.some((e) => e.id === id)));
    lastTyping = null;
    checkpoint = false;
    defaults.stroke = background && lightPaper(background) ? '#232323' : '#d4d4d4';
    delete defaults.fixedStroke;
    draw();
  }
  function undo(redo) {
    finishGesture();
    if (chain && !redo) {
      backtrackChain();
      return;
    }
    if (options.onUndo) {
      tableUI.finishEdit();
      options.onUndo(redo);
      return;
    }
    const from = redo ? future : past,
      to = redo ? past : future,
      s = from.pop();
    if (!s) return;
    to.push(state());
    elements = s.elements;
    background = s.background;
    selection = new Set(s.selection);
    lastTyping = null;
    defaults.stroke = background && lightPaper(background) ? '#232323' : '#d4d4d4';
    delete defaults.fixedStroke;
    draw();
    emit();
  }
  function removeSelected() {
    const ids = removableIds(selected());
    if (!ids.size) return;
    // Deletion can detach the active cell/text field or hide the toolbar button.
    // Keep the next shortcut (notably Undo) within the same board.
    stage.focus({preventScroll:true});
    commit(pruneSingletonGroups(withoutObjects(elements, ids)), [...selection].filter(id => !ids.has(id)));
  }
  function removableIds(items) {
    const lockedGroups = new Set(
      items.filter(item => item.locked).map(item => groupPath(item).at(-1)).filter(Boolean)
    );
    return new Set(
      items.filter(item => !item.locked && !lockedGroups.has(groupPath(item).at(-1))).map(item => item.id)
    );
  }
  function duplicate() {
    const items = copyObjects(selected(), { x: 18 / z, y: 18 / z }, tableScope());
    if (items.length)
      commit(
        [...elements, ...items],
        items.map((e) => e.id)
      );
  }
  function groupSelected(ungroup = false) {
    const items = selected();
    if (items.length < 2 || items.some((e) => e.locked) || containsPartialGroup(items)) return;
    if (ungroup) {
      if (items.some((e) => groupPath(e).length)) {
        commit(
          elements.map((e) => (selection.has(e.id) ? setGroupPath(e, groupPath(e).slice(0, -1)) : e))
        );
      }
      return;
    }
    if (isWholeGroup(items)) return;
    const group = uid();
    const grouped = items.map((e) => setGroupPath(e, [...groupPath(e), group]));
    const top = elements.indexOf(items.at(-1));
    commit([
      ...elements.slice(0, top).filter((e) => !selection.has(e.id)),
      ...grouped,
      ...elements.slice(top + 1)
    ]);
  }
  function stack(front) {
    const items = selected(),
      rest = elements.filter((e) => !selection.has(e.id));
    if (items.length && !items.some((e) => e.locked))
      commit(front ? [...rest, ...items] : [...items, ...rest]);
  }
  function create(type, p, extra = {}) {
    const id = uid();
    const e = {
      id,
      type,
      x: p.x,
      y: p.y,
      w: 1,
      h: 1,
      angle: 0,
      stroke: defaults.stroke,
      fill: defaults.fill,
      lineWidth: defaults.lineWidth
    };
    if (defaults.fixedStroke) e.fixedStroke = true;
    if (type === 'text')
      Object.assign(e, {
        textAlign: defaults.textAlign,
        fontFamily: defaults.fontFamily,
        lineHeight: lineHeightFor(defaults)
      });
    else if (type !== 'image' && !isSheetObject(e))
      Object.assign(e, {
        seed: seedFromId(id),
        roughness: type === 'pen' ? 0 : defaults.roughness,
        strokeStyle: defaults.strokeStyle,
        fillStyle: defaults.fillStyle
      });
    if (type === 'rect' || type === 'diamond') e.rounded = defaults.rounded;
    return { ...e, ...extra };
  }
  function stagePoint(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  function worldPoint(p) {
    return { x: (p.x - tx) / z, y: (p.y - ty) / z };
  }
  let hitZoom = 0;
  function camera() {
    world.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
    root.style.setProperty('--vb-inverse', 1 / z);
    stage.style.backgroundSize = 24 * z + 'px ' + 24 * z + 'px';
    stage.style.backgroundPosition = tx + 'px ' + ty + 'px';
    readout.textContent = Math.round(z * 100) + '%';
    if (hitZoom !== z) {
      hitZoom = z;
      for (const v of views.values()) {
        if (v.hit) v.hit.setAttribute('stroke-width', Math.max(14 / z, v.last.lineWidth + 6 / z));
      }
      placeHandles();
    }
  }
  function zoomAt(value, p = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }) {
    manualCamera = true;
    const origin = worldPoint(p);
    z = clamp(value, 0.05, 8);
    tx = p.x - origin.x * z;
    ty = p.y - origin.y * z;
    camera();
  }
  function fit() {
    const w = stage.clientWidth,
      h = stage.clientHeight;
    if (!w || !h) return;
    const b = extents(elements);
    manualCamera = false;
    const padX = inline ? 28 : 80, padY = inline ? 50 : 145;
    z = elements.length ? clamp(Math.min((w - padX) / b.w, (h - padY) / b.h), 0.05, inline ? 1 : 1.3) : 1;
    tx = w / 2 - (b.x + b.w / 2) * z;
    ty = h / 2 - (inline ? 15 : 0) - (b.y + b.h / 2) * z;
    hasView = true;
    camera();
  }
  function layout(el, e) {
    el.style.left = e.x + 'px';
    el.style.top = e.y + 'px';
    el.style.width = e.w + 'px';
    el.style.height = e.h + 'px';
    el.style.transform = 'rotate(' + e.angle + 'deg)';
  }
  let memberOutlines = new Set();
  let activeRichId = null;
  function historyState() {
    return options.historyState?.() || { undo: !!past.length, redo: !!future.length };
  }
  function refreshHistory() {
    const state = historyState();
    undoBtn.disabled = !state.undo;
    redoBtn.disabled = !state.redo;
    views.get(activeRichId)?.rich?.refreshHistory?.();
  }
  function updateUI() {
    root.dataset.tool = tool;
    if (inline) {
      const sheetOnly = root.dataset.sheetOnly === 'true';
      const compact = sheetOnly && !expandedTools;
      root.classList.toggle('vb-compact-sheet', compact);
      toolsToggle.hidden = !sheetOnly;
      toolsToggle.setAttribute('aria-expanded', String(expandedTools));
      imageButton.hidden = compact;
      compactFit.hidden = !compact;
      for (const [name, b] of toolButtons) b.hidden = compact && name !== 'select' && name !== 'hand';
    }
    for (const [name, b] of toolButtons) b.setAttribute('aria-pressed', String(name === tool));
    styleButton.setAttribute('aria-expanded', String(!panel.hidden));
    refreshHistory();
    const items = selected();
    const richId = tool === 'select' && items.length === 1 && items[0].body && !items[0].locked ? items[0].id : null;
    if (richId !== activeRichId) views.get(activeRichId)?.wrap.classList.remove('is-rich-active');
    if (richId) views.get(richId)?.wrap.classList.add('is-rich-active');
    activeRichId = richId;
    actions.hidden = !items.length;
    duplicateBtn.disabled = !items.length;
    const locked = items.some((e) => e.locked);
    groupBtn.disabled = items.length < 2 || locked || containsPartialGroup(items);
    const grouped = isWholeGroup(items);
    const outlines = items.length > 1 && !grouped ? selection : new Set();
    for (const id of memberOutlines)
      if (!outlines.has(id)) views.get(id)?.wrap.classList.remove('vb-member-outline');
    for (const id of outlines)
      if (!memberOutlines.has(id)) views.get(id)?.wrap.classList.add('vb-member-outline');
    memberOutlines = new Set(outlines);
    const groupLabel = grouped ? tr('Разгруппировать', 'Ungroup') : tr('Сгруппировать', 'Group');
    groupBtn.title = groupLabel + shortcutLabel(grouped ? ' (Ctrl+Shift+G)' : ' (Ctrl+G)');
    groupBtn.setAttribute('aria-label', groupLabel);
    const lockLabel = locked ? tr('Открепить', 'Unlock') : tr('Закрепить', 'Lock');
    lockBtn.title = lockLabel + shortcutLabel(' (Ctrl+Shift+L)');
    lockBtn.setAttribute('aria-label', lockLabel);
    if (lockBtn.dataset.locked !== String(locked)) {
      lockBtn.dataset.locked = String(locked);
      lockBtn.innerHTML = pict(locked ? 'unlock' : 'lock');
    }
    for (const btn of [frontBtn, backBtn]) btn.disabled = locked;
    deleteBtn.disabled = locked && !removableIds(items).size;
    for (const input of [stroke, thickness, fill, noFill, size]) input.disabled = locked;
    const editingFrames = items.length > 0 && items.every(item => item.body);
    objectProperties.hidden = editingFrames;
    frameProperties.hidden = !editingFrames;
    if (editingFrames) {
      syncFrameBackground(items, locked);
      syncFrameBorder(items, locked);
      textOnly.disabled = locked || items.every(item => item.frameBorder === 'none' && item.frameBackground === 'none');
      saveFrameDefault.hidden = !options.textAreaDefaults?.save || items.length !== 1;
      const selected = items[0];
      saveFrameDefault.disabled = selected.frameBorder === defaultFrameStyle.frameBorder &&
        selected.frameBackground === defaultFrameStyle.frameBackground;
      saveFrameDefault.textContent = saveFrameDefault.disabled
        ? tr('Вид по умолчанию', 'Default appearance')
        : tr('Сохранить по умолчанию', 'Save as default');
    }
    bounds.classList.toggle('vb-locked', locked);
    bounds.classList.toggle('vb-single-text', items.length === 1 && items[0].type === 'text');
    const style = items.at(-1) || defaults;
    stroke.value = boardInk(style, background).stroke;
    fill.value = style.fill === 'none' ? '#686868' : style.fill;
    noFill.setAttribute('aria-pressed', String(style.fill === 'none'));
    thickness.value = String(style.lineWidth);
    size.value = String(style.fontSize || defaults.fontSize);
    for (const { key, value, b } of choices) {
      const applicable = items.filter((e) => supportsStyle(e, key));
      b.disabled = locked || (!!items.length && !applicable.length);
      b.setAttribute(
        'aria-pressed',
        String(
          (applicable.length ? applicable : [defaults]).every(
            (e) => {
              if (key === 'rounded' && isConnector(e)) {
                const count = e.smoothPoints?.length || 0;
                return value ? count === e.points.length - 2 : count === 0;
              }
              return (key === 'fontFamily' ? fontStyle(e[key]) : e[key]) === value;
            }
          )
        )
      );
    }
    bounds.hidden = !items.length;
    if (items.length) layout(bounds, gesture?.liveBox || selectionBox(items));
    placeHandles();
    hint.hidden = !!elements.length || !!gesture || !!chain;
  }
  function updateTextHeights(items = selected()) {
    const delta = new Map();
    for (const e of items) {
      if (e.type !== 'text' || e.locked || e.body) continue;
      const field = views.get(e.id)?.content;
      if (!field) continue;
      const size = textBounds(field, e);
      if (size.w !== e.w || size.h !== e.h) delta.set(e.id, size);
    }
    if (delta.size) {
      elements = boundConnectors(
        elements.map((e) => (delta.has(e.id) ? { ...e, ...delta.get(e.id) } : e))
      );
      draw();
      emit();
    }
  }
  function naturalTextWidth(text, style) {
    textRuler.style.font = style.fontSize + 'px ' + fontStack(style.fontFamily);
    textRuler.textContent = text || tr('Текст', 'Text');
    return Math.max(8, textRuler.offsetWidth + 2);
  }
  function textBounds(field, item) {
    if (!fontReady && fontStyle(item.fontFamily) === handFont) earlyText.add(item.id);
    const line = item.fontSize * lineHeightFor(item);
    let w = item.w,
      h;
    if (item.folderPath) {
      if (item.autoResize) w = folderWidth(item);
      h = Math.ceil(line);
    } else if (item.autoResize) {
      w = naturalTextWidth(field.value, item);
      h = Math.ceil(line * field.value.split('\n').length);
    } else {
      const old = field.style.height;
      field.style.height = '1px';
      h = Math.max(Math.ceil(line), field.scrollHeight);
      field.style.height = old;
    }
    const u = item.textAlign === 'center' ? 0.5 : item.textAlign === 'right' ? 1 : 0;
    const anchor = at(item, u, 0);
    const offset = rotate((u - 0.5) * w, -h / 2, item.angle);
    return { x: anchor.x - offset.x - w / 2, y: anchor.y - offset.y - h / 2, w, h };
  }
  function onTextInput(id, field, inputType) {
    const i = elements.findIndex((e) => e.id === id);
    if (i < 0) return;
    const e = elements[i],
      now = performance.now();
    if (e.locked) return;
    if (lastTyping?.id !== id || lastTyping.inputType !== inputType || now - lastTyping.time > 900) remember(state());
    future.length = 0;
    lastTyping = { id, time: now, inputType };
    selection = new Set([id]);
    elements = boundConnectors(
      elements.map((n) => (n === e ? { ...e, text: field.value, ...textBounds(field, e) } : n))
    );
    draw();
    emit();
  }
  function changeShapeLabel(id, text, inputType) {
    const item = elements.find(el => el.id === id);
    if (!item || item.locked || (item.label || '') === text) return;
    const now = performance.now();
    if (lastTyping?.id !== id || lastTyping.inputType !== inputType || now - lastTyping.time > 900) remember(state());
    future.length = 0;
    lastTyping = {id, inputType, time:now};
    const next = {...item};
    if (text) next.label = text; else delete next.label;
    elements = elements.map(el => el === item ? next : el);
    draw(); emit();
  }
  function shapeCaption(view, item) {
    if (!view.caption) {
      view.caption = createShapeLabel(view.wrap,
        (text, inputType) => changeShapeLabel(item.id, text, inputType),
        () => { lastTyping = null; },
        event => {
          event.stopPropagation();
          if (event.isComposing || event.keyCode === 229) return;
          const direction = historyDirection(event);
          if (event.key === 'Escape' || (primaryCommand(event) && !event.shiftKey && event.key === 'Enter')) {
            event.preventDefault(); stage.focus({preventScroll:true});
          } else if (direction) {
            event.preventDefault(); undo(direction === 'redo');
          }
        });
    }
    view.caption.update(boardInk(item, background));
    return view.caption;
  }
  function makeView(e) {
    const wrap = node('div', 'vb-object');
    wrap.dataset.id = e.id;
    wrap.dataset.kind = e.type;
    let content, hit;
    if (e.type === 'table') content = tableUI.makeView(e);
    else if (e.type === 'chart')
      content = createChartView((id, chartType) => {
        const source = elements.find((item) => item.id === id);
        if (source && !source.locked && source.chartType !== chartType)
          commit(
            elements.map((item) => (item === source ? { ...item, chartType } : item)),
            [id]
          );
      });
    else if (e.folderPath) {
      content = node('button', 'vb-folder');
      content.type = 'button';
      content.innerHTML = icon('folder');
      content.append(node('span'));
      // Pointer releases are handled by the stage so a drag never opens the folder.
      content.onclick = event => {
        if (event.detail === 0 && tool === 'select') {
          const item = elements.find(item => item.id === e.id);
          if (item?.folderPath) visitFolder(item.folderPath);
        }
      };
    } else if (e.body) {
      wrap.classList.add('vb-rich-frame');
      content = node('div', 'vb-rich-item');
      content.addEventListener('focusin', () => {
        const item = elements.find(el => el.id === e.id);
        if (item && !item.locked && (selection.size !== 1 || !selection.has(e.id))) {
          selection = new Set([e.id]);
          updateUI();
        }
      });
    } else if (e.type === 'text') {
      content = node('textarea', 'vb-text');
      content.rows = 1;
      content.spellcheck = true;
      content.placeholder = tr('Текст', 'Text');
      content.setAttribute('aria-label', tr('Текст на холсте', 'Canvas text'));
      content.title = tr('Esc — выделить надпись целиком', 'Esc to select the whole text object');
      content.oninput = event => onTextInput(e.id, content, event.inputType);
      content.onfocus = () => {
        const item = elements.find((n) => n.id === e.id);
        if (!item || item.locked || selection.has(item.id)) return;
        selection = new Set([item.id]);
        updateUI();
      };
      content.onblur = () => {
        lastTyping = null;
      };
    } else if (e.type === 'image') {
      content = node('img', 'vb-image');
      content.draggable = false;
    } else {
      content = document.createElementNS(svgNS, 'svg');
      content.setAttribute('aria-hidden', 'true');
      hit = document.createElementNS(svgNS, 'path');
      hit.classList.add('vb-hit');
      const ink = document.createElementNS(svgNS, 'g');
      ink.classList.add('vb-ink');
      content.append(hit, ink);
    }
    wrap.append(content);
    return { wrap, content, hit, last: null };
  }
  // An editor, its selection handles and bound connectors all share this geometry.
  // Growing is part of the edit which caused it, including a later image decode.
  function fitRichHeights(ids, anchorY = 0) {
    const changes = new Map();
    for (const id of ids) {
      const view = views.get(id);
      const extra = view?.rich?.overflowHeight?.();
      if (extra > 0) changes.set(id, extra);
    }
    if (!changes.size) return false;
    elements = boundConnectors(elements.map(item => {
      if (!changes.has(item.id)) return item;
      const next = { ...item, h: item.h + changes.get(item.id) };
      const before = at(item, 0, anchorY), after = at(next, 0, anchorY);
      next.x += before.x - after.x;
      next.y += before.y - after.y;
      return next;
    }));
    return true;
  }
  const pendingRichLayout = new Set();
  function bringRichPointIntoView(caret, gap = 24) {
    if (!caret) return;
    const screen = stage.getBoundingClientRect();
    const dx = Math.max(0, screen.left + gap - caret.left) - Math.max(0, caret.right - screen.right + gap);
    const dy = Math.max(0, screen.top + gap - caret.top) - Math.max(0, caret.bottom - screen.bottom + gap);
    if (dx || dy) { tx += dx; ty += dy; camera(); }
  }
  function revealRichCaret(view) {
    bringRichPointIntoView(view?.rich?.caretBounds?.());
  }
  let richLayoutFrame = 0;
  function scheduleRichLayout() {
    if (dead || gesture || richLayoutFrame || !pendingRichLayout.size) return;
    richLayoutFrame = requestAnimationFrame(() => {
      richLayoutFrame = 0;
      if (dead || gesture) return;
      const grew = fitRichHeights(pendingRichLayout);
      pendingRichLayout.clear();
      if (grew) { draw(); revealRichCaret(views.get(activeRichId)); emit(); }
    });
  }
  function updateRichView(view, item) {
    view.content.inert = !!item.locked;
    if (!options.mountRichText) {
      if (view.richBody === item.body) return;
      view.richBody = item.body;
      const fragment = document.createDocumentFragment();
      for (const block of item.body) {
        if (fragment.hasChildNodes()) fragment.append('\n');
        if (block.type === 'divider') fragment.append(document.createElement('hr'));
        else taskTextContainer(fragment, taskStateOf(block)).append(richBlockText(block));
      }
      view.content.replaceChildren(fragment);
      return;
    }
    if (!view.rich) {
      view.richBody = item.body;
      view.rich = options.mountRichText(view.content, {
        body: item.body, text: item.text, locked: !!item.locked, historyState,
        onOverflow() {
          pendingRichLayout.add(item.id);
          scheduleRichLayout();
        },
        onCaretMove: () => revealRichCaret(view),
        onSearchPoint: rect => bringRichPointIntoView(rect, Math.min(110, stage.clientHeight / 3, stage.clientWidth / 3)),
        onChange({ body, plain }, record = true) {
          const current = elements.find(el => el.id === item.id);
          if (!current || current.locked || dead || view.richBody === body && current.text === plain) return;
          if (record) remember(state());
          future.length = 0;
          lastTyping = null;
          view.richBody = body;
          elements = elements.map(el => el === current ? { ...el, body, text: plain } : el);
          fitRichHeights([item.id]);
          draw();
          revealRichCaret(view);
          emit();
        },
        onUndo: undo,
        onExit: () => stage.focus({ preventScroll: true }),
        onRemove() {
          selection = new Set([item.id]);
          removeSelected();
        }
      });
    } else if (view.richBody !== item.body || !!view.last?.locked !== !!item.locked) {
      view.richBody = item.body;
      view.rich.update(item.body, item.text, { locked: !!item.locked });
    }
  }
  function updateView(v, item, workbook, paper) {
    if (v.last === item && v.background === paper && (!isSheetObject(item) || v.workbook === workbook)) return;
    const e = boardInk(item, background, paper);
    layout(v.wrap, e);
    v.wrap.classList.toggle('vb-object-locked', !!e.locked);
    if (e.type === 'table' || e.type === 'chart') {
      if (e.type === 'table') tableUI.updateView(v.content, e, workbook);
      else updateChartView(v.content, e, workbook, elements, paper);
      v.workbook = workbook;
    } else if (e.type === 'text') {
      if (e.body) {
        v.wrap.style.backgroundColor = e.frameBackground === 'none' ? 'transparent' : e.frameBackground || '';
        v.wrap.style.borderColor = e.frameBorder === 'none' ? 'transparent' : e.frameBorder || '';
        v.wrap.dataset.light = String(frameNeedsDarkText(e, paper));
        updateRichView(v, e);
      } else if (e.folderPath) {
        v.content.lastElementChild.textContent = e.text;
        v.content.title = e.folderPath;
        v.content.setAttribute('aria-label', tr('Открыть папку ', 'Open folder ') + e.text);
        v.content.style.justifyContent = {left:'flex-start', center:'center', right:'flex-end'}[e.textAlign];
      } else {
        v.content.readOnly = !!e.locked;
        if (v.content.value !== e.text) v.content.value = e.text;
      }
      if (!e.body) {
        v.content.style.color = e.stroke;
        v.content.style.fontSize = e.fontSize + 'px';
        v.content.style.fontFamily = fontStack(e.fontFamily);
        v.content.style.lineHeight = String(lineHeightFor(e));
        v.content.style.textAlign = e.textAlign;
      }
    } else if (e.type === 'image') {
      if (v.content.getAttribute('src') !== e.src) v.content.src = e.src;
      v.content.alt = e.alt;
    } else {
      const geometry = [
        'w',
        'h',
        'points',
        'smoothPoints',
        'pressures',
        'strokeProfile',
        'seed',
        'roughness',
        'rounded',
        'strokeStyle',
        'fillStyle',
        'stroke',
        'fill',
        'lineWidth'
      ];
      if (!v.last || v.displayStroke !== e.stroke || geometry.some((key) => item[key] !== v.last[key])) {
        const ink = v.content.lastChild,
          d = pathData(e);
        v.hit.setAttribute('d', d);
        v.hit.setAttribute('fill', shapes.has(e.type) ? 'transparent' : 'none');
        v.hit.setAttribute('stroke-width', Math.max(14 / z, e.lineWidth + 6 / z));
        const painted = paintLayers(e, d);
        if (isConnector(e)) v.hit.setAttribute('d', painted[0].d);
        const layers = painted.map((layer) => {
          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('d', layer.d);
          path.setAttribute('fill', layer.fill);
          path.setAttribute('stroke', layer.stroke);
          path.setAttribute('stroke-width', layer.strokeWidth);
          if (layer.dash.length) path.setAttribute('stroke-dasharray', layer.dash.join(' '));
          return path;
        });
        ink.replaceChildren(...layers);
      }
    }
    if (shapes.has(e.type) && (e.label || v.caption)) shapeCaption(v, item);
    v.last = item;
    v.background = paper;
    v.displayStroke = e.stroke;
  }
  function refreshWorkbook() {
    const sheets = elements.filter(isSheetObject);
    if (!sheets.length) return;
    const workbook = currentWorkbook(elements);
    const paper = boardPaper(background);
    for (const sheet of sheets) {
      const view = views.get(sheet.id);
      if (view) updateView(view, sheet, workbook, paper);
    }
  }
  function draw() {
    const hadFocus = root.contains(document.activeElement);
    const workbook = elements.some(isSheetObject) ? currentWorkbook(elements) : null;
    if (inline) root.dataset.sheetOnly = String(elements.length > 0 && elements.every(isSheetObject));
    const paper = boardPaper(background), light = lightPaper(paper);
    root.dataset.light = String(light);
    root.style.setProperty('--vb-bg', paper);
    root.style.setProperty('--vb-grid', light ? '#00000026' : '#ffffff17');
    root.style.setProperty('--vb-selection', light ? '#565963' : '#b8bbc3');
    const active = new Set(elements.map((e) => e.id));
    for (const [id, v] of views) {
      if (!active.has(id)) {
        if (v.wrap.dataset.kind === 'table') tableUI.removeView(v.content);
        v.rich?.destroy();
        v.wrap.remove();
        views.delete(id);
      }
    }
    for (let i = 0; i < elements.length; i++) {
      const e = elements[i];
      let v = views.get(e.id);
      if (!v || v.wrap.dataset.kind !== e.type || !!v.last?.folderPath !== !!e.folderPath || !!v.last?.body !== !!e.body) {
        if (v?.wrap.dataset.kind === 'table') tableUI.removeView(v.content);
        v?.rich?.destroy();
        v?.wrap.remove();
        v = makeView(e);
        views.set(e.id, v);
      }
      if (objects.children[i] !== v.wrap) objects.insertBefore(v.wrap, objects.children[i] || null);
      updateView(v, e, workbook, paper);
    }
    updateUI();
    camera();
    if (hadFocus && document.activeElement === document.body) stage.focus({preventScroll:true});
  }
  function placeSheetObject(width, height, source) {
    const left = worldPoint({ x: inline ? 14 : 28, y: inline ? 10 : 76 });
    const right = worldPoint({ x: stage.clientWidth - (inline ? 14 : 28), y: stage.clientHeight - (inline ? 40 : 72) });
    const first = {
      x: left.x + Math.max(0, (right.x - left.x - width) * 0.23),
      y: left.y + Math.max(0, (right.y - left.y - height) * 0.25)
    };
    const boxes = elements.map((e) => extents([e]));
    const anchor = source && extents([source]);
    const gap = 30;
    const candidates = anchor
      ? [
          { x: anchor.x + anchor.w + gap, y: anchor.y },
          { x: anchor.x, y: anchor.y + anchor.h + gap },
          { x: anchor.x - width - gap, y: anchor.y },
          { x: anchor.x, y: anchor.y - height - gap }
        ]
      : [];
    candidates.push(first);
    for (const b of boxes)
      candidates.push({ x: b.x + b.w + gap, y: b.y }, { x: b.x, y: b.y + b.h + gap });
    const fits = (p) =>
      boxes.every(
        (b) =>
          p.x + width + 8 <= b.x ||
          p.x >= b.x + b.w + 8 ||
          p.y + height + 8 <= b.y ||
          p.y >= b.y + b.h + 8
      );
    return (
      candidates.find(
        (p) =>
          p.x >= left.x && p.y >= left.y && p.x + width <= right.x && p.y + height <= right.y && fits(p)
      ) ||
      candidates.find(fits) || { x: Math.max(first.x, ...boxes.map((b) => b.x + b.w + gap)), y: first.y }
    );
  }
  function revealSheet(item, companion) {
    const rect = extents([item]);
    if (
      rect.x * z + tx >= 12 &&
      rect.y * z + ty >= (inline ? 10 : 55) &&
      (rect.x + rect.w) * z + tx <= stage.clientWidth - 12 &&
      (rect.y + rect.h) * z + ty <= stage.clientHeight - (inline ? 40 : 52)
    )
      return;
    const pair = companion ? extents([item, companion]) : rect;
    const available = (b) => Math.min((stage.clientWidth - (inline ? 28 : 44)) / b.w, (stage.clientHeight - (inline ? 50 : 132)) / b.h);
    const frame = available(pair) >= 0.6 ? pair : rect;
    z = clamp(Math.min(z, available(frame)), 0.05, 8);
    tx = stage.clientWidth / 2 - (frame.x + frame.w / 2) * z;
    ty = stage.clientHeight / 2 - (inline ? 15 : 0) - (frame.y + frame.h / 2) * z;
    camera();
  }
  function addTable() {
    const previous =
      selected().find((e) => e.type === 'table') || elements.findLast((e) => e.type === 'table');
    setTool('select');
    const fields = normalizeTable({ name: uniqueTableName(tableScope(), tr('Таблица 1', 'Table 1')) });
    const w = 410,
      h = 225;
    const item = create('table', placeSheetObject(w, h, previous), { ...fields, w, h });
    commit([...elements, item], [item.id]);
    revealSheet(item, previous);
    tableUI.focusCell(item.id, 'A1');
  }
  function addChart(sourceId, range) {
    const origin = elements.find((e) => e.id === sourceId && e.type === 'table');
    if (!origin) return;
    setTool('select');
    const w = 388,
      h = 226;
    const item = create('chart', placeSheetObject(w, h, origin), {
      w,
      h,
      tableId: sourceId,
      range: range.start + ':' + range.end,
      chartType: 'line'
    });
    commit([...elements, item], [item.id]);
    revealSheet(item, origin);
  }
  function addText(p, initial = '', dimensions) {
    if (!inline && options.mountRichText) {
      const body = initial.split(/\r?\n/).map(text => ({ type: 'paragraph', runs: text ? [{ text }] : [] }));
      const item = create('text', p, {
        ...defaultFrameStyle, body, text: richPlain(body), w: dimensions?.w ?? richTextWidth, h: dimensions?.h ?? richTextHeight,
        fontSize: 16, fontFamily: sansFont, autoResize: false, fill: 'none'
      });
      tool = 'select';
      commit([...elements, item], [item.id]);
      revealSheet(item);
      views.get(item.id).rich.focus();
      return;
    }
    const e = create('text', p, {
      autoResize: true,
      w: naturalTextWidth(initial, defaults),
      h: Math.ceil(defaults.fontSize * lineHeightFor(defaults)),
      fontSize: defaults.fontSize,
      text: initial,
      fill: 'none'
    });
    tool = 'select';
    commit([...elements, e], [e.id]);
    const field = views.get(e.id).content;
    field.focus({ preventScroll: true });
    field.setSelectionRange(initial.length, initial.length);
    if (initial) updateTextHeights();
  }

  function folderWidth(item) {
    return naturalTextWidth(item.text, item) + Math.ceil(item.fontSize * 1.4);
  }
  function visitFolder(path) {
    openFolder(path).catch(error => { if (!dead) message(folderError(error)); });
  }
  async function addFolder() {
    if (dead || folderPicker) return;
    const request = pickFolder();
    folderPicker = request;
    try {
      const path = await request;
      if (!path || dead || folderPicker !== request) return;
      const text = folderLabel(path);
      const style = {text, fontFamily:sansFont, fontSize:defaults.fontSize};
      const w = folderWidth(style), h = Math.ceil(style.fontSize * lineHeightFor(style));
      const center = worldPoint({x:stage.clientWidth / 2, y:stage.clientHeight / 2});
      const item = create('text', {x:center.x - w / 2, y:center.y - h / 2}, {
        ...style, w, h, folderPath:path, autoResize:true, lineHeight:lineHeightFor(style)
      });
      setTool('select');
      commit([...elements, item], [item.id]);
      stage.focus({preventScroll:true});
    } catch (error) {
      if (!dead && folderPicker === request) message(folderError(error));
    } finally {
      if (folderPicker === request) folderPicker = null;
    }
  }

  for (const name of ['nw', 'ne', 'sw', 'se', 'w', 'e', 'rotate']) {
    const handle = node('button', 'vb-handle vb-' + name);
    handle.type = 'button';
    handle.tabIndex = -1;
    handle.dataset.handle = name;
    const label = name === 'rotate' ? tr('Повернуть', 'Rotate') : tr('Изменить размер', 'Resize');
    handle.title = label;
    handle.setAttribute('aria-label', label);
    if (name === 'rotate') handle.innerHTML = pict(name);
    bounds.append(handle);
  }
  const vertexHandles = new Map();
  function placeHandles() {
    const items = selected(),
      e = items[0],
      connector = items.length === 1 && isConnector(e);
    bounds.classList.toggle('vb-connector', connector);
    const active = new Set();
    function place(kind, i, u, v) {
      const key = kind + i;
      active.add(key);
      let handle = vertexHandles.get(key);
      if (!handle) {
        handle = node('button', 'vb-handle vb-' + kind);
        handle.type = 'button';
        handle.tabIndex = -1;
        handle.dataset.handle = kind;
        handle.dataset.index = String(i);
        vertexHandles.set(key, handle);
        bounds.append(handle);
      }
      handle.style.left = u * 100 + '%';
      handle.style.top = v * 100 + '%';
      const label =
        kind === 'midpoint'
          ? tr('Потяните, чтобы добавить изгиб', 'Drag to add a bend')
          : i > 0 && i < e.points.length - 1
            ? tr('Переместить точку · Alt + щелчок, чтобы удалить', 'Move point · Alt + click to remove')
            : tr('Переместить конец линии', 'Move endpoint');
      if (handle.title !== label) {
        handle.title = label;
        handle.setAttribute('aria-label', label);
      }
    }
    if (connector && !e.locked && tool === 'select') {
      const segments = segmentsOf(e);
      for (let i = 0; i < e.points.length; i++) {
        const [u, v] = e.points[i];
        place('vertex', i, u, v);
        if (i) {
          const [a, b] = e.points[i - 1];
          if (Math.hypot((u - a) * e.w, (v - b) * e.h) * z >= 38) {
            const [x, y] = segmentPoint(segments[i - 1], 0.5);
            place('midpoint', i, x / e.w, y / e.h);
          }
        }
      }
    }
    for (const [key, handle] of vertexHandles) {
      if (!active.has(key)) {
        handle.remove();
        vertexHandles.delete(key);
      }
    }
  }
  const snapGuide = node('div', 'vb-snap-guide');
  const snapDots = Array.from({ length: 9 }, () => node('i', 'vb-snap-dot'));
  snapDots.at(-1).classList.add('vb-snap-active');
  snapGuide.hidden = true;
  snapGuide.setAttribute('aria-hidden', 'true');
  snapGuide.append(...snapDots);
  overlay.append(snapGuide);
  function markSnap(target) {
    snapGuide.hidden = !target?.binding;
    if (!target?.binding) return;
    const sites = magnets(target.shape);
    for (let i = 0; i < snapDots.length; i++) {
      const p = i < sites.length ? at(target.shape, ...sites[i]) : target.point;
      snapDots[i].style.left = p.x + 'px';
      snapDots[i].style.top = p.y + 'px';
    }
  }
  function bindAt(p, exclude, disabled) {
    if (disabled) return { point: p, binding: null };
    for (let i = elements.length - 1; i >= 0; i--) {
      const shape = elements[i];
      if (
        shape.id === exclude ||
        (!shapes.has(shape.type) && !['text', 'image', 'table', 'chart'].includes(shape.type))
      )
        continue;
      const pos = relative(shape, p);
      const uv = bindingPoint(shape, pos.u, pos.v, z);
      if (uv) {
        const binding = { id: shape.id, u: uv[0], v: uv[1] };
        const site = magnets(shape).indexOf(uv);
        if (site >= 0) binding.site = site;
        return { point: at(shape, ...uv), binding, shape };
      }
    }
    return { point: p, binding: null };
  }
  const clampLine = (a, b) => {
    const angle = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 12)) * (Math.PI / 12),
      len = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len };
  };
  function vertexAt(item, p, e, hit) {
    if (!item || !isConnector(item) || item.locked || e.shiftKey || e.altKey) return null;
    const individual = selection.size === 1 && selection.has(item.id);
    if (
      !individual &&
      (selection.has(item.id) || (groupIds(item).length !== 1 && !e.ctrlKey && !e.metaKey))
    )
      return null;
    let index = null,
      closest = (e.pointerType === 'touch' ? 13 : 8) / z;
    const box = relative(item, p);
    if (
      box.u * item.w < -closest ||
      box.v * item.h < -closest ||
      (box.u - 1) * item.w > closest ||
      (box.v - 1) * item.h > closest
    )
      return null;
    item.points.forEach(([u, v], i) => {
      const q = at(item, u, v),
        distance = Math.hypot(q.x - p.x, q.y - p.y);
      if (distance <= closest) {
        closest = distance;
        index = i;
      }
    });
    if (index !== null) return { line: item, index, position: item.points[index] };
    if (item !== hit) return null;
    const segments = segmentsOf(item);
    for (let i = 0; i < segments.length; i++) {
      const { from, to } = segments[i];
      if (Math.hypot(to[0] - from[0], to[1] - from[1]) * z < 38) continue;
      const [x, y] = segmentPoint(segments[i], 0.5);
      if (Math.hypot(box.u * item.w - x, box.v * item.h - y) <= closest) {
        return { line: item, index: i + 1, position: [x / item.w, y / item.h], insert: true };
      }
    }
    return null;
  }
  const hoverVertex = node('i', 'vb-hover-vertex');
  hoverVertex.hidden = true;
  overlay.append(hoverVertex);
  function findVertex(hit, p, event) {
    for (let i = elements.length - 1; i >= 0; i--) {
      const item = elements[i];
      if (hit && item !== hit && item.startBinding?.id !== hit.id && item.endBinding?.id !== hit.id)
        continue;
      const point = vertexAt(item, p, event, hit);
      if (point) return point;
    }
    return null;
  }
  function repositionPoint(g, p, event) {
    const line = g.line;
    const pts = line.points.map(([u, v]) => at(line, u, v));
    const index = g.index;
    if (g.insert) pts.splice(index, 0, g.start);
    const other = pts[index === 0 ? 1 : index - 1];
    const desired = event.shiftKey ? clampLine(other, p) : p;
    const bindingKey = index === 0 ? 'startBinding' : index === pts.length - 1 ? 'endBinding' : null;
    const target = bindingKey
      ? bindAt(desired, line.id, event.ctrlKey || event.metaKey)
      : { point: desired };
    markSnap(target);
    pts[index] = target.point;
    let next = { ...line, ...pointsInBox(pts.map((q) => [q.x, q.y])), angle: 0 };
    if (g.insert) {
      const indices = (line.smoothPoints || []).map(i => i < index ? i : i + 1);
      indices.push(index);
      next = withSmoothPoints(next, indices.sort((a, b) => a - b));
    }
    if (bindingKey) {
      if (target.binding) next[bindingKey] = target.binding;
      else delete next[bindingKey];
    }
    return g.initial.elements.map((a) => (a.id === line.id ? next : a));
  }
  let chain = null,
    suppressDoubleClickUntil = 0;
  const chainHint = node('div', 'vb-chain-hint');
  chainHint.textContent = tr(
    'Щелчок — точка · Двойной щелчок или Enter — завершить',
    'Click to add a point · Double-click or Enter to finish'
  );
  chainHint.hidden = true;
  root.append(chainHint);
  function chainElement(points) {
    const { base } = chain;
    const line = { ...base, ...pointsInBox(points.map(({ point }) => [point.x, point.y])) };
    if (points[0].binding) line.startBinding = points[0].binding;
    if (points.at(-1).binding) line.endBinding = points.at(-1).binding;
    return line;
  }
  function updateChain(p, event) {
    const last = chain.nodes.at(-1).point;
    const q = event.shiftKey ? clampLine(last, p) : p;
    const target = bindAt(q, chain.base.id, event.ctrlKey || event.metaKey);
    markSnap(target);
    chain.preview = target;
    updateView(chain.ghost, chainElement([...chain.nodes, target]));
    return target;
  }
  function beginChain(g) {
    elements = g.initial.elements;
    const ghost = makeView(g.object);
    ghost.wrap.classList.add('vb-chain-preview');
    overlay.prepend(ghost.wrap);
    chain = { base: g.object, nodes: [g.startAnchor], preview: g.startAnchor, ghost };
    updateView(ghost, chainElement([g.startAnchor, g.startAnchor]));
    chainHint.hidden = false;
    draw();
  }
  function finishChain(cancel = false) {
    if (!chain) return;
    const line = !cancel && chain.nodes.length >= 2 ? chainElement(chain.nodes) : null;
    chain.ghost.wrap.remove();
    chain = null;
    chainHint.hidden = true;
    markSnap(null);
    if (line) {
      tool = 'select';
      commit([...elements, line], [line.id]);
    } else updateUI();
  }
  function backtrackChain() {
    if (chain.nodes.length <= 1) return finishChain(true);
    chain.nodes.pop();
    updateView(chain.ghost, chainElement([...chain.nodes, chain.preview]));
  }
  function placeChainPoint(p, event) {
    const target = updateChain(p, event);
    const last = chain.nodes.at(-1).point;
    if (Math.hypot(last.x - target.point.x, last.y - target.point.y) * z < 4) {
      if (chain.nodes.length > 1) {
        finishChain();
        suppressDoubleClickUntil = performance.now() + 500;
      }
      return;
    }
    chain.nodes.push(target);
    if (target.binding) {
      finishChain();
      suppressDoubleClickUntil = performance.now() + 500;
    }
  }
  const livePointers = new Map();
  let pinch = null;
  function pinchPair() {
    const [a, b] = [...livePointers.values()];
    return {
      p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
    };
  }
  function eraseAt(event) {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.vb-object');
    if (!target || !objects.contains(target)) return;
    const id = target.dataset.id;
    if (elements.find((e) => e.id === id)?.locked) return;
    elements = boundConnectors(pruneSingletonGroups(withoutObjects(elements, new Set([id]))));
    draw();
  }
  function startGesture(e) {
    if (e.target.closest('.vb-shape-label-input')) return;
    if (e.button > 1) return;
    const screen = stagePoint(e.clientX, e.clientY),
      p = worldPoint(screen);
    const hit = e.target.closest('.vb-object'),
      item = hit ? elements.find((n) => n.id === hit.dataset.id) : null;
    const handle = e.target.closest('[data-handle]')?.dataset.handle;
    if (e.button === 0 && tool === 'select' && !spaceDown && !item?.locked) {
      if (e.target.closest('.vb-rich-item') && !e.altKey &&
          (!groupPath(item).length || selection.size === 1 && selection.has(item.id)) &&
          (!e.shiftKey || selection.size === 1 && selection.has(item.id))) {
        tableUI.clearSelection();
        selection = new Set([item.id]);
        updateUI();
        return;
      }
      if (
        e.target.closest('.vt-chart-controls') ||
        (e.target.closest('.vt-table') && !e.target.closest('.vt-grip'))
      )
        return;
    }
    const panning = e.button === 1 || spaceDown || tool === 'hand';
    if (!panning) tableUI.clearSelection();
    let clickingText =
      item?.type === 'text' &&
      !item.body &&
      !item.folderPath &&
      !item.locked &&
      tool === 'select' &&
      !spaceDown &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      e.button === 0 &&
      (!groupPath(item).length || (selection.size === 1 && selection.has(item.id)));
    // A click positions the native caret. A first press followed by movement
    // carries the text with the pointer, just like any other canvas object.
    if (clickingText && selection.has(item.id)) {
      const { u, v } = relative(item, p);
      const edgeDistance = Math.min(u * item.w, (1 - u) * item.w, v * item.h, (1 - v) * item.h);
      if (edgeDistance * z <= 4) clickingText = false;
      else if (document.activeElement === e.target) return;
    }
    if (!clickingText) e.preventDefault();
    panel.hidden = true;
    if (!clickingText && !panning) stage.focus({ preventScroll: true });
    stage.setPointerCapture(e.pointerId);
    livePointers.set(e.pointerId, screen);
    if (livePointers.size === 2) {
      finishGesture();
      pinch = pinchPair();
      return;
    }
    if (livePointers.size > 2) return;
    const initial = state();
    gesture = { pointer: e.pointerId, start: p, screen, initial, mode: 'pan', tx, ty };
    if (e.button === 1 || spaceDown || tool === 'hand') {
      root.classList.add('vb-grabbed');
      return;
    }
    if (chain) {
      gesture.mode = 'chain-point';
      updateChain(p, e);
      return;
    }
    if (tool === 'select') {
      const picked = selected();
      const nodeHandle = handle === 'vertex' || handle === 'midpoint';
      const direct =
        nodeHandle && picked.length === 1 && !picked[0].locked
          ? { line: picked[0], index: Number(e.target.closest('[data-index]').dataset.index) }
          : !handle && findVertex(item, p, e);
      if (direct) {
        if (
          handle === 'vertex' &&
          e.altKey &&
          direct.index > 0 &&
          direct.index < direct.line.points.length - 1
        ) {
          const points = direct.line.points
            .filter((_, i) => i !== direct.index)
            .map(([u, v]) => at(direct.line, u, v));
          const indices = (direct.line.smoothPoints || []).filter(i => i !== direct.index)
            .map(i => i < direct.index ? i : i - 1);
          const next = withSmoothPoints({ ...direct.line, angle: 0,
            ...pointsInBox(points.map((q) => [q.x, q.y])) }, indices);
          gesture = null;
          commit(elements.map((a) => (a === direct.line ? next : a)));
          return;
        }
        gesture.mode = 'line-point';
        Object.assign(gesture, direct, { insert: handle === 'midpoint' || direct.insert });
        selection = new Set([direct.line.id]);
        hoverVertex.hidden = true;
        updateUI();
        return;
      }
    }
    if (handle && handle !== 'move') {
      gesture.mode = handle;
      gesture.box = { ...selectionBox(selected()) };
      return;
    }
    if (tool === 'text') {
      if (!inline && options.mountRichText) {
        gesture.mode = 'text-box';
        return;
      }
      gesture = null;
      addText(p);
      return;
    }
    if (tool === 'erase') {
      gesture.mode = 'erase';
      eraseAt(e);
      return;
    }
    if (tool === 'select') {
      const current = selected(),
        box = selectionBox(current);
      const withinSelection =
        !item &&
        current.length > 1 &&
        !e.shiftKey &&
        p.x >= box.x &&
        p.x <= box.x + box.w &&
        p.y >= box.y &&
        p.y <= box.y + box.h;
      if (item || withinSelection) {
        if (item?.folderPath && !handle && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey)
          gesture.folderPath = item.folderPath;
        if (item && !handle) {
          const individual = e.ctrlKey || e.metaKey;
          const ids = individual ? [item.id] : groupIds(item);
          if (e.shiftKey) {
            if (selection.has(item.id)) {
              gesture.toggleOff = ids;
            } else {
              for (const id of ids) selection.add(id);
            }
          } else if (individual || !selection.has(item.id)) selection = new Set(ids);
        }
        if (selected().some((el) => el.locked)) {
          gesture.mode = 'hold';
          draw();
          return;
        }
        gesture.mode = 'move';
        gesture.copyOnDrag = e.altKey;
        gesture.textPress = clickingText;
        gesture.base = elements;
        gesture.ids = new Set(selection);
        gesture.box = { ...selectionBox(selected()) };
      } else {
        gesture.mode = 'marquee';
        // Cache the rotated bounds once per drag. A group is a single target.
        const groups = new Map();
        for (const el of elements) {
          const key = groupPath(el).at(-1) || el;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(el);
        }
        gesture.targets = [...groups.values()]
          .filter((items) => !items.some((el) => el.locked))
          .map((items) => ({ items, bounds: extents(items) }));
        gesture.kept = e.shiftKey ? new Set(selection) : new Set();
        selection = new Set(gesture.kept);
      }
      draw();
      return;
    }
    gesture.mode = 'draw';
    gesture.object = create(tool, p);
    gesture.path = [[p.x, p.y]];
    if (tool === 'pen') {
      gesture.object.strokeProfile = 'freehand';
      if (e.pointerType === 'pen') gesture.pressures = [e.pressure];
    }
    if (isConnector(gesture.object)) gesture.startAnchor = bindAt(p, null, e.ctrlKey || e.metaKey);
    updateGesture(e);
  }
  function translated(e, dx, dy, ids) {
    const next = { ...e, x: e.x + dx, y: e.y + dy };
    for (const key of ['startBinding', 'endBinding'])
      if (e[key] && !ids.has(e[key].id)) delete next[key];
    return next;
  }
  function changeGeometry(g, p, shift) {
    const box = g.box;
    if (g.mode === 'rotate') {
      const cx = box.x + box.w / 2,
        cy = box.y + box.h / 2;
      let delta =
        ((Math.atan2(p.y - cy, p.x - cx) - Math.atan2(g.start.y - cy, g.start.x - cx)) * 180) / Math.PI;
      if (shift) delta = Math.round((delta + box.angle) / 15) * 15 - box.angle;
      g.liveBox = { ...box, angle: box.angle + delta };
      return g.initial.elements.map((e) => {
        if (!selection.has(e.id)) return e;
        const next = translated(e, 0, 0, selection),
          q = rotate(e.x + e.w / 2 - cx, e.y + e.h / 2 - cy, delta);
        return { ...next, x: cx + q.x - e.w / 2, y: cy + q.y - e.h / 2, angle: e.angle + delta };
      });
    }
    if (g.mode === 'w' || g.mode === 'e') {
      const left = g.mode === 'w';
      const anchor = at(box, left ? 1 : 0, 0.5);
      const x = rotate(p.x - anchor.x, p.y - anchor.y, -box.angle).x;
      const w = Math.max(box.body ? 150 : box.fontSize, x * (left ? -1 : 1));
      const offset = rotate(w * (left ? -0.5 : 0.5), 0, box.angle);
      const next = {
        ...box,
        x: anchor.x + offset.x - w / 2,
        y: anchor.y + offset.y - box.h / 2,
        w,
        autoResize: false
      };
      return g.initial.elements.map((el) => (el.id === box.id ? next : el));
    }
    const left = g.mode.endsWith('w'),
      topEdge = g.mode.startsWith('n');
    const anchor = at(box, left ? 1 : 0, topEdge ? 1 : 0),
      diff = rotate(p.x - anchor.x, p.y - anchor.y, -box.angle);
    let w = Math.max(8, (left ? -1 : 1) * diff.x),
      h = Math.max(8, (topEdge ? -1 : 1) * diff.y);
    if (box.type === 'table' || box.type === 'chart') {
      w = Math.max(185, w);
      h = Math.max(125, h);
    }
    if (box.body) {
      w = Math.max(150, w);
      h = Math.max(72, h);
    }
    if (shift || selection.size > 1 || box.type === 'image' || (box.type === 'text' && !box.body)) {
      // Project the cursor onto the diagonal to keep rotated groups and type
      // proportional even when the pointer moves across just one axis.
      const scale = Math.max(
        8 / Math.max(box.w, box.h),
        (w * box.w + h * box.h) / (box.w * box.w + box.h * box.h)
      );
      w = box.w * scale;
      h = box.h * scale;
    }
    const offset = rotate(((left ? -1 : 1) * w) / 2, ((topEdge ? -1 : 1) * h) / 2, box.angle);
    const targetBox = {
      x: anchor.x + offset.x - w / 2,
      y: anchor.y + offset.y - h / 2,
      w,
      h,
      angle: box.angle
    };
    return g.initial.elements.map((e) => {
      if (!selection.has(e.id)) return e;
      const pos = relative(box, { x: e.x + e.w / 2, y: e.y + e.h / 2 }),
        c = at(targetBox, pos.u, pos.v);
      const ew = (e.w * w) / box.w,
        eh = (e.h * h) / box.h,
        next = translated(e, 0, 0, selection);
      const scaled = { ...next, x: c.x - ew / 2, y: c.y - eh / 2, w: ew, h: eh };
      if (e.type === 'text' && !e.body) scaled.fontSize = clamp((e.fontSize * w) / box.w, 8, 180);
      return scaled;
    });
  }
  function updateGesture(e) {
    const screen = stagePoint(e.clientX, e.clientY),
      p = worldPoint(screen);
    if (livePointers.has(e.pointerId)) livePointers.set(e.pointerId, screen);
    if (pinch && livePointers.size >= 2) {
      manualCamera = true;
      const next = pinchPair(),
        anchor = worldPoint(pinch.p);
      z = clamp((z * next.d) / pinch.d, 0.05, 8);
      tx = next.p.x - anchor.x * z;
      ty = next.p.y - anchor.y * z;
      pinch = next;
      camera();
      return;
    }
    const g = gesture;
    if (!g) {
      if (chain) {
        updateChain(p, e);
        return;
      }
      if (tool === 'line' || tool === 'arrow') markSnap(bindAt(p, null, e.ctrlKey || e.metaKey));
      if (tool === 'select' && !spaceDown && !e.target.closest('[data-handle]')) {
        const id = e.target.closest('.vb-object')?.dataset.id;
        const direct = findVertex(id && elements.find((n) => n.id === id), p, e);
        hoverVertex.hidden = !direct || (selection.size === 1 && selection.has(direct.line.id));
        if (!hoverVertex.hidden) {
          const q = at(direct.line, ...direct.position);
          hoverVertex.style.left = q.x + 'px';
          hoverVertex.style.top = q.y + 'px';
        }
      } else hoverVertex.hidden = true;
      return;
    }
    if (e.pointerId !== g.pointer) return;
    if (g.folderPath && Math.hypot(screen.x - g.screen.x, screen.y - g.screen.y) >= 3)
      delete g.folderPath;
    if (g.mode === 'chain-point') {
      updateChain(p, e);
      return;
    }
    if (g.mode === 'hold') return;
    if (g.mode === 'pan') {
      manualCamera = true;
      tx = g.tx + screen.x - g.screen.x;
      ty = g.ty + screen.y - g.screen.y;
      camera();
      return;
    }
    let dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    if (g.mode === 'text-box') {
      if (Math.hypot(dx, dy) * z >= 4 || g.frame) {
        const w = Math.max(150, Math.abs(dx)), h = Math.max(72, Math.abs(dy));
        g.frame = { x: g.start.x - (dx < 0 ? w : 0), y: g.start.y - (dy < 0 ? h : 0), w, h, angle: 0 };
        layout(marquee, g.frame);
        marquee.classList.remove('vb-crossing');
        marquee.hidden = false;
      }
      return;
    }
    if (g.mode === 'move') {
      if (!g.moved) {
        if (Math.hypot(dx, dy) * z < 3) return;
        if (g.textPress) stage.focus({ preventScroll: true });
        if (g.copyOnDrag) {
          const copies = copyObjects(selected(), { x: 0, y: 0 }, tableScope());
          g.base = [...g.base, ...copies];
          g.ids = new Set(copies.map((copy) => copy.id));
          selection = new Set(g.ids);
        }
        root.classList.add('vb-grabbed');
      }
      g.moved = true;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (e.ctrlKey || e.metaKey) {
        for (const guide of guides) guide.hidden = true;
      } else if (g.ids.size) {
        if (!g.alignBox) {
          g.alignBox = extents(g.base.filter((el) => g.ids.has(el.id)));
          const topLeft = worldPoint({ x: 0, y: 0 });
          const bottomRight = worldPoint({ x: stage.clientWidth, y: stage.clientHeight });
          g.alignTargets = g.base
            .filter((el) => !g.ids.has(el.id) && !isConnector(el) && el.type !== 'pen')
            .map((el) => extents([el]))
            .filter(
              (b) =>
                b.x <= bottomRight.x &&
                b.y <= bottomRight.y &&
                b.x + b.w >= topLeft.x &&
                b.y + b.h >= topLeft.y
            );
        }
        [dx, dy] = alignDrag(guides, g.alignBox, g.alignTargets, dx, dy, z, e.shiftKey);
      }
      elements = boundConnectors(
        g.base.map((el) => (g.ids.has(el.id) ? translated(el, dx, dy, g.ids) : el))
      );
    } else if (g.mode === 'marquee') {
      const b = boxFromPoints([
        [g.start.x, g.start.y],
        [p.x, p.y]
      ]);
      layout(marquee, { ...b, angle: 0 });
      marquee.hidden = false;
      selection = new Set(g.kept);
      const crossing = p.x < g.start.x;
      marquee.classList.toggle('vb-crossing', crossing);
      for (const { items, bounds: q } of g.targets) {
        const hit = crossing
          ? q.x + q.w >= b.x && q.y + q.h >= b.y && q.x <= b.x + b.w && q.y <= b.y + b.h
          : q.x >= b.x && q.y >= b.y && q.x + q.w <= b.x + b.w && q.y + q.h <= b.y + b.h;
        if (hit) for (const el of items) selection.add(el.id);
      }
    } else if (g.mode === 'erase') {
      eraseAt(e);
      return;
    } else if (g.mode === 'line-point') {
      if (!g.moved && Math.hypot(dx, dy) * z < 3) return;
      g.moved = true;
      elements = repositionPoint(g, p, e);
    } else if (g.mode === 'draw') {
      const base = g.object;
      if (isConnector(base) && Math.hypot(dx, dy) * z >= 4) g.moved = true;
      if (base.type === 'pen') {
        const samples = e.getCoalescedEvents?.() || [];
        const rect = stage.getBoundingClientRect();
        for (const sample of [...samples, e]) {
          const q = worldPoint({ x: sample.clientX - rect.left, y: sample.clientY - rect.top });
          const last = g.path.at(-1);
          if (Math.hypot(q.x - last[0], q.y - last[1]) * z < 0.6) continue;
          g.path.push([q.x, q.y]);
          if (g.pressures)
            g.pressures.push(sample.type === 'pointerup' ? g.pressures.at(-1) : sample.pressure);
        }
        const stroke = { ...base, ...pointsInBox(g.path) };
        if (g.pressures) stroke.pressures = g.pressures.slice();
        elements = [...g.initial.elements, stroke];
      } else {
        let end = e.shiftKey && isConnector(base) ? clampLine(g.startAnchor?.point || g.start, p) : p;
        if (e.shiftKey && shapes.has(base.type)) {
          const side = Math.max(Math.abs(dx), Math.abs(dy));
          end = { x: g.start.x + Math.sign(dx || 1) * side, y: g.start.y + Math.sign(dy || 1) * side };
        }
        const start = g.startAnchor?.point || g.start,
          endAnchor = isConnector(base) ? bindAt(end, base.id, e.ctrlKey || e.metaKey) : null;
        markSnap(endAnchor);
        end = endAnchor?.point || end;
        const next = {
          ...base,
          ...pointsInBox([
            [start.x, start.y],
            [end.x, end.y]
          ])
        };
        if (g.startAnchor?.binding) next.startBinding = g.startAnchor.binding;
        if (endAnchor?.binding) next.endBinding = endAnchor.binding;
        elements = [...g.initial.elements, next];
      }
    } else {
      elements = boundConnectors(changeGeometry(g, p, e.shiftKey));
    }
    draw();
    if (['w', 'e', 'nw', 'sw', 'ne', 'se'].includes(g.mode) &&
        fitRichHeights(selection, g.mode.startsWith('n') ? 1 : 0)) draw();
  }
  function finishGesture(cancel = false) {
    for (const guide of guides) guide.hidden = true;
    const g = gesture;
    if (!g) return;
    gesture = null;
    scheduleRichLayout();
    marquee.hidden = true;
    markSnap(null);
    hoverVertex.hidden = true;
    root.classList.remove('vb-grabbed');
    if (g.mode === 'chain-point') {
      updateUI();
      return;
    }
    if (cancel) {
      elements = g.initial.elements;
      selection = new Set(g.initial.selection);
      draw();
      return;
    }
    if (g.mode === 'text-box') {
      addText(g.frame || g.start, '', g.frame);
      return;
    }
    if ((g.mode === 'move' || g.mode === 'hold') && g.toggleOff && !g.moved) {
      for (const id of g.toggleOff) selection.delete(id);
    }
    if (g.mode === 'draw') {
      if (isConnector(g.object) && !g.moved) {
        beginChain(g);
        return;
      }
      const last = elements.at(-1);
      if (last?.id === g.object.id) {
        if (
          last.type !== 'pen' &&
          last.w < 3 / z &&
          last.h < 3 / z &&
          !last.startBinding &&
          !last.endBinding
        ) {
          const size = { ...last, w: 100, h: shapes.has(last.type) ? 68 : 45 };
          if (isConnector(size))
            size.points = [
              [0, 1],
              [1, 0]
            ];
          elements = [...g.initial.elements, size];
        }
        if (last.type !== 'pen') {
          tool = 'select';
          selection = new Set([last.id]);
        }
      }
    }
    if (elements !== g.initial.elements) {
      remember(g.initial);
      lastTyping = null;
      draw();
      emit();
      if (['w', 'e', 'nw', 'sw', 'ne', 'se'].includes(g.mode)) updateTextHeights();
    } else updateUI();
    placeHandles();
  }
  function endGesture(e, cancel = false) {
    const g = gesture;
    const screen = stagePoint(e.clientX, e.clientY);
    const openPath = !cancel && g?.folderPath && e.pointerId === g.pointer &&
      Math.hypot(screen.x - g.screen.x, screen.y - g.screen.y) < 3 && g.folderPath;
    if (!cancel && gesture?.pointer === e.pointerId && gesture.mode === 'chain-point') {
      placeChainPoint(worldPoint(stagePoint(e.clientX, e.clientY)), e);
    }
    if (
      !cancel &&
      gesture?.pointer === e.pointerId &&
      (gesture.mode === 'line-point' || (gesture.mode === 'draw' && gesture.object.type === 'pen'))
    ) {
      updateGesture(e);
    }
    livePointers.delete(e.pointerId);
    if (livePointers.size < 2) pinch = null;
    if (gesture?.pointer === e.pointerId) finishGesture(cancel);
    if (openPath) visitFolder(openPath);
  }
  listen(stage, 'pointerdown', startGesture);
  listen(stage, 'pointermove', updateGesture);
  listen(stage, 'pointerleave', () => {
    if (!gesture) {
      markSnap(null);
      hoverVertex.hidden = true;
    }
  });
  listen(stage, 'pointerup', (e) => endGesture(e));
  listen(stage, 'pointercancel', (e) => endGesture(e, true));
  listen(stage, 'lostpointercapture', (e) => endGesture(e, true));
  listen(stage, 'dblclick', (e) => {
    if (e.target.closest('.vb-shape-label-input,.is-rich-active .vb-rich-item')) return;
    if (chain || performance.now() < suppressDoubleClickUntil) return;
    if (tool !== 'select') return;
    // Pointer capture sends the subsequent dblclick to the stage even when
    // both presses hit an existing object. Resolve the original canvas hit.
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target.closest('[data-handle]')) return;
    const id = target.closest('.vb-object')?.dataset.id;
    if (id) {
      const item = elements.find((el) => el.id === id);
      if (item && !item.locked && shapes.has(item.type)) {
        e.preventDefault();
        selection = new Set([item.id]);
        updateUI();
        shapeCaption(views.get(item.id), item).start();
      } else if (item && !item.locked && groupPath(item).length) {
        selection = new Set([item.id]);
        updateUI();
        if (item.body) views.get(item.id)?.rich?.focus();
        else if (item.type === 'text') views.get(item.id)?.content.focus({ preventScroll: true });
      }
      return;
    }
    e.preventDefault();
    addText(worldPoint(stagePoint(e.clientX, e.clientY)));
  });
  listen(
    stage,
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey && e.target.closest('.vb-rich-item') && tool === 'select') return;
      if (inline) {
        // Wheel scrolling belongs to the surrounding note. Zoom stays available
        // under the cursor using the same modifier as a trackpad pinch.
        if (!e.ctrlKey && !e.metaKey && !(active && (e.shiftKey || spaceDown || tool === 'hand'))) return;
        if (!active) {
          setActive(true);
          options.onActivate?.();
        }
      }
      if (
        e.target.matches('textarea:focus') &&
        !e.ctrlKey &&
        !e.metaKey &&
        e.target.scrollHeight > e.target.clientHeight + 1
      )
        return;
      e.preventDefault();
        if (e.ctrlKey || e.metaKey || (!inline && !e.shiftKey && !e.deltaX && Math.abs(e.deltaY) >= 45)) {
        zoomAt(
          z * Math.exp(-clamp(e.deltaY * (e.deltaMode === 1 ? 16 : 1), -500, 500) * 0.002),
          stagePoint(e.clientX, e.clientY)
        );
      } else {
        manualCamera = true;
        tx -= e.shiftKey ? e.deltaX || e.deltaY : e.deltaX;
        ty -= e.shiftKey ? 0 : e.deltaY;
        camera();
      }
    },
    { passive: false }
  );

  function importImages(files, p = worldPoint({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 })) {
    const accepted = Array.from(files).filter((f) =>
      /^image\/(?:png|jpeg|gif|webp|bmp|avif)$/i.test(f.type)
    );
    if (!accepted.length) {
      message(
        tr(
          'Выберите PNG, JPEG, WebP, GIF, BMP или AVIF.',
          'Choose a PNG, JPEG, WebP, GIF, BMP or AVIF image.'
        )
      );
      return;
    }
    const task = (async () => {
      const images = [];
      for (const f of accepted) {
        try {
          const src = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(f);
          });
          if (!safeImage(src)) throw Error();
          const img = new Image();
          img.src = src;
          await img.decode();
          const k = Math.min(
            1,
            480 / Math.max(1, img.naturalWidth),
            380 / Math.max(1, img.naturalHeight)
          );
          const w = Math.max(1, img.naturalWidth * k),
            h = Math.max(1, img.naturalHeight * k),
            offset = (images.length * 20) / z;
          images.push(
            create(
              'image',
              { x: p.x - w / 2 + offset, y: p.y - h / 2 + offset },
              { src, alt: f.name, w, h }
            )
          );
        } catch {
          if (!dead) message(tr('Не удалось прочитать изображение ', 'Could not read image ') + f.name);
        }
      }
      if (images.length && !dead) {
        finishGesture();
        tool = 'select';
        commit(
          [...elements, ...images],
          active ? images.map((e) => e.id) : []
        );
        if (active) stage.focus({ preventScroll: true });
      }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
    return task;
  }
  file.onchange = () => {
    const files = Array.from(file.files);
    file.value = '';
    importImages(files);
  };
  listen(stage, 'dragover', (e) => {
    if (e.target.closest('.vb-rich-item') && tool === 'select') return;
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  listen(stage, 'drop', (e) => {
    if (e.target.closest('.vb-rich-item') && tool === 'select') return;
    e.preventDefault();
    e.stopPropagation();
    if (inline && !active && e.dataTransfer.files.length) {
      setActive(true);
      options.onActivate?.();
    }
    if (e.dataTransfer.files.length)
      importImages(e.dataTransfer.files, worldPoint(stagePoint(e.clientX, e.clientY)));
  });
  let cutSheets = null;
  function putOnClipboard(e, cut) {
    if (e.target.matches('input,textarea') || e.target.closest('.vb-rich-item') || !selection.size) return;
    e.preventDefault();
    e.stopPropagation();
    const items = selected(),
      before = elements;
    const doc = plainDoc(items);
    cutSheets = null;
    const canCut = cut && !items.some(item => item.locked);
    if (canCut && items.some(isSheetObject)) doc.cutId = uid();
    const value = JSON.stringify(doc);
    e.clipboardData.setData('text/plain', copyPrefix + value);
    e.clipboardData.setData('application/x-videron-board', value);
    if (canCut) {
      removeSelected();
      if (doc.cutId) cutSheets = { id: doc.cutId, before, after: elements };
    }
  }
  listen(root, 'copy', (e) => putOnClipboard(e, false));
  listen(root, 'cut', (e) => putOnClipboard(e, true));
  listen(root, 'paste', (e) => {
    if (e.target.matches('input:not(.vb-text)') || e.target.closest('.vb-rich-item')) return;
    const data = e.clipboardData;
    if (data.files.length) {
      e.preventDefault();
      e.stopPropagation();
      importImages(data.files);
      return;
    }
    if (e.target.matches('textarea')) {
      e.stopPropagation();
      return;
    }
    const text = data.getData('text/plain'),
      json =
        data.getData('application/x-videron-board') ||
        (text.startsWith(copyPrefix) ? text.slice(copyPrefix.length) : '');
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.elements)) return;
        const pasted = normalizeBoard(parsed).elements;
        if (!pasted.length) return;
        const center = worldPoint({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 }),
          b = extents(pasted);
        const visible =
          b.x + b.w > -tx / z &&
          b.y + b.h > -ty / z &&
          b.x < (stage.clientWidth - tx) / z &&
          b.y < (stage.clientHeight - ty) / z;
        const restore =
          cutSheets &&
          cutSheets.id === parsed.cutId &&
          pasted.every((item) => !elements.some((e) => item.id === e.id));
        const added = copyObjects(
          pasted,
          visible
            ? { x: 18 / z, y: 18 / z }
            : { x: center.x - b.x - b.w / 2, y: center.y - b.y - b.h / 2 },
          tableScope(),
          restore
        );
        let base = elements;
        if (restore) {
          const names = new Map();
          pasted.forEach((item, index) => {
            if (item.type === 'table') names.set(item.name, added[index].name);
          });
          base = restoreCutFormulas(elements, cutSheets.before, cutSheets.after, names);
          cutSheets = null;
        }
        e.preventDefault();
        e.stopPropagation();
        tool = 'select';
        commit(
          [...base, ...added],
          added.map((a) => a.id)
        );
        return;
      } catch {
        return;
      }
    }
    if (text) {
      e.preventDefault();
      e.stopPropagation();
      addText(worldPoint({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 }), text);
    }
  });
  const keys = {
    KeyV: 'select',
    KeyH: 'hand',
    KeyR: 'rect',
    KeyD: 'diamond',
    KeyO: 'ellipse',
    KeyA: 'arrow',
    KeyL: 'line',
    KeyP: 'pen',
    KeyT: 'text',
    KeyE: 'erase'
  };
  listen(root, 'keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.altKey) return;
    if (e.target.closest('.vb-rich-item')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        stage.focus({ preventScroll: true });
      }
      e.stopPropagation();
      return;
    }
    const typing = e.target.matches('.vb-text');
    const cmd = primaryCommand(e);
    if (!cmd && (e.ctrlKey || e.metaKey)) return;
    const direction = historyDirection(e);
    if (e.target.matches('input,select,textarea:not(.vb-text)')) {
      if (direction && e.target.matches('select,input[type=range],input[type=color]')) {
        e.preventDefault();
        undo(direction === 'redo');
      }
      e.stopPropagation();
      return;
    }
    if (typing) {
      if (cmd && e.shiftKey && e.code === 'KeyL') {
        e.preventDefault();
        if (!e.repeat) toggleLock();
      } else if (direction) {
        e.preventDefault();
        undo(direction === 'redo');
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        stage.focus({ preventScroll: true });
      }
      e.stopPropagation();
      return;
    }
    if (chain && !cmd && !e.shiftKey && ['Enter', 'Escape', 'Backspace', 'Delete'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Backspace' || e.key === 'Delete') backtrackChain();
      else finishChain(e.key === 'Escape');
      return;
    }
    if (cmd) {
      if (direction) undo(direction === 'redo');
      else if (!e.shiftKey && e.code === 'KeyA') {
        tool = 'select';
        const blocked = new Set(
          elements
            .filter((el) => el.locked)
            .map((el) => groupPath(el).at(-1))
            .filter(Boolean)
        );
        selection = new Set(
          elements.filter((el) => !el.locked && !blocked.has(groupPath(el).at(-1))).map((el) => el.id)
        );
        updateUI();
      } else if (e.code === 'KeyD' && !e.shiftKey) {
        if (!e.repeat) duplicate();
      } else if (e.code === 'KeyG') {
        if (!e.repeat) groupSelected(e.shiftKey);
      } else if (e.code === 'KeyL' && e.shiftKey) {
        if (!e.repeat) toggleLock();
      } else return;
    } else if (e.key === 'Escape') {
      if (gesture) finishGesture(true);
      else if (!panel.hidden) panel.hidden = true;
      else if (selection.size || tool !== 'select') {
        selection.clear();
        setTool('select');
      } else if (inline && options.onExit) options.onExit();
      else return;
    } else if (e.key === ' ' && e.target === stage) {
      spaceDown = true;
      root.classList.add('vb-space');
    } else if (e.key === 'Enter' && !e.shiftKey && e.target === stage && selection.size === 1) {
      const [item] = selected();
      if (!item || item.locked || !shapes.has(item.type)) return;
      shapeCaption(views.get(item.id), item).start();
    } else if (!e.shiftKey && e.code === 'KeyF') {
      fit();
    } else if (!e.shiftKey && keys[e.code]) setTool(keys[e.code]);
    else if (!e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
      const chart = e.target.closest('.vt-chart-controls')?.closest('.vb-object');
      if (chart && !selection.has(chart.dataset.id)) {
        const item = elements.find(el => el.id === chart.dataset.id);
        if (item) selection = new Set(groupIds(item));
      }
      removeSelected();
    } else if (selection.size && e.key.startsWith('Arrow') && !selected().some((el) => el.locked)) {
      const step = e.shiftKey ? 10 : 1,
        dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
        dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      commit(elements.map((el) => (selection.has(el.id) ? translated(el, dx, dy, selection) : el)));
    } else if (e.target === stage && e.key.length === 1 && !e.altKey)
      addText(worldPoint({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 }), e.key);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  function releaseSpace() {
    spaceDown = false;
    root.classList.remove('vb-space');
  }
  function flush() {
    tableUI.finishEdit();
    finishGesture();
    finishChain();
  }
  async function commitDraft(closing = false) {
    if (closing) folderPicker = null;
    // Capture interrupted IME input before a table commit or gesture redraws the board.
    for (const item of elements) {
      const view = views.get(item.id);
      const caption = view?.caption?.field;
      if (caption) changeShapeLabel(item.id, caption.value, 'insertText');
      if (item.type === 'text' && !item.folderPath && !item.locked && !item.body &&
          view?.content && view.content.value !== item.text) onTextInput(item.id, view.content);
    }
    await Promise.all([...views.values()].filter(v => v.rich).map(v => v.rich.flush()));
    if (closing) flush();
    else if (!tableUI.commitDraft()) return false;
    await Promise.allSettled([...pending]);
    if (closing) finishGesture();
    if (fitRichHeights(views.keys())) { draw(); emit(); }
    return true;
  }
  function setActive(next) {
    if (!inline || active === next || dead) return;
    active = next;
    root.dataset.active = String(active);
    if (active) return;
    closeFileMenu?.(false);
    flush();
    tableUI.clearSelection();
    for (const id of livePointers.keys()) if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    livePointers.clear();
    pinch = null;
    tool = 'select';
    expandedTools = false;
    lastTyping = null;
    selection.clear();
    panel.hidden = true;
    releaseSpace();
    markSnap(null);
    hoverVertex.hidden = true;
    updateUI();
  }
  listen(window, 'keyup', (e) => {
    if (e.code === 'Space') releaseSpace();
  });
  listen(window, 'blur', releaseSpace);
  listen(window, 'videron:themechange', () => {
    draw();
    // An unfinished connector lives outside the saved drawing.
    if (chain) updateView(chain.ghost, chainElement([...chain.nodes, chain.preview]));
  });
  listen(root, 'pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !styleButton.contains(e.target)) {
      panel.hidden = true;
      styleButton.setAttribute('aria-expanded', 'false');
    }
  });
  let previousWidth = stage.clientWidth, previousHeight = stage.clientHeight;
  const resize = new ResizeObserver(() => {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    if (!hasView || (inline && !manualCamera && (w !== previousWidth || h !== previousHeight))) fit();
    else {
      if (inline && previousWidth && previousHeight) {
        tx += (w - previousWidth) / 2;
        ty += (h - previousHeight) / 2;
      }
      camera();
    }
    previousWidth = w;
    previousHeight = h;
  });
  resize.observe(stage);
  draw();
  fit();
  return {
    getDocument,
    undo,
    revealTableCell(id, address) {
      setTool('select', false);
      const cell = tableUI.revealSearchCell(id, address);
      if (!cell || !stage.clientWidth || !stage.clientHeight) return cell;
      if (z < .85) zoomAt(1);
      const bounds = stage.getBoundingClientRect(), box = cell.getBoundingClientRect();
      if (box.left < bounds.left + 12 || box.right > bounds.right - 12 ||
          box.top < bounds.top + (inline ? 8 : 55) || box.bottom > bounds.bottom - 50) {
        tx += (bounds.left + bounds.right - box.left - box.right) / 2;
        ty += (bounds.top + bounds.bottom - box.top - box.bottom) / 2;
        camera();
      }
      hasView = manualCamera = true;
      return cell;
    },
    revealTextBlock(id, target) {
      const item = elements.find(el => el.id === id);
      const view = views.get(id);
      if (!item || !view || (!view.rich && target?.kind !== 'canvasLabel')) return false;
      setTool('select', false);
      selection = new Set([id]);
      updateUI();
      if (target?.kind === 'body' && item.h * Math.max(1, z) > stage.clientHeight - 132) {
        // An auto-grown area can span many screens. Read the match at text size.
        if (z < 0.85) zoomAt(1);
      } else revealSheet(item);
      if (target?.kind === 'canvasLabel') {
        if (view.caption) {
          stage.focus({preventScroll:true});
          view.caption.highlight(target.start, target.end);
        } else if (view.content instanceof HTMLTextAreaElement) {
          view.content.focus({preventScroll:true});
          view.content.setSelectionRange(target.start, target.end);
        }
        return true;
      }
      if (target) {
        if (!view.rich.revealSearchMatch) return false;
        view.rich.revealSearchMatch(target);
      } else view.rich.focus();
      return true;
    },
    refreshWorkbook,
    pickExternalCell: (event, table, allowed = true) => tableUI.pickExternalCell(event, table?.name, allowed),
    addTable,
    replaceDocument,
    syncDocument,
    setTool,
    setActive,
    flush,
    refreshHistory,
    fit,
    focus: () => stage.focus({ preventScroll: true }),
    commitDraft,
    prepareClose: () => commitDraft(true),
    destroy() {
      if (dead) return;
      closeFileMenu?.(false);
      dead = true;
      cancelAnimationFrame(richLayoutFrame);
      tableUI.destroy();
      for (const view of views.values()) view.rich?.destroy();
      finishGesture();
      controller.abort();
      resize.disconnect();
      clearTimeout(alertTimer);
      root.remove();
    }
  };
}
