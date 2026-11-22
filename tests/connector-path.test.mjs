import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorPath, connectorSegments, segmentExtrema, segmentPoint } from '../frontend/connector-path.js';
import { normalizeBoard } from '../frontend/board.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, a + ' differs from ' + b);
const closePoint = (a, b) => a.forEach((v, axis) => close(v, b[axis]));

test('midpoint bend interpolates the dragged position and has a continuous tangent', () => {
  const [a, b] = connectorSegments([[0, 0], [100, -75], [200, 0]], [1]);
  assert.deepEqual(a.to, [100, -75]);
  assert.deepEqual(b.from, a.to);
  closePoint(a.c2.map((v, i) => a.to[i] - v), b.c1.map((v, i) => v - b.from[i]));
  closePoint(segmentPoint(a, 0.5), [50, -56.25]);
  closePoint(segmentPoint(b, 0.5), [150, -56.25]);
  assert.deepEqual(segmentPoint(a, 0), a.from);
  assert.deepEqual(segmentPoint(b, 1), b.to);
});

test('corner knots stay sharp beside curves, legacy polylines stay straight', () => {
  const knots = [[0, 0], [70, -35], [100, 50], [140, 45], [130, -10]];
  const segments = connectorSegments(knots, [1]);
  assert.ok(segments[0].c1 && segments[1].c2);
  assert.equal(segments[2].c1, null);
  assert.equal(segments[3].c1, null);
  assert.equal(connectorPath(connectorSegments(knots)), 'M0 0L70 -35L100 50L140 45L130 -10');
  const imported = normalizeBoard({ elements: [{id:'line', type:'line',
    points:[[0,0], null, [0.2,0.1], [0.4,0.8], [1,1]], smoothPoints:[0,1,3,2,2,4,300]}] });
  assert.deepEqual(imported.elements[0].smoothPoints, [1, 2]);
  assert.deepEqual(normalizeBoard(imported), imported);
});

test('tangent-oriented arrowheads survive coincident anchors and rotation', () => {
  const knots = [[5, 3], [6, 6], [13, 7]];
  const segments = connectorSegments(knots, [1]);
  const last = segments.at(-1);
  const arrow = connectorPath(segments, 2);
  const wings = [...arrow.matchAll(/M13 7l([^ ]+) ([^M]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.equal(wings.length, 2);
  const axis = wings[0].map((v, i) => -(v + wings[1][i]));
  const direction = last.to.map((v, i) => v - last.c2[i]);
  close(axis[0] * direction[1] - axis[1] * direction[0], 0);
  assert.ok(axis[0] * direction[0] + axis[1] * direction[1] > 0);
  const turn = ([x, y]) => [37 - y, 11 + x];
  const rotated = connectorSegments(knots.map(turn), [1]);
  for (let i = 0; i < segments.length; i++) {
    closePoint(segmentPoint(rotated[i], .4), turn(segmentPoint(segments[i], .4)));
  }
  const repeated = connectorSegments([...knots, knots.at(-1)], [1, 2]);
  assert.doesNotMatch(connectorPath(repeated, 2), /NaN|Infinity/);
});

test('fit bounds include curved excursions beyond the editable knots', () => {
  const s = connectorSegments([[40, 5], [47, 34], [33, 33], [14, 43]], [1, 2]);
  for (const part of s) {
    const bounds = [part.from, ...segmentExtrema(part), part.to];
    for (const axis of [0, 1]) {
      const lo = Math.min(...bounds.map(p => p[axis])), hi = Math.max(...bounds.map(p => p[axis]));
      for (let i = 0; i <= 100; i++) {
        const point = segmentPoint(part, i / 100);
        assert.ok(point[axis] >= lo - 1e-8 && point[axis] <= hi + 1e-8);
      }
    }
  }
});
