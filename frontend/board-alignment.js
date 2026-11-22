// Guides live in world coordinates. The tolerance stays constant on screen.
const anchorPairs = [
  [0, 0],
  [1, 1],
  [0.5, 0.5],
  [0, 1],
  [1, 0]
];

function nearestGuide(moving, targets, axis, tolerance) {
  const dim = axis === 'x' ? 'w' : 'h';
  const across = axis === 'x' ? 'y' : 'x';
  const span = axis === 'x' ? 'h' : 'w';
  let best = null;
  for (const target of targets) {
    const acrossDistance = Math.abs(
      target[across] + target[span] / 2 - moving[across] - moving[span] / 2
    );
    for (const [a, b] of anchorPairs) {
      const at = target[axis] + b * target[dim];
      const offset = at - moving[axis] - a * moving[dim];
      const distance = Math.abs(offset);
      if (distance > tolerance) continue;
      if (
        !best ||
        distance < best.distance ||
        (distance === best.distance && acrossDistance < best.acrossDistance)
      ) {
        best = { at, offset, distance, acrossDistance, target };
      }
    }
  }
  return best;
}

export function alignDrag(guides, box, targets, dx, dy, zoom, axisLocked) {
  const moved = { ...box, x: box.x + dx, y: box.y + dy };
  const x = axisLocked && dx === 0 ? null : nearestGuide(moved, targets, 'x', 5 / zoom);
  const y = axisLocked && dy === 0 ? null : nearestGuide(moved, targets, 'y', 5 / zoom);
  moved.x += x?.offset || 0;
  moved.y += y?.offset || 0;
  const [vertical, horizontal] = guides;
  vertical.hidden = !x;
  horizontal.hidden = !y;
  const margin = 5 / zoom;
  if (x) {
    const from = Math.min(moved.y, x.target.y) - margin;
    vertical.style.left = x.at + 'px';
    vertical.style.top = from + 'px';
    vertical.style.height = Math.max(moved.y + box.h, x.target.y + x.target.h) + margin - from + 'px';
  }
  if (y) {
    const from = Math.min(moved.x, y.target.x) - margin;
    horizontal.style.top = y.at + 'px';
    horizontal.style.left = from + 'px';
    horizontal.style.width = Math.max(moved.x + box.w, y.target.x + y.target.w) + margin - from + 'px';
  }
  return [moved.x - box.x, moved.y - box.y];
}
