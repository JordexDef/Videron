import { tr } from './i18n.js';
import { defaultMapView } from './data.js';
import { areaTreeRows } from './areas.js';
import { gridRowSpacing, gridSpacing, planGridSlots, slotPoint, validSlot } from './area-grid.js';
import { slotAt, slotGridBounds, gridFocusCamera, drawSlotGrid, drawGridGrip, draggedGridSpacing, stageHandleAt, stageTitleAt } from './map-slots.js';
import { shapeSiblingContours, insideContour, traceContour, emptyContourAnchor } from './map-contours.js';
import { contourLabelPositions } from './contour-label.js';
import { drawMapBackgroundDots } from './map-background.js';
import { paintMapNote } from './map-note-paint.js';
import { dragPaintLayer, releaseDragPaint } from './map-drag-paint.js';
import { MapZoomPreview } from './map-zoom-preview.js';
import { areaContactFamilies, measureAreaHulls, separateAreaSiblings } from './area-physics.js';
import { intersectsNote, mapAreaButton, selectionRect } from './map-selection.js';
import { appearanceOf, contact, containsPoint, edgeRadius, geometryFor } from './icons/node-art.js';

const ACCENT = '#ededed';
const NEUTRAL = '#b3b3b3';
const TAU = Math.PI * 2;
const STEP_MS = 1000 / 60;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const extendsSelection = event => event.shiftKey || event.ctrlKey || event.metaKey;

function rgb(color, fallback = NEUTRAL) {
  let hex = String(color || '').trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) hex = '#' + [...hex.slice(1)].map(x => x + x).join('');
  if (!/^#[0-9a-f]{6}$/i.test(hex)) hex = fallback;
  const value = parseInt(hex.slice(1), 16);
  return `${value >> 16},${(value >> 8) & 255},${value & 255}`;
}

const rgba = (color, alpha) => `rgba(${color},${alpha})`;
const tethered = (node, drag) => node.pinned || node.seated || !!drag?.held?.has(node.id);
const noteGap = (a, b) => 6 + 0.14 * Math.min(a.r, b.r);

function radius(note) {
  const length = Math.max(0, note.weight || 0, note.plain?.length || 0, note.type==='data' ? note.dataText?.length || 0 : 0);
  return 16 + 62 * (1 - Math.exp(-Math.sqrt(length / 4200)));
}

function seatedRadius(natural, grid) {
  // Compress only notes approaching the room available in the smaller axis.
  // Smaller notes keep their visual size while their seats move closer.
  const largest = (Math.min(gridSpacing(grid),gridRowSpacing(grid))-6)/2.14;
  if (largest >= 78) return natural;
  const threshold = largest*.75;
  if (natural <= threshold) return natural;
  return threshold + (natural-threshold)*(largest-threshold)/(78-threshold);
}

function spatialCell(grid, x, y) {
  let column = grid.get(x);
  if (!column) grid.set(x, column = new Map());
  let cell = column.get(y);
  if (!cell) column.set(y, cell = []);
  return cell;
}

const mapLabelMetrics = new WeakMap();
function measureMapLabel(ctx, text, owner) {
  const cached = owner && mapLabelMetrics.get(owner);
  if (cached && cached.text === text) return cached;
  let label = text;
  if (text.length > 28) {
    // 58 UTF-16 units cover at least 29 code points, even for a title made of emoji.
    const prefix = Array.from(text.slice(0, 58));
    if (prefix.length > 28) label = prefix.slice(0, 27).join('') + '…';
  }
  const metrics = {text, label, width:ctx.measureText(label).width};
  if (owner) mapLabelMetrics.set(owner,metrics);
  return metrics;
}

function unitVector(a, b) {
  const x = b.x - a.x, y = b.y - a.y;
  const length = Math.hypot(x, y);
  if (length > 0.0001) return [x / length, y / length, length];
  // A stable direction also separates notes created at identical coordinates.
  const angle = (a.index * 2.39996 + b.index * 4.13) % TAU;
  return [Math.cos(angle), Math.sin(angle), 0];
}

// Most maps occupy a compact rectangle. A flat lookup avoids nine hash
// lookups per note per pass there. Widely separated notes keep the sparse grid.
const contactGrids = new WeakMap();
function denseContactGrid(nodes,cellSize) {
  if (nodes.size < 128) return null;
  let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
  for (const n of nodes.values()) {
    left=Math.min(left,n.x);right=Math.max(right,n.x);
    top=Math.min(top,n.y);bottom=Math.max(bottom,n.y);
  }
  left=Math.floor(left/cellSize)-1;top=Math.floor(top/cellSize)-1;
  const cols=Math.floor(right/cellSize)-left+2, rows=Math.floor(bottom/cellSize)-top+2;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(top) || cols*rows > nodes.size*4) return null;
  let grid=contactGrids.get(nodes);
  if (!grid) contactGrids.set(nodes,grid={cells:[],used:[]});
  for (const cell of grid.used) cell.length=0;
  grid.used.length=0;
  grid.left=left;grid.top=top;grid.rows=rows;
  return grid;
}

function relaxNoteContacts(nodes, cellSize) {
  const grid = denseContactGrid(nodes,cellSize);
  const cells = grid ? null : new Map();
  let worst = 0;
  for (const n of nodes.values()) {
    const cx = Math.floor(n.x / cellSize), cy = Math.floor(n.y / cellSize);
    for (let col = -1; col <= 1; col++) {
      const ix=cx+col;
      const column = grid ? null : cells.get(ix);
      if (!grid && !column) continue;
      const start = grid ? (ix-grid.left)*grid.rows-grid.top : 0;
      for (let row = -1; row <= 1; row++) {
        const iy=cy+row;
        const neighbours = grid ? grid.cells[start+iy] : column.get(iy);
        if (!neighbours) continue;
        for (const other of neighbours) {
          if (n.stepFixed && other.stepFixed) continue;
          const gap = noteGap(n,other), reach = n.r + other.r + gap;
          const x=other.x-n.x, y=other.y-n.y;
          const squared=x*x+y*y;
          if (squared >= reach*reach) continue;
          // Accepted contacts are within two note radii; the square root
          // cannot overflow and the circular case needs no temporary vector.
          let distance=Math.sqrt(squared), nx, ny;
          if (distance > .0001) {nx=x/distance;ny=y/distance}
          else [nx,ny,distance]=unitVector(n,other);
          let overlap=reach-distance;
          if (n.geometry || other.geometry) {
            const collision = contact(n,other,nx,ny,distance,gap);
            if (!collision) continue;
            [nx,ny,overlap] = collision;
          }
          if (overlap < 0.04) continue;
          worst = Math.max(worst,overlap);
          const share = n.stepFixed || other.stepFixed ? 1 : 0.5;
          const correction = share * overlap;
          // Drop only the relative speed pushing the outlines together.
          // Tangential motion can still slide one note past another.
          const impulse = share * Math.max(0, (n.vx-other.vx)*nx + (n.vy-other.vy)*ny);
          if (!n.stepFixed) {
            n.x -= nx*correction; n.y -= ny*correction;
            n.vx -= nx*impulse; n.vy -= ny*impulse;
          }
          if (!other.stepFixed) {
            other.x += nx*correction; other.y += ny*correction;
            other.vx += nx*impulse; other.vy += ny*impulse;
          }
        }
      }
    }
    if (grid) {
      const index=(cx-grid.left)*grid.rows+cy-grid.top;
      const bucket=grid.cells[index] ??= [];
      if (!bucket.length) grid.used.push(bucket);
      bucket.push(n);
    } else spatialCell(cells,cx,cy).push(n);
  }
  return worst;
}

