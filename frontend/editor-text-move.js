import {offsetAt, rangeInText, textLength} from './note-text-dom.js'

function rowInGap(content,y) {
  const blocks = content.children
  let low = 0, high = blocks.length
  while (low < high) {
    const mid = (low+high) >>> 1
    if (blocks[mid].getBoundingClientRect().bottom < y) low = mid+1
    else high = mid
  }
  const before = blocks[low-1], after = blocks[low]
  const block = !after || (before && y-before.getBoundingClientRect().bottom < after.getBoundingClientRect().top-y)
    ? before : after
  if (block?.matches('.ve-text')) return block
  return block?.matches('.ve-task-row') ? block.querySelector(':scope > .ve-text') : null
}

function caretAt(doc,x,y) {
  const caret = doc.caretPositionFromPoint?.(x,y)
  if (!caret) return doc.caretRangeFromPoint?.(x,y)
  const range = doc.createRange()
  range.setStart(caret.offsetNode,caret.offset)
  range.collapse(true)
  return range
}

// Hit-test the painted document, independently of pointer capture and the
// user's selection. Never take a drop intended for an image, table or toolbar.
export function textPointAt(content,x,y) {
  const doc = content.ownerDocument, hit = doc.elementFromPoint(x,y)
  if (hit?.closest('.ve-content') !== content) return null
  const row = hit.closest('.ve-text') || (hit === content ? rowInGap(content,y) : null)
  if (!row || row.closest('.ve-content') !== content) return null
  const index = Number(row.dataset.index)
  if (!Number.isInteger(index)) return null
  const box = row.getBoundingClientRect()
  const hitX = Math.max(box.left+0.5,Math.min(box.right-0.5,x))
  const hitY = Math.max(box.top+0.5,Math.min(box.bottom-0.5,y))
  let range = caretAt(doc,hitX,hitY)
  if (!range || !row.contains(range.startContainer)) {
    range = rangeInText(row,hitX <= box.left+box.width/2 ? 0 : textLength(row))
  }
  const offset = offsetAt(row,range.startContainer,range.startOffset)
  let rect = range.getBoundingClientRect()
  if (!rect.height) {
    // Element boundaries and the filler break in an empty editing host may
    // have no caret box. Prefer a text-node boundary, then the empty line.
    rect = rangeInText(row,offset).getBoundingClientRect()
    if (!rect.height) {
      const style = getComputedStyle(row), scale = box.height / (row.offsetHeight || box.height) || 1
      const height = Math.min(box.height,parseFloat(style.lineHeight)*scale)
      rect = new DOMRect(box.left+parseFloat(style.paddingLeft)*scale,box.top,0,height)
    }
  }
  return {index,offset,row,rect}
}

const compare = (a,b) => a.index-b.index || a.offset-b.offset
const inside = (point,range) => compare(point,range.start)>=0 && compare(point,range.end)<=0

function selectedGlyphAt(point,range,x,y) {
  if (!inside(point,range)) return false
  const start = point.index===range.start.index ? range.start.offset : 0
  const end = point.index===range.end.index ? range.end.offset : textLength(point.row)
  for (const rect of rangeInText(point.row,start,end).getClientRects()) {
    if (rect.width && rect.left<=x && x<=rect.right && rect.top<=y && y<=rect.bottom) return true
  }
  return false
}

export function installTextMove({content,scroll,getSelectionRange,move,placeCaret}) {
  const doc = content.ownerDocument, win = doc.defaultView
  const lifetime = new AbortController()
  const capture = {capture:true,signal:lifetime.signal}
  const marker = doc.createElement('i')
  marker.className = 've-text-drop-caret'
  marker.setAttribute('aria-hidden','true')
  let drag, frame = 0, suppressClick = false

  function end() {
    if (!drag) return
    const id = drag.id
    drag = null
    win.cancelAnimationFrame(frame)
    frame = 0
    marker.remove()
    content.classList.remove('ve-moving-text')
    if (content.hasPointerCapture(id)) content.releasePointerCapture(id)
  }

  function update() {
    frame = 0
    if (!drag?.moving) return
    const {x,y,source} = drag
    if (scroll?.isConnected && scroll.scrollHeight>scroll.clientHeight) {
      const view = scroll.getBoundingClientRect(), band = 34
      const toolbar = scroll.querySelector('.ve-toolbar')
      const top = Math.max(view.top,toolbar?.getBoundingClientRect().bottom || view.top)
      if (x>=view.left && x<=view.right) {
        const delta = y<top+band ? y-top-band : Math.max(0,y-view.bottom+band)
        if (delta) {
          const previous = scroll.scrollTop
          scroll.scrollTop += Math.sign(delta)*Math.min(19,Math.ceil(Math.abs(delta)/2))
          if (scroll.scrollTop!==previous) frame = win.requestAnimationFrame(update)
        }
      }
    }
    const point = textPointAt(content,x,y)
    if (!point || inside(point,source)) { marker.remove(); return }
    if (!marker.isConnected) (content.closest('dialog[open]') || doc.body).append(marker)
    const {rect} = point
    marker.style.color = getComputedStyle(point.row).color
    marker.style.left = rect.left+'px'
    marker.style.top = rect.top+'px'
    marker.style.height = rect.height+'px'
  }

  content.addEventListener('pointerdown',event=>{
    if (drag || event.target.closest('.ve-content')!==content) return
    suppressClick = false
    if (event.button!==0 || event.pointerType==='touch' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
    const source = getSelectionRange()
    if (!source || compare(source.start,source.end)===0) return
    const x = event.clientX, y = event.clientY, point = textPointAt(content,x,y)
    if (!point || !selectedGlyphAt(point,source,x,y)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    suppressClick=true
    drag = {id:event.pointerId,source,point,x,y,startX:x,startY:y,moving:false}
    content.setPointerCapture(event.pointerId)
  },capture)
  content.addEventListener('pointermove',event=>{
    if (!drag || event.pointerId!==drag.id) return
    drag.x=event.clientX; drag.y=event.clientY
    if (!drag.moving && Math.hypot(drag.x-drag.startX,drag.y-drag.startY)<4) return
    drag.moving=true
    event.preventDefault()
    event.stopImmediatePropagation()
    content.classList.add('ve-moving-text')
    if (!frame) frame=win.requestAnimationFrame(update)
  },capture)
  content.addEventListener('pointerup',event=>{
    if (!drag || event.pointerId!==drag.id) return
    const {source,point,moving} = drag
    const target = moving && textPointAt(content,event.clientX,event.clientY)
    event.preventDefault()
    event.stopImmediatePropagation()
    end()
    if (!point.row.isConnected) return
    if (!moving) placeCaret({index:point.index,offset:point.offset})
    else if (target && !inside(target,source)) move(source,{index:target.index,offset:target.offset})
  },capture)
  for (const eventName of ['lostpointercapture','pointercancel']) {
    content.addEventListener(eventName,event=>{ if (drag?.id===event.pointerId) end() },capture)
  }
  content.addEventListener('click',event=>{
    if (!suppressClick || !event.detail) return
    suppressClick=false
    event.preventDefault()
    event.stopImmediatePropagation()
  },capture)
  win.addEventListener('keydown',event=>{
    if (!drag) return
    if (event.key==='Escape') { event.preventDefault(); event.stopImmediatePropagation() }
    end()
  },capture)
  win.addEventListener('blur',end,{signal:lifetime.signal})
  return () => { end(); lifetime.abort() }
}
