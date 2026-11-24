import { isLightTheme } from './theme.js';

// Imported boards can have their own paper, independent of the application.
export function boardPaper(background) {
  if (background) return background;
  return isLightTheme() ? '#fafafa' : '#171717';
}

export function lightPaper(color) {
  const channels = color.slice(1).match(/../g).map(hex => {
    const s = parseInt(hex, 16) / 255;
    return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  });
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2] > .18;
}

// Older drawings stored the default pen as this literal shade of gray.
// Resolve it for display/export; the saved drawing stays identical across themes.
export function boardInk(item, background, paper = boardPaper(background)) {
  if (background || item.fixedStroke || item.stroke !== '#d4d4d4' || paper === '#171717') return item;
  const ink = {...item, stroke:'#232323'};
  if (!item.labelColor && item.fillStyle === 'solid' && item.fill && item.fill !== 'none' && !lightPaper(item.fill)) {
    ink.labelColor = '#d4d4d4';
  }
  return ink;
}
