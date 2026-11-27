import {icon} from './art.js';
import {tr} from './i18n.js';

export function mountMapQuickEntry(canvas, canCapture, onCapture, requestFrame) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-quick-entry';
  button.setAttribute('aria-haspopup', 'dialog');
  button.innerHTML = icon('plus');
  button.hidden = true;
  canvas.after(button);
  let id = null, hovered = false;
  button.onclick = () => { if (id) onCapture(id, button); };
  button.onpointerenter = () => { hovered = true; };
  button.onpointerleave = () => { hovered = false; requestFrame(); };
  button.onblur = requestFrame;

  function hide() {
    id = null;
    hovered = false;
    button.hidden = true;
  }

  function sync(graph, activeId) {
    if (graph.drag || graph.pinch || graph.spacePan) { hide(); return; }
    const onlySelected = graph.selectedIds.size === 1 && !graph.selectedInkIds.size ? graph.selectedIds.values().next().value : null;
    const retained = hovered || document.activeElement === button ? id : null;
    const target = [activeId, retained, graph.hover, onlySelected].find(candidate => graph.nodes.get(candidate)?.quickEntry && canCapture(candidate));
    const bounds = target && graph.noteBounds(target, graph.width, graph.height);
    if (!bounds) { hide(); return; }
    id = target;
    const title = tr('Добавить запись', 'Add entry');
    if (button.title !== title) { button.title = title; button.setAttribute('aria-label', title); }
    const x = Math.max(18, Math.min(graph.width - 18, bounds.left + bounds.width + 3));
    const y = Math.max(18, Math.min(graph.height - 18, bounds.top + bounds.height / 2));
    const left = Math.round(x) + 'px', top = Math.round(y) + 'px';
    if (button.style.left !== left) button.style.left = left;
    if (button.style.top !== top) button.style.top = top;
    const expanded = String(target === activeId);
    if (button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);
    if (button.hidden) button.hidden = false;
  }

  return {button, hide, sync};
}
