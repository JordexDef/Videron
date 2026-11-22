import { tokenize, parseAddress } from './table-engine.js';

const views = new WeakMap();
const sessions = new WeakMap();
const paletteSize = 6;

// Workbooks supply opaque table identities so two imported blocks may have
// identical saved IDs or names without sharing their reference colors.
export function formulaReferences(formula, resolve) {
  const spans = [],
    ranges = new Map();
  if (!formula.startsWith('=')) return { spans, ranges };
  const tokens = tokenize(formula);
  let nextColor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i];
    if (first.kind === '"' || first.kind === "'") break;
    if (first.kind !== 'ref') continue;
    let last = first;
    if (tokens[i + 1]?.kind === ':' && tokens[i + 2]?.kind === 'ref') {
      i += 2;
      last = tokens[i];
    }
    const table = resolve(first.sheet);
    if (!table || (last.sheet !== undefined && resolve(last.sheet) !== table)) continue;
    const a = parseAddress(first.addr),
      b = parseAddress(last.addr);
    if (!a || !b || Math.max(a.row, b.row) >= table.rows || Math.max(a.col, b.col) >= table.cols)
      continue;
    const top = Math.min(a.row, b.row),
      bottom = Math.max(a.row, b.row);
    const left = Math.min(a.col, b.col),
      right = Math.max(a.col, b.col);
    if (!ranges.has(table)) ranges.set(table, new Map());
    const keys = ranges.get(table),
      key = [top, left, bottom, right].join('/');
    if (!keys.has(key)) keys.set(key, { top, bottom, left, right, color: nextColor++ % paletteSize });
    spans.push({ start: first.start, end: last.end, color: keys.get(key).color });
  }
  return { spans, ranges };
}

function coloredText(host, raw, spans) {
  const content = document.createDocumentFragment();
  let cursor = 0;
  for (const { start, end, color } of spans) {
    content.append(raw.slice(cursor, start));
    const token = document.createElement('span');
    token.dataset.vtColor = color;
    token.style.setProperty('--vt-ref', 'var(--vt-ref-' + color + ')');
    token.textContent = raw.slice(start, end);
    content.append(token);
    cursor = end;
  }
  content.append(raw.slice(cursor));
  host.replaceChildren(content);
}

export function referenceFieldHost(session) {
  if (session.refHost) return session.refHost;
  const host = document.createElement('div'),
    ink = document.createElement('div');
  host.className = 'vt-formula-frame';
  ink.className = 'vt-formula-ink';
  ink.setAttribute('aria-hidden', 'true');
  host.append(ink);
  session.v.footer.append(host);
  session.refHost = host;
  session.field.addEventListener('scroll', () => {
    ink.scrollLeft = session.field.scrollLeft;
  });
  session.field.addEventListener('compositionstart', () => {
    ink.hidden = true;
  });
  session.field.addEventListener('compositionend', () => {
    ink.hidden = false;
  });
  return host;
}

const outlines = new WeakMap();
const sides = ['top', 'right', 'bottom', 'left'];
const colorVar = (color) => 'var(--vt-ref-' + color + ')';

function edgeLayer(colors, side) {
  const vertical = side === 'left' || side === 'right';
  const stops = colors.map((color, index) => {
    const start = (100 * index) / colors.length;
    const end = (100 * (index + 1)) / colors.length;
    return colorVar(color) + ' ' + start + '% ' + end + '%';
  });
  if (colors.length === 1) stops.push(colorVar(colors[0]));
  return (
    'linear-gradient(to ' +
    (vertical ? 'bottom' : 'right') +
    ',' +
    stops.join(',') +
    ') ' +
    side +
    ' / ' +
    (vertical ? '1.5px 100%' : '100% 1.5px') +
    ' no-repeat'
  );
}

function paint(view, state) {
  const id = view.workbook?.referenceIdentity?.(view.id);
  const ranges = state?.ranges.get(id);
  if (!ranges && !view.hasReferenceColors) return;
  view.hasReferenceColors = !!ranges;
  for (const { cell, row, col } of view.cells.values()) {
    const colors = [],
      edges = [[], [], [], []];
    if (ranges) {
      for (const r of ranges.values()) {
        if (row < r.top || row > r.bottom || col < r.left || col > r.right) continue;
        if (!colors.includes(r.color)) colors.push(r.color);
        const boundaries = [row === r.top, col === r.right, row === r.bottom, col === r.left];
        boundaries.forEach((onEdge, i) => {
          if (onEdge && !edges[i].includes(r.color)) edges[i].push(r.color);
        });
      }
    }
    const signature = colors.length ? [colors, ...edges].join('|') : undefined;
    if (signature === outlines.get(cell)) continue;
    if (!colors.length) {
      outlines.delete(cell);
      delete cell.dataset.vtRefs;
      cell.style.removeProperty('--vt-ref');
      cell.style.removeProperty('--vt-ref-outline');
      cell.style.removeProperty('--vt-ref-overlap');
      continue;
    }
    outlines.set(cell, signature);
    cell.dataset.vtRefs = colors.join(' ');
    cell.style.setProperty('--vt-ref', colorVar(colors[0]));
    const layers = edges.flatMap((ink, i) => (ink.length ? [edgeLayer(ink, sides[i])] : []));
    cell.style.setProperty('--vt-ref-outline', layers.join(',') || 'none');
    if (colors.length > 1) {
      const fills = colors.map(
        (color) => 'color-mix(in srgb, var(--vt-base), ' + colorVar(color) + ' 23%)'
      );
      cell.style.setProperty('--vt-ref-overlap', 'linear-gradient(120deg,' + fills.join(',') + ')');
    } else cell.style.removeProperty('--vt-ref-overlap');
  }
}

function repaint(doc, state) {
  for (const root of doc.querySelectorAll('.vt-table')) {
    const view = views.get(root);
    if (view) paint(view, state);
  }
}

export function clearReferenceColors(view) {
  const doc = view.root.ownerDocument,
    previous = sessions.get(doc);
  if (previous?.view !== view) return;
  sessions.delete(doc);
  if (previous.host === view.quick) view.quick.textContent = previous.raw;
  repaint(doc, null);
}

export function refreshReferenceColors(view, raw, editSession, refreshOnFocus) {
  const doc = view.root.ownerDocument;
  if (!views.has(view.root)) {
    views.set(view.root, view);
    view.root.addEventListener('focusin', refreshOnFocus);
    view.root.addEventListener('focusout', () =>
      queueMicrotask(() => {
        if (!view.root.contains(doc.activeElement)) clearReferenceColors(view);
      })
    );
  }
  if (!raw?.startsWith('=') || (!editSession && !view.root.contains(doc.activeElement))) {
    clearReferenceColors(view);
    paint(view, sessions.get(doc));
    return;
  }
  const host = editSession ? editSession.refHost?.firstElementChild : view.quick;
  if (!host || !view.workbook?.referenceIdentity) return;
  const previous = sessions.get(doc);
  if (
    previous?.view === view &&
    previous.host === host &&
    previous.raw === raw &&
    previous.book === view.workbook
  ) {
    paint(view, previous);
    return;
  }
  if (previous && previous.host === previous.view.quick && previous.host !== host)
    previous.host.textContent = previous.raw;
  const { ranges, spans } = formulaReferences(raw, (sheet) =>
    view.workbook.referenceIdentity(view.id, sheet)
  );
  const state = { view, host, raw, book: view.workbook, ranges };
  sessions.set(doc, state);
  coloredText(host, raw, spans);
  if (editSession) host.scrollLeft = editSession.field.scrollLeft;
  repaint(doc, state);
}
