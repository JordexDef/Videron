import {StateField, StateEffect, invertedEffects} from './vendor/codemirror/editor-core.js'

const separators = {n:'\n', r:'\r', w:'\r\n'}
const code = value => value === '\r\n' ? 'w' : value === '\r' ? 'r' : 'n'
const breaks = /\r\n?|\n/g
const replaceEndings = StateEffect.define()

// Homogeneous files need only one character of metadata. For mixed files,
// remember one character per break, independent of the text in each line.
function inspect(source) {
  const first = /\r\n?|\n/.exec(source)?.[0] || '\n'
  const mixed = first === '\n' ? source.includes('\r') : first === '\r' ? source.includes('\n') :
    /\r(?!\n)|(?:^|[^\r])\n/.test(source)
  return {preferred:code(first), codes:mixed ? (source.match(breaks) || []).map(code).join('') : null}
}

const endings = StateField.define({
  create:() => inspect(''),
  update(info,tr) {
    // Grouped undo may carry multiple snapshots, newest first.
    for (let i = tr.effects.length-1; i >= 0; i--)
      if (tr.effects[i].is(replaceEndings)) return tr.effects[i].value
    if (!info.codes || !tr.docChanged) return info
    const parts = []
    let previous = 0
    tr.changes.iterChanges((from,to,_newFrom,_newTo,inserted) => {
      const first = tr.startState.doc.lineAt(from).number-1, last = tr.startState.doc.lineAt(to).number-1
      if (first === last && inserted.lines === 1) return
      parts.push(info.codes.slice(previous,first), info.preferred.repeat(inserted.lines-1))
      previous = last
    })
    return parts.length ? {...info,codes:parts.join('')+info.codes.slice(previous)} : info
  }
})

export function lineEndingSupport(source) {
  const initial = inspect(source)
  return [endings.init(() => initial), invertedEffects.of(tr => {
    const prior = tr.startState.field(endings)
    // Ordinary intra-line typing on a homogeneous document needs no snapshot.
    return tr.effects.some(effect => effect.is(replaceEndings)) || (prior.codes && tr.docChanged)
      ? [replaceEndings.of(prior)] : []
  })]
}

export function sourceSlice(state,from=0,to=state.doc.length) {
  const info = state.field(endings)
  if (!info.codes) return state.doc.sliceString(from,to,separators[info.preferred])
  const first = state.doc.lineAt(from)
  let index = first.number-1, previousBreak = first.from === from && from > 0 ? -1 : -2
  return state.doc.sliceString(from,to).replace(/\n/g,(_,offset) => {
    // An edit can leave an empty line between a standalone CR and LF.
    // Give the LF a CR prefix so reopening still produces two line breaks.
    const adjacent = offset === previousBreak+1
    previousBreak = offset
    const separator = info.codes[index++]
    return adjacent && separator === 'n' && info.codes[index-2] === 'r' ? '\r\n' : separators[separator]
  })
}

// Record sorting and filtering preserve a homogeneous file's separator.
export function tableTransformEndings(state,source) {
  return state.field(endings).codes ? replaceEndings.of(inspect(source)) : []
}

export function insertedEndings(state,from,to,source,inserted) {
  const original = state.field(endings), next = inspect(source)
  if (from === 0 && to === state.doc.length && (inserted.lines > 1 || !state.doc.length)) return replaceEndings.of(next)
  if (!original.codes && !next.codes && (inserted.lines === 1 || original.preferred === next.preferred)) return []
  const first = state.doc.lineAt(from).number-1, last = state.doc.lineAt(to).number-1
  const head = original.codes?.slice(0,first) ?? original.preferred.repeat(first)
  const tail = original.codes?.slice(last) ?? original.preferred.repeat(state.doc.lines-1-last)
  return replaceEndings.of({...original,codes:head + (next.codes ?? next.preferred.repeat(inserted.lines-1)) + tail})
}

export function editorOffset(state,source,raw) {
  const end = Math.max(0,Math.min(source.length,raw || 0))
  const info = state.field(endings)
  if (!info.codes && info.preferred !== 'w') return end
  if (!info.codes) {
    let low = 1, high = state.doc.lines
    while (low < high) {
      const mid = Math.ceil((low+high)/2)
      if (state.doc.line(mid).from+mid-1 <= end) low = mid
      else high = mid-1
    }
    return Math.min(state.doc.line(low).to,end-low+1)
  }
  let pos = 0, pairs = 0
  while ((pos = source.indexOf('\r\n',pos)) >= 0 && pos+1 < end) {pairs++; pos += 2}
  const insidePair = source[end] === '\n' && source[end-1] === '\r'
  return Math.min(state.doc.length,end-pairs-(insidePair ? 1 : 0))
}
