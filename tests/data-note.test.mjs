import test from 'node:test'
import assert from 'node:assert/strict'
import {checkNote, createNote, newLibrary, readLibrary, serializeLibrary} from '../frontend/data.js'
import {readingFragments} from '../frontend/map-reading.js'
import {findNotes} from '../frontend/search-worker.js'
import {searchTarget} from '../frontend/search-location.js'
import {mergeWorkspace} from '../frontend/workspace-merge.js'

test('data notes retain their exact text, search past the preview and keep map excerpts short', () => {
  const library = newLibrary(), note = createNote(0, 0, null, 'data')
  const text = 'Данные 📄\r\n'.repeat(2000) + 'Последняя строка'
  Object.assign(note, {dataText:text, dataLanguage:'text', plain:text.slice(0,240)})
  library.spaces.personal.notes.push(note)
  const saved = readLibrary(serializeLibrary(library)).spaces.personal.notes[0]
  const {matches} = findNotes([{...saved, plain:saved.dataText}], {query:'строка',exactCase:false})
  const target = searchTarget(saved, matches[0].position)
  assert.deepEqual(target, {kind:'data',start:text.lastIndexOf('строка'),end:text.length})
  assert.equal(searchTarget(saved, {field:'body',start:-1,end:4}), null)
  assert.equal(saved.dataText, text)
  const [fragment] = readingFragments(saved)
  assert.equal(fragment.kind, 'code')
  assert.equal(fragment.text.length, 960)
})

test('sealed placeholders reject data content and language, including an empty document', () => {
  const sealed = {...createNote(0,0),sealed:'envelope'}
  checkNote(sealed)
  assert.throws(()=>checkNote({...sealed,dataText:''}))
  assert.throws(()=>checkNote({...sealed,dataLanguage:'json'}))
  assert.throws(()=>checkNote({...sealed,dataHasHeader:false}))
  assert.throws(()=>checkNote({...createNote(0,0,null,'data'),dataText:{}}))
})

test('conflicting data beyond identical previews can be recovered from either revision', () => {
  const note = createNote(0,0,null,'data'), prefix = 'same line\n'.repeat(60)
  Object.assign(note,{dataText:prefix,plain:prefix.slice(0,240)})
  const base = {notes:[note],areas:[]}, local = structuredClone(base), remote = structuredClone(base)
  local.notes[0].dataText += 'desktop'
  remote.notes[0].dataText += 'laptop'
  const result = mergeWorkspace(base,local,remote)
  assert.equal(result.conflicts.length,1)
  for(const [side, expected] of [['local',local],['remote',remote]]){
    const merged = mergeWorkspace(base,local,remote,{[result.conflicts[0].key]:side})
    assert.equal(merged.data.notes[0].dataText,expected.notes[0].dataText)
  }
})