export class Graph {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.zoomPreview = new MapZoomPreview(canvas,()=>this.repaint());
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.callbacks = callbacks;
    this.nodes = new Map();
    this.edges = [];
    this.groups = [];
    this.gridLabels = [];
    this.stageHeaders = [];
    this.tagSets = [];
    this.heating = new Set();
    this.view = {...defaultMapView};
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.target = null;
    this.width = 1;
    this.height = 1;
    this.tool = 'select';
    this.selectedIds = new Set();
    this.selectedGridId = null;
    this.areaAction = callbacks.onAreaAction && mapAreaButton(canvas, anchor => {
      if (this.selectedIds.size) callbacks.onAreaAction([...this.selectedIds], anchor);
    });
    this.hover = null;
    this.contacts = new Map();
    this.frame = 0;
    this.remaining = 0;
    this.rest = 0;
    this.lastTime = null;
    this.accumulator = 0;
    this.controller = new AbortController();
    const listen = (el, event, fn, options = {}) => el.addEventListener(event, fn, {
      ...options, signal: this.controller.signal
    });
    canvas.style.touchAction = 'none';
    listen(canvas, 'pointerdown', e => this.pointerDown(e));
    listen(canvas, 'pointermove', e => this.queuePointerMove(e));
    listen(canvas, 'pointerup', e => this.pointerUp(e));
    listen(canvas, 'pointercancel', e => this.pointerUp(e, true));
    listen(canvas, 'lostpointercapture', e => {
      if (this.contacts.has(e.pointerId)) this.pointerUp(e, true);
    });
    listen(canvas, 'pointerleave', e => {
      if (!this.drag && e.pointerType!=='touch') {
        this.hover = this.hoverGrid = this.hoverSeat = this.hoverGrip = this.hoverGridArea = this.hoverStage = this.hoverHandle = null;
        this.updateCursor(); this.repaint();
      }
    });
    listen(document,'pointerdown',e=>{
      if(e.pointerType==='touch' && e.target!==canvas && this.hoverStage!=null){
        this.hoverStage=this.hoverHandle=null;this.repaint();
      }
    },{capture:true});
    listen(canvas, 'dblclick', e => this.doubleClick(e));
    listen(canvas, 'contextmenu', e => this.contextMenu(e));
    listen(canvas, 'wheel', e => this.wheel(e), { passive: false });
    listen(canvas, 'keydown', e => {
      if (e.key === 'Escape' && (this.drag || this.pinch)) {
        e.preventDefault(); e.stopPropagation(); this.cancelDrag(); return;
      }
      if (this.tool !== 'select' || this.linking || e.altKey) return;
      if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); e.stopPropagation();
        this.changeSelection(new Set(this.nodes.keys()));
      } else if (e.code === 'Space' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); this.spacePan = true; this.updateCursor();
      }
    });
    const releaseSpace = () => { this.spacePan = false; this.updateCursor(); };
    listen(window, 'keyup', e => { if (e.code === 'Space' && this.spacePan) releaseSpace(); });
    listen(canvas, 'blur', releaseSpace);
    listen(window, 'blur', () => this.cancelDrag());
    const suspend = () => { this.cancelDrag(); this.flushPositions(); };
    listen(window, 'pagehide', suspend);
    listen(document, 'visibilitychange', () => { if (document.hidden) suspend(); });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    listen(window, 'resize', () => this.resize());
    this.resize();
    this.updateCursor();
  }

  get zoom() { return this.camera.zoom; }

  setView(options) {
    const layoutChanged = typeof options.manualLayout === 'boolean' && options.manualLayout !== this.view.manualLayout;
    if (layoutChanged && this.drag) this.cancelDrag();
    for (const key of Object.keys(defaultMapView)) {
      if (typeof options[key] === 'boolean') this.view[key] = options[key];
    }
    if (layoutChanged) {
      if (this.view.manualLayout) {
        this.flushPositions();
        for (const n of this.nodes.values()) n.vx = n.vy = 0;
      }
      this.accumulator = 0;
      this.wake();
    } else this.repaint();
  }

  worldCenter() { return { x: this.camera.x, y: this.camera.y }; }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const w = Math.round(this.width * this.dpr), h = Math.round(this.height * this.dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.repaint();
  }

  setData(notes, areas, placementIds = null) {
    if (this.drag?.noteIds || this.drag?.grid || this.drag?.stage) this.cancelDrag();
    this.measuredGroups = null;
    this.hoverGrid = this.hoverSeat = this.hoverGrip = this.hoverGridArea = this.hoverStage = this.hoverHandle = null;
    this.gridLabels = [];
    this.stageHeaders = [];
    // A placement keeps the same records and their links. Preserve simulation
    // objects and skip normalizing unrelated notes, including their icon and tags.
    const placementOnly = placementIds && this.nodes.size === notes.length &&
      notes.every((note,index) => this.nodes.get(note.id)?.index === index);
    const next = placementOnly ? this.nodes : new Map();
    const previousAreas=new Map((this.groups || []).map(g=>[g.id,g]));
    if (!placementOnly) this.heating.clear();
    const areaMap = new Map(areaTreeRows(areas).map(({area,depth}) =>
      [area.id, {...area,depth,tint:rgb(area.color),nodes:[],nodesBySlot:null,children:[],count:0}]));
    let changed = this.nodes.size !== notes.length || previousAreas.size !== areas.length;
    let placementLayoutChanged = false;
    notes.forEach((note, index) => {
      let node = this.nodes.get(note.id);
      const group = areaMap.get(note.areaId);
      if (placementOnly && !placementIds.has(note.id)) {
        if (group) group.nodes.push(node);
        return;
      }
      const seated = validSlot(group?.grid,note.slot);
      const seat = seated && slotPoint(group.grid,note.slot);
      const x = seated ? seat.x : Number.isFinite(note.x) ? note.x : Math.cos(index * 2.4) * 52 * Math.sqrt(index);
      const y = seated ? seat.y : Number.isFinite(note.y) ? note.y : Math.sin(index * 2.4) * 52 * Math.sqrt(index);
      const tags = [...new Set((note.tags || []).map(t => String(t).replace(/^#/, '').toLowerCase()).filter(Boolean))];
      const links = [...new Set(note.links || [])];
      const appearance = appearanceOf(note);
      const naturalRadius = radius(note), r = seated ? seatedRadius(naturalRadius,group.grid) : naturalRadius;
      const layoutKey = JSON.stringify([tags, links, !!note.pinned, note.areaId, seated, r, appearance.shape]);
      const heatTarget = 1 - Math.exp(-Math.max(0, Number(note.opens) || 0) / 10);
      const title = note.title || tr('Без названия', 'Untitled');
      const appearanceAndLayout = {
        index, title, inputX: x, inputY: y,
        r, naturalRadius, pinned: !!note.pinned, areaId:note.areaId ?? null, slot:note.slot, seated, tags, links, layoutKey,
        geometry: geometryFor(appearance.shape), icon: appearance.icon, customColor: !!appearance.color,
        tint: appearance.color ? rgb(appearance.color) : group?.tint || rgb(note.color),
        heatTarget, heat: node?.heat ?? heatTarget
      };
      if (node) {
        if (node.index !== index) changed = true;
        if ((seated && (x!==node.x || y!==node.y)) || (x !== node.inputX || y !== node.inputY) &&
            (Math.abs(x - node.savedX) > 0.06 || Math.abs(y - node.savedY) > 0.06)) {
          Object.assign(node, {x,y,savedX:x,savedY:y,vx:0,vy:0});
          changed = true;
        }
        if (node.layoutKey !== layoutKey) {
          changed = true;
          placementLayoutChanged = true;
        }
        if (node.title !== title) mapLabelMetrics.delete(node);
        Object.assign(node,appearanceAndLayout);
      } else {
        // Allocate the full simulation record together. These fields are read
        // for every edge and potential contact, several times per frame.
        node = {id:note.id,x,y,vx:0,vy:0,savedX:x,savedY:y,stepX:x,stepY:y,
          restX:x,restY:y,stepFixed:false,...appearanceAndLayout};
        changed = true;
      }
      if (group) group.nodes.push(node);
      if (node.heat !== heatTarget) this.heating.add(node);
      next.set(node.id, node);
    });
    this.nodes = next;
    const ordered = [...areaMap.values()];
    // Folders from older projects can be empty and have no saved map anchor.
    // Give them a stable landing point near their parent, including on an empty map.
    ordered.forEach((group,i) => {
      const parent = areaMap.get(group.parentId);
      const origin = parent?.grid || parent?.nodes[0] || parent?.emptyAnchor || {x:0,y:0};
      const angle = i*2.39996, distance = 120 + 40*Math.sqrt(i);
      const anchor=Number.isFinite(group.anchor?.x) && Number.isFinite(group.anchor?.y)
        ? group.anchor : {x:origin.x+Math.cos(angle)*distance, y:origin.y+Math.sin(angle)*distance};
      const previous=previousAreas.get(group.id);
      group.layoutKey=JSON.stringify([group.parentId,group.grid,group.anchor]);
      if (group.layoutKey!==previous?.layoutKey) changed=true;
      group.emptyAnchor=group.layoutKey===previous?.layoutKey && !previous.count
        ? {...previous.emptyAnchor} : {...anchor};
    });
    for (const group of [...ordered].reverse()) {
      group.count += group.nodes.length;
      const parent = areaMap.get(group.parentId);
      if (parent && parent.depth < group.depth) {
        parent.children.push(group);
        parent.count += group.count;
      }
    }
    this.groups = ordered;
    this.areaFamilies=areaContactFamilies(ordered);
    if (this.selectedGridId && !areaMap.get(this.selectedGridId)?.grid) {
      this.changeSelection(new Set());
    } else if ([...this.selectedIds].some(id => !next.has(id))) {
      this.changeSelection(new Set([...this.selectedIds].filter(id => next.has(id))));
    }
    if (this.hover && !next.has(this.hover)) this.hover = null;
    if (this.linkSource && !next.has(this.linkSource)) this.linkSource = null;
    if (this.drag?.node && !next.has(this.drag.node.id)) this.cancelDrag();
    if (changed) {
      if (!placementOnly) this.buildEdges();
      else if (placementLayoutChanged) this.refreshEdgeForces();
      this.wake();
    }
    this.repaint();
  }

  buildEdges() {
    const unique = new Map();
    const tags = new Map();
    this.sharedTags = [];
    const add = (a, b, manual) => {
      if (!b || a === b) return;
      const key = a.index < b.index ? a.index + '/' + b.index : b.index + '/' + a.index;
      const edge = unique.get(key);
      if (edge) edge.manual ||= manual;
      else unique.set(key, {a,b,manual,strength:0,maxPull:0,gap:0});
    };
    for (const node of this.nodes.values()) {
      for (const id of node.links) add(node, this.nodes.get(id), true);
      for (const tag of node.tags) {
        if (!tags.has(tag)) tags.set(tag, []);
        tags.get(tag).push(node);
      }
    }
    for (const members of tags.values()) {
      if (members.length <= 6) {
        for (let i = 0; i < members.length; i++)
          for (let j = i + 1; j < members.length; j++) add(members[i], members[j], false);
      } else {
        this.sharedTags.push(members);
        for (let i = 0; i < members.length; i++) add(members[i], members[(i + 1) % members.length], false);
      }
    }
    this.edges = [...unique.values()];
    this.refreshEdgeForces();
  }

  refreshEdgeForces() {
    // Ring links follow the tag across folders. Only members in the same
    // folder share a centre of attraction, including after a folder drop.
    this.tagSets = [];
    for (const members of this.sharedTags || []) {
      const local = new Map();
      for (const note of members) {
        if (!local.has(note.areaId)) local.set(note.areaId, []);
        local.get(note.areaId).push(note);
      }
      for (const peers of local.values()) if (peers.length > 1) this.tagSets.push(peers);
    }
    const internalDegree = new Uint32Array(this.nodes.size), externalDegree = new Uint32Array(this.nodes.size);
    for (const {a,b} of this.edges) {
      const degree = a.areaId === b.areaId ? internalDegree : externalDegree;
      degree[a.index]++; degree[b.index]++;
    }
    for (const edge of this.edges) {
      const {a,b} = edge, external = a.areaId !== b.areaId;
      const degree = external ? externalDegree : internalDegree;
      const count = Math.max(degree[a.index], degree[b.index]);
      // Keep the total pull bounded even when every member of one area is
      // linked to the same note in another. Both ends get the same force.
      const scale = external ? 1 / count : Math.min(1, 2 / count);
      edge.strength = (external ? 0.004 : 0.021) * scale;
      edge.maxPull = (external ? 0.55 : 8) * scale;
      edge.gap = noteGap(a,b) + (external ? 26 : 4);
    }
    this.cellSize = 40;
    for (const n of this.nodes.values()) this.cellSize = Math.max(this.cellSize, n.r * 2 + noteGap(n,n));
  }

  wake() {
    this.remaining = this.view?.manualLayout ? 0 : 720;
    this.rest = 0;
    this.repaint();
  }

  step() {
    if (this.view?.manualLayout) return;
    this.measuredGroups = null;
    releaseDragPaint(this.drag);
    const drag = this.drag;
    for (const n of this.nodes.values()) n.stepFixed = tethered(n,drag);
    for (const { a, b, strength, maxPull, gap } of this.edges) {
      if (a.stepFixed && b.stepFixed) continue;
      const [dx, dy, distance] = unitVector(a, b);
      const extension = distance - edgeRadius(a,dx,dy) - edgeRadius(b,-dx,-dy) - gap;
      if (extension <= 0.15) continue;
      const pull = Math.min(extension * strength, maxPull);
      if (!a.stepFixed) { a.vx += dx * pull; a.vy += dy * pull; }
      if (!b.stepFixed) { b.vx -= dx * pull; b.vy -= dy * pull; }
    }
    const gather = (members, factor) => {
      let x = 0, y = 0, area = 0;
      for (const n of members) {
        x += n.x; y += n.y;
        const paddedRadius = n.r + noteGap(n,n) / 2;
        area += paddedRadius * paddedRadius;
      }
      x /= members.length; y /= members.length;
      const extent = Math.sqrt(area) * 1.2;
      let totalX = 0, totalY = 0;
      for (const n of members) {
        const dx = x - n.x, dy = y - n.y, d = Math.hypot(dx, dy);
        const extension = d + n.r - extent;
        if (!d || extension <= 0) continue;
        const pull = Math.min(extension * factor, 1.75) / d;
        const fx = dx * pull, fy = dy * pull;
        totalX += fx; totalY += fy;
        if (!n.stepFixed) { n.vx += fx; n.vy += fy; }
      }
      // Each pull toward the group's moving centre has an equal reaction
      // shared by its members. A pin or the pointer absorbs its own share.
      const reactionX = totalX / members.length, reactionY = totalY / members.length;
      for (const n of members) if (!n.stepFixed) {
        n.vx -= reactionX; n.vy -= reactionY;
      }
    };
    for (const group of this.groups) if (!group.grid && group.nodes.length > 1) gather(group.nodes, 0.008);
    for (const group of this.tagSets) gather(group, 0.005);
    let movable = false;
    for (const n of this.nodes.values()) {
      n.stepX = n.x; n.stepY = n.y;
      if (n.stepFixed) n.vx = n.vy = 0;
      else {
        movable = true;
        n.vx = clamp(n.vx * 0.76, -22, 22);
        n.vy = clamp(n.vy * 0.76, -22, 22);
        n.x += n.vx; n.y += n.vy;
      }
    }
    // Area pressure can push mobile members against a pinned note in the same
    // branch. Resolve the note contacts after both integration and area motion.
    const emptyMovement = drag?.held || drag?.noteIds || drag?.grid ? 0 : separateAreaSiblings(this.groups,this.areaFamilies);
    // Revisit contacts disturbed by adjacent pairs in dense clusters.
    if (movable) {
      for (let pass = 0; pass < 4; pass++) {
        if (relaxNoteContacts(this.nodes,this.cellSize) < 0.3) break;
      }
    }
    // Pressed notes can oscillate by a fraction of a pixel. Check how far
    // they travel over a window so a slow, steady drift still keeps running.
    let movement = 0;
    for (const n of this.nodes.values()) {
      if (!this.rest) { n.restX = n.stepX; n.restY = n.stepY; }
      movement = Math.max(movement, Math.abs(n.x - n.restX), Math.abs(n.y - n.restY));
    }
    this.rest = movement < 0.35 && emptyMovement < 0.045 ? this.rest + 1 : 0;
    if (--this.remaining <= 0 || this.rest >= 16) {
      this.remaining = 0;
      this.flushPositions();
    }
  }

  flushPositions() {
    // A positioning gesture can still turn into a folder drop or be cancelled.
    if (this.drag?.layout || this.drag?.grid) return;
    const positions = [];
    for (const n of this.nodes.values()) {
      if (Math.abs(n.x - n.savedX) + Math.abs(n.y - n.savedY) < 0.05) continue;
      n.savedX = Math.round(n.x * 100) / 100;
      n.savedY = Math.round(n.y * 100) / 100;
      n.inputX = n.savedX; n.inputY = n.savedY;
      positions.push({ id: n.id, x: n.savedX, y: n.savedY });
    }
    if (positions.length) this.callbacks.onMove?.(positions);
  }

  local(event) {
    const r = this.canvas.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  }

  world(point) {
    return { x: (point.x - this.width / 2) / this.zoom + this.camera.x,
             y: (point.y - this.height / 2) / this.zoom + this.camera.y };
  }

  hit(point) {
    const p = this.world(point);
    let closest = null, best = Infinity;
    for (const n of this.nodes.values()) {
      const dx = p.x - n.x, dy = p.y - n.y, d = dx*dx + dy*dy;
      if (d < best && containsPoint(n,dx,dy,4 / this.zoom)) { closest = n; best = d; }
    }
    return closest;
  }

  select(id) {
    this.selectedGridId = null;
    this.selectedIds = new Set(id ? [id] : []);
    this.repaint();
  }
  changeSelection(ids, gridId = null) {
    this.selectedGridId = gridId;
    this.selectedIds = ids;
    this.callbacks.onSelect?.(ids.size === 1 ? ids.values().next().value : null, [...ids]);
    this.repaint();
  }
  setLinkMode(on, sourceId = null) {
    if (this.linking !== !!on) this.cancelDrag();
    if (on && this.selectedGridId) this.changeSelection(new Set());
    this.linking = !!on;
    this.linkSource = on && this.nodes.has(sourceId) ? sourceId : null;
    this.updateCursor(); this.repaint();
  }
  setTool(tool) {
    if (this.tool !== tool) this.cancelDrag();
    if (tool !== 'select' && this.selectedGridId) this.changeSelection(new Set());
    this.tool = tool;
    this.updateCursor(); this.repaint();
  }

  updateCursor() {
    const invalidStage = this.drag?.moved && this.drag.stage?.to === null;
    const invalidMove = this.drag?.noteIds && !this.drag.offMap && !this.drag.mapTarget && !this.drag.moving.size;
    this.canvas.style.cursor = invalidStage || invalidMove || this.drag?.mapTarget?.blocked ? 'no-drop' : this.drag?.resizeGrid ? 'nwse-resize'
      : this.drag?.pan || this.drag?.grid || this.drag?.stage ? 'grabbing' : this.hoverGrip && !this.drag && !this.linking && this.tool==='select' && !this.spacePan ? 'nwse-resize'
      : this.linking || this.drag?.marquee || this.callbacks.recordingRoute?.() ? 'crosshair' : this.tool === 'hand' || this.spacePan || this.hoverGrid ? 'grab'
      : this.drag?.moved ? 'grabbing' : this.hover ? 'pointer' : 'default';
  }

  pointerDown(e) {
    if (e.button > 1) return;
    if (this.zoomPreview?.cropped) this.repaint();
    this.flushPointerMove();
    e.preventDefault();
    this.canvas.focus({ preventScroll: true });
    const p = this.local(e);
    this.hoverSeat = null;
    this.target = null;
    this.contacts.set(e.pointerId, p);
    this.canvas.setPointerCapture(e.pointerId);
    if (this.contacts.size > 1) {
      this.discardGesture();
      this.pinch = this.pinchPoints();
      this.repaint();
      return;
    }
    const extend=extendsSelection(e), bubble=this.hit(p);
    const surface=!bubble && this.gridSurface(p), grip=!bubble && this.hitGridGrip(p);
    const cell=!bubble && this.gridCellAt(p,surface,grip);
    // A modified drag can start a marquee beside a bubble, even inside its seat.
    const node=bubble || (!extend && cell?.note);
    const canGrabGrid=!node && !this.linking && !extend && this.tool==='select' && !this.spacePan && e.button===0 && !this.callbacks.recordingRoute?.();
    const resizeGrid = canGrabGrid && this.callbacks.onGridSpacing && grip;
    const header = canGrabGrid && !resizeGrid && surface?.header;
    const revealed = this.callbacks.onStageReorder ? stageTitleAt(header,p,header?.grid===this.hoverGridArea ? this.hoverStage : null) : null;
    const from = revealed!==null && stageHandleAt(header,p)===revealed ? revealed : null;
    this.hoverStage=revealed;this.hoverHandle=from;
    if(revealed!==null)this.hoverGridArea=header.grid;
    const stage = from === null ? null : {group:header.grid, from, to:from, boundary:from, top:this.world({x:p.x,y:header.t}).y, pointerX:p.x};
    const grid = resizeGrid || (canGrabGrid && !stage && this.callbacks.onGridMove && surface?.move);
    if (this.selectedGridId && (header || (grid && grid.id !== this.selectedGridId))) this.changeSelection(new Set());
    const pan = e.button === 1 || this.spacePan || this.tool === 'hand' || this.callbacks.recordingRoute?.() || (!node && !grid && !stage && (this.linking || e.pointerType === 'touch'));
    const marquee = !pan && !node && !grid && !stage;
    this.drag = { id:e.pointerId,node,cell,pan,grid:!pan && grid,stage,resizeGrid:!pan && !!resizeGrid,marquee,extend,start:p,prev:p,moved:false,button:e.button };
    this.drag.startWorld = this.world(p);
    if (this.drag.grid) this.drag.gridOrigin = grid.grid;
    // Catch a moving bubble on press, even when the pointer has not yet
    // travelled far enough to distinguish a drag from a click.
    if (node && !pan && !this.linking) this.drag.held = new Set([node.id]);
    this.updateCursor();
  }

  pinchPoints() {
    const [a, b] = this.contacts.values();
    return { p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }

  startNoteDrag(drag) {
    this.flushPositions();
    if (!this.selectedIds.has(drag.node.id))
      this.changeSelection(new Set([...(drag.extend ? this.selectedIds : []), drag.node.id]));
    drag.noteIds = [...this.selectedIds];
    drag.seatOrder = [drag.node.id,...drag.noteIds.filter(id=>id!==drag.node.id)];
    if (!this.view?.manualLayout) {
      this.measureGroups();
      // A folder follows its members during the drag. Use the outline the user
      // aimed for at the start of the gesture to decide where a release lands.
      drag.dropHulls = new Map();
      for (const group of this.groups) if (!group.grid) {
        const {x,y,r,points} = group.hull;
        drag.dropHulls.set(group,{x,y,r,points});
      }
    }
    // Live collisions can displace neighbours too. Keep the pre-drag layout
    // until the destination is known, so a trip across the map is reversible.
    // Node indices are stable until setData(), which cancels the gesture.
    drag.layout = Array.from(this.nodes.values(),n=>({node:n,x:n.x,y:n.y,vx:n.vx,vy:n.vy,r:n.r}));
    drag.members = drag.noteIds.map(id=>drag.layout[this.nodes.get(id).index]);
    const canMove = n => n.seated ? !!this.callbacks.onReleaseSeats : this.view?.manualLayout || !n.pinned;
    drag.mobileMembers = canMove(drag.node) ? drag.members.filter(p=>canMove(p.node)) : [];
    drag.allMoving = new Set(drag.noteIds);
    drag.moving = new Set(drag.mobileMembers.map(p=>p.node.id));
    drag.releasesSeats = drag.mobileMembers.some(p=>p.node.seated);
    drag.homeArea = drag.members.every(p=>p.node.areaId===drag.node.areaId) ? drag.node.areaId : null;
  }

  restoreLayout(drag) {
    if (!drag.layout) return;
    releaseDragPaint(drag);
    this.measuredGroups = null;
    for (const original of drag.layout) this.restoreDragNode(original);
  }

  restoreDragNode(original) {
    const n = original.node;
    n.x = original.x; n.y = original.y;
    n.vx = original.vx; n.vy = original.vy; n.r = original.r;
  }

  moveNotes(drag, event, point) {
    drag.overSidebar = !!this.callbacks.onNoteDragMove?.(drag.noteIds, event.clientX, event.clientY);
    const offMap = drag.overSidebar || point.x < 0 || point.y < 0 || point.x >= this.width || point.y >= this.height;
    const world = this.world(point);
    drag.mapTarget = !offMap && !this.view?.manualLayout && this.callbacks.onMapDrop ? this.dropTarget(world,drag) : null;
    if (offMap || drag.mapTarget?.blocked || (!drag.mapTarget && !drag.moving.size)) {
      if (drag.held) { this.restoreLayout(drag); this.remaining = 0; }
      drag.held = null;
    } else {
      // An explicit folder drop carries even pinned notes to the destination.
      // On open canvas a seat can be released directly.
      const seats = drag.mapTarget?.seats;
      const held = seats || (drag.mapTarget ? drag.allMoving : drag.moving);
      // A pointer can produce many successive frames inside the same seat.
      // Its preview nodes are held still by the physics step until we leave it.
      if (seats && drag.held === seats) return;
      this.measuredGroups = null;
      if (drag.held && drag.held !== held) {
        for (const id of drag.held.keys()) if (!held.has(id)) this.restoreDragNode(drag.layout[this.nodes.get(id).index]);
      }
      drag.held = held;
      if (seats) {
        const grid = drag.mapTarget.group.grid;
        for (const [id,slot] of seats) {
          const n = this.nodes.get(id);
          slotPoint(grid,slot,n);
          n.r = seatedRadius(n.naturalRadius,grid);
          n.vx = n.vy = 0;
        }
      } else {
        const dx = world.x - drag.startWorld.x, dy = world.y - drag.startWorld.y;
        for (const original of (drag.mapTarget ? drag.members : drag.mobileMembers)) {
          const n = original.node;
          n.x = original.x + dx; n.y = original.y + dy;
          n.r = n.naturalRadius;
          n.vx = n.vy = 0;
        }
      }
      this.wake();
    }
    drag.offMap = offMap;
  }

  dropTarget(world,drag) {
    // Children win over their parents. Among siblings, an explicit seat wins,
    // then the closer centre breaks ties for unavoidably overlapping contents.
    let best = null, bestSlot = null, bestScore = Infinity;
    for (const group of this.groups) {
      if (best && group.depth < best.depth) continue;
      const hull = drag.dropHulls.get(group);
      const slot = group.grid ? slotAt(group.grid,world) : null;
      if (group.grid ? slot===null : !insideContour(hull,world)) continue;
      const score = group.grid ? Math.hypot(world.x-group.grid.x,world.y-group.grid.y) :
        Math.hypot(world.x-hull.x,world.y-hull.y)/hull.r;
      if (best && group.depth===best.depth && (best.grid && !group.grid ||
          !!best.grid===!!group.grid && score>=bestScore)) continue;
      best = group; bestSlot = slot; bestScore = score;
    }
    if (!best) return null;
    if (drag.mapTarget?.group===best && drag.mapTarget.slot===bestSlot) return drag.mapTarget;
    if (best.grid) {
      const seats = planGridSlots(best.grid,best.nodes,drag.seatOrder,bestSlot);
      return {group:best,slot:bestSlot,seats,blocked:!seats};
    }
    if (drag.homeArea === best.id) return null;
    return {group:best,slot:null,hull:drag.dropHulls.get(best)};
  }

  hitGridLabel(point) {
    return this.gridLabels?.find(box => point.x>=box.l && point.x<=box.r && point.y>=box.t && point.y<=box.b)?.grid;
  }

  stageHeaderAt(point) {
    let best=null;
    for(const header of this.stageHeaders || []){
      if(point.x>=header.l && point.x<header.r && point.y>=header.t && point.y<=header.b &&
          (!best || header.grid.depth>best.grid.depth))best=header;
    }
    return best;
  }

  gridSurface(point) {
    const header=this.stageHeaderAt(point);
    const label=this.hitGridLabel(point) || header?.grid;
    const area=label || this.gridAt(point);
    return {area,header,label,move:label || (area?.grid.stages ? area : null)};
  }

  doubleClick(e) {
    if(e.button!==0 || extendsSelection(e) || this.spacePan || this.tool==='hand' || this.linking || this.callbacks.recordingRoute?.())return;
    const point=this.local(e),node=this.hit(point);
    if(node){this.callbacks.onOpen?.(node.id);return}
    const header=this.stageHeaderAt(point);
    if(header){
      const grip=stageHandleAt(header,point);
      if(this.callbacks.onStageReorder && grip!==null && this.hoverGridArea===header.grid && this.hoverStage===grip)return;
      const col=Math.floor((point.x-header.l)/header.pitch);
      this.callbacks.onEditStage?.(header.grid.id,col,{x:e.clientX,y:e.clientY});
      return;
    }
    const cell=this.gridCellAt(point);
    if(cell?.note)this.callbacks.onOpen?.(cell.note.id);
    else if(cell)this.callbacks.onNewGridNote?.(cell.group.id,cell.slot,cell.world);
  }

  gridCellAt(point, surface=this.gridSurface(point), grip=this.hitGridGrip(point)) {
    const group=surface.area;
    if(!group || surface.label || grip)return null;
    const world=this.world(point), slot=slotAt(group.grid,world);
    if (slot === null) return null;
    if (!group.nodesBySlot) {
      group.nodesBySlot = new Map();
      for (const node of group.nodes) {
        if (node.seated) group.nodesBySlot.set(node.slot,node);
      }
    }
    return {group,world,slot,note:group.nodesBySlot.get(slot)};
  }

  contextGridId(point,node) {
    if (node?.seated) return node.areaId;
    const group=this.hitGridGrip(point) || this.gridSurface(point).area;
    return group?.id ?? null;
  }

  contextMenu(e) {
    e.preventDefault();
    if(this.drag?.moved || this.pinch)return;
    // A touch long-press can open the menu before its pointerup arrives.
    if(this.drag)this.cancelDrag();
    const point=this.local(e);
    let node=this.hit(point);
    const header=!node && this.stageHeaderAt(point);
    if(header && this.callbacks.onStageContext){
      if(this.selectedGridId)this.changeSelection(new Set());
      const index=Math.floor((point.x-header.l)/header.pitch);
      this.callbacks.onStageContext(header.grid.id,index,{x:e.clientX,y:e.clientY});
      return;
    }
    if(!node)node=this.gridCellAt(point)?.note;
    let areaId=this.contextGridId(point,node);
    if(!node && areaId)this.changeSelection(new Set(),areaId);
    else if(this.selectedGridId)this.changeSelection(new Set());
    if(!node && !areaId){
      const world=this.world(point);
      let nearest;
      for(const group of this.groups)if(!group.grid && group.hull && insideContour(group.hull,world) &&
        (!nearest || group.depth>nearest.depth || (group.depth===nearest.depth && group.hull.r<nearest.hull.r)))nearest=group;
      areaId=nearest?.id;
    }
    this.callbacks.onContext?.(node?.id ?? null,e.clientX,e.clientY,areaId);
  }

  gridAt(point) {
    const world=this.world(point);
    let best=null, bestDistance=Infinity;
    for (const g of this.groups) {
      if (!g.grid || (best && g.depth<best.depth) || slotAt(g.grid,world)===null) continue;
      const distance=Math.hypot(world.x-g.grid.x,world.y-g.grid.y);
      if (!best || g.depth>best.depth || distance<bestDistance) { best=g; bestDistance=distance; }
    }
    return best;
  }

  hitGridGrip(point) {
    const world=this.world(point);
    let best=null, nearest=Infinity;
    for (const g of this.groups) {
      if (!g.grid || (best && g.depth<best.depth)) continue;
      const {right,bottom}=slotGridBounds(g.grid);
      const distance=Math.hypot(world.x-right,world.y-bottom)*this.zoom;
      if (distance<=11 && (!best || g.depth>best.depth || distance<nearest)) { best=g;nearest=distance; }
    }
    return best;
  }

  hitSeat(point) {
    const world = this.world(point);
    let best = null;
    for (const group of this.groups) {
      if (!group.grid || best && group.depth<best.group.depth) continue;
      const index = slotAt(group.grid,world);
      if (index===null) continue;
      const tolerance = Math.min(12/this.zoom,gridSpacing(group.grid)/3,gridRowSpacing(group.grid)/3);
      const centre = slotPoint(group.grid,index), distance = Math.hypot(world.x-centre.x,world.y-centre.y);
      if (distance<=tolerance && (!best || group.depth>best.group.depth || distance<best.distance))
        best = {group,index,distance};
    }
    return best;
  }

  previewGrid(group,grid) {
    this.measuredGroups = null;
    group.grid = grid;
    for (const node of group.nodes) if (node.seated) {
      Object.assign(node,slotPoint(grid,node.slot));
      node.r=seatedRadius(node.naturalRadius,grid);
    }
  }

  discardGesture() {
    const drag = this.drag;
    releaseDragPaint(drag);
    this.pendingMove = null;
    this.drag = null;
    this.hoverStage=this.hoverHandle=null;
    if (drag?.grid) this.previewGrid(drag.grid,drag.gridOrigin);
    if (drag?.noteIds) {
      this.restoreLayout(drag);
      this.callbacks.onNoteDragEnd?.();
      if (drag.layout) this.wake();
    }
  }

  cancelDrag() {
    if (!this.drag && !this.contacts.size && !this.pinch) return;
    this.discardGesture();
    this.pinch = null;
    for (const id of this.contacts.keys()) {
      if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    }
    this.contacts.clear();
    this.updateCursor(); this.repaint();
  }

  updateStageDrop(stage, p) {
    const grid=stage.group.grid, pitch=gridSpacing(grid), position=this.world(p);
    const margin=24/this.zoom, left=grid.x-pitch/2;
    stage.pointerX=p.x;
    if (p.x<0 || p.x>=this.width || p.y<0 || p.y>=this.height ||
        position.y<stage.top-margin || position.y>grid.y+(grid.rows-.5)*gridRowSpacing(grid)+margin ||
        position.x<left-margin || position.x>left+grid.cols*pitch+margin) {
      stage.to=stage.boundary=null;
      return;
    }
    // Crossing a column's midpoint switches the insertion line to its far edge.
    // At exactly the midpoint prefer the destination column in either direction.
    const offset=(position.x-grid.x)/pitch;
    const boundary=clamp(offset<stage.from ? Math.ceil(offset) : Math.floor(offset)+1,0,grid.cols);
    stage.boundary=boundary;
    stage.to=boundary>stage.from ? boundary-1 : boundary;
  }

  scrollStageDrag(dt) {
    const drag=this.drag;
    if (!drag?.stage || !drag.moved || drag.stage.to===null) return false;
    const {x}=drag.prev, edge=Math.min(54,this.width/5);
    const speed=x<edge ? (x-edge)/edge : Math.max(0,(x-this.width+edge)/edge);
    if (!speed) return false;
    const grid=drag.stage.group.grid, pitch=gridSpacing(grid)*this.zoom;
    const left=this.width/2+(grid.x-this.camera.x)*this.zoom-pitch/2, right=left+grid.cols*pitch;
    // Stop as soon as the outer insertion line is comfortably inside the view.
    const dx=clamp(speed*.8*dt,Math.min(0,left-12),Math.max(0,right-this.width+12));
    if (Math.abs(dx)<.01) return false;
    this.camera.x+=dx/this.zoom;
    this.updateStageDrop(drag.stage,drag.prev);
    return true;
  }

  queuePointerMove(e) {
    if (!this.drag?.moved || this.drag.id !== e.pointerId) {
      this.pointerMove(e);
      return;
    }
    // Positions are absolute. Between paints only the last sample can be
    // displayed, including when a high-polling mouse crosses several seats.
    this.pendingMove = e;
    this.repaint();
  }

  flushPointerMove() {
    const event = this.pendingMove;
    this.pendingMove = null;
    if (event) this.pointerMove(event);
  }

  pointerMove(e) {
    const p = this.local(e);
    if (this.contacts.has(e.pointerId)) this.contacts.set(e.pointerId, p);
    if (this.contacts.size >= 2 && this.pinch) {
      const prev = this.pinch, next = this.pinchPoints();
      this.camera.x += (prev.p.x - next.p.x) / this.zoom;
      this.camera.y += (prev.p.y - next.p.y) / this.zoom;
      this.zoomAt(next.d / prev.d, next.p);
      this.pinch = next;
      return;
    }
    const drag = this.drag;
    if (drag && e.pointerId === drag.id) {
      if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 4) return;
      if (!drag.moved && drag.node && !drag.pan && !this.linking) this.startNoteDrag(drag);
      drag.moved = true;
      const dx = (p.x - drag.prev.x) / this.zoom, dy = (p.y - drag.prev.y) / this.zoom;
      if (drag.stage) this.updateStageDrop(drag.stage,p);
      else if (drag.pan) { this.camera.x -= dx; this.camera.y -= dy; }
      else if (drag.grid) {
        const pos = this.world(p), origin = drag.gridOrigin;
        const dx=pos.x-drag.startWorld.x, dy=pos.y-drag.startWorld.y;
        if (drag.resizeGrid) {
          const pitch=draggedGridSpacing(origin,dx,dy), current=drag.grid.grid;
          if (pitch.spacing!==gridSpacing(current) || pitch.rowSpacing!==gridRowSpacing(current))
            this.previewGrid(drag.grid,{...origin,...pitch});
        } else this.previewGrid(drag.grid,{...origin,x:origin.x+dx,y:origin.y+dy});
      }
      else if (drag.marquee) {
        const rect = selectionRect(this.world(drag.start), this.world(p));
        drag.preview = new Set(drag.extend ? this.selectedIds : []);
        for (const node of this.nodes.values()) if (intersectsNote(rect,node)) drag.preview.add(node.id);
      } else if (drag.noteIds) this.moveNotes(drag, e, p);
      drag.prev = p;
      this.updateCursor();
      this.repaint();
    } else if (!this.contacts.size) {
      const bubble=this.hit(p);
      const surface=this.gridSurface(p);
      const corner=!bubble && this.hitGridGrip(p);
      const id=bubble?.id ?? this.gridCellAt(p,surface,corner)?.note?.id ?? null;
      const canGrab=!id && !extendsSelection(e) && !this.linking && !this.spacePan && this.tool==='select' && !this.callbacks.recordingRoute?.();
      const grip = canGrab && this.callbacks.onGridSpacing && corner;
      const grid = canGrab && !grip && this.callbacks.onGridMove && surface.move;
      const header=canGrab && !grip && this.callbacks.onStageReorder ? surface.header : null;
      const stage=stageTitleAt(header,p,header?.grid===this.hoverGridArea ? this.hoverStage : null);
      const handle=stage!==null && stageHandleAt(header,p)===stage ? stage : null;
      const area = grip || surface.area;
      const seat = !id && !grip && surface.area ? this.hitSeat(p) : null;
      const heading = canGrab && surface.header;
      const stageName = heading ? heading.grid.grid.stages[Math.floor((p.x-heading.l)/heading.pitch)] : '';
      const hint = grip ? tr('Потяните, чтобы изменить шаг сетки','Drag to adjust grid spacing')
        : handle!==null ? tr('Переместить этап «'+stageName+'»','Move stage “'+stageName+'”') : stageName;
      if (this.canvas.title !== hint) this.canvas.title = hint;
      if (id!==this.hover || grid!==this.hoverGrid || grip!==this.hoverGrip || area!==this.hoverGridArea || stage!==this.hoverStage || handle!==this.hoverHandle ||
          seat?.group!==this.hoverSeat?.group || seat?.index!==this.hoverSeat?.index) {
        this.hover = id; this.hoverGrid = grid; this.hoverSeat = seat; this.hoverGrip = grip; this.hoverGridArea = area;
        this.hoverStage=stage;this.hoverHandle=handle;
        this.updateCursor(); this.repaint();
      }
    }
    this.callbacks.onActivity?.(this.world(p));
  }

  pointerUp(e, cancelled = false) {
    const drag = this.drag;
    if (this.pendingMove?.pointerId === e.pointerId) this.pendingMove = null;
    // A fast release can arrive without a final pointermove at the destination.
    if (!cancelled && drag?.id === e.pointerId) this.pointerMove(e);
    this.contacts.delete(e.pointerId);
    if (this.contacts.size < 2) this.pinch = null;
    if (!drag || e.pointerId !== drag.id) return;
    if (cancelled) { this.discardGesture(); this.updateCursor(); this.repaint(); return; }
    releaseDragPaint(drag);
    this.drag = null;
    if (drag.stage) {
      const {group,from,to}=drag.stage;
      if(drag.moved)this.hoverStage=this.hoverHandle=null;
      if (drag.moved && to!==null && from!==to) this.callbacks.onStageReorder?.(group.id,from,to);
    } else if (drag.grid && drag.moved) {
      const {x,y} = drag.grid.grid, spacing=gridSpacing(drag.grid.grid), rowSpacing=gridRowSpacing(drag.grid.grid);
      this.previewGrid(drag.grid,drag.gridOrigin);
      if (drag.resizeGrid && (spacing!==gridSpacing(drag.gridOrigin) || rowSpacing!==gridRowSpacing(drag.gridOrigin)))
        this.callbacks.onGridSpacing(drag.grid.id,{spacing,rowSpacing});
      else if (x!==drag.gridOrigin.x || y!==drag.gridOrigin.y) this.callbacks.onGridMove(drag.grid.id,x,y);
      if(!drag.resizeGrid){
        this.hoverStage=this.hoverHandle=null;
        const group=this.groups.find(g=>g.id===drag.grid.id);
        this.hoverGrid=this.hoverGridArea=group || null;
      }
    } else if (drag.preview) this.changeSelection(drag.preview);
    else if (!drag.moved && drag.button === 0 && !this.spacePan && this.tool !== 'hand') {
      const id = drag.node?.id ?? drag.cell?.note?.id ?? null;
      if (id && this.callbacks.onRoutePick?.(id)) { this.updateCursor(); this.repaint(); return; }
      if (this.linking) { if (id) this.callbacks.onLink?.(id); }
      else if (id && drag.extend) {
        const ids = new Set(this.selectedIds);
        if (ids.has(id)) ids.delete(id); else ids.add(id);
        this.changeSelection(ids);
      } else if (!drag.extend && !drag.resizeGrid && (id || !this.stageHeaderAt(drag.start))) {
        const pickGrid = !id && !this.callbacks.recordingRoute?.();
        const title = pickGrid && this.hitGridLabel(drag.start);
        const group = title || (pickGrid && drag.cell?.group);
        this.changeSelection(new Set(id ? [id] : []), group?.id);
      }
    } else if (drag.noteIds) {
      try {
        if (drag.overSidebar) this.callbacks.onNoteDrop?.(drag.noteIds, e.clientX, e.clientY);
        else if (drag.mapTarget) {
          const target = drag.mapTarget;
          const positions = target.blocked ? [] : drag.members.map(({node})=>({id:node.id,x:node.x,y:node.y}));
          this.restoreLayout(drag);
          if (!target.blocked) this.callbacks.onMapDrop(target.group.grid?drag.seatOrder:drag.noteIds,target.group.id,target.slot,positions);
        } else if (!drag.offMap && drag.releasesSeats) {
          const positions = drag.mobileMembers.map(({node})=>({id:node.id,x:node.x,y:node.y}));
          this.restoreLayout(drag);
          this.callbacks.onReleaseSeats(positions);
        } else if (!drag.offMap && drag.layout) {
          const before = [], after = [];
          for (const original of drag.mobileMembers) {
            const n = original.node, id = n.id;
            if (Math.abs(n.x-original.x)+Math.abs(n.y-original.y)>=.05) {
              before.push({id,x:original.x,y:original.y});
              after.push({id,x:Math.round(n.x*100)/100,y:Math.round(n.y*100)/100});
            }
          }
          if (before.length) this.callbacks.onManualMove?.(before,after);
          else this.restoreLayout(drag);
        }
      } finally {
        this.callbacks.onNoteDragEnd?.();
        if (drag.layout) { this.flushPositions(); this.wake(); }
      }
    }
    this.updateCursor();
    this.repaint();
  }

  zoomAt(factor, point) {
    this.hoverGrid = this.hoverSeat = this.hoverGrip = this.hoverGridArea = this.hoverStage = this.hoverHandle = null;
    const before = this.world(point);
    const zoom = clamp(this.zoom * factor, this.minZoom, 5);
    if (zoom !== this.zoom) this.zoomChanged = true;
    this.camera.zoom = zoom;
    const after = this.world(point);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.callbacks.onZoom?.(this.zoom);
    this.repaint(true);
  }

  wheel(e) {
    e.preventDefault();
    this.flushPointerMove();
    if (this.drag?.stage) this.cancelDrag();
    this.target = null;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    const point = this.local(e);
    if (e.shiftKey) {
      this.camera.x += (e.deltaX || e.deltaY) * unit / this.zoom;
      this.repaint();
    } else this.zoomAt(Math.exp(-clamp(e.deltaY * unit, -480, 480) * 0.00165), point);
    if (this.drag?.noteIds) {
      this.moveNotes(this.drag,e,point);
      this.drag.prev=point;
      this.updateCursor();
    }
  }

  zoomBy(factor) {
    this.target = null;
    this.zoomAt(factor, { x: this.width / 2, y: this.height / 2 });
  }

  focus(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.select(id);
    this.fly(n.x, n.y, Math.max(1, this.zoom));
  }

  center() { this.fly(0, 0, 1); }

  get minZoom() {
    // A wide 100×100 grid can extend beyond the old 4% overview.
    return this.groups.some(group=>group.grid) ? .005 : .04;
  }

  suggestAreaAnchor(point, parentId=null) {
    this.measureGroups();
    const byId = new Map(this.groups.map(group=>[group.id,group]));
    const ancestors = new Set();
    for (let g=byId.get(parentId); g && !ancestors.has(g.id); g=byId.get(g.parentId)) ancestors.add(g.id);
    const obstacles = this.groups.filter(g=>!ancestors.has(g.id)).map(g=>g.gridBounds || g.hull);
    for (const n of this.nodes.values()) if (!byId.has(n.areaId) || ancestors.has(n.areaId)) obstacles.push(n);
    return emptyContourAnchor(point,obstacles);
  }

  focusArea(id,slot) {
    const group = this.groups.find(g=>g.id===id);
    if (!group) return false;
    this.measureGroups();
    if (group.grid) {
      const p = gridFocusCamera(group.grid,this.width,this.height,slot);
      this.fly(p.x,p.y,p.zoom);
    } else {
      const {x,y,r} = group.hull;
      this.fly(x,y,clamp(Math.min(this.width*.78,this.height*.72)/(2*r),this.minZoom,1.45));
    }
    return true;
  }

  fit({readable=false}={}) {
    if (!this.nodes.size && !this.groups.length) { this.center(); return; }
    this.measureGroups();
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    for (const n of this.nodes.values()) {
      l = Math.min(l, n.x - n.r); r = Math.max(r, n.x + n.r);
      t = Math.min(t, n.y - n.r); b = Math.max(b, n.y + n.r + 20);
    }
    for (const g of this.groups) {
      const hull = g.hull;
      const box = g.gridBounds;
      l = Math.min(l, box?.left ?? hull.x-hull.r); r = Math.max(r, box?.right ?? hull.x+hull.r);
      t = Math.min(t, box?.top ?? hull.y-hull.r); b = Math.max(b, (box?.bottom ?? hull.y+hull.r) + 20);
    }
    const zoom = Math.min(this.width * 0.78 / (r - l), this.height * 0.72 / (b - t));
    if (readable && zoom < .38 && this.groups.some(g=>g.grid)) {
      let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
      for (const n of this.nodes.values()) if (!n.seated) {
        left=Math.min(left,n.x-n.r); right=Math.max(right,n.x+n.r);
        top=Math.min(top,n.y-n.r); bottom=Math.max(bottom,n.y+n.r);
      }
      if (left>right) { this.focusArea(this.groups.find(g=>g.grid).id); return; }
      this.fly((left+right)/2,(top+bottom)/2,clamp(Math.min(this.width*.72/(right-left),this.height*.68/(bottom-top)),.20,1.25));
      return;
    }
    this.fly((r + l) / 2, (b + t) / 2, clamp(zoom, this.minZoom, 1.45));
  }

  fly(x, y, zoom) {
    if (this.drag || this.pinch) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.target = null;
      this.camera = { x, y, zoom };
      this.callbacks.onZoom?.(zoom);
    } else this.target = { x, y, zoom };
    this.repaint();
  }

  repaint(zoomOnly = false) {
    if (!zoomOnly) this.zoomPreview?.reset();
    if (this.frame || this.destroyed || this.visible === false) return;
    this.frame = requestAnimationFrame(t => this.tick(t));
  }

  setVisible(visible) {
    if ((this.visible !== false) === visible) return;
    this.visible = visible;
    if (visible) this.repaint();
    else {
      this.zoomPreview?.reset();
      this.cancelDrag();
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.lastTime = null;
      this.accumulator = 0;
    }
  }

  tick(time) {
    // Keep the current frame marked as scheduled while applying input so it
    // can request a paint without scheduling a redundant second frame.
    this.flushPointerMove();
    this.frame = 0;
    const dt = this.lastTime == null ? STEP_MS : clamp(time - this.lastTime, 1, 50);
    this.lastTime = time;
    if (this.target) {
      const k = 1 - Math.exp(-dt / 62);
      const c = this.camera, target = this.target;
      c.x += (target.x - c.x) * k;
      c.y += (target.y - c.y) * k;
      c.zoom += (target.zoom - c.zoom) * k;
      if ((Math.abs(c.x - target.x) + Math.abs(c.y - target.y)) * c.zoom < 0.16 &&
          Math.abs(c.zoom - target.zoom) < 0.001) {
        Object.assign(c, target);
        this.target = null;
      }
      this.callbacks.onZoom?.(c.zoom);
    }
    // Grids and multi-note selections move as a unit. Keep their surroundings
    // in place while aiming, then settle the links against the committed layout.
    const layoutPreview = this.drag?.grid || this.drag?.held?.size > 1;
    // Paint the new camera before advancing the world under the pointer.
    // Remaining physics work resumes on the next frame without wheel input.
    const zoomFrame = this.zoomChanged;
    this.zoomChanged = false;
    if (this.remaining && !layoutPreview && !zoomFrame) {
      this.accumulator += this.drag?.moved ? Math.min(dt, STEP_MS) : dt;
      const catchUp = this.accumulator >= 2 * STEP_MS;
      const deadline = catchUp ? performance.now() + STEP_MS/2 : Infinity;
      while (this.remaining && this.accumulator >= STEP_MS) {
        this.accumulator -= STEP_MS;
        this.step();
        // Leave time to paint. On a crowded map, replaying missed steps after
        // a long frame can otherwise make the next frame even later.
        if (this.accumulator >= STEP_MS && performance.now() >= deadline) {
          this.accumulator %= STEP_MS;
          break;
        }
      }
    } else this.accumulator = 0;
    if (this.heating.size) {
      const fraction = 1 - Math.exp(-dt / 125);
      for (const n of this.heating) {
        n.heat += (n.heatTarget - n.heat) * fraction;
        if (Math.abs(n.heatTarget - n.heat) < 0.001) {
          n.heat = n.heatTarget;
          this.heating.delete(n);
        }
      }
    }
    const scrolling=this.scrollStageDrag(dt);
    const preview = this.zoomPreview;
    // Below the label threshold the plain overview has no screen-space
    // controls to reposition. Interactions and layout edits use an exact frame.
    const plainOverview = preview?.supported && this.nodes.size >= 2000 && this.zoom < .22 &&
      !this.remaining && !this.heating.size && !this.drag && !this.target && !this.pinch &&
      !this.hover && !this.selectedIds.size && !this.groups.some(group => group.grid) &&
      !this.canvas.parentElement?.dataset?.routeMode;
    if (plainOverview && zoomFrame && preview.show(this.camera,this.width,this.height)) {
      this.callbacks.onMapFrame?.(this);
    } else {
      preview?.reset();
      if (plainOverview) preview.base = {...this.camera,width:this.width,height:this.height};
      this.draw();
    }
    if (scrolling || this.target || (this.remaining && !layoutPreview) || this.heating.size) this.repaint();
    if (!this.frame) this.lastTime = null;
  }

  measureGroups() {
    measureAreaHulls(this.groups);
    shapeSiblingContours(this.groups);
    this.measuredGroups = this.groups;
  }

  draw() {
    const c = this.ctx, w = this.width, h = this.height, z = this.zoom;
    if (!this.dpr) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#171717';
    c.fillRect(0, 0, w, h);
    const ox = w / 2 - this.camera.x * z, oy = h / 2 - this.camera.y * z;
    if (this.view.grid) drawMapBackgroundDots(c, ox, oy, z, w, h, this.dpr);

    const labels = [], labelObstacles = new Map();
    if (this.measuredGroups !== this.groups) this.measureGroups();
    this.gridLabels = [];
    this.stageHeaders = [];
    const target = this.drag?.mapTarget;
    for (const g of this.groups) {
      const active = target?.group===g;
      if (g.grid) {
        const hover = !this.drag && this.hoverSeat?.group===g;
        const stage=this.drag?.stage;
        const style = active ? {active:true,slots:target.seats,blocked:target.blocked,hoverSlot:target.slot,swapping:target.seats?.size>this.drag.seatOrder.length}
          : stage?.group===g ? (this.drag.moved ? {reorder:stage} : {hoverStage:stage.from,hoverHandle:stage.from})
          : hover ? {hoverSlot:this.hoverSeat.index}
          : !this.drag && this.hoverGridArea===g && this.tool==='select' && !this.linking && !this.spacePan && !this.callbacks.recordingRoute?.()
            ? {hoverStage:this.hoverStage,hoverHandle:this.hoverHandle} : undefined;
        const selected = this.selectedGridId === g.id;
        const label = drawSlotGrid(c,g,{ox,oy,zoom:z,width:w,height:h},{...style,selected});
        if (label) {
          if(label.stageHeader)this.stageHeaders.push(label.stageHeader);
          if (active || hover) labels.push(label);
          const title = active || hover ? label.titleLabel : label;
          if (title) labels.push({...title,grid:g,concealed:!selected && !this.view.labels && this.hoverGridArea!==g && this.drag?.grid!==g});
        }
        this.callbacks.onDrawAreaMetric?.(c,g,{ox,oy,zoom:z});
        continue;
      }
      const hull = g.hull;
      const x = ox + hull.x * z, y = oy + hull.y * z, r = hull.r * z;
      if (x + r < 0 || x - r > w || y + r < -25 || y - r > h) continue;
      traceContour(c,hull,ox,oy,z);
      c.fillStyle = rgba(g.tint,0.032); c.fill();
      c.lineWidth = 1; c.strokeStyle = rgba(g.tint,0.35); c.stroke();
      this.callbacks.onDrawAreaMetric?.(c,g,{ox,oy,zoom:z});
      if (!active && this.view.labels && z >= 0.22) labels.push({
        text:g.name, area:g, x,y, tint:rgba(g.tint,0.88), group:true, rank:2
      });
    }
    if (target?.hull) {
      traceContour(c,target.hull,ox,oy,z);
      c.fillStyle=rgba(target.group.tint,0.11); c.fill();
      c.lineWidth=2.5; c.strokeStyle=ACCENT; c.stroke();
      const count=this.drag.noteIds?.length || 1;
      labels.push({text:count>1 ? target.group.name+' · '+count : target.group.name,x:this.drag.prev.x,y:Math.max(14,this.drag.prev.y-30),
        tint:ACCENT,group:true,rank:6});
    }
    const selected = this.drag?.preview || this.selectedIds;
    // On a wide view hundreds of bright links and captions can cover the
    // destination. Keep the grabbed note as the visual reference until release.
    const lead = z < .58 && this.drag?.moved && this.drag.noteIds?.length > 1 ? this.drag.node : null;
    for (const node of this.nodes.values()) {
      const x = ox + node.x*z, y = oy + node.y*z;
      node.screenX = x; node.screenY = y;
      node.clip = (x<0?1:x>w?2:0) | (y<0?4:y>h?8:0);
    }
    const showLinks = this.view.links && !this.view.manualLayout;
    let lastStroke, lastWidth;
    for (const { a, b, manual } of (showLinks ? this.edges : [])) {
      if (a.clip & b.clip) continue;
      const ax=a.screenX, ay=a.screenY, vx=b.screenX-ax, vy=b.screenY-ay;
      // Bounding boxes of long diagonal links can cover the viewport even
      // when the line misses it. Test the corners against the line normal.
      if (a.clip && b.clip && Math.abs((ax-w/2)*vy-(ay-h/2)*vx) >
        (w/2+1)*Math.abs(vy)+(h/2+1)*Math.abs(vx)) continue;
      const length = Math.hypot(vx,vy);
      if (!length) continue;
      const dx = vx / length, dy = vy / length;
      const aEdge = edgeRadius(a,dx,dy)*z, bEdge = edgeRadius(b,-dx,-dy)*z;
      if (length <= aEdge + bEdge) continue;
      const active = lead ? a===lead || b===lead : selected.has(a.id) || selected.has(b.id);
      const stroke = active ? 'rgba(237,237,237,.66)' : rgba(a.tint,manual ? .33 : .17);
      const width = active ? 1.35 : 1;
      const x=ax+aEdge*dx, y=ay+aEdge*dy, endX=b.screenX-bEdge*dx, endY=b.screenY-bEdge*dy;
      if (stroke!==lastStroke) c.strokeStyle = lastStroke = stroke;
      if (width!==lastWidth) c.lineWidth = lastWidth = width;
      c.beginPath(); c.moveTo(x,y); c.lineTo(endX,endY); c.stroke();
    }
    if (showLinks && this.linkSource && this.hover && this.hover !== this.linkSource && !this.drag?.moved && !this.pinch) {
      const from = this.nodes.get(this.linkSource), to = this.nodes.get(this.hover);
      if (from && to && !from.links.includes(to.id) && !to.links.includes(from.id)) {
        // Note bodies cover the endpoints, including custom silhouettes.
        c.save();
        c.setLineDash([4,4]); c.lineWidth = 1.5; c.strokeStyle = 'rgba(237,237,237,.85)';
        c.beginPath(); c.moveTo(from.screenX,from.screenY); c.lineTo(to.screenX,to.screenY); c.stroke();
        c.restore();
      }
    }
    this.callbacks.onDrawRoute?.(c,this,ox,oy,z);
    const overview = this.nodes.size >= 1000;
    const layer = dragPaintLayer(this,selected);
    let bounds = null;
    for (const n of this.nodes.values()) {
      const x = n.screenX, y = n.screenY, r = n.r * z;
      if (x + r < -70 || x - r > w + 70 || y + r < -28 || y - r > h + 28) continue;
      if (this.view.labels && z >= 0.22) {
        const obstacle = { x, y, r };
        for (let ix = Math.floor((x-r) / 96); ix <= Math.floor((x+r) / 96); ix++)
          for (let iy = Math.floor((y-r) / 32); iy <= Math.floor((y+r) / 32); iy++)
            spatialCell(labelObstacles, ix, iy).push(obstacle);
      }
      const select = selected.has(n.id), hover = n.id === this.hover;
      if (select && x+r >= 0 && x-r <= w && y+r >= 0 && y-r <= h) {
        if (!bounds) bounds = {left:x-r,right:x+r,top:y-r,bottom:y+r};
        else {
          bounds.left = Math.min(bounds.left,x-r); bounds.right = Math.max(bounds.right,x+r);
          bounds.top = Math.min(bounds.top,y-r); bounds.bottom = Math.max(bounds.bottom,y+r);
        }
      }
      const cached = layer && n.index>=layer.first && n.index<=layer.last;
      if (!cached || !layer.ready) {
        const seated = this.drag?.noteIds && this.drag.held?.has(n.id) ? !!target?.seats?.has(n.id) : n.seated;
        paintMapNote(cached ? layer.ink : c,n,x,y,r,z,select,hover,seated,this.dpr,overview);
      }
      if (cached && n.index===layer.last) {
        layer.ready = true;
        c.drawImage(layer.canvas,0,0,layer.canvas.width/this.dpr,layer.canvas.height/this.dpr);
      }
      if (this.view.labels && ((lead ? n===lead : select) || hover || z >= 0.58)) labels.push({
        text: n.title, note:n, x, y: y + r + (select ? 16 : 13),
        tint: select ? '#ededed' : hover ? '#dedede' : '#b2b2b2',
        rank: select ? 4 : hover ? 3 : 1
      });
    }
    const view={ox,oy,zoom:z,width:w,height:h};
    const resizing=this.drag?.resizeGrid;
    const gripArea=resizing ? this.drag.grid : this.callbacks.onGridSpacing && !this.drag && !this.linking && this.tool==='select' && !this.spacePan && !this.callbacks.recordingRoute?.() && this.hoverGridArea;
    if (resizing) {
      const grid=this.drag.grid.grid, pointer=this.drag.prev;
      labels.push({text:gridSpacing(grid)+' × '+gridRowSpacing(grid), x:clamp(pointer.x,45,w-45),y:clamp(pointer.y-25,12,h-12),
        group:true, rank:7,tint:ACCENT});
    }
    this.drawLabels(labels, labelObstacles, view);
    this.callbacks.onDrawRoute?.(c,this,ox,oy,z,true);
    const hovered = this.nodes.get(this.hover);
    if(hovered && !this.drag)this.callbacks.onDrawNoteMetric?.(c,hovered.id,{x:ox+hovered.x*z,y:oy+hovered.y*z,r:hovered.r*z});
    if (gripArea) drawGridGrip(c,gripArea.grid,view,resizing || !!this.hoverGrip);
    if (this.drag?.preview) {
      const {left,right,top,bottom} = selectionRect(this.drag.start,this.drag.prev);
      c.fillStyle = 'rgba(235,235,235,.08)';
      c.fillRect(left,top,right-left,bottom-top);
      c.strokeStyle = 'rgba(235,235,235,.7)'; c.lineWidth = 1;
      c.strokeRect(left,top,right-left,bottom-top);
    }
    const showAction = this.tool === 'select' && !this.linking && !this.drag?.moved && !this.pinch && !this.callbacks.recordingRoute?.();
    this.areaAction?.place(showAction ? bounds : null,selected.size,w,h);
    this.callbacks.onMapFrame?.(this);
  }

  drawLabels(labels, obstacles, view) {
    const c = this.ctx, cells = new Map();
    const siblings = new Map();
    for (const family of this.areaFamilies || []) for (const area of family) siblings.set(area,family);
    c.textBaseline = 'middle'; c.textAlign = 'center';
    labels.sort((a, b) => b.rank - a.rank);
    for (const item of labels) {
      if (!item.text) continue;
      c.font = item.group ? '600 12px "Segoe UI", sans-serif' : '11px "Segoe UI", sans-serif';
      const owner = item.note || item.area || item.grid;
      const {label,width} = measureMapLabel(c,item.text,owner);
      const positions = item.area ? contourLabelPositions(item.area,siblings.get(item.area),view,width) : [item];
      for (const {x,y} of positions) {
        const l=x-width/2-4, r=x+width/2+4, t=y-8, b=y+8;
        if (item.area && (l<0 || r>this.width || t<0 || b>this.height)) continue;
        if (r<0 || l>this.width || b<0 || t>this.height) continue;
        const buckets = [];
        let blocked = false;
        for (let ix=Math.floor(l/96); ix<=Math.floor(r/96) && !blocked; ix++)
          for (let iy=Math.floor(t/32); iy<=Math.floor(b/32) && !blocked; iy++) {
            const cell = spatialCell(cells,ix,iy);
            blocked = cell.some(s=>s.l<r && s.r>l && s.t<b && s.b>t);
            if (item.rank===1 || item.area) blocked ||= obstacles.get(ix)?.get(iy)?.some(n=>
              Math.hypot(n.x-clamp(n.x,l,r),n.y-clamp(n.y,t,b)) < n.r);
            buckets.push(cell);
          }
        if (blocked) continue;
        const box = {l,r,t,b};
        if (item.grid) this.gridLabels.push({...box,b:box.b+4,grid:item.grid});
        // Even with map labels hidden, hovering or tapping the title can reach this grid.
        if (item.concealed) break;
        for (const cell of buckets) cell.push(box);
        c.lineWidth=3.2; c.lineJoin='round'; c.strokeStyle='#171717';
        c.strokeText(label,x,y);
        c.fillStyle=item.tint; c.fillText(label,x,y);
        break;
      }
    }
  }

  destroy() {
    this.zoomPreview?.reset();
    this.cancelDrag();
    this.flushPositions();
    this.areaAction?.button.remove();
    this.controller.abort();
    this.observer.disconnect();
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
  }
}
