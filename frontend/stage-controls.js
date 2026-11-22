import { icon } from './art.js';
import { tr } from './i18n.js';
import { mountStageInsert } from './stage-insert.js';

const size = 28;
const gap = 4;

// Prefer the space beside the track title. If the title wasn't drawn, use
// the outside edge of the stage headings so a short stage name stays legible.
export function stageControlPosition(header, title, width, height) {
  if (header.r < 0 || header.l > width || header.b < 0 || header.t > height) return null;
  const bounds = title || header;
  const middle = (bounds.t + bounds.b - size) / 2;
  const y = Math.round(title && title !== header ? Math.min(middle,header.t-size-1) : middle);
  const overX = Math.min(width - size - gap, Math.max(gap, (Math.max(0,bounds.l) + Math.min(width,bounds.r) - size) / 2));
  const candidates = [
    {x:bounds.r + gap, y},
    {x:bounds.l - gap - size, y},
    {x:overX, y:bounds.t - size - gap}
  ];
  for (const point of candidates) {
    if (point.x >= gap && point.x + size <= width - gap && point.y >= gap && point.y + size <= height - gap)
      return {x:Math.round(point.x), y:Math.round(point.y)};
  }
  return null;
}

export function mountStageControls({canvas, onEdit, onInsert}) {
  const layer = document.createElement('div');
  layer.className = 'stage-controls';
  canvas.after(layer);
  const buttons = new Map();
  const insert = onInsert && mountStageInsert(canvas,layer,onInsert);
  const events = new AbortController();
  let lastGraph, touched;
  function revealTouch(button) {
    touched?.classList.remove('is-touched');
    touched=button;
    touched?.classList.add('is-touched');
  }
  // A tap on a track is the touch equivalent of pointing at its title.
  document.addEventListener('pointerdown', e=>{
    if(touched?.contains(e.target))return;
    const track=e.pointerType==='touch' && e.isPrimary && e.target===canvas && !layer.hidden &&
      lastGraph?.gridSurface(lastGraph.local(e)).area;
    revealTouch(track ? buttons.get(track.id) : null);
  },{capture:true,signal:events.signal});

  function add(id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stage-edit';
    button.setAttribute('aria-haspopup','dialog');
    button.setAttribute('aria-expanded','false');
    button.dataset.stageId = id;
    button.innerHTML = icon('sliders');
    button.onclick = () => {
      // The edit form restores its opener's focus on close.
      button.focus({preventScroll:true});
      onEdit(id,button);
    };
    layer.append(button);
    buttons.set(id,button);
    return button;
  }

  function sync(graph) {
    lastGraph=graph;
    const dormant = graph.linking || graph.tool === 'hand' || !!graph.drag?.moved || !!graph.pinch;
    layer.hidden = dormant;
    if (dormant) { revealTouch(null); insert?.sync(graph); return; }
    const headers = new Map(graph.stageHeaders.map(header => [header.grid.id,header]));
    const titles = new Map();
    for (const title of graph.gridLabels) {
      titles.set(title.grid.id,title);
      // Plain grids and tracks at overview zoom only have their own title.
      if (!headers.has(title.grid.id)) headers.set(title.grid.id,title);
    }
    const visible = new Set();
    for (const header of headers.values()) {
      const group = header.grid;
      const position = stageControlPosition(header,titles.get(group.id),graph.width,graph.height);
      if (!position) continue;
      visible.add(group.id);
      const button = buttons.get(group.id) || add(group.id);
      const label = group.grid.stages
        ? tr('Настроить дорожку «' + group.name + '»', 'Edit stage track “' + group.name + '”')
        : tr('Настроить сетку «' + group.name + '»', 'Edit grid “' + group.name + '”');
      if (button.title !== label) {
        button.title = label;
        button.setAttribute('aria-label',label);
      }
      const transform = 'translate(' + position.x + 'px, ' + position.y + 'px)';
      if (button.style.transform !== transform) button.style.transform = transform;
      const bounds=titles.get(group.id)||header;
      const bridge=position.x>=bounds.r?'left':position.x+size<=bounds.l?'right':'bottom';
      if(button.dataset.bridge!==bridge)button.dataset.bridge=bridge;
      button.classList.toggle('is-active', graph.hoverGridArea === group || graph.hoverGrid === group);
    }
    for (const [id,button] of buttons) {
      if (visible.has(id)) continue;
      if (document.activeElement === button) canvas.focus({preventScroll:true});
      if(touched===button)revealTouch(null);
      button.remove();
      buttons.delete(id);
    }
    insert?.sync(graph);
  }

  return {sync, reset(){revealTouch(null);insert?.reset()}, destroy() { events.abort();insert?.destroy();buttons.clear();layer.remove(); }};
}
