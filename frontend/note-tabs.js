import { icon } from './art.js';
import { iconSvg } from './icons/node-art.js';
import { tr } from './i18n.js';
import { animateTitleSpoiler } from './note-title-particles.js';

const kindIcon = { text: 'newTextNote', canvas: 'newCanvas', data: 'newData' };

export function mountNoteTabs(root, { onOpen, onClose, onMove }) {
  const doc = root.ownerDocument;
  const tabs = new Map();
  let order = [];
  let selected = null;
  let drag = null;
  let drop = null;
  let frame = 0;
  let ignoreClick = false;

  function makeTab(id) {
    const item = doc.createElement('div');
    item.className = 'note-tab';
    item.dataset.noteId = id;
    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'note-tab-open';
    const symbol = doc.createElement('span');
    symbol.className = 'note-tab-icon';
    symbol.setAttribute('aria-hidden', 'true');
    const title = doc.createElement('span');
    title.className = 'note-tab-title';
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'note-tab-close';
    close.innerHTML = icon('x');
    open.append(symbol, title);
    item.append(open, close);
    open.addEventListener('click', event => {
      if (!ignoreClick || event.detail === 0) onOpen(id);
      ignoreClick = false;
    });
    close.addEventListener('click', () => onClose(id));
    open.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || drag) return;
      ignoreClick = false;
      drag = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false };
      open.setPointerCapture(event.pointerId);
    });
    return { item, open, close, symbol, title, label: null, locked: null, art: null, color: null };
  }

  function paintTab(view, tab, active) {
    const locked = !!tab.locked;
    const label = locked ? tr('Зашифрованная заметка', 'Encrypted note') : tab.title || tr('Без названия', 'Untitled');
    const closeLabel = tr('Закрыть вкладку', 'Close tab');
    if (view.label !== label || view.locked !== locked) {
      view.label = label;
      view.locked = locked;
      view.open.title = label;
      view.open.setAttribute('aria-label', label);
      if (locked) {
        const mask = doc.createElement('span');
        mask.className = 'note-title-spoiler';
        mask.setAttribute('aria-hidden', 'true');
        animateTitleSpoiler(mask);
        view.title.replaceChildren(mask);
      } else view.title.textContent = label;
    }
    const action = `${closeLabel}: ${label}`;
    view.close.title = closeLabel;
    view.close.setAttribute('aria-label', action);
    const fallback = locked ? 'lock' : kindIcon[tab.type] || kindIcon.text;
    const art = tab.icon || fallback;
    if (view.art !== art) {
      view.art = art;
      const svg = iconSvg(tab.icon);
      if (svg) view.symbol.replaceChildren(svg);
      else view.symbol.innerHTML = icon(fallback);
    }
    if (view.color !== tab.color) {
      view.color = tab.color;
      view.item.style.setProperty('--note-tab-tint', tab.color || '');
    }
    view.item.classList.toggle('is-active', active);
    view.open.setAttribute('aria-pressed', String(active));
  }

  function focus(id) {
    const view = tabs.get(id);
    if (!view) return false;
    view.open.focus({ preventScroll: true });
    view.item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  function update(records, activeId) {
    if (drag && !records.some(tab => tab.id === drag.id)) finishDrag(false);
    const nextOrder = records.map(tab => tab.id);
    const keep = new Set(nextOrder);
    const oldFocus = doc.activeElement;
    for (const [id, view] of tabs) {
      if (keep.has(id)) continue;
      view.item.remove();
      tabs.delete(id);
    }
    let next = root.firstElementChild;
    for (const tab of records) {
      let view = tabs.get(tab.id);
      if (!view) tabs.set(tab.id, view = makeTab(tab.id));
      paintTab(view, tab, tab.id === activeId);
      if (view.item !== next) root.insertBefore(view.item, next);
      next = view.item.nextElementSibling;
    }
    order = nextOrder;
    root.setAttribute('aria-label', tr('Открытые заметки', 'Open notes'));
    root.hidden = records.length === 0;
    doc.documentElement.classList.toggle('has-note-tabs', !root.hidden);
    if (root.contains(oldFocus) && doc.activeElement !== oldFocus) oldFocus.focus({ preventScroll: true });
    if (activeId !== selected) {
      selected = activeId;
      tabs.get(selected)?.item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function markDrop(x) {
    const otherIds = order.filter(id => id !== drag.id);
    const before = otherIds.find(id => {
      const rect = tabs.get(id).item.getBoundingClientRect();
      return x < rect.left + rect.width / 2;
    });
    const item = tabs.get(before ?? otherIds.at(-1))?.item;
    if (item === drop?.item && before === drop?.before) return;
    if (drop) delete drop.item.dataset.drop;
    if (item) item.dataset.drop = before ? 'before' : 'after';
    drop = item ? { item, before } : null;
  }

  function scrollDrag() {
    frame = 0;
    if (!drag?.active) return;
    const rect = root.getBoundingClientRect();
    const left = drag.x - rect.left, right = rect.right - drag.x;
    const speed = left < 28 ? -8 : right < 28 ? 8 : 0;
    const old = root.scrollLeft;
    root.scrollLeft += speed;
    if (root.scrollLeft !== old) {
      markDrop(drag.x);
      frame = requestAnimationFrame(scrollDrag);
    }
  }

  function finishDrag(move) {
    const { id, active } = drag;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    drag = null;
    root.classList.remove('is-dragging');
    tabs.get(id)?.item.classList.remove('is-dragging');
    const target = drop;
    if (drop) delete drop.item.dataset.drop;
    drop = null;
    if (!active) return;
    ignoreClick = true;
    if (move && target) {
      const nextId = order[order.indexOf(id) + 1];
      if (nextId !== target.before) onMove(id, target.before ?? null);
    }
  }

  root.addEventListener('pointermove', event => {
    if (drag?.pointer !== event.pointerId) return;
    if (!drag.active) {
      if (order.length < 2 || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      drag.active = true;
      root.classList.add('is-dragging');
      tabs.get(drag.id).item.classList.add('is-dragging');
    }
    drag.x = event.clientX;
    markDrop(drag.x);
    if (!frame) frame = requestAnimationFrame(scrollDrag);
  });
  root.addEventListener('pointerup', event => {
    if (drag?.pointer === event.pointerId) {
      const rect = root.getBoundingClientRect();
      finishDrag(event.clientY >= rect.top && event.clientY <= rect.bottom);
    }
  });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    root.addEventListener(type, event => {
      if (drag?.pointer === event.pointerId) finishDrag(false);
    });
  }
  root.addEventListener('wheel', event => {
    if (event.ctrlKey || !event.deltaY || event.deltaX || root.scrollWidth <= root.clientWidth) return;
    event.preventDefault();
    root.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
  }, { passive: false });

  root.addEventListener('keydown', event => {
    const id = event.target.closest('.note-tab')?.dataset.noteId;
    const index = order.indexOf(id);
    if (index < 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (event.altKey && !delta) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : index + delta;
    if (!delta && event.key !== 'Home' && event.key !== 'End' && event.key !== 'Delete') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Delete') onClose(id);
    else if (event.altKey && order[next]) {
      onMove(id, (delta > 0 ? order[next + 1] : order[next]) ?? null);
      focus(id);
    } else focus(order[Math.max(0, Math.min(order.length - 1, next))]);
  });

  return { update, focus };
}
