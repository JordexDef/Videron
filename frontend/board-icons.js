import { icon } from './art.js';

const extraIcons = {
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11"/>',
  rect: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  diamond: '<path d="m12 2 10 10-10 10L2 12z"/>',
  line: '<path d="m4 20 16-16"/>',
  pen: '<path d="M3 20c3-9 7 5 11-4m-5-2 1-4L18 2l4 4-8 8-5 1z"/>',
  drawingTools: '<path d="m3 14 5-9 5 9z"/><circle cx="16.5" cy="15" r="4.5"/>',
  erase:
    '<path d="m4 12 9-9a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-9 9H9l-5-5a2 2 0 0 1 0-3zm4-4 8 8m-7 4h12"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 4-5 4 5"/>',
  undo: '<path d="M8 5 3 10l5 5m-5-5h11a6 6 0 0 1 0 12"/>',
  redo: '<path d="m16 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>',
  duplicate:
    '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  front: '<rect x="3" y="3" width="12" height="12" rx="2"/><path d="M9 16v4h11V9h-4"/>',
  backLayer: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M8 15H3V3h12v5"/>',
  group:
    '<rect x="2" y="2" width="20" height="20" rx="3" stroke-dasharray="2 3"/><rect x="6" y="6" width="6" height="6"/><path d="M11 14v4h7v-7h-4"/>',
  rotate: '<path d="M20 10a8 8 0 1 0-2 8m2-14v6h-6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  unlock:
    '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.6-1.7M12 15v2"/>',
  move: '<path d="M12 2v20M2 12h20M9 5l3-3 3 3m4 4 3 3-3 3M5 9l-3 3 3 3m4 4 3 3 3-3"/>',
  styles:
    '<circle cx="12" cy="12" r="8"/><path d="M12 4v16a8 8 0 0 1 0-16" fill="currentColor" stroke="none"/>'
};
export function boardIcon(key) {
  return extraIcons[key]
    ? '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + extraIcons[key] + '</svg>'
    : icon(key);
}
