import { getStroke } from './vendor/perfect-freehand/index.js';

export function pressureSamples(values, count) {
  if (!Array.isArray(values) || values.length !== count || !values.every(Number.isFinite)) return null;
  return values.map((p) => Math.min(1, Math.max(0, p)));
}

export function freehandPath(item) {
  const samples = item.points.map(([u, v], i) =>
    item.pressures ? [u * item.w, v * item.h, item.pressures[i]] : [u * item.w, v * item.h]
  );
  const outline = getStroke(samples, {
    size: item.lineWidth * 4.25,
    simulatePressure: !item.pressures,
    streamline: 0.5,
    smoothing: 0.5,
    thinning: 0.6,
    easing: (value) => Math.sin((value * Math.PI) / 2),
    last: true
  });
  if (!outline.length) return '';
  const number = (value) => Math.round(value * 100) / 100;
  const vertex = ([x, y]) => number(x) + ' ' + number(y);
  const mid = (a, b) => vertex([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  let path = 'M' + mid(outline.at(-1), outline[0]);
  for (let i = 0; i < outline.length; i++) {
    const next = outline[(i + 1) % outline.length];
    path += 'Q' + vertex(outline[i]) + ' ' + mid(outline[i], next);
  }
  return path + 'Z';
}
