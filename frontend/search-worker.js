export function searchPreview(note, result) {
  const source = result.tag ? note.tags : note.plain
  const offset = result.tag?.[0] ?? (result.position?.field === 'body' ? result.position.start : 0)
  const length = result.tag?.[1] ?? (result.position?.field === 'body' ? result.position.end - offset : 0)
  const start = Math.max(0, offset - 35)
  return {
    snippet:(start ? '…' : '') + source.slice(start, start + 150).replace(/\s/g, ' '),
    start:offset - start + (start ? 1 : 0), length
  }
}

export function findNotes(notes, options, preview = searchPreview) {
  const { query, regex, exactCase, pinned, area } = options
  let expression
  if (regex && query) {
    try { expression = new RegExp(query, exactCase ? 'u' : 'iu') }
    catch { return {regexError:'syntax'} }
  }
  const needle = exactCase || regex ? query : query.toLowerCase()
  // A literal native search can scan the original buffer. Ordinary typing then
  // needs no lowercase copy of every text file, even when there are no hits.
  // Long patterns, contextual Greek sigma and lone UTF-16 surrogates retain
  // literal string semantics through indexOf below.
  let literal
  if (query && !exactCase && !regex && needle.length <= 1024 && !/[ςσ\uD800-\uDFFF]/u.test(needle)) {
    literal = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  }
  const mayMatchExpandedI = !exactCase && !regex && /[i\u0307]/.test(needle)
  // Lowercasing can expand a character (İ → i + combining dot). Locate the
  // original UTF-16 boundaries for the editor and the preview in that rare case.
  function sourceOffset(text, foldedOffset, endBoundary) {
    let growth = 0
    for (let i = text.indexOf('İ'); i >= 0 && i + growth < foldedOffset; i = text.indexOf('İ', i + 1)) {
      if (foldedOffset === i + growth + 1) return endBoundary ? i + 1 : i
      growth++
    }
    return foldedOffset - growth
  }
  function match(text) {
    if (expression) {
      const value = expression.exec(text)
      return value ? [value.index, value[0].length] : null
    }
    if (literal && !(mayMatchExpandedI && text.includes('İ'))) {
      const value = literal.exec(text)
      if (!value) return null
      // Unicode regex folding also equates (for example) ſ and s; verify the
      // candidate to keep literal results consistent with the slower path.
      if (value[0].toLowerCase() === needle) return [value.index, value[0].length]
    }
    const folded = exactCase ? text : text.toLowerCase()
    const start = folded.indexOf(needle)
    if (start < 0) return null
    if (text.length === folded.length) return [start, needle.length]
    const from = sourceOffset(text, start, false)
    return [from, sourceOffset(text, start + needle.length, true) - from]
  }
  const matches = [], areaIds = area ? new Set(options.areaIds || [area]) : null
  for (const n of notes) {
    if (Object.hasOwn(n, 'sealed')) continue
    if ((pinned && !n.pinned) || (areaIds && !areaIds.has(n.areaId || '_none'))) continue
    if (!query) {
      const result = {id:n.id, rank:0, modified:n.modified}
      if (!options.deferSnippets) Object.assign(result, {title:[0,0], position:null}, preview(n, result))
      matches.push(result)
      continue
    }
    const title = match(n.title)
    const body = match(n.plain)
    const tag = body ? null : match(n.tags)
    if (!title && !body && !tag) continue
    let position = null
    if (body || title) {
      const [from, size] = body || title
      position = {field:body ? 'body' : 'title', start:from, end:from + size}
    }
    const result = {id:n.id, title, position, rank:title ? 1 : 0, modified:n.modified}
    if (tag) result.tag = tag
    if (!options.deferSnippets) Object.assign(result, preview(n, result))
    matches.push(result)
  }
  matches.sort((a,b) => b.rank-a.rank || b.modified-a.modified)
  return {matches}
}
export function installSearchWorker(find, preview) {
  let notes = []
  self.onmessage = ({data}) => {
    if (data.notes) notes = data.notes
    if (!data.options) return
    let response
    try {
      response = find(notes,data.options,preview)
    } catch (error) {
      // Some engines compile on the first match, after new RegExp succeeded.
      // A rejected pattern should leave the loaded workspace available for retry.
      if (!data.options.regex || !(error instanceof SyntaxError || error instanceof RangeError)) throw error
      response = {regexError:'complexity'}
    }
    self.postMessage(response)
  }
}
export function searchWorkerSource() {
  return '('+installSearchWorker.toString()+')('+findNotes.toString()+','+searchPreview.toString()+')'
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) installSearchWorker(findNotes,searchPreview)
