import {rangeInText} from './note-text-dom.js'
export {rangeInText}

function viewport(node) {
  const box = node.getBoundingClientRect()
  const scaleX = box.width / node.offsetWidth || 1, scaleY = box.height / node.offsetHeight || 1
  const left = box.left + node.clientLeft * scaleX, top = box.top + node.clientTop * scaleY
  return {left, top, right:left + node.clientWidth * scaleX, bottom:top + node.clientHeight * scaleY, scaleX, scaleY}
}

function emptyCaret(node) {
  const box = node.getBoundingClientRect(), style = getComputedStyle(node)
  return new DOMRect(box.left + parseFloat(style.paddingLeft), box.top + parseFloat(style.paddingTop), 2, parseFloat(style.lineHeight))
}

function panTo(node, caret, match, visibleTop) {
  const view = viewport(node)
  if(visibleTop!==undefined)view.top=Math.max(view.top,visibleTop)
  // Fit the complete hit on each axis when possible. For a very large hit
  // show its beginning, where typing and keyboard navigation will resume.
  const vertical = match.height && match.height <= view.bottom - view.top ? match : caret
  const horizontal = match.width && match.width <= view.right - view.left ? match : caret
  if (vertical.top < view.top || vertical.bottom > view.bottom)
    node.scrollTop += (vertical.top + vertical.bottom - view.top - view.bottom) / (2 * view.scaleY)
  if (horizontal.left < view.left || horizontal.right > view.right)
    node.scrollLeft += (horizontal.left + horizontal.right - view.left - view.right) / (2 * view.scaleX)
}

// Input and textarea values have no DOM text nodes. Lay out just the title
// with its actual font, padding and line wrapping to measure the hit.
function titleMirror(input, layer) {
  const mirror = document.createElement('div'), style = getComputedStyle(input)
  const singleLine = input.tagName === 'INPUT'
  mirror.className = 've-search-measure'
  mirror.textContent = input.value
  for (const key of ['font','lineHeight','letterSpacing','textAlign','direction','padding','tabSize','overflowWrap'])
    mirror.style[key] = style[key]
  mirror.style.whiteSpace = singleLine ? 'pre' : 'pre-wrap'
  if (singleLine) mirror.style.paddingBlock = '0'
  layer.append(mirror)
  function align() {
    const box = input.getBoundingClientRect()
    const inset = singleLine ? (box.height - parseFloat(style.lineHeight)) / 2 : input.clientTop
    mirror.style.left = (box.left + input.clientLeft - input.scrollLeft) + 'px'
    mirror.style.top = (box.top + inset - input.scrollTop) + 'px'
    mirror.style.width = input.clientWidth + 'px'
  }
  align()
  return {mirror, align}
}

// The painted rectangles live outside both the editable document and the
// syntax mirror. They never enter selection, undo history, copying or saving.
export function createSearchReveal({root, title, scroll, blockAt, focusBlock, onSearchPoint, visibleTop}) {
  let dismiss = () => {}
  function reveal(target) {
    dismiss()
    if (!target) return
    const layer = document.createElement('div'), paint = document.createElement('div')
    layer.className = 've-search-flash'
    layer.setAttribute('aria-hidden','true')
    layer.append(paint)
    const ranges = []
    let alignTitle, focus
    function add(node, start, end, clip) {
      ranges.push({node, range:rangeInText(node, start, end), clip})
    }
    if (target.kind === 'title') {
      root.append(layer)
      const {mirror,align} = titleMirror(title, layer)
      alignTitle = align
      add(mirror, target.start, target.end, title)
      focus = () => {
        title.focus({preventScroll:true})
        title.setSelectionRange(target.start, target.start)
      }
    } else if (target.kind === 'body') {
      for (const {index,start,end} of target.ranges) {
        const block = blockAt?.(index)
        if (!block) continue
        add(block.node, start, end, block.input)
        focus ??= () => focusBlock(index, start)
      }
      if (ranges.length) (root.closest('.ve-canvas-editor') || root).append(layer)
    }
    if (!ranges.length) return
    focus()

    const first = ranges[0]
    const caret = first.range.cloneRange()
    caret.collapse(true)
    function bounds() {
      const rect = caret.getBoundingClientRect()
      return rect.height ? rect : emptyCaret(first.node)
    }
    function syncInner() {
      if (alignTitle) alignTitle()
      else if (first.clip) {
        first.node.scrollTop = first.clip.scrollTop
        first.node.scrollLeft = first.clip.scrollLeft
      }
    }
    syncInner()
    if (first.clip) { panTo(first.clip, bounds(), first.range.getBoundingClientRect()); syncInner() }
    const contentTop=target.kind==='body'?visibleTop:undefined
    if (scroll) panTo(scroll, bounds(), first.range.getBoundingClientRect(),contentTop?.())
    if (onSearchPoint) onSearchPoint(bounds())

    let frame
    function draw() {
      frame = null
      alignTitle?.()
      const outer = viewport(scroll || root)
      if(contentTop)outer.top=Math.max(outer.top,contentTop())
      const fragment = document.createDocumentFragment()
      for (const {node,range,clip} of ranges) {
        const area = clip ? viewport(clip) : outer
        const top = Math.max(outer.top, area.top), bottom = Math.min(outer.bottom, area.bottom)
        const left = Math.max(outer.left, area.left), right = Math.min(outer.right, area.right)
        const block = node.getBoundingClientRect()
        if (block.bottom < top || block.top > bottom || top >= bottom || left >= right) continue
        const boxes = range.getClientRects()
        for (const rect of boxes.length ? boxes : [emptyCaret(node)]) {
          const x = Math.max(left, rect.left), y = Math.max(top, rect.top)
          const w = Math.min(right, rect.left + Math.max(2, range.collapsed ? 0 : rect.width)) - x
          const h = Math.min(bottom, rect.bottom) - y
          if (w <= 0 || h <= 0) continue
          const mark = document.createElement('i')
          Object.assign(mark.style, {left:x+'px', top:y+'px', width:w+'px', height:h+'px'})
          fragment.append(mark)
        }
      }
      paint.replaceChildren(fragment)
    }
    function scheduleDraw() { if (frame == null) frame = requestAnimationFrame(draw) }
    const listeners = new AbortController(), options = {signal:listeners.signal,capture:true}
    dismiss = () => {
      clearTimeout(timer); cancelAnimationFrame(frame)
      listeners.abort(); layer.remove()
      dismiss = () => {}
    }
    const timer = setTimeout(dismiss, 2200)
    for (const event of ['pointerdown','keydown','beforeinput']) root.addEventListener(event,dismiss,options)
    root.addEventListener('scroll', scheduleDraw, options)
    window.addEventListener('resize', scheduleDraw, options)
    draw()
  }
  return {reveal, clear:() => dismiss()}
}
