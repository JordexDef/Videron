import test from 'node:test'
import assert from 'node:assert/strict'
import {richBodyFindRecords,replaceFindBody,replaceNoteRuns,replaceNoteString} from '../frontend/note-find-text.js'
import {documentFindRecords,replaceFindDocument} from '../frontend/note-find-document.js'

test('note find exposes editable text in display order without reading credential or attachment values',()=>{
  const body=[{type:'heading',runs:[{text:'Intro'}]},{type:'paragraph',list:'task',runs:[{text:'visit ',bold:true},{text:'here',href:'https://private.example'}]},
    {type:'credentials',entries:[{login:'private',password:'secret'}]},{type:'image',alt:'private',src:'data:…'},
    {type:'code',language:'json',text:'{\r\n}'},{type:'divider'}]
  assert.deepEqual(richBodyFindRecords(body),[{id:'0',text:'Intro'},{id:'1',text:'visit here'},{id:'4',text:'{\n}'}])
  const next=replaceFindBody(body,[{id:'1',from:3,to:8,text:'X'},{id:'4',from:2,to:3,text:']'}])
  assert.equal(next[2],body[2])
  assert.deepEqual(next[1],{...body[1],runs:[{text:'visX',bold:true},{text:'re',href:'https://private.example'}]})
  assert.deepEqual(next[4],{...body[4],text:'{\r\n]'})
  assert.equal(body[1].runs[0].text,'visit ')
})

test('ordered replacements preserve original styles, including unchanged matches and a zero-width insertion',()=>{
  const runs=[{text:'cat',italic:true},{text:'sleeps'},{text:'cat',bold:true}]
  assert.deepEqual(replaceNoteRuns(runs,[{from:1,to:5,text:'atsl'}]),runs)
  assert.deepEqual(replaceNoteRuns(runs,[{from:0,to:3,text:'dog'},{from:9,to:12,text:'fox'},{from:12,to:12,text:'!'}]),
    [{text:'dog',italic:true},{text:'sleeps'},{text:'fox!',bold:true}])
  assert.deepEqual(replaceNoteRuns([],[{from:0,to:0,text:'empty'}]),[{text:'empty'}])
  assert.equal(replaceNoteString('banana',[{from:1,to:3,text:'X'},{from:3,to:5,text:'Y'}]),'bXYa')
})

test('inline drawings and tables with duplicate object IDs keep independent cells, geometry and formulas',()=>{
  const table=()=>({type:'drawing',board:{version:2,elements:[{id:'table/id',type:'table',cells:{A1:'fox',B1:'=A1'}}]}})
  const body=[table(),{type:'heading',runs:[{text:'fox'}]},table()]
  const records=documentFindRecords(body)
  assert.deepEqual(records.map(r=>r.text),['fox','=A1','fox','fox','=A1'])
  const next=replaceFindDocument(body,[{id:records[3].id,from:0,to:3,text:'Wolf'}])
  assert.equal(next[0],body[0])
  assert.equal(next[1],body[1])
  assert.deepEqual(next[2].board.elements,[{id:'table/id',type:'table',cells:{A1:'Wolf',B1:'=A1'}}])
})
