import test from 'node:test'
import assert from 'node:assert/strict'
import { openNoteSession, isProtectedNote } from '../frontend/note-vault.js'
import { newLibrary, readLibrary, serializeLibrary } from '../frontend/data.js'
import { WorkspaceRecords } from '../frontend/workspace-records.js'

test('protected notes require a vault-aware reader until the last one is removed', () => {
  const lib = newLibrary()
  lib.spaces.demo = {areas:[],notes:[{id:'hidden',title:'',body:[],plain:'',links:[],tags:[],sealed:'opaque'}]}
  const saved = serializeLibrary(lib)
  assert.equal(JSON.parse(saved).version,2)
  assert.equal(readLibrary(saved).spaces.demo.notes[0].sealed,'opaque')
  assert.throws(()=>readLibrary(saved.replace('"plain":""','"plain":"stray preview"')))
  assert.throws(()=>readLibrary(saved.replace('"plain":""','"plain":"","agentTask":{"result":"stray result"}')))
  lib.spaces.demo.notes.length=0
  assert.equal(JSON.parse(serializeLibrary(lib)).version,1)
})

// The native crypto is exercised separately. Opaque tokens here let these tests
// inspect exactly what a map, plugin or workspace save can see at each stage.
function fixture() {
  const record = {id:'a', title:'private title', body:[{type:'code',text:'private code'}], tags:['private tag'],
    plain:'private code', futureAttachment:{caption:'private attachment'}, links:['b'], x:11, y:29, areaId:'area'}
  const payloads = new Map(), snapshots = []
  let key = false, session, savingFails = false
  function seal(payload) {
    assert.ok(key)
    const token = 'envelope-' + payloads.size
    payloads.set(token, payload)
    return token
  }
  const bridge = {
    async ProtectNote(id, payload, password) { assert.equal(password,'test password'); key = true; return seal(payload) },
    async UnlockNote(id, token, password) {
      if (password !== 'test password' || !payloads.has(token)) throw new Error('VD_PASSWORD')
      key = true; return payloads.get(token)
    },
    async SealNote(id, payload) { return seal(payload) },
    async LockNote() { key = false }
  }
  async function prompt({onSubmit}) { await onSubmit({password:'test password',currentPassword:'test password'}); return true }
  async function open(modifiers={}) {
    session = await openNoteSession({record,bridge,dirty() {},prompt,
      async persist() {
        await session?.flush()
        if (savingFails) throw new Error('VD_WRITE')
        snapshots.push(JSON.stringify(record))
      }, ...modifiers})
    return session
  }
  return {record,payloads,snapshots,bridge,open,get key() {return key},set failWrite(value){savingFails=value}}
}

test('data note language and full document stay inside the envelope across edits', async () => {
  const f = fixture()
  Object.assign(f.record,{type:'data',body:[],dataLanguage:'json',dataText:'{"value":"private"}'})
  let session = await f.open()
  await session.manageProtection()
  session.changed({dataText:'{"value":"updated"}',plain:'updated'})
  assert.ok(await session.beforeClose())
  assert.doesNotMatch(JSON.stringify(f.record),/dataText|dataLanguage|updated|private/)
  session = await f.open()
  assert.equal(session.note.dataText,'{"value":"updated"}')
  assert.equal(session.note.dataLanguage,'json')
  assert.ok(await session.beforeClose())
})

test('sealing an open task keeps progress reported since the editor opened', async () => {
  const f = fixture()
  f.record.agentTask = {rootId:'idea',key:'draft',weight:2,status:'working',result:''}
  const session = await f.open()
  f.record.agentTask = {...f.record.agentTask,status:'done',result:'Verified result'}
  await session.manageProtection()
  session.changed({title:'Updated title'})
  assert.ok(await session.beforeClose())
  assert.doesNotMatch(JSON.stringify(f.record),/agentTask|Verified result/)
  const reopened = await f.open()
  assert.equal(reopened.note.agentTask.status,'done')
  assert.equal(reopened.note.agentTask.result,'Verified result')
  assert.ok(await reopened.beforeClose())
})

test('a task state edit survives local saves, workspace deltas and a note lock', async () => {
  const f = fixture()
  const task = {type:'paragraph',listStyle:'task-choice',runs:[{text:'private task'}]}
  Object.assign(f.record,{body:[task],plain:'private task'})
  const lib = newLibrary(), space = lib.spaces.demo = {notes:[f.record],areas:[]}
  const records = new WorkspaceRecords(space)
  task.taskState = 'done'
  records.mark({notes:[f.record]})
  const update = records.prepare(space)
  assert.deepEqual(update.patch.notes.edit[0].set.body, [task])
  assert.equal(update.patch.notes.edit[0].set.plain, undefined)
  update.commit()
  const restored = readLibrary(serializeLibrary(lib)).spaces.demo
  assert.deepEqual(restored.notes[0].body, [task])
  let session = await f.open()
  await session.manageProtection()
  const cancelled = {...task,taskState:'cancelled'}
  session.changed({body:[cancelled]})
  assert.ok(await session.beforeClose())
  assert.doesNotMatch(JSON.stringify(f.record), /taskState|private task|cancelled/)
  session = await f.open()
  assert.deepEqual(session.note.body, [cancelled])
  assert.ok(await session.beforeClose())
})

