import test from 'node:test'
import assert from 'node:assert/strict'
import { openNoteSession, isProtectedNote, protectedNoteTitle } from '../frontend/note-vault.js'
import { normalizeMapLabel, validMapLabel } from '../frontend/note-label.js'
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

test('remembered access reopens the current envelope without another prompt or plaintext workspace writes', async () => {
  const f = fixture(), hints = new Map(), deadline = 1_800_000_000_000
  const initial = await f.open()
  await initial.manageProtection()
  await initial.beforeClose()
  let prompts = 0, closes = 0, resumes = 0
  f.bridge.UnlockNoteFor = async (space, id, sealed, password, minutes) => {
    assert.equal(space, 'personal')
    assert.equal(minutes, 15)
    return {plain:await f.bridge.UnlockNote(id, sealed, password), remembered:true, expiresAt:deadline}
  }
  f.bridge.ResumeNote = async (space, id, sealed) => {
    resumes++
    assert.equal(space, 'personal')
    assert.equal(sealed, f.record.sealed)
    return {plain:await f.bridge.UnlockNote(id, sealed, 'test password'), remembered:true, expiresAt:deadline}
  }
  f.bridge.CloseNoteEditor = async () => { closes++; await f.bridge.LockNote() }
  const options = {
    spaceId:'personal',
    onRemember(id, expiresAt) { if (expiresAt === null) hints.delete(id); else hints.set(id, expiresAt) },
    async prompt({allowRemember, onSubmit}) {
      prompts++
      assert.equal(allowRemember, true)
      await onSubmit({password:'test password', rememberMinutes:15})
      return true
    },
  }
  let session = await f.open(options)
  assert.equal(session.expiresAt, deadline)
  assert.equal(hints.get(f.record.id), deadline)
  session.changed({plain:'private edit at the deadline'})
  f.failWrite = true
  await assert.rejects(session.beforeClose(), /VD_WRITE/)
  assert.equal(closes, 0)
  f.failWrite = false
  assert.ok(await session.beforeClose())
  assert.equal(closes, 1)
  const synced = {...JSON.parse(f.payloads.get(f.record.sealed)),title:'private remote title'}
  f.record.sealed = 'synced-envelope'
  f.payloads.set(f.record.sealed, JSON.stringify(synced))
  session = await f.open({...options, tryResume:true})
  assert.equal(resumes, 1)
  assert.equal(prompts, 1)
  assert.equal(session.expiresAt, deadline)
  assert.equal(session.note.title, 'private remote title')
  assert.equal(session.note.plain, 'private edit at the deadline')
  assert.doesNotMatch(JSON.stringify(f.record), /private/)
  assert.ok(await session.beforeClose())
})

test('an expired grant requests the password again and cancellation revokes an in-flight unlock', async () => {
  const f = fixture(), hints = []
  const initial = await f.open()
  await initial.manageProtection()
  await initial.beforeClose()
  f.bridge.ResumeNote = async () => { throw new Error('VD_LOCKED') }
  f.bridge.UnlockNoteFor = async (_space,id,sealed,password) => ({
    plain:await f.bridge.UnlockNote(id,sealed,password), remembered:true, expiresAt:0,
  })
  f.bridge.CloseNoteEditor = () => assert.fail('cancelled unlock must release the grant')
  const options = {
    spaceId:'personal', tryResume:true, onRemember:(id,deadline) => hints.push([id,deadline]),
    async prompt({onSubmit}) { await onSubmit({password:'test password', rememberMinutes:-1}); return false },
  }
  assert.equal(await f.open(options), null)
  assert.deepEqual(hints, [['a',null],['a',0],['a',null]])
  assert.equal(f.key, false)
  f.bridge.ResumeNote = async () => { throw new Error('VD_CORRUPT') }
  await assert.rejects(f.open({...options, prompt:() => assert.fail('corrupt envelope')}), /VD_CORRUPT/)
})

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

