const gap = 6;

export function tableBarPosition(sheet, anchor, view, width, height, docks) {
  const x = Math.max(view.left+gap,Math.min(sheet.left,view.right-gap-width));
  let ceiling = view.top+gap, floor = view.bottom-gap;
  for (const {rect,atTop} of docks) {
    if (!rect.width || x >= rect.right || x+width <= rect.left) continue;
    if (atTop) ceiling = Math.max(ceiling,rect.bottom+gap);
    else floor = Math.min(floor,rect.top-gap);
  }
  // Above a sheet, leave room for its rotation handle.
  const options = [sheet.bottom+gap,sheet.top-32-height,anchor.bottom+gap,anchor.top-gap-height];
  const y = options.find(y => y>=ceiling && y+height<=floor) ??
    Math.max(view.top+gap,Math.min(Math.max(ceiling,anchor.bottom+gap),floor-height));
  return {x,y};
}

// Keep the active table's controls at screen scale even when the sheet extends
// past the canvas. A manual popover preserves the table's focus and event path.
export function canvasTableFooter(view) {
  const {root,footer} = view, board = root.closest('.vb');
  if (!board || typeof footer.showPopover !== 'function') return;
  const world = root.closest('.vb-world'), object = root.closest('.vb-object');
  const scroll = board.closest('.ve-scroll');
  const doc = root.ownerDocument;
  let frame = 0, cell;
  footer.setAttribute('popover','manual');
  footer.showPopover();

  function place() {
    frame = 0;
    const sheet = root.getBoundingClientRect(), canvas = board.getBoundingClientRect();
    const clip = scroll?.getBoundingClientRect() || canvas;
    const left = Math.max(0,canvas.left,clip.left), top = Math.max(0,canvas.top,clip.top);
    const right = Math.min(doc.documentElement.clientWidth,canvas.right,clip.right);
    const bottom = Math.min(doc.documentElement.clientHeight,canvas.bottom,clip.bottom);
    const available = right - left - 2*gap;
    const visible = board.contains(doc.activeElement) && available > 0 && bottom > top && sheet.right > left && sheet.left < right &&
      sheet.bottom > top && sheet.top < bottom;
    footer.style.visibility = visible ? '' : 'hidden';
    if (!visible) return;
    footer.style.maxWidth = available + 'px';
    footer.style.width = footer.classList.contains('vt-formulating')
      ? Math.min(available,Math.max(290,Math.min(520,sheet.width))) + 'px' : 'max-content';
    const {width,height} = footer.getBoundingClientRect();
    const docks = Array.from(board.querySelectorAll(':scope > .vb-dock:not([hidden])'), dock =>
      ({rect:dock.getBoundingClientRect(),atTop:dock.classList.contains('vb-tools')}));
    const anchor = cell?.isConnected ? cell.getBoundingClientRect() : sheet;
    const {x,y} = tableBarPosition(sheet,anchor,{left,top,right,bottom},width,height,docks);
    footer.style.left = x+'px';
    footer.style.top = y+'px';
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(place); }
  const size = new ResizeObserver(schedule), moved = new MutationObserver(schedule);
  for (const el of [root,footer,board]) size.observe(el);
  for (const el of [world,object]) if (el) moved.observe(el,{attributes:true,attributeFilter:['style']});
  window.addEventListener('scroll',schedule,true);
  window.addEventListener('resize',schedule);
  board.addEventListener('focusin',schedule);
  board.addEventListener('focusout',schedule);
  return {
    update(anchor) { cell=anchor; schedule(); },
    destroy() {
      cancelAnimationFrame(frame);size.disconnect();moved.disconnect();
      window.removeEventListener('scroll',schedule,true);
      window.removeEventListener('resize',schedule);
      board.removeEventListener('focusin',schedule);
      board.removeEventListener('focusout',schedule);
      footer.hidePopover();footer.removeAttribute('popover');
      for (const prop of ['top','left','width','max-width','visibility']) footer.style.removeProperty(prop);
    }
  };
}
