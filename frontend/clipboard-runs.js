// An HTML clipboard contains source whitespace between elements, while a note
// displays its stored text verbatim (white-space: pre-wrap).
const blocks = new Set('ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DETAILS DIV DL DT FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER LI MAIN NAV OL P PRE SECTION TABLE TR UL'.split(' '))
const ignored = new Set('HEAD IFRAME NOSCRIPT OBJECT SCRIPT STYLE TEMPLATE TITLE'.split(' '))
const markKeys = ['bold', 'italic', 'underline', 'color', 'href', 'folderPath']
const paragraphBreak = Symbol('clipboard paragraph boundary')

function append(runs, text, marks) {
  if (!text) return
  const last = runs.at(-1)
  if (last && !last[paragraphBreak] && markKeys.every(key => last[key] === marks[key])) last.text += text
  else runs.push({...marks, text})
}

function separate(runs) {
  runs.push({text:'\n',[paragraphBreak]:true})
}

function htmlRuns(fragment, marksForElement) {
  const runs = []
  let betweenBlocks = false, lineStart = true, pendingSpace = null, emitted = 0, endedWithBreak = false

  function beginContent() {
    if (betweenBlocks) separate(runs)
    else if (endedWithBreak) {
      // A trailing BR already separates the next block visually. Promote it
      // instead of adding another line, keeping BRs inside paragraphs soft.
      const last=runs.at(-1)
      if (last && !last[paragraphBreak] && last.text.endsWith('\n')) {
        last.text=last.text.slice(0,-1)
        if (!last.text) runs.pop()
        separate(runs)
      }
    }
    betweenBlocks=false
    endedWithBreak=false
  }

  function emit(text, marks) {
    beginContent()
    if (pendingSpace && !lineStart) append(runs, ' ', pendingSpace)
    pendingSpace = null
    append(runs, text, marks)
    emitted++
    lineStart = text.endsWith('\n')
  }

  function walk(node, inherited, whitespace) {
    if (node.nodeType === 3) {
      const text = node.data.replace(/\r\n?/g, '\n')
      if (!text) return
      if (['pre','pre-wrap','break-spaces'].includes(whitespace)) { emit(text, inherited); return }
      const parts = whitespace === 'pre-line' ? text.split('\n') : [text]
      for (const [i, part] of parts.entries()) {
        if (i) { pendingSpace = null; emit('\n', inherited) }
        const compact = part.replace(/[ \t\r\n\f]+/g, ' ')
        if (!lineStart && compact.startsWith(' ')) pendingSpace ??= inherited
        const visible = compact.replace(/^ | $/g, '')
        if (visible) emit(visible, inherited)
        if (!lineStart && compact.endsWith(' ')) pendingSpace ??= inherited
      }
      return
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return
    const tag = node.tagName
    if (ignored.has(tag) || node.hidden || node.style?.display === 'none') return
    if (tag === 'BR') { pendingSpace = null; emit('\n', inherited); return }
    const block = blocks.has(tag)
    if (block) {
      pendingSpace = null
      if (!lineStart) betweenBlocks=true
      beginContent()
      lineStart = true
    }
    const marks = tag ? marksForElement(node, inherited) : inherited
    const mode = node.style?.whiteSpace || (tag === 'PRE' ? 'pre' : whitespace)
    const before = emitted
    // Browsers use one BR as the placeholder in an otherwise empty paragraph.
    const filler = block && node.childNodes.length === 1 && node.firstChild?.tagName === 'BR'
    if (!filler) for (const child of node.childNodes) walk(child, marks, mode)
    if (block) {
      pendingSpace = null
      betweenBlocks = betweenBlocks || !lineStart || emitted === before
      endedWithBreak = !betweenBlocks
      lineStart = true
    }
  }
  walk(fragment, {}, 'normal')
  return runs
}

const spaceAt = (text, offset) => {
  const code = text.charCodeAt(offset)
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 160
}

// When both representations describe the same text, the plain clipboard
// supplies the writer's actual line breaks; the HTML supplies the text marks.
function matchPlainSpacing(runs, plain) {
  const richText = runs.map(run => run.text).join('')
  if (richText === plain) return runs
  if (!/[^ \t\r\n\f\u00a0]/.test(richText) && /[^ \t\r\n\f\u00a0]/.test(plain)) return [{text:plain}]
  const result = []
  let pos = 0, spaceMarks, breaks=[]
  function appendGap(gap, fallback) {
    const style=spaceMarks || fallback
    if (!breaks.includes(true)) append(result,gap,style)
    else {
      let start=0, index=0
      for (let i=0;i<gap.length;i++) if (gap[i]==='\n') {
        if (breaks[Math.min(index++,breaks.length-1)]) {
          append(result,gap.slice(start,i),style)
          separate(result)
          start=i+1
        }
      }
      append(result,gap.slice(start),style)
    }
    spaceMarks=null;breaks=[]
  }
  for (const run of runs) {
    const rich = run.text
    let i = 0
    while (i < rich.length) {
      if (spaceAt(rich, i)) {
        if (!run[paragraphBreak]) spaceMarks ??= run
        if (rich[i]==='\n') breaks.push(!!run[paragraphBreak])
        i++; continue
      }
      const gap = pos
      while (spaceAt(plain, pos)) pos++
      appendGap(plain.slice(gap,pos),breaks.includes(true)?{}:run)
      const start = pos
      while (i < rich.length && !spaceAt(rich,i) && !spaceAt(plain,pos)) {
        if (rich[i] !== plain[pos]) return runs
        i++; pos++
      }
      append(result, plain.slice(start,pos), run)
    }
  }
  const tail = pos
  while (spaceAt(plain,pos)) pos++
  if (pos !== plain.length) return runs
  const last=runs.at(-1)
  appendGap(plain.slice(tail),last && !last[paragraphBreak]?last:{})
  return result
}

export function readClipboardParagraphs(fragment, plainText, marksForElement) {
  const plain = plainText?.replace(/\r\n?/g, '\n')
  const runs = fragment ? htmlRuns(fragment, marksForElement) : []
  if (!runs.length) return plain ? [[{text:plain}]] : []
  const paragraphs=[[]]
  for (const run of plain == null ? runs : matchPlainSpacing(runs, plain)) {
    if (run[paragraphBreak]) paragraphs.push([])
    else append(paragraphs.at(-1),run.text,run)
  }
  return paragraphs
}

export function readClipboardRuns(fragment, plainText, marksForElement) {
  const runs=[]
  for (const [i,row] of readClipboardParagraphs(fragment,plainText,marksForElement).entries()) {
    if (i) append(runs,'\n',{})
    for (const run of row) append(runs,run.text,run)
  }
  return runs
}
