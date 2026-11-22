// This function is also used by the blob worker in desktop WebViews.
export function findNotes(notes, options) {
  const { query, regex, exactCase, pinned, area } = options
  let expression
  if (regex && query) {
    try { expression = new RegExp(query, exactCase ? 'u' : 'iu') }
    catch { return {error:options.language === 'en' ? 'Invalid regular expression. Check the pattern syntax.' : 'Некорректное регулярное выражение. Проверьте синтаксис шаблона.'} }
  }
  const needle = exactCase ? query : query.toLowerCase()
  // Lowercasing can expand a character (İ → i + combining dot). Locate the
  // original UTF-16 boundaries for the editor and the preview in that rare case.
  function sourceOffset(text, foldedOffset, endBoundary) {
    let source = 0, folded = 0
    for (const character of text) {
      if (foldedOffset === folded) return source
      const width = character.toLowerCase().length
      if (foldedOffset < folded + width) {
        if (width === character.length) return source + foldedOffset - folded
        return endBoundary ? source + character.length : source
      }
      source += character.length
      folded += width
    }
    return text.length
  }
  function match(text) {
    if (!query) return [0, 0]
    if (expression) {
      const value = expression.exec(text)
      return value ? [value.index, value[0].length] : null
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
    if ((pinned && !n.pinned) || (areaIds && !areaIds.has(n.areaId || '_none'))) continue
    const title = match(n.title)
    const body = match(n.plain)
    const tag = body ? null : match(n.tags)
    if (!title && !body && !tag) continue
    const source = tag ? n.tags : n.plain
    const [offset, length] = body || tag || [0,0]
    const start = Math.max(0, offset - 35)
    const snippet = (start ? '…' : '') + source.slice(start, start + 150).replace(/\s/g, ' ')
    let position = null
    if (query && (body || title)) {
      const [from, size] = body || title
      position = {field:body ? 'body' : 'title', start:from, end:from + size}
    }
    matches.push({id:n.id,title,snippet,start:offset-start+(start?1:0),length,position,rank:query && title ? 1 : 0,modified:n.modified})
  }
  matches.sort((a,b) => b.rank-a.rank || b.modified-a.modified)
  return {matches}
}
export function installSearchWorker(find) {
  let notes = []
  self.onmessage = ({data}) => {
    if (data.notes) notes = data.notes
    if (data.options) self.postMessage(find(notes,data.options))
  }
}
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) installSearchWorker(findNotes)
