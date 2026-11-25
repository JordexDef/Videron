import {sameWorkspaceValue as equal} from './workspace-merge.js'
import {blockText} from './search-location.js'
import {validSlot} from './area-grid.js'

const conflict=Symbol('overlapping edits')
const field=(saved,target,live)=>equal(saved,target)?live:equal(saved,live)?target:conflict

// Track both possible boundaries in repeated text (for example A,A → A).
// All alignments must put the peer's change on the same side of our edit.
function span(before,after) {
  const limit=Math.min(before.length,after.length)
  let prefix=0,suffix=0
  while(prefix<limit && equal(before[prefix],after[prefix]))prefix++
  while(suffix<limit && equal(before[before.length-1-suffix],after[after.length-1-suffix]))suffix++
  const earliest=Math.min(prefix,limit-suffix)
  suffix=Math.min(suffix,limit-prefix)
  if(typeof before==='string'){
    const splitsPair=(s,i)=>i>0 && /[\uD800-\uDBFF]/.test(s[i-1]) && i<s.length && /[\uDC00-\uDFFF]/.test(s[i])
    if(splitsPair(before,prefix) || splitsPair(before,before.length-suffix) || splitsPair(after,after.length-suffix))return null
  }
  return {earliest,start:prefix,end:before.length-suffix,insert:after.slice(prefix,after.length-suffix)}
}
function replaySplice(saved,target,live) {
  const edit=span(saved,target),other=span(saved,live)
  if(!edit || !other || other.start===0 && other.end===saved.length)return conflict
  if(edit.start===edit.end && other.start===other.end && edit.earliest<=other.start && other.earliest<=edit.start)return conflict
  let offset=0
  if(other.end<=edit.earliest)offset=other.insert.length-(other.end-other.start)
  else if(other.earliest<edit.end)return conflict
  return live.slice(0,edit.start+offset).concat(edit.insert,live.slice(edit.end+offset))
}
function textBlock(saved,target,live) {
  if([saved,target,live].every(b=>b?.type==='code' && typeof b.text==='string')){
    const format=({text,...rest})=>rest
    if(!equal(format(saved),format(target)) || !equal(format(saved),format(live)))return conflict
    const text=replaySplice(saved.text,target.text,live.text)
    return text===conflict?conflict:{...live,text}
  }
  if(!saved || !target || !live || ![saved,target,live].every(b=>b.runs?.length===1 && typeof b.runs[0].text==='string'))return conflict
  const style=({runs,...block})=>({...block,runs:runs.map(({text,...marks})=>marks)})
  if(!equal(style(saved),style(target)) || !equal(style(saved),style(live)))return conflict
  const text=replaySplice(saved.runs[0].text,target.runs[0].text,live.runs[0].text)
  return text===conflict?conflict:{...live,runs:[{...live.runs[0],text}]}
}
// Paragraphs have no persistent IDs. A repeated or relocated block cannot
// act as an anchor just because its numeric position stayed the same.
function positions(blocks) {
  const indices=new Map()
  for(let i=0;i<blocks.length;i++){
    const key=blockKey(blocks[i])
    indices.set(key,indices.has(key)?-1:i)
  }
  return indices
}
const blockKey=b=>b.type+'\0'+blockText(b)
function rows(saved,target,live,mergeItem) {
  const simple=field(saved,target,live)
  if(simple!==conflict)return simple
  if(saved.length!==target.length || saved.length!==live.length)return replaySplice(saved,target,live)
  const next=live.slice()
  const original=mergeItem && positions(saved),current=mergeItem && positions(live)
  for(let i=0;i<saved.length;i++){
    if(equal(saved[i],target[i]))continue
    if(mergeItem){
      const before=blockKey(saved[i]),after=blockKey(live[i])
      if([original.get(before),current.get(before),original.get(after),current.get(after)].some(index=>index!==undefined && index!==i))return conflict
    }
    let item=field(saved[i],target[i],live[i])
    if(item===conflict && mergeItem)item=mergeItem(saved[i],target[i],live[i])
    if(item===conflict)return conflict
    next[i]=item
  }
  return next
}
function richStep(saved,target,live) {
  const title=field(saved.title,target.title,live.title)
  const body=rows(saved.body,target.body,live.body,textBlock)
  const links=field(saved.relations.links,target.relations.links,live.relations.links)
  const pin=field(saved.relations.pinned,target.relations.pinned,live.relations.pinned)
  const placement=s=>[s.relations.areaId,s.relations.slot]
  const moved=!equal(placement(saved),placement(target))
  if([title,body,links,pin].includes(conflict) || moved && (!equal(placement(saved),placement(live)) || !equal(saved.point,live.point) || saved.relations.pinned!==live.relations.pinned))return conflict
  const [areaId,slot]=placement(moved?target:live)
  const next={...target,title,body,relations:{areaId,slot,links,pinned:pin},point:moved?target.point:live.point}
  if(target.mark && !equal(target.body,body)){
    // A saved selection must not extend over paragraphs inserted by a peer.
    // Follow the original block when unambiguous, else restore a caret only.
    const block=target.body[target.mark.index]
    let index=-1
    for(let i=0;i<body.length;i++)if(equal(body[i],block)){
      if(index>=0){index=-1;break}
      index=i
    }
    next.mark=index>=0?{...target.mark,index}:{index:Math.min(target.mark.index,body.length-1),start:0}
    next.range=null
  }
  return next
}

