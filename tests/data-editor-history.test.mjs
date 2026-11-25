import test from 'node:test'
import assert from 'node:assert/strict'
import {EditorState,history,undo,redo,undoDepth,redoDepth,isolateHistory} from '../frontend/vendor/codemirror/editor-core.js'
import {textDocument} from '../frontend/data-document.js'
import {insertedEndings,lineEndingSupport,sourceSlice} from '../frontend/data-line-endings.js'
import {captureDataHistory,restoreDataHistory,changeDataTitle,dataTitleSupport,dataTitle} from '../frontend/data-editor-history.js'

function editor(source,title='') {
  const target={state:EditorState.create({doc:textDocument(source),extensions:[lineEndingSupport(source),history(),dataTitleSupport(title)]})}
  target.dispatch=tr=>{target.state=tr.state}
  target.replace=(from,to,text)=>{
    const insert=textDocument(text)
    target.dispatch(target.state.update({changes:{from,to,insert},effects:insertedEndings(target.state,from,to,text,insert),
      selection:{anchor:from+insert.length},annotations:isolateHistory.of('full')}))
  }
  target.rename=title=>target.dispatch(target.state.update({effects:changeDataTitle(title),annotations:isolateHistory.of('full')}))
  target.reopen=(source=sourceSlice(target.state),title=dataTitle(target.state))=>{
    const saved=JSON.parse(JSON.stringify(captureDataHistory(target.state,sourceSlice(target.state))))
    target.state=restoreDataHistory(saved,source,title) ?? editor(source,title).state
  }
  return target
}
test('data editor restores both native history branches and selection after a JSON round trip',()=>{
  const t=editor('ab')
  t.dispatch(t.state.update({selection:{anchor:1}}))
  t.replace(1,1,'X'); t.replace(2,2,'Y')
  assert(undo(t));const caret=t.state.selection.toJSON()
  t.reopen()
  assert.deepEqual(t.state.selection.toJSON(),caret)
  assert.equal(undoDepth(t.state),1);assert.equal(redoDepth(t.state),1)
  assert(redo(t));assert.equal(sourceSlice(t.state),'aXYb')
  assert(undo(t));assert(undo(t));assert.equal(sourceSlice(t.state),'ab')
  t.reopen()
  assert.equal(redoDepth(t.state),2)
  assert(redo(t));assert(redo(t));assert.equal(sourceSlice(t.state),'aXYb')
})
test('independent peer ranges survive local undo, redo and a second close',()=>{
  const t=editor('head\nvalue\ntail')
  t.replace(5,10,'local')
  t.reopen('new head\nlocal\ntail')
  assert(undo(t));assert.equal(sourceSlice(t.state),'new head\nvalue\ntail')
  t.reopen('new head\nvalue\nupdated tail')
  assert(redo(t));assert.equal(sourceSlice(t.state),'new head\nlocal\nupdated tail')
})
test('an overlapping peer replacement invalidates just the unsafe suffix of older history',()=>{
  const t=editor('one\ntwo')
  t.replace(0,3,'AAA');t.replace(4,7,'BBB')
  t.reopen('remote\nBBB')
  assert(undo(t));assert.equal(sourceSlice(t.state),'remote\ntwo')
  assert.equal(undo(t),false)
  assert(redo(t));assert.equal(sourceSlice(t.state),'remote\nBBB')
  t.reopen('remote\npeer won')
  assert.equal(undo(t),false);assert.equal(sourceSlice(t.state),'remote\npeer won')
})
test('sorts, imports and earlier undo/redo restore the exact mixed line endings',()=>{
  const old='h,v\r\na,1\rb,2\na,1\n', dedup='h,v\r\na,1\rb,2\n'
  const t=editor(old)
  t.replace(0,t.state.doc.length,dedup)
  t.replace(0,t.state.doc.length,'x\r\ny\r\n')
  t.reopen()
  assert(undo(t));assert.equal(sourceSlice(t.state),dedup)
  assert(undo(t));assert.equal(sourceSlice(t.state),old)
  t.reopen()
  assert(redo(t));assert.equal(sourceSlice(t.state),dedup)
  assert(redo(t));assert.equal(sourceSlice(t.state),'x\r\ny\r\n')
})
test('a different line ending convention from the peer stays intact',()=>{
  const t=editor('one\r\ntwo')
  t.replace(0,3,'local');t.reopen('local\ntwo')
  assert.equal(undo(t),false)
  assert.equal(sourceSlice(t.state),'local\ntwo')
})
test('title and body operations undo and redo in their original order after reopening',()=>{
  const t=editor('base','old')
  t.rename('new');t.replace(4,4,' tail');t.rename('final')
  t.reopen()
  assert(undo(t));assert.equal(dataTitle(t.state),'new');assert.equal(sourceSlice(t.state),'base tail')
  assert(undo(t));assert.equal(sourceSlice(t.state),'base')
  assert(undo(t));assert.equal(dataTitle(t.state),'old')
  t.reopen()
  assert(redo(t));assert.equal(dataTitle(t.state),'new')
  assert(redo(t));assert.equal(sourceSlice(t.state),'base tail')
  assert(redo(t));assert.equal(dataTitle(t.state),'final')
})
test('a newer title from a peer survives undo and redo of the data rows',()=>{
  const t=editor('base','old')
  t.rename('mine');t.replace(4,4,' tail');t.reopen('base tail','remote')
  assert(undo(t));assert.equal(sourceSlice(t.state),'base');assert.equal(dataTitle(t.state),'remote')
  assert.equal(undo(t),false)
  assert(redo(t));assert.equal(sourceSlice(t.state),'base tail');assert.equal(dataTitle(t.state),'remote')
})
test('redo restores a later title after undoing local data beside a peer change',()=>{
  const t=editor('key,value\na,1\nb,2','Draft')
  t.replace(13,13,'0');t.rename('Local data heading')
  const combined='key,value\na,10\nb,20'
  t.reopen(combined)
  assert(undo(t));assert.equal(dataTitle(t.state),'Draft')
  assert(undo(t));assert.equal(sourceSlice(t.state),'key,value\na,1\nb,20')
  t.reopen()
  assert(redo(t));assert.equal(sourceSlice(t.state),combined)
  assert(redo(t));assert.equal(dataTitle(t.state),'Local data heading')
})
test('a peer deleting one of two identical lines never undoes the surviving line',()=>{
  const t=editor('start\nend')
  t.replace(0,0,'start\n')
  t.reopen('start\nend')
  assert.equal(undo(t),false); assert.equal(sourceSlice(t.state),'start\nend')
})
test('a peer inserting repeated letters invalidates ambiguous redo and preserves unrelated undo',()=>{
  const t=editor('foo abbc')
  t.replace(0,3,'bar');t.replace(5,6,'')
  assert(undo(t))
  t.reopen('bar abbbc')
  assert.equal(redo(t),false)
  assert(undo(t));assert.equal(sourceSlice(t.state),'foo abbbc')
})
test('a peer replacement of an emoji treats both UTF-16 units as one changed region',()=>{
  const t=editor('\ude03')
  t.replace(0,0,'\ud83d')
  t.reopen('😅')
  assert.equal(undo(t),false);assert.equal(sourceSlice(t.state),'😅')
})
