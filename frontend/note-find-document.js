import {canvasFindRecords,replaceCanvasMatches} from './canvas-note-find.js'
import {richBlockFindRecord,replaceFindBody} from './note-find-text.js'

// The leading block index keeps two separate inline boards searchable even
// when an imported drawing contains the same object IDs as another board.
export function inlineFindTarget(id) {
  const separator=id.indexOf('/')
  return separator<0 ? null : {index:Number(id.slice(0,separator)),id:id.slice(separator+1)}
}

export function documentFindRecords(body) {
  const records=[]
  body.forEach((block,index)=>{
    const record=richBlockFindRecord(block,index)
    if(record)records.push(record)
    else if(block.type==='drawing' && Array.isArray(block.board?.elements)){
      for(const inner of canvasFindRecords(block.board.elements))records.push({...inner,id:index+'/'+inner.id})
    }
  })
  return records
}

export function replaceFindDocument(body, edits) {
  const inline=new Map(), text=[]
  for(const edit of edits){
    const target=inlineFindTarget(edit.id)
    if(!target){text.push(edit);continue}
    if(!inline.has(target.index))inline.set(target.index,[])
    inline.get(target.index).push({...edit,id:target.id})
  }
  const next=replaceFindBody(body,text)
  for(const [index,changes] of inline){
    const block=body[index]
    const elements=replaceCanvasMatches(block.board.elements,changes)
    if(elements!==block.board.elements)next[index]={...block,board:{...block.board,elements}}
  }
  return next
}