// The note itself may be unchanged while a peer deletes a linked note, or
// occupies/reconfigures the grid slot that our inverse would put it back in.
export function canRestoreRelations(id,from,to,notes,areas) {
  if(!equal(from.links,to.links)){
    const ids=new Set(notes.map(n=>n.id))
    if(to.links.some(link=>!from.links.includes(link) && !ids.has(link)))return false
  }
  if(from.areaId===to.areaId && from.slot===to.slot || !to.areaId)return true
  const area=areas.find(a=>a.id===to.areaId)
  if(!area)return false
  if(!area.grid)return to.slot==null
  return validSlot(area.grid,to.slot) && !notes.some(n=>n.id!==id && n.areaId===to.areaId && n.slot===to.slot)
}
function canvasStep(saved,target,live) {
  const title=field(saved.title,target.title,live.title)
  let elements
  // Element IDs survive Z-order changes, draws, and deletions on another PC.
  // An edit to existing objects never has to restore the old canvas ordering.
  if(saved.elements.length===target.elements.length && saved.elements.every((s,i)=>s.id===target.elements[i].id)){
    const edits=new Map()
    saved.elements.forEach((s,i)=>{
      if(!equal(s,target.elements[i]))edits.set(s.id,{before:s,after:target.elements[i]})
    })
    elements=live.elements.map(item=>{
      const e=edits.get(item.id)
      if(!e || !equal(e.before,item))return item
      edits.delete(item.id)
      return e.after
    })
    if(edits.size)return conflict
  }else elements=rows(saved.elements,target.elements,live.elements)
  const background=field(saved.background,target.background,live.background)
  if([title,elements,background].includes(conflict))return conflict
  const ids=new Set(elements.map(obj=>obj.id))
  if(ids.size!==elements.length)return conflict
  return {...target,title,elements,background,selection:target.selection.filter(id=>ids.has(id))}
}

// Capture structurally shared blocks once, even when the session store seals
// the history as JSON. Carets, selection, and the two stack orders are retained.
export function packEditorHistory(head,past,future) {
  if(!past.length && !future.length)return undefined
  const list=Object.hasOwn(head,'body')?'body':'elements'
  const items=[],seen=new Map()
  function pack(s){
    return {...s,[list]:s[list].map(item=>{
      if(!seen.has(item)){seen.set(item,items.length);items.push(item)}
      return seen.get(item)
    })}
  }
  return {items,head:pack(head),past:past.map(pack),future:future.map(pack)}
}
export function restoreEditorHistory(cache,current) {
  const empty={past:[],future:[]}
  const rich=Object.hasOwn(current,'body'),list=rich?'body':'elements'
  if(!cache?.head || !Array.isArray(cache.head[list]))return empty
  const unpack=s=>({...s,[list]:s[list].map(i=>cache.items[i])})
  const head=unpack(cache.head)
  if(equal(head,current))return {past:cache.past.map(unpack),future:cache.future.map(unpack)}
  function restore(stack) {
    let saved=head,live=current
    const result=[]
    for(let i=stack.length-1;i>=0;i--){
      const target=unpack(stack[i])
      const next=rich?richStep(saved,target,live):canvasStep(saved,target,live)
      // Older snapshots share the same ancestry. Stop at the first ambiguous
      // inverse, including when a peer has already undone the local edit.
      if(next===conflict)break
      result.push(next);saved=target;live=next
    }
    return result.reverse()
  }
  return {past:restore(cache.past),future:restore(cache.future)}
}
