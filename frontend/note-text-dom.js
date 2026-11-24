// Browser selections, stored runs and the rich text editor all use UTF-16
// offsets. A native soft break counts as one character, but the single <br>
// that an editing host inserts as an empty placeholder has no stored text.
function softBreak(node) {
  return node.nodeName === 'BR' && node.parentNode.childNodes.length > 1
}

function childIndex(node) {
  return Array.prototype.indexOf.call(node.parentNode.childNodes,node)
}

export function offsetAt(root, node, offset) {
  const prefix = root.ownerDocument.createRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(node,offset)
  let length = prefix.toString().length
  for (const br of root.querySelectorAll('br')) {
    if (!softBreak(br)) continue
    if (prefix.comparePoint(br.parentNode,childIndex(br)+1) > 0) break
    length++
  }
  return length
}

export function textLength(root) {
  return offsetAt(root,root,root.childNodes.length)
}

export function rangeInText(root, start, end = start) {
  const doc = root.ownerDocument
  const walk = doc.createTreeWalker(root,NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,{
    acceptNode:node => node.nodeType === Node.TEXT_NODE || softBreak(node)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  })
  let node = walk.nextNode(), position = 0
  function point(offset) {
    while (node) {
      const text = node.nodeType === Node.TEXT_NODE
      const length = text ? node.length : 1
      if (offset <= position+length) {
        const local = Math.max(0,offset-position)
        return text ? [node,local] : [node.parentNode,childIndex(node)+local]
      }
      position += length
      node = walk.nextNode()
    }
    return [root,root.childNodes.length]
  }
  const range = doc.createRange()
  range.setStart(...point(start))
  range.setEnd(...point(end))
  return range
}