test('credential entries can only be edited and reopened inside a sealed note', async () => {
  const f=fixture(), block={type:'credentials',entries:[{resource:'service-example',login:'user-example',password:'secret-example'}]}
  let session=await f.open()
  assert.throws(()=>session.changed({body:[block]}), /VD_CREDENTIALS_REQUIRE_LOCK/)
  const lib=newLibrary()
  lib.spaces.personal.notes.push({...f.record,body:[block]})
  assert.throws(()=>readLibrary(serializeLibrary(lib)), /VD_CREDENTIALS_REQUIRE_LOCK/)
  await session.manageProtection()
  session.changed({body:[block],plain:''})
  assert.ok(await session.beforeClose())
  assert.doesNotMatch(JSON.stringify(f.snapshots),/user-example|service-example|secret-example/)
  session=await f.open()
  assert.deepEqual(session.note.body,[block])
  await assert.rejects(session.manageProtection(), /VD_CREDENTIALS_REQUIRE_LOCK/)
  assert.ok(isProtectedNote(f.record))
  session.changed({body:[],plain:''})
  await session.manageProtection()
  assert.ok(!isProtectedNote(f.record))
  assert.doesNotMatch(JSON.stringify(f.record),/user-example|service-example|secret-example/)
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

test('restyling a closed encrypted note updates only map fields and survives resealing', async () => {
  const f = fixture()
  f.record.appearance = {shape:'diamond',icon:'lucide/bookmark',color:'#ABCDEF',radius:60,badgeSize:'large',leftIcon:'lucide/book-open',rightIcon:'phosphor/house',caption:'private caption'}
  let session = await f.open()
  await session.manageProtection()
  assert.ok(await session.beforeClose())
  assert.deepEqual(f.record.appearance,{shape:'diamond',icon:'lucide/bookmark',color:'#abcdef',radius:60,badgeSize:'large',leftIcon:'lucide/book-open',rightIcon:'phosphor/house'})
  assert.doesNotMatch(JSON.stringify(f.record),/private|caption/)
  const space = {notes:[f.record],areas:[]}, records = new WorkspaceRecords(space)
  const style = {shape:'square',icon:'phosphor/house',rightIcon:'lucide/bookmark',color:'#a9c6ed'}
  f.record.appearance = style
  records.mark({notes:[f.record]})
  assert.deepEqual({...records.prepare(space).patch.notes.edit[0].set},{appearance:style})
  assert.equal(f.key,false)
  session = await f.open()
  assert.deepEqual(session.note.appearance,{...style,caption:'private caption'})
  session.changed({title:'private edit'})
  assert.ok(await session.beforeClose())
  session = await f.open()
  assert.deepEqual(session.note.appearance,{...style,caption:'private caption'})
  await session.manageProtection()
  assert.deepEqual(f.record.appearance,{...style,caption:'private caption'})
  assert.ok(await session.beforeClose())
})

test('a public label is opt-in and never replaces or exposes the private note title', async () => {
  const f = fixture()
  // An older extension could already have used this property inside a plain note.
  f.record.mapLabel = 'private extension field'
  let session = await f.open()
  await session.manageProtection()
  await session.beforeClose()
  assert.equal(Object.hasOwn(f.record,'mapLabel'), false)
  assert.equal(protectedNoteTitle(f.record), protectedNoteTitle())
  const sealed = f.record.sealed, space = {notes:[f.record],areas:[]}
  const records = new WorkspaceRecords(space)
  f.record.mapLabel = 'Работа 📁'
  records.mark({notes:[f.record]})
  const rename = records.prepare(space)
  assert.deepEqual({...rename.patch.notes.edit[0].set}, {mapLabel:'Работа 📁'})
  rename.commit()
  assert.equal(f.record.sealed, sealed)
  assert.equal(protectedNoteTitle(f.record), 'Работа 📁')
  session = await f.open()
  assert.equal(session.note.title, 'private title')
  assert.equal(session.note.mapLabel, 'private extension field')
  session.changed({title:'private new title'})
  await session.beforeClose()
  assert.equal(f.record.title, '')
  assert.equal(protectedNoteTitle(f.record), 'Работа 📁')
  assert.doesNotMatch(JSON.stringify(f.record), /private/)
  delete f.record.mapLabel
  session = await f.open()
  session.changed({plain:'another edit'})
  await session.beforeClose()
  assert.equal(Object.hasOwn(f.record,'mapLabel'), false)
  assert.equal(protectedNoteTitle(f.record), protectedNoteTitle())
  session = await f.open()
  await session.manageProtection()
  assert.equal(f.record.title, 'private new title')
  assert.equal(f.record.mapLabel, 'private extension field')
  await session.beforeClose()
})

test('group membership survives protection and ungrouping a locked note overrides its older encrypted metadata',async () => {
  const f = fixture(), id = crypto.randomUUID()
  f.record.mapGroupId = id
  let session = await f.open()
  await session.manageProtection(); await session.beforeClose()
  assert.equal(f.record.mapGroupId,id)
  const sealed = f.record.sealed
  delete f.record.mapGroupId
  session = await f.open()
  assert.equal(session.note.mapGroupId,undefined)
  assert.equal(f.record.sealed,sealed)
  await session.manageProtection()
  assert.equal(Object.hasOwn(f.record,'mapGroupId'),false)
  await session.beforeClose()
})

test('failed removal of protection restores the public label with the envelope', async () => {
  const f = fixture()
  let session = await f.open()
  await session.manageProtection()
  await session.beforeClose()
  f.record.mapLabel = 'My map label'
  session = await f.open()
  const unlock = f.bridge.UnlockNote
  f.bridge.UnlockNote = async (...args) => { const plain = await unlock(...args); f.failWrite = true; return plain }
  await assert.rejects(session.manageProtection(), /VD_WRITE/)
  assert.equal(protectedNoteTitle(f.record), 'My map label')
  assert.doesNotMatch(JSON.stringify(f.record), /private/)
  f.failWrite = false
  assert.ok(await session.beforeClose())
})

test('stored map labels are single-line Unicode strings of up to 120 code points', () => {
  const label = '📁'.repeat(120)
  assert.equal(normalizeMapLabel('  Карта\n📁  '), 'Карта 📁')
  assert.equal(normalizeMapLabel(label + 'x'), label)
  const lib = newLibrary(), note = {id:'a',title:'',plain:'',links:[],tags:[],body:[],sealed:'opaque'}
  lib.spaces.personal.notes.push(note)
  for (const invalid of ['', null, {}, ' surrounded ', 'a\u007fb', 'a\u2028b', label+'x']) {
    assert.equal(validMapLabel(invalid), false)
    note.mapLabel = invalid
    assert.throws(() => readLibrary(serializeLibrary(lib)))
  }
  note.mapLabel = label
  assert.equal(readLibrary(serializeLibrary(lib)).spaces.personal.notes[0].mapLabel, label)
})

test('previously private legacy appearance stays private across edits and failed protection removal', async () => {
  const f = fixture()
  f.record.appearance = {shape:'diamond',icon:'lucide/bookmark',color:'#abcdef'}
  let session = await f.open()
  await session.manageProtection()
  await session.beforeClose()
  delete f.record.appearance // A record created by an older application.
  session = await f.open()
  session.changed({plain:'private update'})
  await session.flush()
  assert.equal(Object.hasOwn(f.record,'appearance'),false)
  const unlock=f.bridge.UnlockNote
  f.bridge.UnlockNote=async(...args)=>{const value=await unlock(...args);f.failWrite=true;return value}
  await assert.rejects(session.manageProtection(),/VD_WRITE/)
  assert.equal(Object.hasOwn(f.record,'appearance'),false)
  f.failWrite=false
  assert.ok(await session.beforeClose())
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
