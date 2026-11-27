export function moveListItem(items, from, to) {
  const next = items.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// Use pointer capture instead of native drag data. The gesture carries only
// a row index, even when its row contains a currently revealed password.
export function attachVerticalReorder(handle, list, row, onMove) {
  let drag = null
  const marker = document.createElement('span')
  marker.className = 've-reorder-line'
  marker.setAttribute('aria-hidden', 'true')
  handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown')

  const index = () => Array.prototype.indexOf.call(list.children, row)

  function finish(commit) {
    if (!drag) return
    const {pointer, to} = drag
    drag = null
    marker.remove()
    row.classList.remove('ve-reordering')
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
    const from = index()
    if (commit && from >= 0 && to != null && to !== from) onMove(from, to)
  }

  handle.onpointerdown = event => {
    if (drag || handle.disabled || event.button !== 0 || list.children.length < 2) return
    event.preventDefault()
    handle.focus({preventScroll:true})
    drag = {pointer:event.pointerId, start:event.clientY, to:null}
    handle.setPointerCapture(event.pointerId)
  }
  handle.onpointermove = event => {
    if (!drag || event.pointerId !== drag.pointer ||
        (drag.to == null && Math.abs(event.clientY - drag.start) < 4)) return
    const scroll = list.closest('.ve-scroll'), view = scroll?.getBoundingClientRect()
    const {clientX:x, clientY:y} = event, {left, right} = list.getBoundingClientRect()
    if (x < left - 24 || x > right + 24) {
      drag.to = null
      marker.remove()
      row.classList.remove('ve-reordering')
      return
    }
    if (view && y < view.top + 28) scroll.scrollTop -= 18
    else if (view && y > view.bottom - 28) scroll.scrollTop += 18

    const rows = Array.from(list.children)
    const boundary = rows.findIndex(item => {
      const rect = item.getBoundingClientRect()
      return y < rect.top + rect.height / 2
    })
    const from = index()
    drag.to = boundary < 0 ? rows.length - 1 : boundary - Number(boundary > from)
    if (drag.to === from) { marker.remove();row.classList.remove('ve-reordering');return }
    const edge = boundary < 0 ? rows.at(-1).getBoundingClientRect().bottom : rows[boundary].getBoundingClientRect().top
    row.classList.add('ve-reordering')
    const top = view ? Math.max(view.top + 1, Math.min(edge, view.bottom - 1)) : edge
    Object.assign(marker.style, {left:left + 'px', width:(right - left) + 'px', top:top + 'px'})
    if (!marker.isConnected) list.closest('.vd-editor')?.append(marker)
  }
  handle.onpointerup = event => { if (event.pointerId === drag?.pointer) finish(true) }
  handle.onlostpointercapture = handle.onpointercancel = event => {
    if (event.pointerId === drag?.pointer) finish(false)
  }
  handle.onkeydown = event => {
    if (event.key === 'Escape' && drag) { event.preventDefault();event.stopPropagation();finish(false);return }
    if (drag || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const from = index(), to = from + (event.key === 'ArrowUp' ? -1 : 1)
    if (from >= 0 && to >= 0 && to < list.children.length) onMove(from, to)
  }
}
