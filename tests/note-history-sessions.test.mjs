import test from 'node:test'
import assert from 'node:assert/strict'
import {NoteHistorySessions} from '../frontend/note-history-sessions.js'

const ref=(space,note,protection='plain')=>({space,note,folder:'',kind:'text',protection})
function desktop(){
  const stored=new Map()
  return {
    stored,
    ReadEditorHistory:async r=>stored.get(JSON.stringify(r))??'',
    StoreEditorHistory:async (r,raw)=>{stored.set(JSON.stringify(r),raw)},
    ForgetEditorHistories:async (space,ids)=>{
      for(const key of stored.keys()){
        const r=JSON.parse(key)
        if((!space || r.space===space) && (!ids.length || ids.includes(r.note)))stored.delete(key)
      }
    }
  }
}

test('plain note histories remain separate across projects and revoked handles cannot restore them',async()=>{
  const bridge=desktop(), sessions=new NoteHistorySessions(bridge)
  const a=ref('one','same'), b=ref('two','same'), c=ref('one','other')
  for(const r of [a,b,c])await (await sessions.open(r)).save([r.space,r.note])
  assert.equal(bridge.stored.size,0)
  const first=await sessions.open(a)
  assert.deepEqual(first.take(),['one','same'])
  assert.equal(first.take(),undefined)
  await sessions.reconcile('one',[{id:'other'}],()=>c)
  await first.save(['stale'])
  assert.equal((await sessions.open(a)).take(),undefined)
  assert.deepEqual((await sessions.open(b)).take(),['two','same'])
  assert.deepEqual((await sessions.open(c)).take(),['one','other'])
})

test('a full lock can interrupt opening a note; both ordinary and sealed checkpoints survive the WebView reload',async()=>{
  const bridge=desktop()
  const sessions=new NoteHistorySessions(bridge)
  const a=ref('one','ordinary'), b=ref('two','vault','note')
  await (await sessions.open(a)).save(['ordinary'])
  await (await sessions.open(b)).save(['secret'])
  assert.equal(bridge.stored.size,1)
  await sessions.open(b) // Lock before the editor mounts.
  await sessions.parkForLock()
  assert.equal(bridge.stored.size,2)
  const restartedView=new NoteHistorySessions(bridge)
  const protectedNote=await restartedView.open(b),plain=await restartedView.open(a)
  assert.deepEqual(protectedNote.take(),['secret'])
  assert.deepEqual(plain.take(),['ordinary'])
  await protectedNote.save(undefined)
  await plain.save(['later'])
  assert.equal(bridge.stored.size,0)
  assert.deepEqual((await restartedView.open(a)).take(),['later'])
  assert.equal((await restartedView.open(b)).take(),undefined)
})

test('edits following a failed close stay in the same undo session, even after an empty checkpoint',async()=>{
  const sessions=new NoteHistorySessions(desktop())
  for(const policy of ['plain','note']){
    const r=ref('one',policy,policy), editor=await sessions.open(r)
    await editor.save(undefined)
    await editor.save(['new edit'])
    const reopened=await sessions.open(r)
    assert.deepEqual(reopened.take(),['new edit'])
    await reopened.save(undefined)
    assert.equal((await sessions.open(r)).take(),undefined)
  }
})
