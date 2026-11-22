import { icon } from './art.js';
import { tr } from './i18n.js';

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

export function mapAreaButton(canvas, choose) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-area-action';
  button.setAttribute('aria-haspopup','dialog');
  button.hidden = true;
  button.innerHTML = icon('folder');
  const text = document.createElement('span'), count = document.createElement('span');
  count.className = 'map-selection-count';
  button.append(text,count);
  canvas.after(button);
  button.onclick = () => choose(button);
  return {
    button,
    place(bounds, size, width, height) {
      const hidden = !bounds || !size;
      if (button.hidden !== hidden) button.hidden = hidden;
      if (button.hidden) return;
      const label = tr('В область…','Move to area…');
      if (text.textContent !== label) text.textContent = label;
      count.hidden = size < 2;
      if (count.textContent !== String(size)) count.textContent = String(size);
      const gap = 10, w = button.offsetWidth, h = button.offsetHeight;
      const x = Math.max(gap, Math.min((bounds.left+bounds.right-w)/2, width-w-gap));
      // Clear the map controls and the bubble titles underneath the selection.
      const below = bounds.bottom + 23;
      const y = below+h < height-66 ? below : bounds.top-h-gap;
      button.style.left = Math.round(x)+'px';
      button.style.top = Math.round(Math.max(52,Math.min(y,height-h-gap)))+'px';
    }
  };
}
