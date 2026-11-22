// The popover stays in the editor's DOM for selection, shortcuts and tab order.
// Its screen coordinates are independent of the canvas transform.
export function attachTextToolbar(editor, toolbar, handleShortcut) {
  toolbar.classList.add('ve-canvas-toolbar')
  toolbar.hidden = true
  const topLayer = typeof toolbar.showPopover === 'function'
  if (topLayer) toolbar.setAttribute('popover', 'manual')
  let frame, board, camera, raf = 0, watching = false
  const listeners = new AbortController()
  const events = {signal:listeners.signal}
  const changes = new MutationObserver(schedule)
  const sizes = new ResizeObserver(schedule)

  function schedule() { if (!raf) raf = requestAnimationFrame(position) }
  function hide() {
    if (toolbar.hidden) return
    toolbar.hidden = true
    if (topLayer) toolbar.hidePopover()
    else editor.prepend(toolbar)
  }
  function stop() {
    if (watching) {
      watching = false
      changes.disconnect(); sizes.disconnect()
      window.removeEventListener('scroll', schedule, true)
    }
    hide()
  }
  function position() {
    raf = 0
    const focused = editor.ownerDocument.activeElement
    if ((!editor.contains(focused) && !toolbar.contains(focused)) || focused?.closest('dialog,.ve-tag-menu')) {
      stop(); return
    }
    frame ||= editor.closest('.vb-rich-frame')
    board ||= editor.closest('.vb')
    camera ||= editor.closest('.vb-world')
    if (!board || !frame?.classList.contains('is-rich-active')) { stop(); return }
    if (!watching) {
      watching = true
      changes.observe(frame, {attributes:true,attributeFilter:['class','style']})
      changes.observe(camera, {attributes:true,attributeFilter:['style']})
      sizes.observe(board); sizes.observe(frame); sizes.observe(toolbar)
      window.addEventListener('scroll', schedule, true)
    }
    const view = board.getBoundingClientRect(), box = frame.getBoundingClientRect()
    if (box.bottom <= view.top || box.top >= view.bottom || box.right <= view.left || box.left >= view.right) {
      hide(); return
    }
    if (toolbar.hidden) {
      toolbar.hidden = false
      if (topLayer) toolbar.showPopover()
      else board.append(toolbar)
    }
    const gap = 8
    toolbar.style.maxWidth = Math.max(1, view.width - gap * 2) + 'px'
    const {width, height} = toolbar.getBoundingClientRect()
    const center = (Math.max(view.left, box.left) + Math.min(view.right, box.right)) / 2
    const x = Math.max(view.left + gap, Math.min(center - width / 2, view.right - gap - width))
    let top = view.top + gap, bottom = view.bottom - gap
    // Keep the canvas tools and bottom actions reachable near viewport edges.
    for (const dock of board.querySelectorAll(':scope > .vb-dock:not([hidden])')) {
      const rect = dock.getBoundingClientRect()
      if (x >= rect.right || x + width <= rect.left) continue
      if (dock.classList.contains('vb-tools')) top = Math.max(top, rect.bottom + gap)
      else bottom = Math.min(bottom, rect.top - gap)
    }
    const above = box.top - 35 - height // clears the rotation handle
    const below = box.bottom + gap
    let y = above
    if (above < top) y = below + height <= bottom ? below : top
    y = Math.max(view.top + gap, Math.min(y, view.bottom - height - gap))
    toolbar.style.left = (topLayer ? x : x - view.left) + 'px'
    toolbar.style.top = (topLayer ? y : y - view.top) + 'px'
  }
  for (const event of ['focusin','focusout']) {
    editor.addEventListener(event, schedule, events)
    if (!topLayer) toolbar.addEventListener(event, schedule, events)
  }
  if (!topLayer) {
    toolbar.classList.add('ve-toolbar-portal')
    toolbar.addEventListener('keydown', event => {
      if (toolbar.parentElement === board) { handleShortcut(event); event.stopPropagation() }
    }, events)
  }
  return () => { cancelAnimationFrame(raf); listeners.abort(); stop(); toolbar.remove() }
}
