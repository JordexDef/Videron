import { boardElementText } from './board-summary.js'

export const textTypes = new Set(['paragraph', 'heading', 'subheading', 'quote'])

export function blockText(block) {
  if (block.type === 'code') return block.text || ''
  if (textTypes.has(block.type)) return (block.runs || []).map(run => run.text).join('')
  return block.alt || ''
}

function boardTarget(elements, plain, start, end) {
  let offset = 0
  for (const item of elements || []) {
    const text = boardElementText(item)
    if (!text) continue
    if (!plain.startsWith(text, offset)) return null
    if (start >= offset && start <= offset + text.length) {
      const from = start - offset, to = Math.min(end - offset, text.length)
      if (item.type === 'table' && item.id) {
        // The cached summary lists the table name followed by cells in insertion order.
        let cellStart = String(item.name ?? '').length + 1
        for (const [address, value] of Object.entries(item.cells || {})) {
          const cellEnd = cellStart + String(value ?? '').length
          if (from < cellEnd && to > cellStart || from === to && from >= cellStart && from <= cellEnd)
            return {kind:'tableCell', id:item.id, address}
          if (cellStart >= to) break
          cellStart = cellEnd + 1
        }
      }
      if (item.type === 'text' && item.body) {
        const match = searchTarget({body:item.body, plain:text}, {field:'body', start:from, end:to})
        return match && {kind:'canvasText', id:item.id, match}
      }
      if (item.label || (item.type === 'text' && !item.folderPath))
        return {kind:'canvasLabel', id:item.id, start:from, end:to}
    }
    offset += text.length + 1
  }
  return null
}

// Search works on note.plain, where one newline separates consecutive blocks.
// Nested boards contribute their own summaries, even though they aren't editable text.
export function searchTarget(note, position) {
  if (!note || !position) return null
  const {field, start, end} = position
  if (field === 'title') {
    return note.title && end <= note.title.length ? {kind:'title', start, end} : null
  }
  if (field !== 'body') return null
  if (note.type === 'data') {
    return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= note.dataText.length
      ? {kind:'data', start, end} : null
  }
  const plain = note.plain || ''
  if (end > plain.length) return null
  if (note.type === 'canvas') return boardTarget(note.board?.elements, plain, start, end)
  const blocks = note.body?.length ? note.body : plain.split('\n').map(text => ({type:'paragraph', runs:[{text}]}))
  let offset = 0, boundary = null
  const ranges = []
  for (let index = 0; index < blocks.length && offset <= end; index++) {
    const block = blocks[index]
    const text = block.type === 'drawing' && block.board
      ? (block.board.elements || []).map(boardElementText).filter(Boolean).join('\n')
      : blockText(block)
    const limit = offset + text.length
    // A stale cached summary must never point the cursor at unrelated text.
    if (!plain.startsWith(text, offset) || (index < blocks.length - 1 ? plain[limit] !== '\n' : limit !== plain.length))
      return null
    if (block.type === 'drawing' && start >= offset && start <= limit) {
      const match = boardTarget(block.board?.elements, text, start - offset, Math.min(end, limit) - offset)
      if (match?.kind === 'tableCell') return {kind:'tableCell', index, id:match.id, address:match.address}
    }
    if (textTypes.has(block.type) || block.type === 'code') {
      const from = Math.max(start, offset), to = Math.min(end, limit)
      if (from < to) ranges.push({index, start:from - offset, end:to - offset})
      else if (from === to && !boundary) boundary = {index, start:from - offset, end:to - offset}
    }
    offset = limit + 1
  }
  if (!ranges.length && boundary) ranges.push(boundary)
  return ranges.length ? {kind:'body', ranges} : null
}
