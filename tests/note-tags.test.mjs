import test from 'node:test'
import assert from 'node:assert/strict'
import {tagRanges, noteTags, notesWithTag} from '../frontend/note-tags.js'
import {boardSummary} from '../frontend/board.js'

test('tags retain the original UTF-16 offsets and match case-insensitively across note fields', ()=>{
  const s='🎨 Проект: #Эскиз/Этап-2, (#идея) и x#слитно.'
  assert.deepEqual(tagRanges(s).map(t=>[s.slice(t.start,t.end),t.tag]),[
    ['#Эскиз/Этап-2','эскиз/этап-2'],['#идея','идея']])
  assert.deepEqual(noteTags('#План','к #план и #Ёлка'),['план','ёлка'])
})

test('URL fragments and paths are excluded from graph tags and inline navigation', ()=>{
  const s='https://host/#one https://host/q=#two www.test.com/#three /a/#four #пять'
  assert.deepEqual(noteTags('',s),['пять'])
})

test('matches only other unsealed notes in the supplied space', ()=>{
  const notes=[{id:'current',tags:['road']},{id:'target',tags:['#ROAD']},
    {id:'other',tags:['road/b']},{id:'secret',sealed:'anything',tags:['road']}]
  assert.deepEqual(notesWithTag(notes,'current','road').map(n=>n.id),['target'])
})

test('canvas rich blocks preserve searchable code and link text while indexing prose tags', ()=>{
  const body=[{type:'code',text:'#code'}, {type:'heading',runs:[{text:'#План '},{text:'#url',href:'https://example.org'}]}]
  const summary=boardSummary({elements:[{type:'text',body,text:'#code\n#План #url'},{type:'text',text:'#После'}]})
  assert.equal(summary.plain,'#code\n#План #url\n#После')
  assert.deepEqual(noteTags('',summary.tagText),['план','после'])
})
