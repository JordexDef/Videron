import test from 'node:test'
import assert from 'node:assert/strict'
import {canRestoreRelations,packEditorHistory,restoreEditorHistory} from '../frontend/editor-history.js'

const p=text=>({type:'paragraph',runs:[{text}]})
const rich=(...texts)=>({title:'Draft',body:texts.map(p),relations:{areaId:null,slot:null,links:[],pinned:false},point:{x:0,y:0}})
const closed=(head,past,future=[])=>JSON.parse(JSON.stringify(packEditorHistory(head,past,future)))
const board=(...elements)=>({title:'Canvas',elements,background:null,selection:[]})

test('reopened note undoes and redoes local steps against a newer independent paragraph',()=>{
  const before=rich('start','second'),head=rich('start A','second'),after=rich('start A B','second')
  const cached=closed(head,[before],[after])
  const current={...rich('start A','from peer'),title:'New title'}
  current.relations.pinned=true
  const restored=restoreEditorHistory(cached,current)
  assert.deepEqual(restored.past[0],{...current,body:[p('start'),p('from peer')]})
  assert.deepEqual(restored.future[0],{...current,body:[p('start A B'),p('from peer')]})
})

test('independent simple text edits in the same paragraph keep peer content on either side',()=>{
  const before=rich('one two'),head=rich('one local two')
  for(const [input,expected] of [['peer: one local two','peer: one two'],['one local two!','one two!']]){
    const {past}=restoreEditorHistory(closed(head,[before]),rich(input))
    assert.deepEqual(past[0].body,[p(expected)])
  }
})

test('edits to different lines in a code block keep the peer line',()=>{
  const code=text=>({...rich(''),body:[{type:'code',language:'json',text}]})
  const before=code('alpha\nbeta'),head=code('alpha mine\nbeta'),current=code('alpha mine\npeer')
  const {past}=restoreEditorHistory(closed(head,[before]),current)
  assert.equal(past[0].body[0].text,'alpha\npeer')
  current.body[0].language='text'
  assert.equal(restoreEditorHistory(closed(head,[before]),current).past.length,0)
})

test('undo and redo stop at overlapping edits, including a peer that already undid the local change',()=>{
  const base=rich('base'),head=rich('A'),after=rich('AB')
  for(const text of ['Peer','base']){
    const restored=restoreEditorHistory(closed(head,[base]),rich(text))
    assert.equal(restored.past.length,0)
  }
  assert.equal(restoreEditorHistory(closed(head,[],[after]),rich('x')).future.length,0)
})

test('a peer can insert a distinct row ahead of the locally edited row',()=>{
  const cache=closed(rich('Local','end'),[rich('Before','end')])
  const {past}=restoreEditorHistory(cache,rich('New','Local','end'))
  assert.deepEqual(past[0].body,[p('New'),p('Before'),p('end')])
  // If the rows at the boundary are identical there is no stable identity.
  assert.equal(restoreEditorHistory(cache,rich('Local','Local','end')).past.length,0)
})

test('the next keystroke after undo cannot replace a peer paragraph via a stale selection',()=>{
  const before={...rich('Before','end'),mark:{index:0,start:2},
    range:{anchor:{index:0,offset:1},focus:{index:1,offset:2}}}
  const cache=closed(rich('Local','end'),[before])
  const [step]=restoreEditorHistory(cache,rich('from peer','Local','end')).past
  assert.deepEqual(step.mark,{index:1,start:2})
  assert.equal(step.range,null)
})

test('equal row counts cannot disguise a deletion plus an insertion around duplicate paragraphs',()=>{
  const cached=closed(rich('header','A','A'),[rich('header','Mine','A')])
  assert.equal(restoreEditorHistory(cached,rich('A','A','footer')).past.length,0)
  const cachedRedo=closed(rich('A','A','footer'),[],[rich('A','Mine','footer')])
  assert.equal(restoreEditorHistory(cachedRedo,rich('header','A','A')).future.length,0)
})

test('formatting and relations received from peers survive unrelated undo and redo',()=>{
  const head=rich('my word','Peer'),before=rich('word','Peer'),after=rich('my words','Peer')
  const current=rich('my word','Peer')
  current.body[1].runs[0].color='#ff4422'
  current.relations={links:['peer'],areaId:'dock',slot:2,pinned:true}
  current.point={x:222,y:10}
  const {past,future}=restoreEditorHistory(closed(head,[before],[after]),current)
  for(const step of [past[0],future[0]]){
    assert.deepEqual(step.body[1],current.body[1])
    assert.deepEqual(step.relations,current.relations)
    assert.deepEqual(step.point,current.point)
  }
  current.body[0].runs[0].bold=true
  assert.deepEqual(restoreEditorHistory(closed(head,[before],[after]),current),{past:[],future:[]})
  const linked=rich('same'),unlinked=rich('same')
  linked.relations.links=['A']
  const other=rich('same');other.relations.links=['B']
  assert.equal(restoreEditorHistory(closed(linked,[unlinked]),other).past.length,0)
})

test('an undo cannot resurrect links to removed notes or move a note into an unavailable grid slot',()=>{
  const source={areaId:null,slot:null,links:[]},grid={id:'g',grid:{rows:1,cols:2}}
  const target={areaId:'g',slot:1,links:['b']}
  const notes=[{id:'a'},{id:'b'}],can=(n,a)=>canRestoreRelations('a',source,target,n,a)
  assert.equal(can(notes,[grid]),true)
  assert.equal(can(notes.slice(0,1),[grid]),false)
  assert.equal(can(notes,[]),false)
  assert.equal(can(notes,[{...grid,grid:{rows:1,cols:1}}]),false)
  assert.equal(can([...notes,{id:'c',areaId:'g',slot:1}],[grid]),false)
})

test('reopened canvas keeps other changed objects and external title',()=>{
  const rect={id:'rect',type:'rect',x:0},moved={...rect,x:125}
  const table={id:'sheet',type:'table',cells:{A1:'Start'}}
  const before=board(rect,table),head=board(moved,table)
  const cache=closed(head,[{...before,selection:['rect']}])
  assert.equal(cache.items.length,3) // The table occupies one pool slot in both snapshots.
  const changed={...table,cells:{A1:'Peer'}}
  const current={...board(moved,changed),title:'From B'}
  const restored=restoreEditorHistory(cache,current)
  assert.deepEqual(restored.past[0],{...current,elements:[rect,changed],selection:['rect']})
  const peer={id:'new',type:'image'}
  const reordered=restoreEditorHistory(cache,board(changed,peer,moved))
  assert.deepEqual(reordered.past[0].elements,[changed,peer,rect])
  assert.equal(restoreEditorHistory(cache,board(changed,peer)).past.length,0)
  assert.equal(restoreEditorHistory(cache,board({...moved,x:180},table)).past.length,0)
})

test('discard a stale area placement if a peer moved the note to another point',()=>{
  const before=rich('a'),head=rich('a')
  head.relations.areaId='area';head.point={x:120,y:40}
  const {past}=restoreEditorHistory(closed(head,[before]),{...head,point:{x:188,y:42}})
  assert.equal(past.length,0)
})
