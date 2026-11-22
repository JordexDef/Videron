import { canMoveArea, descendantAreaIds } from './areas.js';
import { fullGridIds } from './area-grid.js';
import { icon } from './art.js';
import { tr } from './i18n.js';

export function mountAreaDrag({sidebar, tree, list, getWorkspace, getListSelection, onAssign, onMove, onExpand}) {
  const nav = tree.closest('nav'), rootTarget = sidebar.querySelector('.area-label');
  const ghost = document.createElement('div'), label = document.createElement('span');
  ghost.className = 'area-drag-preview'; ghost.hidden = true;
  ghost.setAttribute('aria-hidden','true');
  document.body.append(ghost);
  const listeners = new AbortController(), events = {signal:listeners.signal};
  let source = null, gesture = null, target = null, point = null;
  let expandId = null, timer = 0, scrollFrame = 0, blockedClick = null;

  function clearTarget() {
    target?.classList.remove('area-drop-target');
    target = null;
  }
  function clear() {
    const previous = gesture;
    gesture = null;
    if (previous?.capture?.hasPointerCapture(previous.pointerId))
      previous.capture.releasePointerCapture(previous.pointerId);
    clearTarget(); clearTimeout(timer); cancelAnimationFrame(scrollFrame);
    scrollFrame = 0; expandId = null; point = null; source = null;
    sidebar.classList.remove('area-drop-root-visible');
    document.body.classList.remove('area-dragging','area-drag-invalid');
    ghost.hidden = true;
  }
  function begin(payload) {
    source = payload;
    rootTarget.dataset.dropLabel = tr('Верхний уровень','Top level');
    sidebar.classList.toggle('area-drop-root-visible', !source.excluded.has(null));
    ghost.innerHTML = icon(payload.kind === 'folder' ? 'folder' : 'list');
    label.textContent = payload.name;
    ghost.append(label);
    document.body.classList.add('area-dragging');
  }
  function startNotes(ids) {
    const space = getWorkspace();
    if (!space) return false;
    if (source?.kind === 'notes' && source.space === space && source.selection === ids) return true;
    const keys = new Set(ids), matched = space.notes.filter(note => keys.has(note.id));
    if (!matched.length) return false;
    const parents = new Set(matched.map(note => note.areaId ?? null));
    const excluded = fullGridIds(space,keys);
    if (parents.size === 1) excluded.add(matched[0].areaId ?? null);
    begin({kind:'notes', selection:ids, ids:matched.map(note => note.id), space,
      excluded,
      name:matched.length === 1 ? tr('Заметка','Note') : tr('Заметки · ','Notes · ') + matched.length});
    return true;
  }
  function startFolder(id) {
    const space = getWorkspace(), folder = space?.areas.find(area => area.id === id);
    if (!folder) return false;
    const excluded = descendantAreaIds(space.areas,id);
    const parentId = folder.parentId ?? null;
    excluded.add(parentId);
    begin({kind:'folder', id, parentId, space, excluded, name:folder.name});
    return true;
  }
  function expandAfterHover(row) {
    const id = row?.querySelector('.area-disclosure[aria-expanded="false"]') ? row.dataset.areaId : null;
    if (id === expandId) return;
    clearTimeout(timer); expandId = id;
    if (id) timer = setTimeout(() => {
      if (!source || !point || getWorkspace() !== source.space) return;
      onExpand?.(id);
      updatePoint(point.x,point.y);
    },600);
  }
  function autoScroll() {
    if (scrollFrame || !point) return;
    const rect = nav.getBoundingClientRect(), {x,y} = point;
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return;
    const edge = Math.min(32,rect.height / 4);
    const offset = Math.min(0,y - rect.top - edge) + Math.max(0,y - rect.bottom + edge);
    if (!offset || (offset < 0 ? nav.scrollTop <= 0 : nav.scrollTop + nav.clientHeight >= nav.scrollHeight - 1)) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!point) return;
      nav.scrollTop += Math.sign(offset) * Math.ceil(Math.abs(offset) * .45);
      updatePoint(point.x,point.y);
    });
  }
  function updatePoint(x,y) {
    point = {x,y};
    const rect = sidebar.getBoundingClientRect();
    const inside = x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom &&
      getComputedStyle(sidebar).visibility !== 'hidden';
    let row = null;
    if (inside && source.space === getWorkspace()) {
      const hit = document.elementFromPoint(x,y);
      const folder = hit?.closest('.area-tree-row[data-area-id]');
      if (folder && tree.contains(folder)) row = folder;
      else if (rootTarget.contains(hit)) row = rootTarget;
    }
    const valid = row && !source.excluded.has(row.dataset.areaId ?? null) ? row : null;
    if (valid !== target) {
      clearTarget(); target = valid; target?.classList.add('area-drop-target');
    }
    // Its current parent is a no-op destination, but opening it lets a folder
    // reach a sibling inside a collapsed branch.
    const canExpand = source.kind === 'notes' || valid || row?.dataset.areaId === source.parentId;
    expandAfterHover(row !== rootTarget && canExpand ? row : null);
    document.body.classList.toggle('area-drag-invalid',inside && !valid);
    ghost.hidden = !inside && !gesture;
    if (!ghost.hidden) {
      const left = x+16+ghost.offsetWidth < innerWidth ? x+16 : x-ghost.offsetWidth-12;
      const top = y+14+ghost.offsetHeight < innerHeight ? y+14 : y-ghost.offsetHeight-10;
      ghost.style.transform = 'translate('+Math.max(4,left)+'px,'+Math.max(4,top)+'px)';
    }
    if (inside) autoScroll();
    return inside;
  }
  function finish(x,y) {
    const inside = updatePoint(x,y), destination = target, item = source;
    clear();
    if (destination && item.space === getWorkspace()) {
      const id = destination.dataset.areaId ?? null;
      if (item.kind === 'folder') {
        if (canMoveArea(item.space.areas,item.id,id)) onMove(item.id,id);
      } else onAssign(item.ids,id);
    }
    return inside;
  }
  function pointerDown(event) {
    if (event.button !== 0 || !event.isPrimary || gesture) return;
    const row = event.target.closest('.area-tree-link,.tree-note-link[data-note-id],.child-area[data-area-id],.note-row[data-note-id]');
    if (!row) return;
    const folder = row.closest('[data-area-id]');
    gesture = {pointerId:event.pointerId, x:event.clientX, y:event.clientY,
      folder:folder?.dataset.areaId, note:row.dataset.noteId, capture:event.currentTarget, active:false};
  }
  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.active) {
      const threshold = event.pointerType === 'touch' ? 10 : 5;
      if (Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y) < threshold) return;
      const selected = gesture.capture===list ? new Set(getListSelection()) : new Set();
      const started = gesture.folder ? startFolder(gesture.folder) :
        startNotes(selected.has(gesture.note) ? selected : [gesture.note]);
      if (!started) { clear(); return; }
      gesture.active = true;
      blockedClick = event.pointerId;
      gesture.capture.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    updatePoint(event.clientX,event.clientY);
  }
  function up(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (gesture.active) { event.preventDefault(); finish(event.clientX,event.clientY); }
    else clear();
  }
  for (const host of [tree,list]) {
    host.addEventListener('pointerdown',pointerDown,events);
    host.addEventListener('lostpointercapture',e=>{
      if (gesture?.active && gesture.pointerId === e.pointerId && e.target === host) clear();
    },events);
  }
  document.addEventListener('pointermove',move,events);
  document.addEventListener('pointerup',up,events);
  document.addEventListener('pointercancel',e=>{ if (gesture?.pointerId === e.pointerId) clear(); },events);
  document.addEventListener('keydown',e=>{
    if (e.key === 'Escape' && gesture) {
      e.preventDefault(); e.stopPropagation(); clear();
    }
  },{capture:true,signal:listeners.signal});
  document.addEventListener('pointerdown',()=>{blockedClick=null}, {capture:true,signal:listeners.signal});
  document.addEventListener('click',e=>{
    if (blockedClick === null || !e.detail || (e.pointerId != null && e.pointerId !== blockedClick)) return;
    blockedClick = null; e.preventDefault(); e.stopImmediatePropagation();
  },{capture:true,signal:listeners.signal});
  window.addEventListener('blur',clear,events);
  nav.addEventListener('scroll',()=>{ if (point && source) updatePoint(point.x,point.y); },events);
  return {
    hoverNotes(ids,x,y) { return startNotes(ids) && updatePoint(x,y); },
    dropNotes(ids,x,y) { return startNotes(ids) && finish(x,y); },
    clear,
    destroy() { clear(); listeners.abort(); ghost.remove(); delete rootTarget.dataset.dropLabel; }
  };
}
