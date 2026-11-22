import { addressOf, TABLE_LIMITS } from './table-engine.js';
import { tr } from './i18n.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Pointer coordinates and scroll offsets must share the table's local axes.
// Canvas tables can be both rotated and zoomed. Note tables use CSS pixels.
function localPoint(scroller, event, angle, inverseZoom) {
  const box = scroller.getBoundingClientRect();
  const dx = (event.clientX - box.left - box.width / 2) * inverseZoom;
  const dy = (event.clientY - box.top - box.height / 2) * inverseZoom;
  return {
    x: scroller.offsetWidth / 2 + dx * Math.cos(angle) + dy * Math.sin(angle),
    y: scroller.offsetHeight / 2 - dx * Math.sin(angle) + dy * Math.cos(angle)
  };
}

function extension(source, row, col, axis) {
  const target = { ...source };
  let added;
  if (axis === 'rows' && row < source.top) {
    target.top = row;
    added = { ...target, bottom: source.top - 1 };
  } else if (axis === 'rows' && row > source.bottom) {
    target.bottom = row;
    added = { ...target, top: source.bottom + 1 };
  } else if (axis === 'cols' && col < source.left) {
    target.left = col;
    added = { ...target, right: source.left - 1 };
  } else if (axis === 'cols' && col > source.right) {
    target.right = col;
    added = { ...target, left: source.right + 1 };
  }
  return { target, added };
}

function cursorTip(root, signal) {
  const tip = document.createElement('div');
  tip.className = 'vt-fill-tip';
  tip.setAttribute('role', 'tooltip');
  const address = document.createElement('span'), value = document.createElement('strong'), mode = document.createElement('span');
  address.className = 'vt-fill-tip-address';
  value.className = 'vt-fill-tip-value';
  mode.className = 'vt-fill-tip-mode';
  mode.textContent = tr('Копия', 'Copy');
  tip.append(address, value, mode);
  tip.hidden = true;
  (root.closest('dialog') || document.body).append(tip);
  signal.addEventListener('abort', () => tip.remove(), { once: true });
  let width, height;
  return (pointer, addr, label, copy) => {
    if (!addr) { tip.hidden = true; return; }
    const shown = label === '' ? tr('Пусто', 'Blank') : label;
    if (tip.hidden || address.textContent !== addr || value.textContent !== shown || mode.hidden === copy) {
      address.textContent = addr;
      value.textContent = shown;
      mode.hidden = !copy;
      tip.hidden = false;
      width = tip.offsetWidth;
      height = tip.offsetHeight;
    }
    const x = pointer.clientX, y = pointer.clientY;
    const left = x + 14 + width <= window.innerWidth - 4 ? x + 14 : x - width - 12;
    const top = y + 18 + height <= window.innerHeight - 4 ? y + 18 : y - height - 12;
    tip.style.left = clamp(left, 4, window.innerWidth - width - 4) + 'px';
    tip.style.top = clamp(top, 4, window.innerHeight - height - 4) + 'px';
  };
}

