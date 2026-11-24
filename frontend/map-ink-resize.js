const grips = [
  ['nw', 0, 0, 'nwse-resize'], ['ne', 1, 0, 'nesw-resize'],
  ['sw', 0, 1, 'nesw-resize'], ['se', 1, 1, 'nwse-resize'],
  ['w', 0, .5, 'ew-resize'], ['e', 1, .5, 'ew-resize'],
  ['n', .5, 0, 'ns-resize'], ['s', .5, 1, 'ns-resize']
];

// Keep handles usable on thin strokes and at overview zoom.
function selectionBox(item, zoom) {
  const w = Math.max(item.w + 8 / zoom, 18 / zoom);
  const h = Math.max(item.h + 8 / zoom, 18 / zoom);
  return {x:item.x + (item.w - w) / 2, y:item.y + (item.h - h) / 2, w, h};
}

function handles(item, box, zoom) {
  const result = [];
  for (const [name, u, v, cursor] of grips) {
    if (name.length === 1 && (item.type === 'text' || (u === .5 ? box.w : box.h) * zoom < 36)) continue;
    result.push({name, x:box.x + u * box.w, y:box.y + v * box.h, cursor});
  }
  return result;
}

export function inkHandleAt(item, point, zoom, touch = false) {
  if (!item) return null;
  const box = selectionBox(item, zoom);
  let nearest = null, distance = (touch ? 14 : 8) / zoom;
  if (point.x < box.x - distance || point.x > box.x + box.w + distance ||
      point.y < box.y - distance || point.y > box.y + box.h + distance) return null;
  for (const handle of handles(item, box, zoom)) {
    const d = Math.hypot(point.x - handle.x, point.y - handle.y);
    if (d <= distance) { nearest = handle; distance = d; }
  }
  return nearest;
}

export function paintInkHandles(ctx, item, {ox, oy, zoom}, palette) {
  const box = selectionBox(item, zoom), size = 7 / zoom;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(zoom, zoom);
  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = palette.caption;
  ctx.setLineDash([3 / zoom, 4 / zoom]);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([]);
  ctx.strokeStyle = palette.ink;
  ctx.fillStyle = palette.badge;
  for (const handle of handles(item, box, zoom)) {
    ctx.fillRect(handle.x - size / 2, handle.y - size / 2, size, size);
    ctx.strokeRect(handle.x - size / 2, handle.y - size / 2, size, size);
  }
  ctx.restore();
}

export function resizeMapInk(item, handle, dx, dy, keepRatio) {
  const hx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const hy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  // Start from pointer displacement so clicking anywhere in the handle never shifts the shape.
  let w = item.w + dx * hx, h = item.h + dy * hy, fontSize = item.fontSize;
  if (keepRatio || item.type === 'text') {
    let scale = !hx ? h / item.h : !hy ? w / item.w :
      (w * item.w + h * item.h) / (item.w * item.w + item.h * item.h);
    scale = Math.max(scale, 1 / Math.max(item.w, item.h));
    if (item.type === 'text') {
      const previous = item.fontSize || 22;
      fontSize = Math.min(180, Math.max(8, previous * scale));
      scale = fontSize / previous;
    }
    w = Math.max(1, item.w * scale);
    h = Math.max(1, item.h * scale);
  } else {
    w = Math.max(1, w);
    h = Math.max(1, h);
  }
  if (w === item.w && h === item.h) return item;
  const x = item.x + (item.w - w) * (1 - hx) / 2;
  const y = item.y + (item.h - h) * (1 - hy) / 2;
  const resized = {...item, x, y, w, h};
  if (item.type === 'text') resized.fontSize = fontSize;
  return resized;
}
