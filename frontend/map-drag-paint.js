// Cache one contiguous run in painter order. Its translucent rims and halos
// stay between the same neighbours as notes move across it.
const minimumVisible = 128;
const maxPixels = 4 * 1024 * 1024; // RGBA surface, up to 16 MiB.

export function releaseDragPaint(drag) {
  const state = drag?.bodyLayer;
  if (!state) return;
  if (state.canvas) state.canvas.width = state.canvas.height = 0;
  drag.bodyLayer = null;
}

export function dragPaintLayer(graph, selected, palette) {
  const {drag,canvas,nodes,width,height,dpr,zoom,hover,camera} = graph;
  if (!drag?.moved || !(drag.held?.size > 1) || !(drag.noteIds?.length >= 32) ||
      nodes.size < 1000 || graph.heating?.size || !canvas?.width || !canvas.height ||
      canvas.width*canvas.height > maxPixels) {
    releaseDragPaint(drag);
    return null;
  }
  const old = drag.bodyLayer;
  if (old && old.x===camera.x && old.y===camera.y && old.zoom===zoom && old.dpr===dpr &&
      old.width===width && old.height===height && old.selected===selected && old.hover===hover && old.palette===palette)
    return old.canvas ? old : null;
  releaseDragPaint(drag);
  const state = drag.bodyLayer = {x:camera.x,y:camera.y,zoom,dpr,width,height,selected,hover,palette};
  let first, visible = 0, best = minimumVisible - 1;
  for (const n of nodes.values()) {
    if (drag.allMoving.has(n.id) || selected.has(n.id)) { visible=0; continue; }
    const x=n.screenX, y=n.screenY, r=n.r*zoom;
    if (x+r < -70 || x-r > width+70 || y+r < -28 || y-r > height+28) continue;
    if (!visible) first=n.index;
    if (++visible > best) { best=visible; state.first=first; state.last=n.index; }
  }
  if (state.last===undefined) return null;
  const layer=canvas.ownerDocument.createElement('canvas');
  layer.width=canvas.width; layer.height=canvas.height;
  state.ink=layer.getContext('2d');
  if (!state.ink) return null;
  state.canvas=layer;
  state.ink.setTransform(dpr,0,0,dpr,0,0);
  state.ink.lineCap=graph.ctx.lineCap;
  return state;
}