export function trackFill(v, event, source, axisSelection, { signal, preview, commit, cancel }) {
  const { root, scroller, item } = v;
  const board = root.closest('.vb');
  const angle = board ? (item.angle || 0) * Math.PI / 180 : 0;
  const inverseZoom = board ? Number(getComputedStyle(board).getPropertyValue('--vb-inverse')) || 1 : 1;
  const header = v.grid.tHead?.offsetHeight || 0;
  const labels = v.grid.querySelector('.vt-row-number')?.offsetWidth || 0;
  const cellWidth = (v.grid.offsetWidth - labels) / item.cols;
  const cellHeight = parseFloat(getComputedStyle(v.cells.values().next().value.cell).height);
  const start = localPoint(scroller, event, angle, inverseZoom);
  let pointer = event, moved = false, frame = 0, result, copy = event.ctrlKey;
  const showTip = cursorTip(root, signal);
  const opts = { signal };

  function update(scroll) {
    if (!moved && Math.hypot(pointer.clientX - event.clientX, pointer.clientY - event.clientY) < 4) return;
    moved = true;
    const point = localPoint(scroller, pointer, angle, inverseZoom);
    const width = scroller.clientWidth, height = scroller.clientHeight;
    const x = point.x + scroller.scrollLeft - labels, y = point.y + scroller.scrollTop - header;
    const dx = Math.max(0, source.left * cellWidth - x, x - (source.right + 1) * cellWidth);
    const dy = Math.max(0, source.top * cellHeight - y, y - (source.bottom + 1) * cellHeight);
    const axis = axisSelection || (dx || dy ? (dx > dy ? 'cols' : 'rows')
      : Math.abs(point.x - start.x) > Math.abs(point.y - start.y) ? 'cols' : 'rows');
    const edgeSpeed = (distance) => clamp(Math.ceil(distance), 0, 22);
    const inset = 12 * inverseZoom;
    if (scroll) {
      const before = axis === 'rows' ? scroller.scrollTop : scroller.scrollLeft;
      if (axis === 'rows') scroller.scrollTop += edgeSpeed(point.y - height + inset) - edgeSpeed(header + inset - point.y);
      else scroller.scrollLeft += edgeSpeed(point.x - width + inset) - edgeSpeed(labels + inset - point.x);
      if (before !== (axis === 'rows' ? scroller.scrollTop : scroller.scrollLeft)) scheduleScroll();
    }
    // Grow only after the viewport reaches the final real row or column.
    // Remaining pointer travel then represents new cells at the current zoom.
    const maxX = scroller.scrollLeft + width < scroller.scrollWidth - 1 ? width - 1 : Infinity;
    const maxY = scroller.scrollTop + height < scroller.scrollHeight - 1 ? height - 1 : Infinity;
    const gridX = clamp(point.x, labels, maxX) + scroller.scrollLeft - labels;
    const gridY = clamp(point.y, header, maxY) + scroller.scrollTop - header;
    const row = clamp(Math.floor(gridY / cellHeight), 0, TABLE_LIMITS.rows - 1);
    const col = clamp(Math.floor(gridX / cellWidth), 0, TABLE_LIMITS.cols - 1);
    result = extension(source, row, col, axis);
    const edge = result.added ? addressOf(
      axis === 'rows' ? row : clamp(row, source.top, source.bottom),
      axis === 'cols' ? col : clamp(col, source.left, source.right)
    ) : null;
    const label = preview(result.target, result.added, edge, copy);
    showTip(pointer, edge, label, copy);
    drawOverflow(result.added);
  }

  function drawOverflow(added) {
    const below = added?.bottom >= item.rows, right = added?.right >= item.cols;
    const box = v.fillOverflow;
    box.hidden = !below && !right;
    if (box.hidden) return;
    const left = labels + Math.max(added.left, right ? item.cols : 0) * cellWidth - scroller.scrollLeft;
    const top = header + Math.max(added.top, below ? item.rows : 0) * cellHeight - scroller.scrollTop;
    const endX = labels + (added.right + 1) * cellWidth - scroller.scrollLeft;
    const endY = header + (added.bottom + 1) * cellHeight - scroller.scrollTop;
    const x = right ? left : Math.max(labels, left), y = below ? top : Math.max(header, top);
    box.style.left = scroller.offsetLeft + x + 'px';
    box.style.top = scroller.offsetTop + y + 'px';
    box.style.width = Math.max(0, (right ? endX : Math.min(scroller.clientWidth, endX)) - x) + 'px';
    box.style.height = Math.max(0, (below ? endY : Math.min(scroller.clientHeight, endY)) - y) + 'px';
  }

  function scheduleScroll() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; update(true); });
  }
  root.setPointerCapture(event.pointerId);
  root.addEventListener('pointermove', e => {
    if (e.pointerId !== event.pointerId) return;
    pointer = e;
    copy = e.ctrlKey;
    update(false);
    scheduleScroll();
  }, opts);
  root.addEventListener('pointerup', e => {
    if (e.pointerId !== event.pointerId) return;
    pointer = e;
    copy = e.ctrlKey;
    update(false);
    if (result?.added) commit();
    else cancel();
  }, opts);
  for (const type of ['pointercancel', 'lostpointercapture'])
    root.addEventListener(type, e => { if (e.pointerId === event.pointerId) cancel(); }, opts);
  window.addEventListener('blur', cancel, opts);
  for (const type of ['keydown', 'keyup']) window.addEventListener(type, e => {
    if (type === 'keydown' && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    if (e.key === 'Control' && e.ctrlKey !== copy) { copy = e.ctrlKey; update(false); }
  }, { signal, capture: true });
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame);
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    v.fillOverflow.hidden = true;
  }, { once: true });
}
