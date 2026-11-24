// Numeric families are shared with the Excalidraw file format.
export const handFont = 5;
export const sansFont = 2;
export const monoFont = 3;

export function fontStyle(id) {
  if (id === handFont || id === 1) return handFont;
  if (id === monoFont || id === 8) return monoFont;
  return sansFont;
}

export function fontStack(id) {
  switch (fontStyle(id)) {
    case handFont:
      return 'Excalifont, "Segoe Print", sans-serif';
    case monoFont:
      return 'Consolas, "Liberation Mono", monospace';
    default:
      return 'Inter, "Segoe UI", sans-serif';
  }
}

export function lineHeightFor(item) {
  if (Number.isFinite(item.lineHeight) && item.lineHeight >= 0.5 && item.lineHeight <= 4)
    return item.lineHeight;
  return fontStyle(item.fontFamily) === handFont ? 1.25 : 1.3;
}

let handFontReady;
export function loadHandFont() {
  return (handFontReady ||= document.fonts.load('20px Excalifont').catch(() => {
    handFontReady = undefined;
  }));
}

export function textLines(ctx, text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const token of paragraph.match(/\s+|\S+/gu) || []) {
      if (/^\s/u.test(token)) {
        line += token;
        continue;
      }
      if (line && ctx.measureText(line + token).width > width) {
        lines.push(line.trimEnd());
        line = '';
      }
      if (ctx.measureText(token).width <= width) {
        line += token;
        continue;
      }
      for (const ch of token) {
        if (line && ctx.measureText(line + ch).width > width) {
          lines.push(line);
          line = '';
        }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

let measureContext;
export function wrappedSceneText(item, text = item.text) {
  if (item.autoResize || typeof document === 'undefined') return text;
  measureContext ||= document.createElement('canvas').getContext('2d');
  measureContext.font = item.fontSize + 'px ' + fontStack(item.fontFamily);
  return textLines(measureContext, text, item.w).join('\n');
}
