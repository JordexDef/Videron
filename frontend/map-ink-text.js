import { fontStack, lineHeightFor, sansFont } from './board-fonts.js';
import { boardInk } from './board-theme.js';
import { tr } from './i18n.js';
import { primaryCommand, shortcutLabel } from './shortcuts.js';

export function newMapText(point, style) {
  return {id:crypto.randomUUID(), type:'text', ...point, ...style, text:'', w:1, h:29,
    fontSize:22, fontFamily:sansFont, autoResize:true};
}

function textSize(item) {
  return Number.isFinite(item.fontSize) ? Math.max(8, Math.min(180, item.fontSize)) : 22;
}

export function measureMapText(ctx, item, text) {
  const size = textSize(item), lines = text.split('\n');
  ctx.font = size + 'px ' + fontStack(item.fontFamily);
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  return {w:Math.max(1, Math.ceil(width + 1)), h:Math.ceil(size * lineHeightFor(item) * lines.length)};
}

export function paintMapText(ctx, item) {
  const size = textSize(item), lineHeight = size * lineHeightFor(item);
  ctx.font = size + 'px ' + fontStack(item.fontFamily);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const metrics = ctx.measureText('Hg');
  const baseline = (lineHeight + (metrics.fontBoundingBoxAscent ?? size * .8) - (metrics.fontBoundingBoxDescent ?? size * .2)) / 2;
  let y = baseline;
  for (const line of item.text.split('\n')) {
    ctx.fillText(line, 0, y);
    y += lineHeight;
  }
}

export function mountMapTextEditor({stage, canvas, graph, onFinish}) {
  const doc = stage.ownerDocument;
  let session, ruler;

  function sync() {
    if (!session) return;
    const {field,item} = session, z = graph.zoom;
    const x = (item.x - graph.camera.x) * z + graph.width / 2;
    const y = (item.y - graph.camera.y) * z + graph.height / 2;
    field.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + z + ')';
    field.style.color = boardInk(item).stroke;
  }
  function measure() {
    const {field,item} = session;
    ruler ??= doc.createElement('canvas').getContext('2d');
    const {w,h} = measureMapText(ruler, item, field.value);
    field.style.width = Math.max(112, w + 4) + 'px';
    field.style.height = (h + 1) + 'px';
    return {w,h};
  }
  function finish(save, refocus = false) {
    if (!session) return false;
    const {field,item,original} = session;
    const text = field.value;
    const after = save && text.trim() ? {...item, text, ...measure()} : null;
    session = null;
    field.remove();
    onFinish(original, original && text === original.text ? original : after, save);
    if (refocus) canvas.focus({preventScroll:true});
    return true;
  }
  function open(item, original) {
    finish(true);
    const field = doc.createElement('textarea');
    field.className = 'map-ink-text-editor';
    field.wrap = 'off';
    field.spellcheck = true;
    field.value = item.text;
    field.placeholder = tr('Текст', 'Text');
    field.setAttribute('aria-label', tr('Текст на карте', 'Map text'));
    field.title = shortcutLabel(tr('Ctrl+Enter — сохранить, Esc — отменить', 'Ctrl+Enter to save, Esc to cancel'));
    field.style.fontFamily = fontStack(item.fontFamily);
    field.style.fontSize = textSize(item) + 'px';
    field.style.lineHeight = String(lineHeightFor(item));
    field.addEventListener('input', measure);
    field.addEventListener('blur', () => { if (session?.field === field) finish(true); });
    field.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || (e.key === 'Enter' && primaryCommand(e) && !e.shiftKey)) {
        e.preventDefault(); e.stopPropagation();
        finish(e.key !== 'Escape', true);
      }
    });
    session = {field,item,original};
    stage.append(field);
    measure(); sync();
    field.focus({preventScroll:true});
    field.setSelectionRange(field.value.length, field.value.length);
    graph.repaint();
  }
  return {open, sync, finish, get item() { return session?.item; }};
}
