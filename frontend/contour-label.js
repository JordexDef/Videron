// Anchor the text to the actual silhouette. The preferred side can be occupied
// by another folder after the two contours compress.
export function* contourLabelPositions(area, neighbours, view, textWidth) {
  const {ox,oy,zoom} = view, hull = area.hull;
  const vertical = area.depth % 2 ? -.25 : .25;
  for (const turn of [vertical,-vertical,vertical/2,vertical*1.5,-vertical/2,-vertical*1.5,0,.5]) {
    const angle = turn * Math.PI * 2, dx = Math.cos(angle), dy = Math.sin(angle);
    const points = hull.points;
    const edge = points
      ? points[Math.round((turn+1)*points.length) % points.length]
      : {x:hull.x + dx*hull.r, y:hull.y + dy*hull.r};
    const x = ox + edge.x*zoom + dx*(textWidth/2+8);
    const y = oy + edge.y*zoom + dy*14;
    const left = (x-textWidth/2-3-ox)/zoom, right = (x+textWidth/2+3-ox)/zoom;
    const top = (y-8-oy)/zoom, bottom = (y+8-oy)/zoom;
    if (neighbours?.some(other => {
      if (other === area) return false;
      const box = other.gridBounds;
      if (box) return left < box.right && right > box.left && top < box.bottom && bottom > box.top;
      const h = other.hull;
      // Its enclosing circle is a cheap conservative test for this small label.
      const sx = Math.max(left-h.x, 0, h.x-right), sy = Math.max(top-h.y, 0, h.y-bottom);
      return sx*sx + sy*sy <= h.r*h.r;
    })) continue;
    yield {x,y};
  }
}
