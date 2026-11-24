import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {runInNewContext} from 'node:vm'
import {readExtensionManifests, supportsNoteCommand} from '../frontend/extension-manifest.js'

const view = {apiVersion:1, id:'example.actions', name:'Actions', html:'<p>Actions</p>'}
const note = {id:'follow-up', title:'Follow up', scope:'note'}
const space = {id:'summary', title:'Summary', scope:'workspace'}
const parse = value => readExtensionManifests([{...view, ...value}])[0]

test('commands and permissions are optional and survive a round trip', () => {
  const legacy = parse({})
  assert.ok(!Object.hasOwn(legacy, 'commands'))
  assert.ok(!Object.hasOwn(legacy, 'permissions'))
  const manifest = parse({commands:[note, space], permissions:['notes.read', 'notes.create', 'notes.append']})
  assert.deepEqual(manifest.commands, [note, space])
  assert.deepEqual(parse(JSON.parse(JSON.stringify(manifest))), manifest)
  assert.deepEqual(parse({commands:[], permissions:[]}).permissions, [])
})

test('command declarations reject duplicates, malformed entries and oversized menus', () => {
  assert.throws(() => parse({commands:[note, {...note, id:note.id.toUpperCase(), scope:'workspace'}]}))
  for (const commands of [null, 'action', [null], ['action'], [{id:'partial'}],
    [{...note, id:'bad id'}], [{...note, id:'x'.repeat(97)}], [{...note, title:'  '}],
    [{...note, title:'x'.repeat(121)}], [{...note, title:'One\nTwo'}],
    [{...note, scope:'device'}], [{...note, extra:true}],
    Array.from({length:33}, (_, index) => ({...note, id:'a' + index}))])
    assert.throws(() => parse({commands}))
  const [trimmed] = parse({commands:[{...note, title:'  Follow up  '}]}).commands
  assert.equal(trimmed.title, 'Follow up')
})

test('permission names must be supported, explicit and unique', () => {
  for (const permissions of [null, 'notes.read', {}, [false], ['notes.*'], ['notes.READ'],
    ['notes.read', 'notes.read'], ['notes.read', 'notes.append', 'notes.create', 'other']])
    assert.throws(() => parse({permissions}))
  const language = {type:'language', locale:'fr', messages:{'Edit':'Modifier'}}
  assert.throws(() => parse({...language, commands:[note]}))
})

test('note-type filters preserve untyped text notes and only apply to note commands', () => {
  const [filtered] = parse({commands:[{...note, noteTypes:['text','data']}]}).commands
  assert.deepEqual(filtered.noteTypes, ['text','data'])
  assert.equal(supportsNoteCommand(filtered, {id:'legacy'}), true)
  assert.equal(supportsNoteCommand(filtered, {type:'data'}), true)
  assert.equal(supportsNoteCommand(filtered, {type:'canvas'}), false)
  assert.equal(supportsNoteCommand(note, {type:'canvas'}), true)
  assert.equal(supportsNoteCommand(note, null), false)
  assert.equal(supportsNoteCommand(space, {type:'text'}), false)
  assert.throws(() => parse({commands:[{...space, noteTypes:['text']}]}))
  for (const types of [null, [], 'text', ['TEXT'], ['text','text'], ['world']])
    assert.throws(() => parse({commands:[{...note, noteTypes:types}]}))
})

test('the meeting follow-up example runs as a view and submits one scoped append per click', async () => {
  const source = readFileSync(new URL('../docs/examples/meeting-follow-up.json', import.meta.url), 'utf8')
  const [example] = readExtensionManifests([JSON.parse(source)])
  assert.deepEqual(example.permissions, ['notes.append'])
  assert.deepEqual(example.commands[0].noteTypes, ['text'])
  const fields = new Map()
  function field(id) {
    if (!fields.has(id)) fields.set(id, {value:'', focus(){}, hidden:id === 'entry'})
    return fields.get(id)
  }
  const appended = []
  let handlers, finish
  runInNewContext(example.html.match(/<script>([\s\S]+)<\/script>/)[1], {
    document:{getElementById:field},
    videron:{
      start(value){ handlers = value },
      notes:{append(text){ appended.push(text); return new Promise(resolve => { finish = resolve }) }}
    }
  })
  handlers.onData({language:'en'})
  assert.equal(field('entry').hidden, true)
  field('action').value = 'Publish minutes'
  await field('add').onclick()
  assert.equal(appended.length, 0)
  handlers.onCommand({id:example.commands[0].id, noteId:'n1'})
  assert.equal(field('entry').hidden, false)
  field('owner').value = 'Lena'
  const pending = field('add').onclick()
  await field('add').onclick()
  assert.deepEqual(appended, ['Next step — Publish minutes · Lena'])
  assert.equal(field('add').disabled, true)
  finish()
  await pending
  assert.equal(field('status').textContent, 'Follow-up added.')
  await field('add').onclick()
  assert.equal(appended.length, 1)
})
