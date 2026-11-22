const prefixes = new Map([
  ['-', 'bullet'], ['*', 'bullet'], ['+', 'bullet'],
  ['1.', 'decimal'], ['1)', 'parenthesis'],
])
const styles = new Set(prefixes.values())

export const listStyleForPrefix = text => prefixes.get(text)
export const isListStyle = value => styles.has(value)
export const listStyleOf = block => block?.type === 'paragraph' && styles.has(block.listStyle) ? block.listStyle : null
export const indentOf = block => Number.isInteger(block?.indent) ? Math.min(8, Math.max(0, block.indent)) : 0

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
    return String(ordinal) + (style === 'decimal' ? '.' : ')')
  })
}

export function atParentLevel(blocks, index) {
  const block = blocks[index], depth = indentOf(block)
  if (!depth) {
    const {listStyle, ...paragraph} = block
    return paragraph
  }
  const target = depth - 1
  let style = listStyleOf(block)
  for (let i = index - 1; i >= 0 && listStyleOf(blocks[i]); i--) {
    const previousDepth = indentOf(blocks[i])
    if (previousDepth > target) continue
    if (previousDepth === target) style = listStyleOf(blocks[i])
    break
  }
  return {...block, indent:target, listStyle:style}
}
