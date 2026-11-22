const tiles = new WeakMap();

// Consecutive levels share every second row and column. Keep those dots at
// full opacity while the intermediate ones fade in as the camera approaches.
export function drawMapBackgroundDots(ctx, ox, oy, zoom, width, height, dpr) {
  const base = 26 * zoom;
  const pitch = base * 2 ** Math.ceil(Math.log2(15 / base));
  const progress = Math.max(0, Math.min(1, (pitch - 15) / 15));
  const opacity = Math.round(255 * progress * progress * (3 - 2 * progress));
  const period = pitch * 2;
  // Give each dot the same subpixel phase on both sides of a level change.
  const pixels = 4 * Math.round(period * dpr * 2 / 4);
  let tile = tiles.get(ctx);
  if (!tile || tile.pixels !== pixels || tile.opacity !== opacity || tile.dpr !== dpr) {
    const canvas = tile?.canvas ?? ctx.canvas.ownerDocument.createElement('canvas');
    canvas.width = canvas.height = pixels;
    const ink = canvas.getContext('2d');
    const quarter = pixels / 4;
    for (const x of [quarter, 3 * quarter]) {
      for (const y of [quarter, 3 * quarter]) {
        ink.fillStyle = 'rgba(190,190,190,' + (.16 * (x === quarter && y === quarter ? 1 : opacity / 255)) + ')';
        ink.beginPath();
        ink.arc(x, y, 1.48 * dpr, 0, 2 * Math.PI);
        ink.fill();
      }
    }
    tile = {canvas, pixels, opacity, dpr, pattern:ctx.createPattern(canvas, 'repeat')};
    tiles.set(ctx, tile);
  }
  const scale = period / pixels;
  const x = (ox - pitch / 2) % period, y = (oy - pitch / 2) % period;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = tile.pattern;
  ctx.fillRect(-x / scale, -y / scale, width / scale, height / scale);
  ctx.restore();
}
