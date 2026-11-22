import { icon } from './art.js';
import { tr } from './i18n.js';
import { isProtectedNote, protectedNoteTitle } from './note-vault.js';

const untitled = () => tr('Без названия', 'Untitled');
const routesLabel = () => tr('Маршруты', 'Routes');
const savedRoutes = space => Array.isArray(space?.routes) ? space.routes.filter(route =>
  typeof route?.id === 'string' && typeof route.name === 'string' && Array.isArray(route.stops)) : [];

function copyStop(stop) {
  if (typeof stop?.noteId !== 'string' || !stop.noteId) return null;
  return {noteId:stop.noteId, fragment:typeof stop.fragment === 'string' ? stop.fragment : null};
}

export function storeRoute(space, draft) {
  const stops = draft.stops.map(copyStop).filter(Boolean);
  if (!stops.length) return false;
  const routes = savedRoutes(space);
  const index = routes.findIndex(route => route.id === draft.id);
  const name = draft.name.trim() || tr('Маршрут ', 'Route ') + (index < 0 ? routes.length + 1 : index + 1);
  const route = {id:draft.id, name, stops};
  if (index < 0) routes.push(route);
  else routes[index] = route;
  space.routes = routes;
  return true;
}

// Keep the original index even if a stop is unavailable. Undoing note deletion
// then restores its place in the route without any second history transaction.
export function availableStops(space, route) {
  const readable = new Map((space?.notes || []).filter(note => !isProtectedNote(note)).map(note => [note.id,note]));
  return (route?.stops || []).flatMap((stop, index) => {
    const note = readable.get(stop?.noteId);
    return note ? [{index, stop, note}] : [];
  });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, glyph, action, className = '') {
  const node = element('button', 'route-btn ' + className);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  node.innerHTML = glyph === 'play'
    ? '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="m7 4 13 8-13 8z"/></svg>'
    : icon(glyph);
  node.addEventListener('click', action);
  return node;
}

