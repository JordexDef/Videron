export function seedFromId(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash & 0x7fffffff || 1;
}

export function boxFromPoints(points) {
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
export function pointsInBox(points) {
  const box = boxFromPoints(points);
  return { ...box, points: points.map(([x, y]) => [(x - box.x) / box.w, (y - box.y) / box.h]) };
}
