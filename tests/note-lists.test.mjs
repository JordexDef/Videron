import test from 'node:test'
import assert from 'node:assert/strict'
import {
  listMarkers, atParentLevel, listStyleForPrefix, listItemForPrefix, withListStyle,
  taskStateOf, taskMarker, taskCounts, toggleTask, continuedListItem,
} from '../frontend/note-lists.js'

const item = (listStyle, indent=0) => ({type:'paragraph', listStyle, indent, runs:[{text:'item',bold:true}]})

test('list markers restart at style and paragraph boundaries and preserve each parent count', () => {
  const blocks = [
    item('decimal'), item('bullet',1), item('parenthesis',2), item('parenthesis',2),
    item('bullet',1), item('decimal'), item('parenthesis'), item('parenthesis'),
    {type:'code',text:'code'}, item('parenthesis'),
  ]
  assert.deepEqual(listMarkers(blocks), ['1.','•','1)','2)','•','2.','1)','2)','','1)'])
})

test('outdenting a child adopts its parent marker and preserves rich text', () => {
  const blocks = [item('decimal'), item('bullet',1), item('parenthesis',2)]
  blocks[2] = atParentLevel(blocks,2)
  assert.equal(blocks[2].indent,1)
  assert.deepEqual(listMarkers(blocks),['1.','•','•'])
  blocks[2] = atParentLevel(blocks,2)
  assert.deepEqual(listMarkers(blocks),['1.','•','2.'])
  blocks[2] = atParentLevel(blocks,2)
  assert.deepEqual(listMarkers(blocks),['1.','•',''])
  assert.deepEqual(blocks[2].runs,[{text:'item',bold:true}])
})

test('only complete leading prefixes start lists', () => {
  for (const text of ['-','*','+']) assert.equal(listStyleForPrefix(text),'bullet')
  assert.equal(listStyleForPrefix('1.'),'decimal')
  assert.equal(listStyleForPrefix('1)'),'parenthesis')
  for (const text of ['1','1.2','--','x-', ' -']) assert.equal(listStyleForPrefix(text),undefined)
})

test('task shortcuts recognize complete checkbox markers in text or an existing bullet', () => {
  const paragraph = {type:'paragraph', runs:[]}
  for (const [prefix, state, style] of [
    ['[]','pending','task'], ['[ ]','pending','task'], ['- [ ]','pending','task'],
    ['[x]','done','task'], ['[X]','done','task'], ['* [x]','done','task'],
    ['[-]','cancelled','task-choice'], ['- [-]','cancelled','task-choice'],
  ]) {
    assert.equal(listStyleForPrefix(prefix), style)
    assert.equal(taskStateOf(listItemForPrefix(paragraph,prefix)), state)
  }
  const nested = item('bullet', 1)
  assert.deepEqual(listItemForPrefix(nested, '[ ]'), {...nested, listStyle:'task'})
  assert.equal(listItemForPrefix({...paragraph,type:'code'}, '[x]'), null)
  for (const prefix of ['[', '[o]', 'a[ ]', ' [ ]', '-[ ]', '-  [ ]']) {
    assert.equal(listItemForPrefix(paragraph,prefix), null)
  }
})

test('task outcomes are exclusive, reversible and leave rich content untouched', () => {
  const plain = item('task'), choice = item('task-choice',1)
  assert.deepEqual(toggleTask(toggleTask(plain)), plain)
  assert.equal(toggleTask(plain,'cancelled'), plain)
  const done = toggleTask(choice)
  const cancelled = toggleTask(done,'cancelled')
  assert.equal(cancelled.taskState,'cancelled')
  assert.equal(done.taskState,'done')
  assert.equal(cancelled.runs,choice.runs)
  assert.equal(choice.taskState,undefined)
  assert.deepEqual(toggleTask(cancelled,'cancelled'),choice)
  assert.deepEqual(toggleTask(cancelled,'done'),done)
  assert.deepEqual(listItemForPrefix(cancelled,'[ ]'),choice)
})

test('changing the list style retains only outcomes supported by the destination', () => {
  const choice = item('task-choice'), done = toggleTask(choice)
  const cancelled = toggleTask(choice,'cancelled')
  const plain = {type:'paragraph',indent:0,runs:choice.runs}
  assert.deepEqual(withListStyle(done,'task'),{...plain,listStyle:'task',taskState:'done'})
  assert.deepEqual(withListStyle(cancelled,'task'),{...plain,listStyle:'task'})
  assert.deepEqual(withListStyle(done,'decimal'),{...plain,listStyle:'decimal'})
  assert.deepEqual(withListStyle(cancelled,null),plain)
  assert.deepEqual(withListStyle({...plain,taskState:'done'},'task-choice'),choice)
  assert.deepEqual(withListStyle({...plain,type:'heading'},'task-choice'),choice)
  assert.equal(taskStateOf({...choice,type:'heading',taskState:'done'}),null)
})

test('a continued task starts open at the same depth and outdent adopts only the parent style', () => {
  const parent = toggleTask(item('task-choice'),'cancelled')
  const child = toggleTask(item('task',1))
  const next = continuedListItem(child,[])
  assert.deepEqual(next,{type:'paragraph',indent:1,runs:[],listStyle:'task'})
  assert.deepEqual(atParentLevel([parent,child],1), {...child,indent:0,listStyle:'task-choice'})
  assert.equal(taskStateOf(atParentLevel([parent,next],1)),'pending')
  assert.equal(taskStateOf(atParentLevel([item('decimal'),child],1)),null)
  assert.equal(atParentLevel([parent],0).taskState,undefined)
})

test('task counts and preview markers respect mixed lists, nested tasks and malformed legacy fields', () => {
  const blocks = [
    item('decimal'), item('task',1), toggleTask(item('task-choice',1),'cancelled'),
    item('decimal'), toggleTask(item('task')), {type:'image',listStyle:'task',taskState:'done'},
    {...item('bullet'), taskState:'done'}, {...item('task'), taskState:'cancelled'},
  ]
  assert.deepEqual(taskCounts(blocks),{pending:2,done:1,cancelled:1})
  assert.deepEqual(listMarkers(blocks),['1.','☐','☒','2.','☑','','•','☐'])
  assert.equal(taskMarker(null),'')
})
