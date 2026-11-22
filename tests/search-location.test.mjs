import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { findNotes, installSearchWorker } from '../frontend/search-worker.js'
import { searchTarget } from '../frontend/search-location.js'

const paragraph = (...runs) => ({type:'paragraph', runs:runs.map(text => ({text}))})
const note = (plain, body = [], extra = {}) => ({id:'one', title:'Notebook', tags:'#meta', plain, body, modified:1, ...extra})
const result = (n, query, flags) => findNotes([n], {query, ...flags}).matches[0]
const hit = (n, query, flags) => searchTarget(n, result(n, query, flags)?.position)

test('canvas search locates a caption or plain label after other board content', () => {
  const elements = [
    {id:'tab',type:'table',name:'Costs',cells:{A1:'120'}},
    {id:'shape',type:'rect',label:'Готовый проект'},
    {id:'words',type:'text',text:'Stand-alone text'}
  ]
  const n = note('Costs\n120\nГотовый проект\nStand-alone text', [], {type:'canvas',board:{elements}})
  assert.deepEqual(hit(n, 'проект'), {kind:'canvasLabel', id:'shape',start:8,end:14})
  assert.deepEqual(hit(n, 'alone'), {kind:'canvasLabel', id:'words',start:6,end:11})
})

test('canvas search maps a match in formatted text and code to the right text area', () => {
  const body = [paragraph('📁 ', 'пример'), {type:'code', text:'{"name": "example"}'}]
  const text = '📁 пример\n{"name": "example"}'
  const elements = [{type:'ellipse'}, {type:'rect',label:'В начало'}, {type:'text',id:'box',body,text}]
  const n = note('В начало\n' + text, [], {type:'canvas',board:{elements}})
  assert.deepEqual(hit(n,'пример'), {kind:'canvasText',id:'box',match:{kind:'body',ranges:[{index:0,start:3,end:9}]}})
  assert.deepEqual(hit(n,'example'), {kind:'canvasText',id:'box',match:{kind:'body',ranges:[{index:1,start:10,end:17}]}})
})

test('an excerpt near the bottom of a code block maps to the original offsets after rich text and nested tables', () => {
  const prefix = '😀 заголовок'
  const summary = 'Таблица 1\n11\n22'
  const code = '// line\n'.repeat(160) + '  const target = true'
  const blocks = [paragraph('😀 ', 'заголовок'), {type:'drawing', board:{elements:[
    {type:'table', name:'Таблица 1', cells:{A1:'11', A2:'22'}}
  ]}}, {type:'code', text:code}]
  const n = note([prefix, summary, code].join('\n'), blocks, {title:'Target'})
  const m = result(n, 'target')
  const start = code.indexOf('target')
  assert.equal(m.snippet.slice(m.start, m.start + m.length), 'target')
  assert.ok(m.position.start > 1000)
  assert.deepEqual(searchTarget(n, m.position), {kind:'body', ranges:[{index:2, start, end:start + 6}]})
  assert.equal(hit(n, 'Таблица'), null)
})

test('global regex positions map across formatting runs and block separators', () => {
  const n = note('first 😀red\nblue text', [paragraph('first ', '😀', 'red'), paragraph('blue text')])
  assert.deepEqual(hit(n, '😀re.\\nbl.e', {regex:true}), {kind:'body', ranges:[
    {index:0, start:6, end:11}, {index:1, start:0, end:4}
  ]})
  assert.deepEqual(hit(n, '(?=red)', {regex:true}), {kind:'body', ranges:[{index:0,start:8,end:8}]})
  assert.deepEqual(hit(n, '\n'), {kind:'body', ranges:[{index:0,start:11,end:11}]})
})

test('plain legacy notes open at the right paragraph and metadata-only results have no body target', () => {
  const n = note('first\n\nlast')
  assert.deepEqual(hit(n, 'last'), {kind:'body', ranges:[{index:2, start:0, end:4}]})
  assert.deepEqual(hit(n, 'book'), {kind:'title',start:4,end:8})
  assert.equal(hit(n, '#meta'), null)
  assert.equal(hit(n, ''), null)
  assert.equal(hit({...n, type:'canvas'}, 'last'), null)
  assert.equal(hit({...n, body:[paragraph('old')]}, 'last'), null)
  assert.equal(searchTarget({...n, title:''}, {field:'title',start:0,end:8}), null)
})

test('literal case folding keeps original UTF-16 offsets before and inside an expanded character', () => {
  const n = note('İ😀x İ')
  assert.deepEqual(result(n, 'x').position, {field:'body',start:3,end:4})
  assert.deepEqual(result(n, 'i\u0307').position, {field:'body',start:0,end:1})
  assert.deepEqual(result(n, '\u0307').position, {field:'body',start:0,end:1})
  assert.deepEqual(result(note('i\u0307'), 'İ').position, {field:'body',start:0,end:2})
  assert.equal(result(n, 'i', {exactCase:true}), undefined)
})

test('the standalone desktop worker sends the same range as the module worker', () => {
  let response
  const self = {postMessage:value=>{response=JSON.parse(JSON.stringify(value))}}
  vm.runInNewContext('(' + installSearchWorker.toString() + ')(' + findNotes.toString() + ')', {self})
  const n = note('İ😀x')
  self.onmessage({data:{notes:[n]}})
  self.onmessage({data:{options:{query:'x'}}})
  assert.deepEqual(response.matches[0].position, {field:'body', start:3,end:4})
})
