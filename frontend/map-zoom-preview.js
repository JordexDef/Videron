// Crop the existing backing image without changing the canvas element's
// bounds. Pointer coordinates and world-space hit testing use the live camera.
export class MapZoomPreview {
  constructor(canvas, repaint) {
    this.canvas = canvas;
    this.repaint = repaint;
    this.supported = typeof CSS !== 'undefined' && CSS.supports('object-view-box', 'inset(10%)');
  }

  reset() {
    this.base = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
    if (this.cropped) { this.canvas.style.objectViewBox = ''; this.cropped = false; }
  }

  show(camera, width, height) {
    const base = this.base;
    if (!base || base.width !== width || base.height !== height || !width || !height) return false;
    const scale = camera.zoom / base.zoom;
    if (scale < 1 || scale > 1.30) return false;
    const dx = (camera.x-base.x)*base.zoom/width, dy = (camera.y-base.y)*base.zoom/height;
    const margin = (1-1/scale)/2;
    const sides = [margin+dy,margin-dx,margin-dy,margin+dx];
    if (sides.some(side => side < -1e-7)) return false;

    this.canvas.style.objectViewBox = 'inset('+sides.map(side => Math.max(0,side)*100+'%').join(' ')+')';
    this.cropped = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer=0; this.repaint(); },100);
    return true;
  }
}
