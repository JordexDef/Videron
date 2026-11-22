const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// A dragged bend is an interpolation knot. Its two Bézier handles share
// one tangent in drawing coordinates, including after rotation and resizing.
export function connectorSegments(points, smoothPoints = []) {
  const tangents = new Map();
  for (const i of smoothPoints) {
    const before = points[i - 1], knot = points[i], after = points[i + 1];
    if (!before || !knot || !after) continue;
    const ax = knot[0] - before[0], ay = knot[1] - before[1];
    const bx = after[0] - knot[0], by = after[1] - knot[1];
    const a = Math.hypot(ax, ay), b = Math.hypot(bx, by);
    if (!a || !b) continue;
    const length = Math.min(a, b) / 6;
    tangents.set(i, [(ax / a + bx / b) * length, (ay / a + by / b) * length]);
  }
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i];
    const outgoing = tangents.get(i - 1), incoming = tangents.get(i);
    let c1 = outgoing ? [from[0] + outgoing[0], from[1] + outgoing[1]] : null;
    let c2 = incoming ? [to[0] - incoming[0], to[1] - incoming[1]] : null;
    // At the open end of a spline, use a quadratic expressed as a cubic.
    // An isolated bend thus flows from endpoint to endpoint through the handle.
    if (!c1 && c2) c1 = mix(from, mix(to, c2, 1.5), 2 / 3);
    else if (!c2 && c1) c2 = mix(to, mix(from, c1, 1.5), 2 / 3);
    segments.push({ from, to, c1, c2 });
  }
  return segments;
}

export function segmentPoint({ from, to, c1, c2 }, t) {
  if (!c1) return mix(from, to, t);
  const middle = mix(c1, c2, t);
  return mix(mix(mix(from, c1, t), middle, t), mix(middle, mix(c2, to, t), t), t);
}

// A spline can briefly extend beyond its knots near a hairpin. Include
// stationary points so fit-to-content and marquee selection see that ink.
export function segmentExtrema(segment) {
  const { from, to, c1, c2 } = segment, points = [];
  if (!c1) return points;
  for (const axis of [0, 1]) {
    const start = c1[axis] - from[axis], middle = c2[axis] - c1[axis], end = to[axis] - c2[axis];
    const a = start - 2 * middle + end, b = 2 * (middle - start);
    const discriminant = b * b - 4 * a * start;
    if (discriminant < 0) continue;
    const roots = Math.abs(a) < 1e-12 ? [-start / b]
      : [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)];
    for (const t of roots) if (t > 0 && t < 1) points.push(segmentPoint(segment, t));
  }
  return points;
}

export function connectorPath(segments, arrowWidth) {
  if (!segments.length) return '';
  const pos = p => p.join(' ');
  let path = 'M' + pos(segments[0].from);
  for (const { to, c1, c2 } of segments) {
    path += c1 ? 'C' + pos(c1) + ' ' + pos(c2) + ' ' + pos(to) : 'L' + pos(to);
  }
  if (arrowWidth !== undefined) {
    // Imported paths may include a repeated endpoint. Use the last real tangent.
    const segment = segments.findLast(({ from, to }) => from[0] !== to[0] || from[1] !== to[1]);
    if (segment) {
      const { from, to, c2 } = segment;
      const tail = c2 && (c2[0] !== to[0] || c2[1] !== to[1]) ? c2 : from;
      const angle = Math.atan2(to[1] - tail[1], to[0] - tail[0]);
      const length = Math.min(Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.43, Math.max(12, arrowWidth * 4));
      for (const da of [-0.48, 0.48])
        path += 'M' + pos(to) + 'l' + -length * Math.cos(angle + da) + ' ' + -length * Math.sin(angle + da);
    }
  }
  return path;
}
