import {textPointAt} from './editor-text-move.js'
import {offsetAt, rangeInText} from './note-text-dom.js'

const highlightName = 'videron-note-selection'
const compare = (a,b) => a.index-b.index || a.offset-b.offset
const ordered = (a,b) => compare(a,b)<=0 ? {start:a,end:b} : {start:b,end:a}
const point = ({index,offset}) => ({index,offset})
const clamp = (value,low,high) => Math.min(Math.max(low,value),high)

// The browser keeps its native caret and single-paragraph selection. A
// selection across independent editing hosts needs its own anchor and focus:
// both WebView2 and WebKit clip the native highlight at the first host.
export function createTextSelection({content,rowAt,lengthAt,scroll,visibleTop,moveVertically,reveal}) {
  const listeners = new AbortController(), events = {signal:listeners.signal}
  let across = null, painted = null, fallback = null, gesture = null, frame = 0, swallowClick = false

  function domPoint(node,offset) {
    const row = (node?.nodeType===1 ? node : node?.parentElement)?.closest('.ve-text')
    if (!row) return null
    const index = Number(row.dataset.index)
    return rowAt(index)===row ? {index,offset:offsetAt(row,node,offset)} : null
  }
  function endpoints() {
    if (across) return across
    const sel = getSelection()
    const anchor = domPoint(sel.anchorNode,sel.anchorOffset), focus = domPoint(sel.focusNode,sel.focusOffset)
    return anchor && focus ? {anchor,focus} : null
  }
  function selected() {
    const ends = endpoints()
    if (!ends || !compare(ends.anchor,ends.focus)) return null
    if (!across && ends.anchor.index!==ends.focus.index && compare(bounded(ends.anchor,ends.focus),ends.focus)) return null
    return ordered(ends.anchor,ends.focus)
  }
  function clear() {
    across = null
    content.classList.remove('ve-cross-selection')
    if (painted) {
      const highlight = globalThis.CSS?.highlights?.get(highlightName)
      highlight?.delete(painted)
      if (highlight && !highlight.size) CSS.highlights.delete(highlightName)
      painted = null
    }
    fallback?.remove()
    fallback = null
  }
  function paintFallback() {
    if (!fallback || !painted) return
    const bounds = content.getBoundingClientRect(), view = scroll?.getBoundingClientRect() || bounds
    const pieces = document.createDocumentFragment()
    for (const rect of painted.getClientRects()) {
      const top = Math.max(rect.top,bounds.top,view.top,visibleTop()), bottom = Math.min(rect.bottom,bounds.bottom,view.bottom)
      if (bottom<=top || !rect.width) continue
      const mark = document.createElement('i')
      Object.assign(mark.style,{left:rect.left+'px',top:top+'px',width:rect.width+'px',height:bottom-top+'px'})
      pieces.append(mark)
    }
    fallback.replaceChildren(pieces)
  }
  function select(anchor,focus) {
    const first = rowAt(anchor.index), last = rowAt(focus.index)
    if (!first || !last) return
    const a = rangeInText(first,anchor.offset), f = rangeInText(last,focus.offset)
    if (document.activeElement!==last) last.focus({preventScroll:true})
    const sel = getSelection()
    if (first===last) {
      clear()
      sel.setBaseAndExtent(a.startContainer,a.startOffset,f.startContainer,f.startOffset)
      return
    }
    const forward = compare(anchor,focus)<0
    across = {anchor:point(anchor),focus:point(focus)}
    content.classList.add('ve-cross-selection')
    // Leave the active row editable, including for IME and clipboard events.
    const edge = rangeInText(last,forward?0:lengthAt(focus.index))
    sel.setBaseAndExtent(edge.startContainer,edge.startOffset,f.startContainer,f.startOffset)
    if (!painted) {
      painted = document.createRange()
      if (globalThis.Highlight && globalThis.CSS?.highlights) {
        let highlight = CSS.highlights.get(highlightName)
        if (!highlight) { highlight = new Highlight(); CSS.highlights.set(highlightName,highlight) }
        highlight.priority = 1
        highlight.add(painted)
      } else {
        fallback = document.createElement('div')
        fallback.className = 've-selection-paint'
        fallback.setAttribute('aria-hidden','true')
        document.body.append(fallback)
      }
    }
    const start = forward?a:f, end = forward?f:a
    painted.setStart(start.startContainer,start.startOffset)
    painted.setEnd(end.startContainer,end.startOffset)
    paintFallback()
  }
  function bounded(anchor,focus) {
    const direction = Math.sign(focus.index-anchor.index)
    for (let index=anchor.index; index!==focus.index; index+=direction) {
      if (!rowAt(index+direction)) return {index,offset:direction>0?lengthAt(index):0}
    }
    return focus
  }
  function stopGesture() {
    gesture = null
    cancelAnimationFrame(frame)
    frame = 0
  }
  function extendDrag() {
    if (!gesture) return
    const rect = content.getBoundingClientRect(), viewport = scroll?.getBoundingClientRect() || rect
    const top = Math.max(rect.top,viewport.top,visibleTop()), bottom = Math.min(rect.bottom,viewport.bottom)
    if (bottom<=top) return
    const x = clamp(gesture.x,rect.left+1,rect.right-1), y = clamp(gesture.y,top+1,bottom-1)
    const hit = textPointAt(content,x,y)
    if (hit && (gesture.manual || hit.index!==gesture.anchor.index)) {
      gesture.manual = true
      select(gesture.anchor,bounded(gesture.anchor,hit))
    }
    if (scroll && gesture.manual && !frame) {
      const distance = gesture.y < top+16 ? gesture.y-(top+16) : Math.max(0,gesture.y-(bottom-16))
      if (distance && !((distance<0 && scroll.scrollTop<=0) || (distance>0 && scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-1))) {
        frame = requestAnimationFrame(()=>{
          frame=0
          scroll.scrollTop+=clamp(distance/2,-28,28)
          extendDrag()
        })
      }
    }
  }
  content.addEventListener('pointerdown',event=>{
    if (!event.isPrimary || event.button!==0 || event.target.closest('.ve-content')!==content) return
    const hit = textPointAt(content,event.clientX,event.clientY)
    const previous = endpoints()
    stopGesture()
    swallowClick = false
    clear()
    if (!hit || event.ctrlKey || event.metaKey || event.altKey || event.pointerType==='touch') return
    const anchor = event.shiftKey && previous ? previous.anchor : point(hit)
    gesture = {id:event.pointerId,anchor,x:event.clientX,y:event.clientY,manual:false}
    if (event.shiftKey && previous) {
      event.preventDefault()
      gesture.manual = true
      select(anchor,bounded(anchor,hit))
    }
  },events)
  window.addEventListener('pointermove',event=>{
    if (gesture?.id!==event.pointerId) return
    if (!(event.buttons&1)) { stopGesture(); return }
    gesture.x=event.clientX;gesture.y=event.clientY
    extendDrag()
    if (gesture?.manual) event.preventDefault()
  },events)
  // Cancelling mousemove suppresses the compatibility event's native selection
  // adjustment after we have extended past the original editing host.
  window.addEventListener('mousemove',event=>{if(gesture?.manual)event.preventDefault()},events)
  window.addEventListener('pointerup',event=>{
    if (gesture?.id!==event.pointerId) return
    if (gesture.manual) { extendDrag();swallowClick=true }
    stopGesture()
  },events)
  window.addEventListener('pointercancel',stopGesture,events)
  window.addEventListener('blur',stopGesture,events)
  content.addEventListener('click',event=>{
    if (!swallowClick) return
    swallowClick=false
    event.preventDefault();event.stopImmediatePropagation()
  },{...events,capture:true})
  content.addEventListener('focusin',event=>{
    if (across && event.target.closest('.ve-text')!==rowAt(across.focus.index)) clear()
  },events)
  window.addEventListener('scroll',paintFallback,{...events,capture:true})
  window.addEventListener('resize',paintFallback,events)

  function keydown(event) {
    if (event.defaultPrevented || event.isComposing || event.keyCode===229) return
    const ends = endpoints()
    if (!ends || event.target.closest('.ve-text')!==rowAt(ends.focus.index)) return
    const {key} = event, command = event.ctrlKey || event.metaKey
    const {anchor,focus} = ends
    if (command && !event.shiftKey && !event.altKey && event.code==='KeyA') {
      let first=focus.index,last=focus.index
      while(rowAt(first-1))first--
      while(rowAt(last+1))last++
      if(first===last)return
      event.preventDefault();event.stopPropagation()
      select({index:first,offset:0},{index:last,offset:lengthAt(last)})
      return
    }
    if (key==='Escape' && across) {
      event.preventDefault();event.stopPropagation();select(focus,focus);return
    }
    if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(key)) return
    const backward=['ArrowUp','ArrowLeft','Home'].includes(key), direction=backward?-1:1
    if (!event.shiftKey) {
      if (!across) return
      const range=ordered(anchor,focus), edge=backward?range.start:range.end
      event.preventDefault();select(edge,edge);reveal(rowAt(edge.index));return
    }
    if (command && (key==='Home'||key==='End')) {
      let index=focus.index
      while(rowAt(index+direction))index+=direction
      event.preventDefault();select(anchor,{index,offset:backward?0:lengthAt(index)});reveal(rowAt(index));return
    }
    const vertical=key==='ArrowUp'||key==='ArrowDown'
    const atEdge=focus.offset===(backward?0:lengthAt(focus.index))
    if (!vertical && !across && !(atEdge && key.startsWith('Arrow') && rowAt(focus.index+direction))) return
    const sel=getSelection(), row=rowAt(focus.index)
    const caret=rangeInText(row,focus.offset)
    sel.collapse(caret.startContainer,caret.startOffset)
    let target
    if(vertical && rowAt(focus.index+direction) && moveVertically(focus.index,focus.offset,backward)) {
      target=domPoint(sel.focusNode,sel.focusOffset)
    } else if(!vertical && key.startsWith('Arrow') && atEdge && rowAt(focus.index+direction)) {
      target={index:focus.index+direction,offset:backward?lengthAt(focus.index-1):0}
    } else {
      const unit=vertical?'line':key==='Home'||key==='End'?'lineboundary':command||event.altKey?'word':'character'
      sel.modify('move',backward?'backward':'forward',unit)
      target=domPoint(sel.focusNode,sel.focusOffset) || focus
    }
    event.preventDefault()
    select(anchor,bounded(anchor,target))
    reveal(rowAt(target.index))
  }
  content.addEventListener('keydown',keydown,{...events,capture:true})
  return {selected,select,clear,get across(){return across},destroy(){listeners.abort();stopGesture();clear()}}
}
