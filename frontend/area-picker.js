import { areaTreeRows } from './areas.js';
import { icon } from './art.js';
import { tr } from './i18n.js';

// One field can find a destination or supply the name for a new folder.
export function areaPicker({anchor, title, areas, allowed = () => true, rootLabel,
  currentId, createIn, choose, create, close, full}) {
  const box = document.createElement('section');
  box.className = 'area-picker';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', title);
  box.anchor = anchor instanceof Element ? anchor : null;
  const input = document.createElement('input'), list = document.createElement('div');
  input.type = 'text'; input.maxLength = 80; input.autocomplete = 'off';
  list.className = 'area-picker-list';
  box.append(input, list);
  const paths = [], entries = [];
  for (const {area, depth, pathLabel} of areaTreeRows(areas)) {
    if (allowed(area.id)) entries.push({id:area.id, name:area.name,
      parent:depth ? paths[depth-1] : '', color:area.color, grid:!!area.grid});
    paths[depth] = pathLabel;
  }
  if (rootLabel && allowed(null)) entries.unshift({id:null, name:rootLabel, parent:''});
  let naming = !!create && !entries.length, active = null, raf = 0;
  function row(symbol, name, detail, action) {
    const b = document.createElement('button'), label = document.createElement('span');
    b.type = 'button'; b.innerHTML = icon(symbol);
    const primary = document.createElement('strong'); primary.textContent = name;
    label.append(primary);
    if (detail) {
      const pathLabel = document.createElement('small'); pathLabel.textContent = detail; label.append(pathLabel);
    }
    b.append(label); b.onclick = action;
    return b;
  }
  function render() {
    const query = input.value.trim(), term = query.toLocaleLowerCase();
    const found = naming ? [] : entries.filter(entry =>
      (entry.parent + ' / ' + entry.name).toLocaleLowerCase().includes(term));
    input.placeholder = naming ? tr('Название новой области','New area name') :
      create ? tr('Найти или создать область','Find or create an area') : tr('Найти область','Find an area');
    input.setAttribute('aria-label', input.placeholder);
    list.replaceChildren();
    for (const entry of found) {
      const unavailable=full?.has(entry.id);
      const detail=[entry.parent,unavailable && tr('Недостаточно мест','Not enough slots')].filter(Boolean).join(' · ');
      const b = row(entry.id === null ? 'layers' : entry.grid ? 'slots' : 'folder', entry.name, detail, () => choose(entry.id));
      b.disabled=!!unavailable;
      if (entry.color) b.firstElementChild.style.color = entry.color;
      if (entry.id === currentId) b.insertAdjacentHTML('beforeend',icon('check'));
      list.append(b);
    }
    const exact = found.find(entry => entry.name.toLocaleLowerCase() === term);
    active = exact ? list.children[found.indexOf(exact)] : list.querySelector('button:enabled');
    if (create) {
      const label = query ? tr('Создать «{name}»','Create “{name}”',{name:query}) : tr('Новая область…','New area…');
      const add = row('plus', label, createIn, () => {
        if (query) create(query);
        else { naming = true; render(); input.focus(); }
      });
      add.className = 'area-picker-create';
      add.disabled = naming && !query;
      list.append(add);
      if (!active || naming) active = add;
    } else if (!found.length) {
      const empty = document.createElement('p'); empty.textContent = tr('Нет подходящих областей','No matching areas'); list.append(empty);
    }
    active?.classList.add('area-picker-current');
  }
  input.oninput = render;
  box.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(); box.anchor?.focus({preventScroll:true}); return;
    }
    if (event.key === 'Enter' && event.target === input) {
      event.preventDefault(); active?.click(); return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const targets = [input, ...list.querySelectorAll('button:enabled')];
      const index = targets.indexOf(document.activeElement);
      const next = index + (event.key === 'ArrowDown' ? 1 : -1);
      event.preventDefault(); targets[(next + targets.length) % targets.length].focus();
    }
  };
  box.onfocusout = event => { if (event.relatedTarget && !box.contains(event.relatedTarget)) close(); };
  function place() {
    raf = 0;
    if (!box.isConnected) return;
    if (box.anchor && !box.anchor.isConnected) { close(); return; }
    const rect = box.anchor ? box.anchor.getBoundingClientRect() : anchor;
    const x = rect.left ?? rect.x, y = rect.bottom ?? rect.y, gap = 6;
    const top = y + gap + box.offsetHeight <= innerHeight ? y + gap : (rect.top ?? y) - gap - box.offsetHeight;
    box.style.left = Math.max(gap, Math.min(x, innerWidth - box.offsetWidth - gap)) + 'px';
    box.style.top = Math.max(gap, Math.min(top, innerHeight - box.offsetHeight - gap)) + 'px';
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(place); }
  const events = new AbortController(), size = new ResizeObserver(schedule), movement = new MutationObserver(schedule);
  size.observe(box);
  if (box.anchor) {
    size.observe(box.anchor); movement.observe(box.anchor,{attributes:true,attributeFilter:['style','hidden']});
  }
  window.addEventListener('scroll',schedule,{capture:true,signal:events.signal});
  window.addEventListener('resize',schedule,{signal:events.signal});
  box.dispose = () => { events.abort(); size.disconnect(); movement.disconnect(); cancelAnimationFrame(raf); };
  document.body.append(box); render(); place(); input.focus({preventScroll:true});
  return box;
}
