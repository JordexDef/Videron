const TAU = 2 * Math.PI;
const margin = 27;
const contentMargin = 8;
export const contourGap = 8;

// A folder owns discs (notes and child contours). Its natural outline is a circle.
// Contact with another folder can use the free margin, but cannot cut into its contents.
export function measureContour(group) {
  const parts = [...group.nodes.map(n => ({x:n.x, y:n.y, r:n.r, weight:1})),
    ...group.children.map(({hull,count,gridBounds}) => ({
      x:hull.x, y:hull.y, r:hull.r, weight:Math.max(1,count), box:gridBounds
    }))];
  if (!parts.length) return {...group.emptyAnchor, r:42, parts:[]};
  let x = 0, y = 0, weight = 0;
  for (const part of parts) {
    x += part.x * part.weight;
    y += part.y * part.weight;
    weight += part.weight;
  }
  x /= weight; y /= weight;
  let r = 0;
  for (const part of parts) r = Math.max(r, Math.hypot(part.x-x, part.y-y) + part.r);
  return {x, y, r:r + margin, parts};
}

// Distance from the centre to a supporting line normal to (nx,ny).
// A grid child occupies its rectangle, including when it is only one row tall.
export function contourSupport(hull, nx, ny, padding = contentMargin) {
  if (!hull.parts.length) return 14 + padding;
  let clearance = 0;
  for (const part of hull.parts) {
    const span = part.box
      ? (Math.abs(nx)*(part.box.right-part.box.left)+Math.abs(ny)*(part.box.bottom-part.box.top))/2
      : part.r;
    clearance = Math.max(clearance, (part.x-hull.x)*nx + (part.y-hull.y)*ny + span);
  }
  return clearance + padding;
}

function addCut(hull, nx, ny, limit, core) {
  if (limit >= hull.r) return;
  (hull.cuts ||= []).push({nx, ny, limit, core});
}

function circleContact(a,b) {
  const dx = b.x-a.x, dy = b.y-a.y, d = Math.hypot(dx,dy);
  if (d >= a.r+b.r+contourGap) return;
  const ux = d > .01 ? dx/d : 1, uy = d > .01 ? dy/d : 0;
  function contact(nx,ny) {
    const distance = dx*nx + dy*ny;
    const coreA = contourSupport(a,nx,ny,0), coreB = contourSupport(b,-nx,-ny,0);
    return {nx,ny,distance,coreA,coreB,room:distance-coreA-coreB};
  }
  let best = contact(ux,uy);
  if (best.room < contourGap && (a.parts.length > 1 || b.parts.length > 1 || a.parts[0]?.box || b.parts[0]?.box)) {
    // An oblique seam can separate two pinned rows even when their projections
    // on the line between their centres overlap.
    for (const degrees of [12,24,36,48,60,72,84]) {
      const radians = degrees*Math.PI/180, c = Math.cos(radians), s = Math.sin(radians);
      for (const t of [s,-s]) {
        const other = contact(ux*c-uy*t, ux*t+uy*c);
        if (other.room > best.room) best = other;
      }
      if (best.room >= contourGap + 2*contentMargin) break;
    }
  }
  const {nx,ny,distance,coreA,coreB,room} = best;
  // A shared seam can slide toward the folder with an empty margin. Cutting
  // each contour independently would let them cross when only one side yields.
  const skin = Math.max(.4, Math.min(contentMargin, (room-contourGap)/2));
  const gap = Math.max(0, Math.min(contourGap,room-2*skin));
  const split = Math.max(coreA+skin+gap/2,
    Math.min(distance-coreB-skin-gap/2, distance*a.r/(a.r+b.r)));
  addCut(a,nx,ny,split-gap/2,coreA+.4);
  addCut(b,-nx,-ny,Math.max(coreB+skin,distance-split-gap/2),coreB+.4);
}

function gridContact(hull,box) {
  const dx = Math.max(box.left,Math.min(hull.x,box.right))-hull.x;
  const dy = Math.max(box.top,Math.min(hull.y,box.bottom))-hull.y;
  const d = Math.hypot(dx,dy);
  if (d > .01 && d < hull.r+contourGap) {
    const nx = dx/d, ny = dy/d, core = contourSupport(hull,nx,ny,0)+.4;
    addCut(hull,nx,ny,Math.max(core,d-contourGap),core);
  }
}

const sampledBoundaries = new WeakMap();

