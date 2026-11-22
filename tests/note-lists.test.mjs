import test from 'node:test'
import assert from 'node:assert/strict'
import {listMarkers, atParentLevel, listStyleForPrefix} from '../frontend/note-lists.js'

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
