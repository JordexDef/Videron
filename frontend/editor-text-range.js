import { textTypes } from './search-location.js'

export function sliceRuns(runs = [], start, end = Infinity) {
  let pos = 0
  return runs.flatMap(run => {
    const text = run.text.slice(Math.max(0,start-pos), Math.max(0,end-pos))
    pos += run.text.length
    return text ? [{...run,text}] : []
  })
}

const lengthOf = runs => (runs || []).reduce((size, run) => size + run.text.length, 0)
const compare = (a,b) => a.index-b.index || a.offset-b.offset
function validPoint(body, point) {
  const block = body[point?.index]
  return Number.isInteger(point?.index) && textTypes.has(block?.type) &&
    Number.isInteger(point.offset) && point.offset >= 0 && point.offset <= lengthOf(block.runs)
}

export function selectedBlocks(body, {start,end}) {
  if (!validPoint(body,start) || !validPoint(body,end) || compare(start,end) >= 0) return []
  const blocks = body.slice(start.index,end.index+1)
  if (blocks.some(block => !textTypes.has(block.type))) return []
  return blocks.map((block,i) => ({
    ...block,runs:sliceRuns(block.runs, i === 0 ? start.offset : 0, i === blocks.length-1 ? end.offset : Infinity),
  }))
}

// A paragraph break belongs to the selection only when it lies between its endpoints.
// Keep the paragraph attributes of the surviving text on either side of a splice.
export function replaceTextRange(body, {start,end}, fragment) {
  const first = body[start.index], last = body[end.index]
  const before = sliceRuns(first.runs,0,start.offset), after = sliceRuns(last.runs,end.offset)
  const inserted = fragment.map(block => ({...block}))
  if (inserted.length <= 1) {
    const runs = inserted[0]?.runs || []
    const owner = before.length ? first : after.length ? last : inserted[0] || first
    inserted[0] = {...owner,runs:[...before,...runs,...after]}
  } else {
    const head = inserted[0], tail = inserted.at(-1)
    inserted[0] = {...(before.length ? first : head),runs:[...before,...head.runs]}
    inserted[inserted.length-1] = {...(tail.runs.length ? tail : last),runs:[...tail.runs,...after]}
  }
  const index = start.index+inserted.length-1
  const offset = lengthOf(inserted.at(-1).runs)-lengthOf(after)
  return {body:[...body.slice(0,start.index),...inserted,...body.slice(end.index+1)],start,end:{index,offset}}
}

export function moveTextRange(body, range, target) {
  if (!validPoint(body,target)) return null
  const {start,end} = range
  if (compare(target,start) >= 0 && compare(target,end) <= 0) return null
  const fragment = selectedBlocks(body,range)
  if (!fragment.length) return null
  const cut = replaceTextRange(body,range,[])
  let point = target
  if (target.index === end.index && compare(target,end) > 0) {
    point = {index:start.index,offset:start.offset+target.offset-end.offset}
  } else if (target.index > end.index) {
    point = {...target,index:target.index-(end.index-start.index)}
  }
  return replaceTextRange(cut.body,{start:point,end:point},fragment)
}
