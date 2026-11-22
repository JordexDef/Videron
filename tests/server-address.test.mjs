import test from 'node:test'
import assert from 'node:assert/strict'

function mockStorage(t,get) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage')
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get})
  t.after(()=>{
    if(previous)Object.defineProperty(globalThis,'localStorage',previous)
    else delete globalThis.localStorage
  })
}

test('a new session prefills the last confirmed HTTPS endpoint and keeps its port',async t=>{
  const values=new Map()
  mockStorage(t,()=>({
    getItem:key=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,value),
  }))
  const first=await import('../frontend/server-address.js?first')
  assert.equal(first.lastServerAddress(),'')
  first.rememberServerAddress('https://sync.example.test:443')
  for(const address of ['https://a:b@other.test','https://other.test/#secret',
    'https://other.test/?token=secret','https://other.test/path','videron-sync://host:8743#credentials',
    'http://other.test:8743','https://other.test:0','https://other.test:65536']){
    first.rememberServerAddress(address)
  }
  assert.deepEqual([...values.values()],['https://sync.example.test:443'])
  const next=await import('../frontend/server-address.js?restart')
  assert.equal(next.lastServerAddress(),'https://sync.example.test:443')
  next.rememberServerAddress('https://[::1]:8743')
  assert.deepEqual([...values.values()],['https://[::1]:8743'])
  values.set([...values.keys()][0],'https://user:secret@other.test')
  const corrupted=await import('../frontend/server-address.js?corrupted')
  assert.equal(corrupted.lastServerAddress(),'')
})

test('reopening the dialog remembers an address for the session if storage is unavailable',async t=>{
  mockStorage(t,()=>{throw new Error('storage disabled')})
  const memory=await import('../frontend/server-address.js?session')
  assert.equal(memory.lastServerAddress(),'')
  memory.rememberServerAddress('https://nas.local:8743')
  assert.equal(memory.lastServerAddress(),'https://nas.local:8743')
})
