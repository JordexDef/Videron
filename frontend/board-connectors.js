// Coordinates are normalized to an unrotated element. Distances are measured
// in world units, so elongated and rotated shapes use the same screen tolerance.
const rect = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1]
];
const diamond = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5]
];
const halfway = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const landmarks = (vertices) =>
  vertices.flatMap((a, i) => [a, halfway(a, vertices[(i + 1) % vertices.length])]);
const rectMagnets = landmarks(rect);
const diamondMagnets = landmarks(diamond);
const ellipseMagnets = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  return [(1 + Math.cos(a)) / 2, (1 + Math.sin(a)) / 2];
});

export function roundedCorners(vertices) {
  function approach([x, y], [tx, ty]) {
    const amount = Math.min(0.24, 12 / Math.hypot(tx - x, ty - y));
    return [x + (tx - x) * amount, y + (ty - y) * amount];
  }
  return vertices.map((corner, i) => ({
    before: approach(corner, vertices[(i + vertices.length - 1) % vertices.length]),
    corner,
    after: approach(corner, vertices[(i + 1) % vertices.length])
  }));
}

const roundedCache = new WeakMap();
function roundedGeometry(shape) {
  let geometry = roundedCache.get(shape);
  if (geometry) return geometry;
  const { w, h } = shape;
  const vertices = shape.type === 'diamond' ? diamond : rect;
  const curves = roundedCorners(vertices.map(([u, v]) => [u * w, v * h]));
  const sites = [],
    outline = [];
  for (const [i, { before, corner, after }] of curves.entries()) {
    // Twelve segments keep the freely sliding anchor within 0.05 world units
    // of the quadratic stroke. The halfway magnet lies exactly on the curve.
    for (let j = 0; j <= 12; j++) {
      const t = j / 12,
        s = 1 - t;
      const q = [
        (s * s * before[0] + 2 * s * t * corner[0] + t * t * after[0]) / w,
        (s * s * before[1] + 2 * s * t * corner[1] + t * t * after[1]) / h
      ];
      outline.push(q);
      if (j === 6) sites.push(q);
    }
    sites.push(halfway(vertices[i], vertices[(i + 1) % vertices.length]));
  }
  geometry = { sites, outline };
  roundedCache.set(shape, geometry);
  return geometry;
}

export function magnets(shape) {
  if (shape.type === 'ellipse') return ellipseMagnets;
  if (shape.rounded && (shape.type === 'rect' || shape.type === 'diamond'))
    return roundedGeometry(shape).sites;
  return shape.type === 'diamond' ? diamondMagnets : rectMagnets;
}

function closestOnPolygon(vertices, u, v, w, h) {
  let best,
    distance = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i],
      b = vertices[(i + 1) % vertices.length];
    const dx = (b[0] - a[0]) * w,
      dy = (b[1] - a[1]) * h;
    const fraction = ((u - a[0]) * w * dx + (v - a[1]) * h * dy) / (dx * dx + dy * dy);
    const t = Math.max(0, Math.min(1, fraction));
    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const d = Math.hypot((u - q[0]) * w, (v - q[1]) * h);
    if (d < distance) {
      distance = d;
      best = q;
    }
  }
  return best;
}

function closestOnEllipse(u, v, w, h) {
  const sx = u < 0.5 ? -1 : 1,
    sy = v < 0.5 ? -1 : 1;
  const px = Math.abs((u - 0.5) * w),
    py = Math.abs((v - 0.5) * h);
  const distance = (a) => ((w / 2) * Math.cos(a) - px) ** 2 + ((h / 2) * Math.sin(a) - py) ** 2;
  let lo = 0,
    hi = Math.PI / 2;
  for (let i = 0; i < 30; i++) {
    const a = (2 * lo + hi) / 3,
      b = (lo + 2 * hi) / 3;
    if (distance(a) < distance(b)) hi = b;
    else lo = a;
  }
  const angle = (lo + hi) / 2;
  return [(1 + sx * Math.cos(angle)) / 2, (1 + sy * Math.sin(angle)) / 2];
}

export function bindingPoint(shape, u, v, zoom) {
  const { w, h, type } = shape;
  const reach = 14 / zoom;
  if (u * w < -reach || v * h < -reach || (u - 1) * w > reach || (v - 1) * h > reach) return null;
  let best,
    shortest = 11 / zoom;
  for (const m of magnets(shape)) {
    const distance = Math.hypot((u - m[0]) * w, (v - m[1]) * h);
    if (distance <= shortest) {
      best = m;
      shortest = distance;
    }
  }
  if (best) return best;
  const x = Math.abs(2 * u - 1),
    y = Math.abs(2 * v - 1);
  const rounded = shape.rounded && (type === 'rect' || type === 'diamond') && roundedGeometry(shape);
  const inside = rounded
    ? rounded.outline.every(([ax, ay], i) => {
        const [bx, by] = rounded.outline[(i + 1) % rounded.outline.length];
        return (bx - ax) * (v - ay) - (by - ay) * (u - ax) >= -1e-10;
      })
    : type === 'ellipse'
      ? x * x + y * y <= 1
      : type === 'diamond'
        ? x + y <= 1
        : Math.max(x, y) <= 1;
  const q =
    type === 'ellipse'
      ? closestOnEllipse(u, v, w, h)
      : closestOnPolygon(rounded?.outline || (type === 'diamond' ? diamond : rect), u, v, w, h);
  return inside || Math.hypot((u - q[0]) * w, (v - q[1]) * h) <= reach ? q : null;
}
