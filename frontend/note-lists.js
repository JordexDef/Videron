const prefixes = new Map([
  ['-', {listStyle:'bullet'}], ['*', {listStyle:'bullet'}], ['+', {listStyle:'bullet'}],
  ['1.', {listStyle:'decimal'}], ['1)', {listStyle:'parenthesis'}],
  ['[]', {listStyle:'task'}], ['[ ]', {listStyle:'task'}],
  ['[x]', {listStyle:'task',taskState:'done'}], ['[X]', {listStyle:'task',taskState:'done'}],
  ['[-]', {listStyle:'task-choice',taskState:'cancelled'}],
])
const styles = new Set(Array.from(prefixes.values(), prefix => prefix.listStyle))
const taskMarks = new Map([['pending','☐'], ['done','☑'], ['cancelled','☒']])

function prefixFormat(text) {
  // A typed "- " has usually become a bullet already. A pasted "- [ ]" can
  // still contain the leading marker when the user types the final space.
  return prefixes.get(/^[-*+] \[/.test(text) ? text.slice(2) : text)
}

export const listStyleForPrefix = text => prefixFormat(text)?.listStyle
export const isListStyle = value => styles.has(value)
export const listStyleOf = block => block?.type === 'paragraph' && styles.has(block.listStyle) ? block.listStyle : null
export const indentOf = block => Number.isInteger(block?.indent) ? Math.min(8, Math.max(0, block.indent)) : 0
export const isTaskStyle = style => style === 'task' || style === 'task-choice'
export const taskMarker = state => taskMarks.get(state) || ''

export function taskStateOf(block) {
  const style = listStyleOf(block)
  if (!isTaskStyle(style)) return null
  if (block.taskState === 'done') return 'done'
  if (style === 'task-choice' && block.taskState === 'cancelled') return 'cancelled'
  return 'pending'
}

export function taskCounts(blocks) {
  const counts = {pending:0, done:0, cancelled:0}
  for (const block of blocks) {
    const state = taskStateOf(block)
    if (state) counts[state]++
  }
  return counts
}

export function withListStyle(block, style) {
  const {listStyle, taskState, ...next} = block
  if (!isListStyle(style)) return next
  next.type = 'paragraph'
  next.listStyle = style
  const state = taskStateOf(block)
  if (state === 'done' && isTaskStyle(style)) next.taskState = state
  if (state === 'cancelled' && style === 'task-choice') next.taskState = state
  return next
}

export function listItemForPrefix(block, text) {
  const format = prefixFormat(text)
  if (!format || block.type !== 'paragraph') return null
  const {taskState, ...next} = block
  if (format.listStyle === 'task' && listStyleOf(block) === 'task-choice') {
    return {...next, ...format, listStyle:'task-choice'}
  }
  return {...next, ...format}
}

export function toggleTask(block, outcome = 'done') {
  const state = taskStateOf(block)
  if (!state) return block
  if (outcome !== 'done' && (outcome !== 'cancelled' || block.listStyle !== 'task-choice')) return block
  const next = {...block}
  if (state === outcome) delete next.taskState
  else next.taskState = outcome
  return next
}

export function continuedListItem(block, runs) {
  const next = {type:'paragraph', runs}
  const depth = indentOf(block), style = listStyleOf(block)
  if (depth) next.indent = depth
  if (style) next.listStyle = style
  return next
}

// Counters belong to a level. A nested list may use a different marker while
// the parent's next number is kept until the list ends.
export function listMarkers(blocks) {
  const levels = []
  return blocks.map(block => {
    const style = listStyleOf(block)
    if (!style) { levels.length = 0; return '' }
    const depth = indentOf(block)
    levels.length = depth + 1
    const ordinal = levels[depth]?.style === style ? levels[depth].ordinal + 1 : 1
    levels[depth] = {style, ordinal}
    if (style === 'bullet') return '•'
    if (isTaskStyle(style)) return taskMarker(taskStateOf(block))
    return String(ordinal) + (style === 'decimal' ? '.' : ')')
  })
}

export function atParentLevel(blocks, index) {
  const block = blocks[index], depth = indentOf(block)
  if (!depth) return withListStyle(block, null)
  const target = depth - 1
  let style = listStyleOf(block)
  for (let i = index - 1; i >= 0 && listStyleOf(blocks[i]); i--) {
    const previousDepth = indentOf(blocks[i])
    if (previousDepth > target) continue
    if (previousDepth === target) style = listStyleOf(blocks[i])
    break
  }
  return {...withListStyle(block, style), indent:target}
}
