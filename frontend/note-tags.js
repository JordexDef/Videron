import {tr} from './i18n.js'
import {isProtectedNote} from './note-vault.js'

export function tagRanges(text) {
  const tags = []
  const urls = text.matchAll(/(?:[\p{L}][\w+.-]*:\/\/|mailto:|www\.)[^\s<>"']+/giu)
  let url = urls.next().value
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) {
    const end = m.index + m[0].length, start = end - m[1].length - 1
    while (url && start >= url.index + url[0].length) url = urls.next().value
    if ((url && start >= url.index) || (start && /[/\\#]/.test(text[start - 1]))) continue
    tags.push({start,end,tag:m[1].toLowerCase()})
  }
  return tags
}

export function noteTags(title, plain) {
  return [...new Set(tagRanges(title + '\n' + plain).map(match => match.tag))]
}

export function notesWithTag(notes, noteId, tag) {
  return notes.filter(note => note.id !== noteId && !isProtectedNote(note) &&
    note.tags?.some(value => String(value).replace(/^#/, '').toLowerCase() === tag))
}

// Ranges leave editable nodes and the browser's native selection untouched.
// Tags may span text runs with different formatting, but stop at links or a line break.
function domTags(editable) {
  const results = [], doc = editable.ownerDocument
  let text = '', nodes = []
  function flush() {
    let i = 0
    for (const {start,end,tag} of tagRanges(text)) {
      while (nodes[i].end <= start) i++
      const range = doc.createRange()
      range.setStart(nodes[i].node, start - nodes[i].start)
      while (nodes[i].end < end) i++
      range.setEnd(nodes[i].node, end - nodes[i].start)
      results.push({range,tag})
    }
    text = ''; nodes = []
  }
  function walk(node) {
    if (node.nodeType === 3) {
      if (node.length) {
        nodes.push({node,start:text.length,end:text.length + node.length})
        text += node.data
      }
      return
    }
    if (node.matches('a,br,code,[contenteditable="false"]')) { flush(); return }
    const block = node.matches('div,p') && node !== editable
    if (block) flush()
    for (const child of node.childNodes) if (child.nodeType === 1 || child.nodeType === 3) walk(child)
    if (block) flush()
  }
  walk(editable); flush()
  return results
}

export function createTagNavigator({root,notes,noteId,onOpenNote}) {
  const doc = root.ownerDocument, ranges = new Map()
  const key = 'videron-note-tag'
  let popup, outside, titleCleanup, syncTitle, dead = false
  function clearPaint() {
    const highlight = globalThis.CSS?.highlights?.get(key)
    if (highlight) for (const tags of ranges.values()) for (const {range} of tags) highlight.delete(range)
    ranges.clear()
    if (highlight && !highlight.size) CSS.highlights.delete(key)
  }
  function paint(editable) {
    let highlight = globalThis.CSS?.highlights?.get(key)
    const matches = domTags(editable)
    if (highlight) for (const {range} of ranges.get(editable) || []) highlight.delete(range)
    if (matches.length && !highlight && globalThis.Highlight && globalThis.CSS?.highlights) {
      highlight = new Highlight()
      CSS.highlights.set(key, highlight)
    }
    for (const {range} of matches) highlight?.add(range)
    ranges.set(editable, matches)
  }
  function dismiss() {
    outside?.abort(); outside = null
    popup?.remove(); popup = null
  }
  function open(tag, anchor) {
    if (!onOpenNote) return
    dismiss()
    const matches = notesWithTag(notes, noteId, tag)
    if (matches.length === 1) { onOpenNote(matches[0].id); return }
    const previous = doc.activeElement
    const restore = () => { dismiss(); if (previous?.isConnected) previous.focus({preventScroll:true}) }
    popup = doc.createElement('section'); popup.className = 've-tag-menu'; popup.tabIndex = -1
    popup.setAttribute('role','dialog'); popup.setAttribute('aria-label','#' + tag)
    if (popup.showPopover) popup.setAttribute('popover','manual')
    const head = doc.createElement('strong'); head.textContent = '#' + tag; popup.append(head)
    const buttons = []
    if (matches.length) {
      const table = doc.createElement('table')
      table.setAttribute('aria-label', tr('Заметки с тегом', 'Notes with tag'))
      for (const note of matches) {
        const button = doc.createElement('button')
        button.type = 'button'; button.textContent = note.title?.trim() || tr('Без названия','Untitled')
        button.onclick = () => { dismiss(); onOpenNote(note.id) }
        table.insertRow().insertCell().append(button); buttons.push(button)
      }
      popup.append(table)
    } else {
      const empty = doc.createElement('p')
      empty.textContent = tr('Этот тег пока только в этой заметке.', 'Only this note has this tag.')
      popup.append(empty)
    }
    root.append(popup); popup.showPopover?.()
    const rect = anchor.getBoundingClientRect?.() || anchor
    const box = popup.getBoundingClientRect(), gap = 5
    popup.style.left = Math.max(gap, Math.min(rect.left, doc.documentElement.clientWidth - box.width - gap)) + 'px'
    const below = rect.bottom + gap
    popup.style.top = Math.max(gap, below + box.height <= doc.documentElement.clientHeight ? below : rect.top - box.height - gap) + 'px'
    popup.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); restore(); return }
      if (!buttons.length || !['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return
      e.preventDefault()
      const i = buttons.indexOf(doc.activeElement), n = buttons.length
      buttons[e.key === 'Home' ? 0 : e.key === 'End' ? n-1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus()
    })
    outside = new AbortController()
    const opts = {capture:true,signal:outside.signal}
    for (const event of ['pointerdown','focusin']) doc.addEventListener(event, e => {
      if (!popup?.contains(e.target)) dismiss()
    }, opts)
    window.addEventListener('resize',restore,{signal:outside.signal})
    root.addEventListener('scroll', e => {
      if(popup?.contains(e.target))return
      // Focusing a tag in a scrollable sidebar can queue its scroll event
      // before the click opens the menu. The anchor is already in position.
      const now=anchor.getBoundingClientRect?.()
      if(!now || now.left!==rect.left || now.top!==rect.top)dismiss()
    }, opts)
    ;(buttons[0] || popup).focus({preventScroll:true})
  }
  function atPoint(editable,x,y) {
    for (const {range,tag} of ranges.get(editable) || []) {
      for (const rect of range.getClientRects())
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return {tag,rect}
    }
  }
  function activate(e, editable) {
    if (!onOpenNote || e.defaultPrevented || e.shiftKey || e.altKey || e.target.closest('a') || !doc.getSelection()?.isCollapsed) return false
    const hit = atPoint(editable,e.clientX,e.clientY)
    if (!hit) return false
    e.preventDefault(); e.stopPropagation(); open(hit.tag,hit.rect)
    return true
  }
  function keydown(e, editable) {
    if (!onOpenNote || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.isComposing) return false
    const sel = doc.getSelection()
    if (!sel?.rangeCount || !sel.isCollapsed || !editable.contains(sel.focusNode)) return false
    const hit = (ranges.get(editable)||[]).find(({range})=>range.isPointInRange(sel.focusNode,sel.focusOffset))
    if (!hit) return false
    e.preventDefault(); e.stopPropagation(); open(hit.tag,hit.range)
    return true
  }

  // Native title fields own cursor, IME and undo. Mirror just the tag ink so
  // multiline title wrapping and horizontal scrolling keep their native behavior.
  function trackTitle(field) {
    queueMicrotask(()=>{
      if (dead || !field.parentElement) return
      const single = field.tagName === 'INPUT'
      const wrap = doc.createElement('div'), mirror = doc.createElement('div')
      wrap.className = 've-tag-field' + (single ? ' ve-tag-single' : '')
      mirror.className = 've-tag-ink'; mirror.setAttribute('aria-hidden','true')
      const focused = doc.activeElement === field, start = field.selectionStart, end = field.selectionEnd
      field.before(wrap); wrap.append(field,mirror)
      if (focused) { field.focus({preventScroll:true}); field.setSelectionRange(start,end) }
      let previous, tags = []
      function sync() {
        if (previous !== field.value) {
          previous = field.value; tags = tagRanges(previous)
          mirror.replaceChildren()
          let from = 0
          for (const hit of tags) {
            const span = doc.createElement('span')
            span.textContent = previous.slice(hit.start, hit.end); hit.span = span
            mirror.append(previous.slice(from,hit.start),span); from = hit.end
          }
          mirror.append(previous.slice(from)); mirror.hidden = !tags.length
        }
        mirror.scrollLeft = field.scrollLeft; mirror.scrollTop = field.scrollTop
      }
      function size() {
        const css = getComputedStyle(field)
        for (const property of ['font','lineHeight','letterSpacing','padding','textAlign','direction','wordSpacing','tabSize','borderWidth'])
          mirror.style[property] = css[property]
        mirror.style.width = field.offsetWidth + 'px'; mirror.style.height = field.offsetHeight + 'px'
        if (single) mirror.style.lineHeight = Math.max(0,field.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)) + 'px'
        sync()
      }
      const observer = new ResizeObserver(size); observer.observe(field)
      const controls = new AbortController(), opts = {signal:controls.signal}
      field.addEventListener('input',sync,opts); field.addEventListener('scroll',sync,opts)
      field.addEventListener('click',e=>{
        if (!onOpenNote || e.shiftKey || e.altKey || field.selectionStart !== field.selectionEnd) return
        for (const {tag,span} of tags) for (const rect of span.getClientRects()) {
          if(e.clientX>=rect.left && e.clientX<=rect.right && e.clientY>=rect.top && e.clientY<=rect.bottom) {
            e.preventDefault(); e.stopPropagation(); open(tag,rect); return
          }
        }
      },opts)
      field.addEventListener('keydown',e=>{
        if (!onOpenNote || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.isComposing ||
            field.selectionStart !== field.selectionEnd) return
        const hit = tags.find(t=>t.start<=field.selectionStart && t.end>=field.selectionStart)
        if (hit) { e.preventDefault(); e.stopImmediatePropagation(); open(hit.tag,hit.span) }
      },{...opts,capture:true})
      size(); syncTitle = sync; titleCleanup = ()=>{observer.disconnect(); controls.abort()}
    })
  }
  return {paint, clearPaint, activate, keydown, open, trackTitle, syncTitle:()=>syncTitle?.(),
    destroy(){ dead=true; dismiss(); clearPaint(); titleCleanup?.() }}
}
