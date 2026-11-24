import { icon } from './art.js';
import { boardIcon } from './board-icons.js';
import { tr } from './i18n.js';
import { shortcutLabel, shortcutAria } from './shortcuts.js';

export function selectionRect(a, b) {
  return {left:Math.min(a.x,b.x), right:Math.max(a.x,b.x), top:Math.min(a.y,b.y), bottom:Math.max(a.y,b.y)};
}

// Select any touched part of a bubble, including the drawn corners of a polygon.
export function intersectsNote(rect, note) {
  const {x,y,r,geometry} = note;
  if (x+r < rect.left || x-r > rect.right || y+r < rect.top || y-r > rect.bottom) return false;
  if (!geometry) {
    const dx = Math.max(rect.left-x, x-rect.right, 0);
    const dy = Math.max(rect.top-y, y-rect.bottom, 0);
    return dx*dx + dy*dy <= r*r;
  }
  const vertices = geometry.points;
  if (vertices.every(([px]) => x+px*r < rect.left) || vertices.every(([px]) => x+px*r > rect.right) ||
      vertices.every(([,py]) => y+py*r < rect.top) || vertices.every(([,py]) => y+py*r > rect.bottom)) return false;
  return geometry.normals.every(([nx,ny]) => {
    const nearX = nx < 0 ? rect.right : rect.left, nearY = ny < 0 ? rect.bottom : rect.top;
    return nx*(nearX-x) + ny*(nearY-y) <= geometry.apothem*r;
  });
}

export function mapAreaButton(canvas, choose, changeGroup) {
  const bar = document.createElement('div');
  bar.className = 'map-area-action';
  bar.hidden = true;
  const area = document.createElement('button'), group = document.createElement('button');
  area.type = group.type = 'button';
  area.setAttribute('aria-haspopup','dialog');
  area.innerHTML = icon('folder');
  const text = document.createElement('span'), count = document.createElement('span');
  count.className = 'map-selection-count';
  area.append(text,count);
  const groupLabel = document.createElement('span');
  group.innerHTML = boardIcon('group');
  group.append(groupLabel);
  bar.append(group,area);
  canvas.after(bar);
  area.onclick = () => choose(area);
  group.onclick = () => changeGroup?.(group.dataset.action);
  return {
    button:bar,
    place(bounds, size, width, height, groupAction) {
      const hidden = !bounds || (!size && !groupAction);
      if (bar.hidden !== hidden) bar.hidden = hidden;
      if (hidden) return;
      area.hidden = !size;
      group.hidden = !groupAction;
      if (groupAction) {
        const ungroup = groupAction === 'ungroup';
        const label = ungroup ? tr('Разгруппировать','Ungroup') : tr('Сгруппировать','Group');
        if (group.dataset.action !== groupAction || groupLabel.textContent !== label) {
          const keys = ungroup ? 'Ctrl+Shift+G' : 'Ctrl+G';
          group.dataset.action = groupAction;
          groupLabel.textContent = label;
          group.title = label + ' (' + shortcutLabel(keys) + ')';
          group.setAttribute('aria-keyshortcuts',shortcutAria(keys));
        }
      }
      const label = tr('В область…','Move to area…');
      if (text.textContent !== label) text.textContent = label;
      count.hidden = size < 2;
      if (count.textContent !== String(size)) count.textContent = String(size);
      const gap = 10, w = bar.offsetWidth, h = bar.offsetHeight;
      const x = Math.max(gap, Math.min((bounds.left+bounds.right-w)/2, width-w-gap));
      // Clear the map controls and the bubble titles underneath the selection.
      const below = bounds.bottom + 23;
      const y = below+h < height-66 ? below : bounds.top-h-gap;
      bar.style.left = Math.round(x)+'px';
      bar.style.top = Math.round(Math.max(52,Math.min(y,height-h-gap)))+'px';
    }
  };
}