function drawRoute(ctx, graph, stops, current, ox, oy, zoom, playing, badgesOnly) {
  if (!stops.length) return;
  const points = stops.map(({index, stop}, position) => {
    const node = graph.nodes.get(stop.noteId);
    return node && {x:ox + node.x * zoom, y:oy + node.y * zoom, radius:node.r * zoom,
      id:stop.noteId, index, ordinal:(playing ? position : index) + 1};
  }).filter(Boolean);
  if (!points.length) return;
  ctx.save();
  if (!badgesOnly) {
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = '#c1b7d6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.font = '600 10px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const badges = new Map();
  for (const point of points) {
    if (!badges.has(point.id) || point.index === current) badges.set(point.id, point);
  }
  for (const point of badges.values()) {
    const offset = point.radius * Math.SQRT1_2;
    const x = point.x - offset, y = point.y - offset;
    if (x < -15 || x > graph.width + 15 || y < -11 || y > graph.height + 11) continue;
    ctx.beginPath();
    ctx.arc(x, y, 9.5, 0, Math.PI * 2);
    ctx.fillStyle = point.index === current ? '#dfd9eb' : '#302d36';
    ctx.fill();
    ctx.strokeStyle = '#938c9c';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = point.index === current ? '#29262d' : '#e6e1eb';
    ctx.fillText(String(point.ordinal), x, y, 17);
  }
  ctx.restore();
}

export function mountMapRoutes({stage, getSpace, getFragments = () => [], onChange, onVisit, onStop, onModeChange}) {
  const panel = element('section', 'map-routes');
  let mode = '', space, anchor, route, draft, stops = [], index = -1;
  let expanded = false, deleting = null, hint = '', lastPick = -Infinity;

  function reset() {
    if (!mode) return;
    const wasPlaying = mode === 'play';
    mode = ''; space = null; route = null; draft = null; stops = []; index = -1;
    expanded = false; deleting = null; hint = ''; lastPick = -Infinity;
    panel.remove(); panel.replaceChildren();
    delete stage.dataset.routeMode;
    anchor?.setAttribute('aria-expanded', 'false');
    anchor = null;
    document.removeEventListener('pointerdown', outside, true);
    if (wasPlaying) onStop?.();
    onModeChange?.(mode);
  }

  function outside(event) {
    if (mode === 'list' && !panel.contains(event.target) && !anchor?.contains(event.target)) reset();
  }

  function render() {
    stage.dataset.routeMode = mode;
    panel.className = 'map-routes map-route-' + mode;
    panel.setAttribute('aria-label', routesLabel());
    panel.replaceChildren();
    if (mode === 'list') renderList();
    if (mode === 'edit') renderEdit();
    if (mode === 'play') renderPlayer();
    if (!panel.isConnected) stage.append(panel);
    onModeChange?.(mode);
  }

  function open(target) {
    if (mode && space !== getSpace()) reset();
    if (mode === 'edit') {
      expanded = !expanded;
      render();
      return;
    }
    if (mode === 'list') { reset(); return; }
    reset();
    space = getSpace();
    if (!space) return;
    mode = 'list'; anchor = target;
    anchor?.setAttribute('aria-expanded','true');
    const bounds = stage.getBoundingClientRect(), at = anchor?.getBoundingClientRect();
    panel.style.setProperty('--route-right', Math.max(8, Math.min(bounds.width - 310, bounds.right - (at?.right ?? bounds.right))) + 'px');
    panel.style.setProperty('--route-top', Math.max(8, Math.min(bounds.height - 150, (at?.bottom ?? bounds.top + 44) - bounds.top + 7)) + 'px');
    document.addEventListener('pointerdown', outside, true);
    render();
    panel.querySelector('.route-start:enabled,.route-new')?.focus({preventScroll:true});
  }

  function beginEdit(item) {
    route = null; mode = 'edit'; deleting = null; expanded = false; hint = ''; lastPick = -Infinity;
    draft = item ? {id:item.id, name:item.name, stops:item.stops.map(copyStop).filter(Boolean)}
      : {id:crypto.randomUUID(), name:'', stops:[]};
    index = draft.stops.length - 1;
    stops = availableStops(space, draft);
    render();
    panel.querySelector('input').focus({preventScroll:true});
  }

  function visit(originalIndex) {
    const keepPlayerFocus = panel.contains(document.activeElement);
    const previousButton = document.activeElement?.classList.contains('route-prev');
    index = originalIndex;
    const current = stops.find(item => item.index === index);
    render();
    if (current) onVisit?.(current.note.id, current.stop.fragment ?? null);
    if (keepPlayerFocus) {
      const previous = previousButton && panel.querySelector('.route-prev:enabled');
      (previous || panel.querySelector('.route-next'))?.focus({preventScroll:true});
    }
  }

  function start(item) {
    stops = availableStops(space, item);
    if (!stops.length) { render(); return; }
    mode = 'play'; route = item; deleting = null;
    visit(stops[0].index);
  }

  function step(delta) {
    const next = stops[stops.findIndex(item => item.index === index) + delta];
    if (next) visit(next.index);
  }

  function renderList() {
    const heading = element('div', 'route-list-head');
    heading.append(element('strong','',routesLabel()), button(tr('Закрыть','Close'),'x',reset));
    const list = element('div','route-list-items');
    const readable = new Set(space.notes.filter(note => !isProtectedNote(note)).map(note => note.id));
    for (const item of savedRoutes(space)) {
      const row = element('div', 'route-row');
      if (deleting === item.id) {
        row.append(element('span','route-ellipsis', tr('Удалить маршрут?','Delete this route?')),
          button(tr('Отмена','Cancel'),'x',() => { deleting = null; render(); }),
          button(tr('Удалить','Delete'),'check',() => {
            space.routes = savedRoutes(space).filter(old => old.id !== item.id);
            deleting = null; onChange?.(); render();
          }));
      } else {
        const count = item.stops.filter(stop => readable.has(stop?.noteId)).length;
        const play = button(tr('Пройти маршрут','Play route') + ' · ' + item.name,'play',() => start(item),'route-start');
        play.disabled = !count;
        if (!count) play.title = tr('Нет доступных остановок','No available stops');
        play.append(element('span','route-ellipsis',item.name), element('small','',String(count)));
        row.append(play,button(tr('Редактировать','Edit'),'edit',() => beginEdit(item)),
          button(tr('Удалить маршрут','Delete route'),'trash',() => { deleting = item.id; render(); }));
      }
      list.append(row);
    }
    const create = button(tr('Новый маршрут','New route'),'plus',() => beginEdit(null),'route-new');
    create.append(element('span','',tr('Новый маршрут','New route')));
    panel.append(heading, list, create);
  }

  function changeDraft() {
    hint = '';
    stops = availableStops(space, draft);
    index = Math.min(index, draft.stops.length - 1);
    render();
  }

  function renderStops() {
    const list = element('ol','route-edit-stops');
    const notes = new Map(space.notes.map(note => [note.id,note]));
    draft.stops.forEach((stop,i) => {
      const note = notes.get(stop.noteId), row = element('li','');
      const name = !note ? tr('Заметка удалена','Deleted note') : isProtectedNote(note) ? protectedNoteTitle() : note.title.trim() || untitled();
      const title = element('span','route-ellipsis',name);
      title.title = name;
      row.append(element('small','route-stop-number', String(i+1)), title);
      const move = delta => {
        const dest = i + delta;
        [draft.stops[i], draft.stops[dest]] = [draft.stops[dest], draft.stops[i]];
        index = dest; changeDraft();
      };
      const up = button(tr('Переместить выше','Move up'),'chevron',() => move(-1),'route-up');
      const down = button(tr('Переместить ниже','Move down'),'chevron',() => move(1),'route-down');
      up.disabled = i === 0; down.disabled = i === draft.stops.length - 1;
      row.append(up, down, button(tr('Убрать остановку','Remove stop'),'x',() => {
        draft.stops.splice(i,1); changeDraft();
      }));
      const fragments = note && !isProtectedNote(note) ? getFragments(note) : [];
      if (fragments.length) {
        const select = element('select','route-fragment');
        select.setAttribute('aria-label', tr('Фрагмент заметки','Note excerpt') + ' · ' + name);
        const initial = element('option','',tr('Фрагмент с карты','Map preview'));
        initial.value = '';
        select.append(initial);
        for (const fragment of fragments) {
          const option = element('option','', fragment.label);
          option.value = fragment.key;
          select.append(option);
        }
        select.value = fragments.some(part => part.key === stop.fragment) ? stop.fragment : '';
        select.onchange = () => { stop.fragment = select.value || null; };
        row.append(select);
      }
      list.append(row);
    });
    return list;
  }

  function renderEdit() {
    const bar = element('div','route-edit-bar');
    const name = element('input','route-name');
    name.value = draft.name;
    name.placeholder = tr('Название маршрута','Route name');
    name.setAttribute('aria-label', name.placeholder);
    name.oninput = () => { draft.name = name.value; };
    name.onkeydown = event => {
      if (event.key === 'Enter') { name.blur(); stage.querySelector('canvas')?.focus({preventScroll:true}); }
      if (event.key === 'Escape') { event.stopPropagation(); name.blur(); }
    };
    const details = button(tr('Остановки и фрагменты','Stops and excerpts'),'list',() => {
      expanded = !expanded; render(); panel.querySelector('.route-count')?.focus({preventScroll:true});
    },'route-count');
    details.append(element('span','',String(draft.stops.length)));
    details.disabled = !draft.stops.length;
    details.setAttribute('aria-expanded', String(expanded && draft.stops.length > 0));
    const save = button(tr('Сохранить маршрут','Save route'),'check',() => {
      if (!storeRoute(space, draft)) return;
      draft = null; stops = []; index = -1; mode = 'list'; expanded = false;
      onChange?.(); render();
    },'route-save');
    save.append(element('span','',tr('Сохранить','Save')));
    save.disabled = !draft.stops.length;
    bar.append(name, details, save, button(tr('Отменить редактирование','Cancel editing'),'x',reset));
    const instruction = element('p','route-hint',hint || tr('Щёлкайте заметки в порядке показа','Click notes in the order you want to visit them'));
    instruction.setAttribute('role','status');
    if (expanded && draft.stops.length) panel.append(renderStops());
    panel.append(instruction,bar);
  }

  function renderPlayer() {
    const position = stops.findIndex(item => item.index === index);
    const note = stops[position]?.note;
    const caption = element('div','route-caption');
    caption.append(element('small','route-ellipsis',route.name),element('strong','route-ellipsis',note?.title.trim() || untitled()));
    const previous = button(tr('Предыдущая остановка (←)','Previous stop (←)'),'chevron',() => step(-1),'route-prev');
    previous.disabled = position <= 0;
    const last = position === stops.length - 1;
    const next = last ? button(tr('Завершить маршрут','Finish route'),'check',reset,'route-next')
      : button(tr('Следующая остановка (→)','Next stop (→)'),'chevron',() => step(1),'route-next');
    const count = element('span','route-position', (position+1) + ' / ' + stops.length);
    count.setAttribute('aria-live','polite');
    panel.append(caption, previous, count, next, button(tr('Выйти из маршрута (Esc)','Exit route (Esc)'),'x',reset));
  }

  function pick(id) {
    if (mode !== 'edit' || space !== getSpace()) return false;
    const note = space.notes.find(note => note.id === id);
    if (!note || isProtectedNote(note)) {
      hint = tr('Выберите незашифрованную заметку','Choose an unencrypted note');
      render();
      return true;
    }
    const now = performance.now();
    if (draft.stops.at(-1)?.noteId === id && now - lastPick < 450) return true;
    draft.stops.push({noteId:id,fragment:null});
    lastPick = now;
    index = draft.stops.length - 1;
    changeDraft();
    return true;
  }

  function keydown(event) {
    if (!mode || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey ||
      event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return false;
    if (event.key === 'Escape') reset();
    else if (mode !== 'play') return false;
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'Home') visit(stops[0].index);
    else if (event.key === 'End') visit(stops.at(-1).index);
    else return false;
    event.preventDefault();
    return true;
  }

  function refresh() {
    if (!mode) return;
    if (space !== getSpace()) { reset(); return; }
    if (mode === 'play') {
      route = savedRoutes(space).find(item => item.id === route.id);
      stops = availableStops(space, route);
      if (!stops.length) { reset(); return; }
      if (!stops.some(item => item.index === index)) {
        visit((stops.find(item => item.index > index) || stops.at(-1)).index);
        return;
      }
    } else if (mode === 'edit') {
      stops = availableStops(space, draft);
      if (panel.contains(document.activeElement) && document.activeElement.matches('input,select')) return;
    }
    render();
  }

  return {open, pick, keydown, reset, refresh, isEditing:() => mode === 'edit',
    draw:(ctx, graph, ox, oy, zoom, badgesOnly = false) =>
      drawRoute(ctx, graph, stops, index, ox, oy, zoom, mode === 'play', badgesOnly)};
}
