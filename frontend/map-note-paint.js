import { drawIcon, edgeRadius, traceOutline } from './icons/node-art.js';

const rgba = (tint, alpha) => `rgba(${tint},${alpha})`;
// A transient drag canvas can disappear while all of its notes stay open.
const contextPaints = new WeakMap();

function notePaint(ctx, node) {
  let notePaints = contextPaints.get(ctx);
  if (!notePaints) { notePaints=new WeakMap(); contextPaints.set(ctx,notePaints); }
  let paint = notePaints.get(node);
  if (!paint || paint.heat !== node.heat ||
      paint.tint !== node.tint || paint.customColor !== node.customColor) {
    const {tint, heat, customColor} = node;
    paint = { tint, heat, customColor, styles:[] };
    notePaints.set(node,paint);
  }
  return paint;
}

function gradient(ctx, tint, heat, x, y, inner, outer) {
  const glow = ctx.createRadialGradient(x,y,inner,x,y,outer);
  glow.addColorStop(0,rgba(tint,heat*.21));
  glow.addColorStop(.52,rgba(tint,heat*.065));
  glow.addColorStop(1,rgba(tint,0));
  return glow;
}

function bodyStyle(paint, selected, hovered) {
  const state = selected ? 2 : hovered ? 1 : 0;
  if (!paint.styles[state]) {
    const alpha = (selected ? .13 : hovered ? .09 : .042) + (paint.customColor ? .11 : 0) + paint.heat*.24;
    // Composite the tint over the opaque #1b1b1b base once.
    const channels = paint.tint.split(',').map(value => Math.round(27+(Number(value)-27)*alpha));
    paint.styles[state] = {
      fill:'rgb('+channels.join(',')+')',
      stroke:selected ? '#ededed' : rgba(paint.tint,(hovered ? .74 : .49) + paint.heat*.19)
    };
  }
  return paint.styles[state];
}

export function paintNoteBody(ctx, node, x, y, r, selected, hovered, dpr, overview) {
  const paint = notePaint(ctx,node);
  // At overview scale adjacent two-pixel halos merge into a haze. Keep heat
  // in the fill and rim, then ease the halo in as it becomes distinguishable.
  const t = overview ? Math.min(1,Math.max(0,(r-5.5)/3)) : 1;
  if (node.heat > .04 && r > 3 && t > 0) {
    const previousAlpha = t < 1 ? ctx.globalAlpha : 1;
    if (t < 1) ctx.globalAlpha=previousAlpha*t*t*(3-2*t);
    if (r*.6 <= 20) {
      // In this range the halo scales with the radius. Canvas gradients follow
      // the fill transform, so scrolling/zooming can reuse the same gradient.
      paint.glow ??= gradient(ctx,node.tint,node.heat,0,0,.78,1.6);
      ctx.setTransform(dpr*r,0,0,dpr*r,dpr*x,dpr*y);
      ctx.fillStyle = paint.glow;
      ctx.fillRect(-1.6,-1.6,3.2,3.2);
      ctx.setTransform(dpr,0,0,dpr,0,0);
    } else {
      const extent = r+20;
      ctx.fillStyle = gradient(ctx,node.tint,node.heat,x,y,r*.78,extent);
      ctx.fillRect(x-extent,y-extent,extent*2,extent*2);
    }
    if (t < 1) ctx.globalAlpha=previousAlpha;
  }
  const style = bodyStyle(paint,selected,hovered);
  ctx.lineJoin = 'round';
  traceOutline(ctx,node.geometry,x,y,r);
  ctx.fillStyle=style.fill; ctx.fill();
  ctx.strokeStyle=style.stroke;
  ctx.lineWidth=selected ? 1.8 : hovered ? 1.5 : 1.18;
  ctx.stroke();
}

export function paintMapNote(c,n,x,y,r,z,select,hover,seated,dpr,overview) {
  paintNoteBody(c,n,x,y,r,select,hover,dpr,overview);
  if (select) {
    c.lineJoin='round';
    traceOutline(c,n.geometry,x,y,r + 4);
    c.strokeStyle = 'rgba(237,237,237,.25)'; c.lineWidth = 1; c.stroke();
  }
  if (n.icon) {
    const apothem = n.geometry?.apothem || 1;
    drawIcon(c,n.icon,x,y,Math.min(r*1.05, r*apothem*1.68),'rgba(240,240,240,.92)');
  }
  if ((n.pinned || seated) && r > 7 && (!n.icon || r > 14)) {
    c.save();
    // Give a decorated note a separate pin badge on the upper-right edge.
    const offset = n.icon ? edgeRadius(n,Math.SQRT1_2,-Math.SQRT1_2)*z*Math.SQRT1_2 : 0;
    c.translate(x+offset, y-offset);
    if (n.icon) {
      c.beginPath(); c.arc(0,0,6,0,2*Math.PI); c.fillStyle='#252525'; c.fill();
      c.strokeStyle=rgba(n.tint,0.5); c.lineWidth=1; c.stroke(); c.scale(0.73,0.73);
    }
    c.rotate(Math.PI * 0.19);
    c.strokeStyle = rgba(n.tint, 0.87); c.lineWidth = 1.35; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(-2.5, -4); c.lineTo(2.5, -4);
    c.lineTo(1.7, -1.1); c.lineTo(3, 1.4); c.lineTo(-3, 1.4); c.lineTo(-1.7, -1.1);
    c.closePath(); c.moveTo(0, 1.4); c.lineTo(0, 4.7); c.stroke(); c.restore();
  }
}

