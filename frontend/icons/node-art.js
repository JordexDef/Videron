import { vectors } from './vectors.js';
import { lucideExtra } from './lucide-extra.js';
import { phosphorExtra } from './phosphor-extra.js';

const namespace = 'http://www.w3.org/2000/svg';
export const lockSticker = 'phosphor/lock-key';
export const minNoteRadius = 16;
export const maxNoteRadius = 78;
const badgeSizes = new Set(['small', 'large', 'hidden']);
// Four and eight o'clock leave the upper corners free for lock and pin status.
export const sideBadgeX = Math.sqrt(3) / 2;
export const sideBadgeY = 0.5;
const crowdedBadgeLimits = new Map();

export function contentRadius(note) {
  const length = Math.max(0, note.weight || 0, note.plain?.length || 0, note.type === 'data' ? note.dataText?.length || 0 : 0);
  return minNoteRadius + (maxNoteRadius - minNoteRadius) * (1 - Math.exp(-Math.sqrt(length / 4200)));
}

// Screen-space radius. At overview zoom the markers disappear before they can obscure their node.
export function badgeRadius(r, size, geometry = null, withSideIcons = false) {
  if (size === 'hidden' || r <= 12) return 0;
  const scale = size === 'small' ? 0.75 : size === 'large' ? 1.35 : 1;
  let limit = 0.6;
  if (withSideIcons) {
    // Fit all five possible markers along this silhouette. Cache the unit-size clearance per shape.
    if (!crowdedBadgeLimits.has(geometry)) {
      const anchors = [[-Math.SQRT1_2,-Math.SQRT1_2],[Math.SQRT1_2,-Math.SQRT1_2],[-sideBadgeX,sideBadgeY],[sideBadgeX,sideBadgeY],[0,1]];
      const centres = [];
      for (const [dx,dy] of anchors) {
        const edge = edgeRadius({r:1,geometry},dx,dy);
        const x=edge*dx, y=edge*dy;
        for (const point of centres) limit=Math.min(limit,Math.hypot(x-point.x,y-point.y)*0.47);
        centres.push({x,y});
      }
      crowdedBadgeLimits.set(geometry,limit);
    } else limit=crowdedBadgeLimits.get(geometry);
  }
  const regular = Math.max(8, Math.min(18, r * 0.2));
  return withSideIcons ? Math.min(r * limit / 1.35, regular) * scale : Math.min(r * limit, regular * scale);
}
export const shapeNames = ['circle', 'square', 'diamond', 'triangle', 'pentagon', 'hexagon'];
export const iconChoices = new Map(
  [...vectors, ...lucideExtra, ...phosphorExtra].map(([id, ru, en, layers]) => [
    id,
    {
      id,
      ru,
      en,
      layers,
      outline: id.startsWith('lucide/'),
      paths: null
    }
  ])
);

function polygon(sides, startAngle) {
  const points = [],
    normals = [];
  for (let i = 0; i < sides; i++) {
    const angle = startAngle + (i * 2 * Math.PI) / sides;
    points.push([Math.cos(angle), Math.sin(angle)]);
    const normalAngle = angle + Math.PI / sides;
    normals.push([Math.cos(normalAngle), Math.sin(normalAngle)]);
  }
  return { points, normals, apothem: Math.cos(Math.PI / sides) };
}

const top = -Math.PI / 2;
const geometries = new Map([
  ['circle', null],
  ['square', polygon(4, (-3 * Math.PI) / 4)],
  ['diamond', polygon(4, top)],
  ['triangle', polygon(3, top)],
  ['pentagon', polygon(5, top)],
  ['hexagon', polygon(6, 0)]
]);

export function appearanceOf(note) {
  const source = note.appearance || {};
  const style = {
    shape: geometries.has(source.shape) ? source.shape : 'circle',
    icon: iconChoices.has(source.icon) ? source.icon : null,
    color:
      typeof source.color === 'string' && /^#[\da-f]{6}$/i.test(source.color)
        ? source.color.toLowerCase()
        : null
  };
  if (Number.isInteger(source.radius) && source.radius >= minNoteRadius && source.radius <= maxNoteRadius) style.radius = source.radius;
  if (badgeSizes.has(source.badgeSize)) style.badgeSize = source.badgeSize;
  if (iconChoices.has(source.leftIcon)) style.leftIcon = source.leftIcon;
  if (iconChoices.has(source.rightIcon)) style.rightIcon = source.rightIcon;
  return style;
}

export function validMapAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const style = appearanceOf({appearance:value});
  return Object.entries(value).every(([key, item]) => Object.hasOwn(style,key) &&
    style[key] === (key === 'color' && typeof item === 'string' ? item.toLowerCase() : item));
}

export const geometryFor = (shape) => geometries.get(shape) || null;

export function traceOutline(ctx, geometry, x, y, radius) {
  ctx.beginPath();
  if (!geometry) {
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    return;
  }
  const points = geometry.points;
  ctx.moveTo(x + points[0][0] * radius, y + points[0][1] * radius);
  for (let i = 1; i < points.length; i++)
    ctx.lineTo(x + points[i][0] * radius, y + points[i][1] * radius);
  ctx.closePath();
}