test('sealing an edit marks the new envelope even after the map record was acknowledged', async () => {
  const f=fixture(), space={notes:[f.record],areas:[]}
  let records
  const session=await f.open({dirty:()=>records?.mark({notes:[f.record]})})
  await session.manageProtection()
  records=new WorkspaceRecords(space)
  const previous=f.record.sealed
  session.changed({plain:'private edit'})
  records.prepare(space).commit()
  await session.flush()
  const next=records.prepare(space)
  assert.equal(next.patch.notes.edit[0].set.sealed,f.record.sealed)
  assert.notEqual(f.record.sealed,previous)
  assert.doesNotMatch(JSON.stringify(next.patch),/private edit/)
  assert.ok(await session.beforeClose())
})

test('only the detached note contains private data across open, edits, map moves and relock', async () => {
  const f = fixture()
  let session = await f.open()
  await session.manageProtection()
  assert.ok(isProtectedNote(f.record))
  assert.doesNotMatch(JSON.stringify(f.record),/private|futureAttachment/)
  session.changed({plain:'private update',tags:['private update tag']})
  f.record.x = 43
  assert.ok(await session.beforeClose())
  assert.equal(f.key,false)
  assert.doesNotMatch(f.snapshots.at(-1),/private|futureAttachment/)
  assert.equal((await f.open({prompt:async()=>false})),null)
  assert.equal(f.key,false)
  // A system lock can arrive while the native password operation completes.
  assert.equal(await f.open({prompt:async({onSubmit})=>{
    await onSubmit({password:'test password'})
    return false
  }}),null)
  assert.equal(f.key,false)
  session=await f.open()
  assert.equal(session.note.futureAttachment.caption,'private attachment')
  assert.equal(session.note.plain,'private update')
  assert.equal(session.note.x,43)
  assert.deepEqual(session.note.links,['b'])
  await session.manageProtection()
  assert.equal(f.key,false)
  assert.ok(!isProtectedNote(f.record))
  assert.equal(f.record.plain,'private update')
  assert.equal(f.record.futureAttachment.caption,'private attachment')
})

test('a slow seal catches up with subsequent edits before it releases the key', async () => {
  const f=fixture(), session=await f.open()
  await session.manageProtection()
  const original=f.bridge.SealNote
  let resume
  const wait=new Promise(resolve=>{resume=resolve})
  f.bridge.SealNote=async (...args)=>{await wait;return original(...args)}
  session.changed({title:'private edit 1'})
  const first=session.flush()
  session.changed({title:'private edit 2'})
  const close=session.beforeClose()
  assert.ok(f.key)
  resume()
  await first
  assert.ok(await close)
  assert.equal(JSON.parse(f.payloads.get(f.record.sealed)).title,'private edit 2')
  assert.equal(f.key,false)
})

test('submitting protection keeps an unsaved draft out of queued workspace saves', async () => {
  const f=fixture(), session=await f.open()
  let release, entered
  const waiting=new Promise(resolve=>{release=resolve})
  const started=new Promise(resolve=>{entered=resolve})
  const original=f.bridge.ProtectNote
  f.bridge.ProtectNote=async (...args)=>{entered();await waiting;return original(...args)}
  session.changed({title:'private draft'})
  const securing=session.manageProtection()
  await started
  const autosave=session.flush().then(()=>JSON.stringify(f.record))
  session.changed({plain:'private last edit'})
  assert.equal(f.snapshots.length,0,'no plaintext preflight write')
  release()
  await securing
  assert.doesNotMatch(await autosave,/private/)
  assert.ok(f.snapshots.every(snapshot=>!snapshot.includes('private')))
  await session.beforeClose()
  assert.equal((await f.open()).note.plain,'private last edit')
})

test('after a write failure, retries save the envelope and keep the last changes', async () => {
  const f=fixture(), session=await f.open()
  const original=f.bridge.ProtectNote
  f.bridge.ProtectNote=async (...args)=>{
    const envelope=await original(...args)
    f.failWrite=true
    return envelope
  }
  await assert.rejects(session.manageProtection(),/VD_WRITE/)
  assert.ok(session.protected)
  assert.ok(f.key)
  assert.doesNotMatch(JSON.stringify(f.record),/private/)
  session.changed({plain:'private after write error'})
  await session.flush()
  assert.doesNotMatch(JSON.stringify(f.record),/private/)
  f.failWrite=false
  assert.ok(await session.beforeClose())
  assert.equal(f.key,false)
  assert.ok(f.snapshots.every(snapshot=>!snapshot.includes('private')))
  assert.equal((await f.open()).note.plain,'private after write error')
})

test('failed plaintext write keeps protection and retries closing with the last edits', async () => {
  const f=fixture(), errors=[]
  const session=await f.open({onError:error=>errors.push(error.message)})
  await session.manageProtection()
  const persist=f.snapshots.length
  // Permit the preflight save, fail the write which would remove protection.
  const unlock=f.bridge.UnlockNote
  f.bridge.UnlockNote=async(...args)=>{const value=await unlock(...args);f.failWrite=true;return value}
  await assert.rejects(session.manageProtection(),/VD_WRITE/)
  assert.ok(isProtectedNote(f.record))
  assert.doesNotMatch(JSON.stringify(f.record),/private/)
  assert.ok(f.key)
  session.changed({title:'private recovered'})
  assert.equal(await session.beforeClose(),false)
  assert.ok(f.key)
  assert.deepEqual(errors,['VD_WRITE'])
  f.failWrite=false
  assert.ok(await session.beforeClose())
  assert.ok(f.snapshots.slice(persist).every(s=>!s.includes('private')))
  assert.equal(JSON.parse(f.payloads.get(f.record.sealed)).title,'private recovered')
})
