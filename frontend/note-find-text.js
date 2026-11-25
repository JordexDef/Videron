import {blockText, textTypes} from './search-location.js'

// A record is one editable paragraph or code block. Inline runs share offsets;
// media, credentials and link destinations are never part of the search text.
export function richBlockFindRecord(block,index) {
  if (!textTypes.has(block.type) && block.type !== 'code') return null
  const text = blockText(block)
  return {id:String(index),text:block.type === 'code' ? text.replace(/\r\n?/g,'\n') : text}
}

export function richBodyFindRecords(body) {
  return body.map(richBlockFindRecord).filter(Boolean)
}

export function replaceNoteString(source, edits) {
  const result = []
  let position = 0
  for (const {from,to,text} of edits) {
    result.push(source.slice(position,from),text)
    position = to
  }
  result.push(source.slice(position))
  return result.join('')
}

// Walk the runs once even when a paragraph has thousands of matches.
// Inserted text inherits the formatting of the first matched character.
export function replaceNoteRuns(runs, edits) {
  const result = []
  const source = runs.map(run => run.text).join('')
  let index = 0, offset = 0, position = 0, previousStyle
  function append(style,text) {
    if (!text) return
    if (result.length && style === previousStyle) result.at(-1).text += text
    else result.push({...style,text})
    previousStyle = style
  }
  function advance(end,keep) {
    while (position < end && index < runs.length) {
      const run = runs[index], size = Math.min(end-position,run.text.length-offset)
      if (keep) append(run,run.text.slice(offset,offset+size))
      position += size
      offset += size
      if (offset === run.text.length) { index++; offset = 0 }
    }
  }
  for (const {from,to,text} of edits) {
    if (text.length === to-from && source.startsWith(text,from)) continue
    advance(from,true)
    append(runs[index] || runs.at(-1),text)
    advance(to,false)
  }
  advance(Infinity,true)
  return result
}

export function replaceFindBody(body, edits) {
  const grouped = new Map()
  for (const edit of edits) {
    if (!grouped.has(edit.id)) grouped.set(edit.id,[])
    grouped.get(edit.id).push(edit)
  }
  const next = body.slice()
  for (const [id,changes] of grouped) {
    const index = Number(id), block = body[index]
    if (block?.type === 'code') {
      const source = block.text || ''
      // Textarea offsets count CRLF as one. Retain existing endings outside each edit.
      let raw = 0, displayed = 0
      function rawOffset(offset) {
        while (displayed < offset && raw < source.length) {
          if (source[raw++] === '\r' && source[raw] === '\n') raw++
          displayed++
        }
        return raw
      }
      const mapped = source.includes('\r') ? changes.map(edit => ({...edit,from:rawOffset(edit.from),to:rawOffset(edit.to)})) : changes
      next[index] = {...block,text:replaceNoteString(source,mapped)}
    }
    else if (textTypes.has(block?.type)) next[index] = {...block,runs:replaceNoteRuns(block.runs || [],changes)}
  }
  return next
}
