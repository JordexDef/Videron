import test from 'node:test'
import assert from 'node:assert/strict'
import {EditorState, Text, history, undo, redo, Transaction} from '../frontend/vendor/codemirror/editor-core.js'
import {lineEndingSupport, insertedEndings, tableTransformEndings, editorOffset, sourceSlice} from '../frontend/data-line-endings.js'
import {buildDataDocument,textDocument} from '../frontend/data-document.js'

function editor(source) {
  const target = {state:EditorState.create({doc:source,extensions:[lineEndingSupport(source),history()]})}
  target.dispatch = transaction => { target.state = transaction.state }
  target.change = spec => target.dispatch(target.state.update(spec))
  return target
}

test('a large table replacement preserves split CRLF, long fields and undo in the original document',async()=>{
  const boundary = 128*1024
  const raw = 'x'.repeat(boundary-1) + '\r\n"multi\rline",🙂\n' + 'a,b\r\n'.repeat(90000)
  const doc = await buildDataDocument(raw,new AbortController().signal)
  assert.ok(doc.eq(textDocument(raw)))
  const prior='h,v\n1,old\n2,first', target=editor(prior)
  target.change({changes:{from:0,to:target.state.doc.length,insert:doc},
    effects:insertedEndings(target.state,0,target.state.doc.length,raw,doc),
    annotations:Transaction.userEvent.of('input.transform')})
  assert.equal(sourceSlice(target.state),raw)
  assert.ok(undo(target))
  assert.equal(sourceSlice(target.state),prior)
  assert.ok(redo(target))
  assert.equal(sourceSlice(target.state),raw)
})

test('a cancelled import or transform cannot build a replacement document',async()=>{
  for (const raw of ['', 'header\ndata'])
    await assert.rejects(buildDataDocument(raw,AbortSignal.abort()),{name:'AbortError'})
})

test('a cancellation during a large build discards its partial line tree',async t=>{
  let elapsed = 0
  t.mock.method(performance,'now',() => elapsed += 10)
  const controller = new AbortController()
  queueMicrotask(() => controller.abort())
  await assert.rejects(buildDataDocument('a\n'.repeat(130*1024),controller.signal),{name:'AbortError'})
})

test('table history restores mixed quotes and separators after dropping duplicate records',()=>{
  const original='name,val\r\na,"one\ntwo"\rb,3\r\na,4\n'
  const changed='name,val\r\na,"one\ntwo"\rb,3\r\n'
  const target=editor(original)
  target.change({changes:{from:0,to:target.state.doc.length,insert:textDocument(changed)},
    effects:tableTransformEndings(target.state,changed), annotations:Transaction.userEvent.of('input.transform')})
  assert.equal(sourceSlice(target.state),changed)
  assert.ok(undo(target))
  assert.equal(sourceSlice(target.state),original)
})

test('mixed line endings survive edits, undo groups and redo',() => {
  const source = 'one\r\ntwo\nthree\rfour'
  const target = editor(source)
  target.change({changes:{from:3,to:4},userEvent:'delete.forward'})
  target.change({changes:{from:3,to:7},userEvent:'delete.forward'})
  assert.equal(sourceSlice(target.state),'onethree\rfour')
  assert.ok(undo(target))
  assert.equal(sourceSlice(target.state), source)
  assert.ok(redo(target))
  assert.equal(sourceSlice(target.state),'onethree\rfour')
})

test('clearing a mixed-EOL line preserves its physical line on save and reload',() => {
  const original = 'a\r \nb', target = editor(original)
  target.change({changes:{from:2,to:3},userEvent:'delete.forward'})
  const saved = sourceSlice(target.state)
  assert.equal(saved,'a\r\r\nb')
  assert.equal(sourceSlice(target.state,2,3),'\r\n')
  assert.ok(editor(saved).state.doc.eq(target.state.doc))
  assert.ok(undo(target))
  assert.equal(sourceSlice(target.state),original)
})

test('inserting mixed-EOL text into Windows text preserves all separators',() => {
  const target = editor('start\r\nend')
  const text = 'x\ny\rz\r\n', insert = Text.of(text.split(/\r\n?|\n/)), from = 6
  target.change({changes:{from,insert},effects:insertedEndings(target.state,from,from,text,insert),
    annotations:Transaction.userEvent.of('input.import')})
  assert.equal(sourceSlice(target.state),'start\r\nx\ny\rz\r\nend')
  assert.ok(undo(target))
  assert.equal(sourceSlice(target.state),'start\r\nend')
})

test('search maps raw UTF-16 offsets to CodeMirror positions across line endings',() => {
  for (const source of ['a\r\n📎\r\nx','a\n📎\nx','a\r📎\nx\r\nz']) {
    const {state} = editor(source)
    for (let i=0;i<=source.length;i++) {
      const end = source[i-1] === '\r' && source[i] === '\n' ? i-1 : i
      assert.equal(editorOffset(state,source,i),source.slice(0,end).replace(/\r\n/g,'\n').length)
    }
  }
})