// Distance to the visible edge on the ray from the node centre.
export function edgeRadius(node, dx, dy) {
  if (!node.geometry) return node.r;
  let projection = 0;
  for (const [nx, ny] of node.geometry.normals) projection = Math.max(projection, dx * nx + dy * ny);
  return (node.r * node.geometry.apothem) / Math.max(projection, 1e-9);
}

export function containsPoint(node, dx, dy, slop) {
  if (!node.geometry) return Math.hypot(dx, dy) <= node.r + slop;
  const limit = node.r * node.geometry.apothem + slop;
  return node.geometry.normals.every(([x, y]) => x * dx + y * dy <= limit);
}

function support(geometry, dx, dy) {
  if (!geometry) return 1;
  let max = -Infinity;
  for (const [x, y] of geometry.points) max = Math.max(max, x * dx + y * dy);
  return max;
}

// The primitives have fixed orientations. Projections on their face normals
// depend only on the two shapes and can be scaled to each note's radius.
const faceAxes = new Map([...geometries.values()].map(shape=>[shape,new Map()]));
function axesFor(a,b) {
  const pairs = faceAxes.get(a);
  const cached = pairs?.get(b);
  if (cached) return cached;
  const axes = [];
  for (const shape of [a,b]) for (const [x,y] of shape?.normals || []) {
    axes.push({x,y,aMax:support(a,x,y),aBack:support(a,-x,-y),
      bMax:support(b,x,y),bBack:support(b,-x,-y)});
  }
  if (pairs && faceAxes.has(b)) pairs.set(b,axes);
  return axes;
}

// Test face normals of both polygons. Circle–polygon pairs also need the
// direction towards the nearest vertex to resolve a rounded corner contact.
export function contact(a, b, dx, dy, distance, padding = 0.6) {
  if (distance >= a.r + b.r + padding) return null;
  if (!a.geometry && !b.geometry) return [dx, dy, a.r + b.r + padding - distance];
  const best = [dx, dy, Infinity];
  const test = (nx, ny, aMax, aBack, bMax, bBack) => {
    const projected = (b.x - a.x) * nx + (b.y - a.y) * ny;
    const forward = a.r*aMax + b.r*bBack - projected + padding;
    const backward = a.r*aBack + b.r*bMax + projected + padding;
    const amount = Math.min(forward, backward);
    if (amount <= 0) return false;
    if (amount < best[2]) {
      const direction = forward <= backward ? 1 : -1;
      best[0] = nx * direction;
      best[1] = ny * direction;
      best[2] = amount;
    }
    return true;
  };
  for (const axis of axesFor(a.geometry || null,b.geometry || null)) {
    if (!test(axis.x,axis.y,axis.aMax,axis.aBack,axis.bMax,axis.bBack)) return null;
  }
  if (!a.geometry || !b.geometry) {
    const shape = a.geometry ? a : b,
      circle = a.geometry ? b : a;
    let shortest = Infinity,
      vx = 0,
      vy = 0;
    for (const [x, y] of shape.geometry.points) {
      const ex = shape.x - circle.x + x * shape.r,
        ey = shape.y - circle.y + y * shape.r;
      const squared = ex * ex + ey * ey;
      if (squared < shortest) {
        shortest = squared;
        vx = ex;
        vy = ey;
      }
    }
    const length = Math.sqrt(shortest);
    if (length > 1e-7) {
      const nx = vx/length, ny = vy/length;
      if (!test(nx,ny,support(a.geometry,nx,ny),support(a.geometry,-nx,-ny),
        support(b.geometry,nx,ny),support(b.geometry,-nx,-ny))) return null;
    }
  }
  return best;
}

export function shapeSvg(shape) {
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '-1.15 -1.15 2.3 2.3');
  svg.setAttribute('aria-hidden', 'true');
  const form = geometryFor(shape);
  const outline = document.createElementNS(namespace, form ? 'polygon' : 'circle');
  if (form) outline.setAttribute('points', form.points.map((p) => p.join(',')).join(' '));
  else outline.setAttribute('r', '1');
  outline.setAttribute('stroke', 'currentColor');
  outline.setAttribute('stroke-width', '1.5');
  outline.setAttribute('vector-effect', 'non-scaling-stroke');
  outline.setAttribute('stroke-linejoin', 'round');
  outline.setAttribute('fill', 'none');
  svg.append(outline);
  return svg;
}

export function iconSvg(id) {
  const item = iconChoices.get(id);
  if (!item) return null;
  const svg = document.createElementNS(namespace, 'svg');
  const size = item.outline ? 24 : 256;
  svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
  svg.setAttribute('aria-hidden', 'true');
  if (item.outline) {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  } else svg.setAttribute('fill', 'currentColor');
  for (const [d, opacity] of item.layers) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', d);
    if (opacity !== undefined) path.setAttribute('opacity', opacity);
    svg.append(path);
  }
  return svg;
}

export function drawIcon(ctx, id, x, y, size, color) {
  const item = iconChoices.get(id);
  if (!item || size < 5) return;
  item.paths ??= item.layers.map(([d, alpha = 1]) => ({ path: new Path2D(d), alpha }));
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  const scale = size / (item.outline ? 24 : 256);
  ctx.scale(scale, scale);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = color;
  const parentAlpha = ctx.globalAlpha;
  for (const { path, alpha } of item.paths) {
    ctx.globalAlpha = alpha * parentAlpha;
    if (item.outline) ctx.stroke(path);
    else ctx.fill(path);
  }
  ctx.restore();
}