function boundary(group) {
  const hull = group.hull;
  if (!hull.cuts?.length) {
    sampledBoundaries.delete(group);
    return;
  }
  // Distant contacts often stay still throughout a drag. Keep their immutable
  // points; a drag can still hold the previous polygon as its drop target.
  const previous = sampledBoundaries.get(group);
  if (previous && previous.x === hull.x && previous.y === hull.y && previous.r === hull.r &&
      previous.cuts.length === hull.cuts.length && hull.cuts.every((cut,i) => {
        const old = previous.cuts[i];
        return cut.nx === old.nx && cut.ny === old.ny && cut.limit === old.limit && cut.core === old.core;
      })) {
    hull.points = previous.points;
    return;
  }
  // Sample the smooth radial minimum densely enough for the map's maximum zoom.
  const n = Math.min(384, Math.max(72, Math.ceil(5*Math.sqrt(hull.r))));
  const points = [];
  for (let i=0; i<n; i++) {
    const angle = i*TAU/n, nx = Math.cos(angle), ny = Math.sin(angle);
    let radius = hull.r;
    for (const cut of hull.cuts) {
      const towards = nx*cut.nx + ny*cut.ny;
      if (towards <= 0) continue;
      // Bow gently into our own side of the seam. Its allocated gap is clear
      // along the whole contact, including the shoulders.
      const bow = Math.min(3, hull.r*.05)*towards*towards;
      const cap = Math.max(cut.core,cut.limit-bow) / towards;
      // Round the shoulder where the compressed side rejoins the circle.
      const blend = Math.max(0, 8 - Math.abs(hull.r-cap));
      radius = Math.min(radius, Math.max(cut.core/towards, Math.min(hull.r,cap) - blend*blend/32));
    }
    points.push({x:hull.x+nx*radius, y:hull.y+ny*radius});
  }
  hull.points = points;
  sampledBoundaries.set(group,{x:hull.x, y:hull.y, r:hull.r, cuts:hull.cuts, points});
}

export function shapeSiblingContours(groups) {
  const families = new Map();
  for (const group of groups) {
    const key = group.parentId || null;
    if (!families.has(key)) families.set(key,[]);
    const {hull} = group;
    if (hull.cuts) { delete hull.cuts; delete hull.points; }
    const box = group.gridBounds || {left:hull.x-hull.r, right:hull.x+hull.r, top:hull.y-hull.r, bottom:hull.y+hull.r};
    families.get(key).push({group,box});
  }
  // Siblings distant along the x-axis never enter the contact pass.
  for (const family of families.values()) {
    family.sort((a,b)=>a.box.left-b.box.left);
    for (let i=0; i<family.length; i++) {
      const a = family[i];
      for (let j=i+1; j<family.length && family[j].box.left<a.box.right+contourGap; j++) {
        const b = family[j];
        if (a.box.top>b.box.bottom+contourGap || b.box.top>a.box.bottom+contourGap) continue;
        if (a.group.grid && b.group.grid) continue;
        if (a.group.grid) gridContact(b.group.hull,a.box);
        else if (b.group.grid) gridContact(a.group.hull,b.box);
        else circleContact(a.group.hull,b.group.hull);
      }
    }
  }
  for (const group of groups) if (!group.grid) boundary(group);
}

export function insideContour(hull,p) {
  const dx = p.x-hull.x, dy = p.y-hull.y;
  if (dx*dx+dy*dy>hull.r*hull.r) return false;
  if (!hull.points) return true;
  const points = hull.points;
  const angle = Math.atan2(dy,dx);
  const i = Math.min(points.length-1, Math.floor((angle<0?angle+TAU:angle)*points.length/TAU));
  const a = points[i], b = points[(i+1)%points.length];
  return (b.x-a.x)*(p.y-a.y) >= (b.y-a.y)*(p.x-a.x) - 1e-6;
}

export function traceContour(c,hull,ox,oy,z) {
  c.beginPath();
  if (!hull.points) { c.arc(ox+hull.x*z,oy+hull.y*z,hull.r*z,0,TAU); return; }
  const [first] = hull.points;
  c.moveTo(ox+first.x*z,oy+first.y*z);
  for (let i=1; i<hull.points.length; i++) {
    const p = hull.points[i];
    c.lineTo(ox+p.x*z,oy+p.y*z);
  }
  c.closePath();
}

// Find room for a new empty folder. Project obstacle discs/boxes onto the
// horizontal and vertical lines through the requested point, then take the
// closest free exit. A 100×100 grid takes the same work as a single slot.
export function emptyContourAnchor(point, obstacles) {
  const clearance = 54;
  let nearest = null, best = Infinity;
  for (const [axis,across] of [['x','y'],['y','x']]) {
    const spans = [];
    for (const o of obstacles) {
      if ('r' in o) {
        const r = o.r+clearance, offset = o[across]-point[across];
        if (Math.abs(offset) >= r) continue;
        const reach = Math.sqrt(r*r-offset*offset);
        spans.push([o[axis]-reach,o[axis]+reach]);
      } else {
        const horizontal = axis==='x';
        const min = horizontal ? o.top : o.left, max = horizontal ? o.bottom : o.right;
        if (point[across] <= min-clearance || point[across] >= max+clearance) continue;
        spans.push([(horizontal?o.left:o.top)-clearance,(horizontal?o.right:o.bottom)+clearance]);
      }
    }
    spans.sort((a,b)=>a[0]-b[0]);
    const start = point[axis];
    let left = Infinity, right = -Infinity;
    for (const [lo,hi] of spans) {
      if (lo >= right) {
        if (left < start && start < right) break;
        left = lo;
      }
      right = Math.max(right,hi);
    }
    if (start <= left || start >= right) return {...point};
    for (const exit of [right,left]) {
      if (Math.abs(exit-start) >= best) continue;
      nearest = {...point,[axis]:exit};
      best = Math.abs(exit-start);
    }
  }
  return nearest;
}
