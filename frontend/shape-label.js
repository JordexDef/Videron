import { tr } from './i18n.js';
import { fontStack, handFont, lineHeightFor, textLines } from './board-fonts.js';

export function labelFrame(shape) {
  const fraction = shape.type === 'ellipse' ? Math.SQRT1_2 : shape.type === 'diamond' ? 0.5 : 1;
  const w = Math.max(1, shape.w * fraction - 8);
  const h = Math.max(1, shape.h * fraction - 8);
  return { x:(shape.w - w) / 2, y:(shape.h - h) / 2, w, h };
}

let measuring;
export function layoutShapeLabel(shape, ctx) {
  const frame = labelFrame(shape);
  const family = shape.fontFamily || handFont;
  const leading = lineHeightFor({fontFamily:family});
  const max = Math.min(shape.fontSize || 20, frame.h / leading);
  const min = Math.min(8, max);
  const text = shape.label || '';
  if (!ctx && typeof document !== 'undefined') {
    measuring ||= document.createElement('canvas').getContext('2d');
    ctx = measuring;
  }
  function measure(size) {
    if (!ctx) return text.split('\n');
    ctx.font = size + 'px ' + fontStack(family);
    return textLines(ctx, text, frame.w);
  }
  let size = max, lines = measure(size);
  if (size > min && lines.length * size * leading > frame.h) {
    let low = min, high = max;
    while (high - low > 0.5) {
      const test = (low + high) / 2;
      if (measure(test).length * test * leading <= frame.h) low = test;
      else high = test;
    }
    size = low; lines = measure(size);
  }
  const line = size * leading, height = Math.min(frame.h, lines.length * line);
  const color = shape.labelColor || shape.stroke || '#d4d4d4';
  return { ...frame, y:(shape.h - height) / 2, h:height, color, size, family, leading, line, lines };
}

export function paintShapeLabel(ctx, shape) {
  const box = layoutShapeLabel(shape, ctx);
  ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.fillStyle = box.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  box.lines.forEach((line, i) => ctx.fillText(line, shape.w / 2, box.y + (i + 0.5) * box.line));
  ctx.restore();
}

export function createShapeLabel(wrap, onInput, onBlur, onKey) {
  const display = document.createElement('span');
  display.className = 'vb-shape-label';
  wrap.append(display);
  let field, shape, match;
  function update(item) {
    shape = item;
    if (!field && !item.label) { display.hidden = true; return; }
    const box = layoutShapeLabel(item);
    const node = field || display;
    display.hidden = !!field;
    node.style.width = box.w + 'px';
    node.style.height = box.h + 'px';
    node.style.color = box.color;
    node.style.fontSize = box.size + 'px';
    node.style.fontFamily = fontStack(box.family);
    node.style.lineHeight = String(box.leading);
    if (field) {
      field.readOnly = !!item.locked;
      if (field.value !== (item.label || '')) field.value = item.label || '';
    } else {
      display.textContent = box.lines.join('\n');
      if (match?.text === item.label && (match.persistent || performance.now() - match.time < 2200)) paintMatch();
    }
  }
  function start() {
    if (field) return;
    match = null;
    field = document.createElement('textarea');
    field.className = 'vb-shape-label-input';
    field.setAttribute('aria-label', tr('Текст внутри фигуры', 'Text inside shape'));
    field.spellcheck = true;
    field.value = shape.label || '';
    field.oninput = event => onInput(field.value, event.inputType);
    field.onkeydown = onKey;
    for (const event of ['copy', 'cut', 'paste']) field.addEventListener(event, e => e.stopPropagation());
    field.onblur = () => {
      const old = field;
      if (old.value !== (shape.label || '')) onInput(old.value, 'insertCompositionText');
      field = null;
      old.remove(); update(shape); onBlur();
    };
    wrap.append(field); update(shape);
    field.focus({preventScroll:true}); field.select();
  }
  function highlight(start, end, persistent = false) {
    if (!shape.label || field) return;
    match = {start, end, text:shape.label, time:performance.now(), persistent};
    paintMatch();
  }
  function paintMatch() {
    const {start, end} = match;
    const lines = display.textContent.split('\n'), content = document.createDocumentFragment();
    let offset = 0;
    for (const [index, line] of lines.entries()) {
      if (index) content.append('\n');
      // Soft wraps can trim the separating space or split a single long word.
      const pos = shape.label.indexOf(line, offset);
      if (pos < 0) { content.append(line); continue; }
      const from = Math.max(start - pos, 0), to = Math.min(end - pos, line.length);
      if (from < to) {
        const mark = document.createElement('span');
        mark.className = match.persistent ? 'vb-find-mark' : 'vb-search-caption';
        if (!match.persistent) mark.style.animationDelay = (match.time - performance.now()) + 'ms';
        mark.textContent = line.slice(from, to);
        content.append(line.slice(0, from), mark, line.slice(to));
      } else content.append(line);
      offset = pos + line.length;
    }
    display.replaceChildren(content);
  }
  return {update, start, highlight, clearHighlight() {match = null; update(shape);}, get field() { return field; }};
}
