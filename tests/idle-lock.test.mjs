import test from 'node:test'
import assert from 'node:assert/strict'
import {createIdleLock, normalizeIdleMinutes} from '../frontend/idle-lock.js'

function fixture() {
  const win = new EventTarget(), doc = new EventTarget(), timers = new Map()
  let wall = 0, mono = 0, locks = 0, serial = 0
  const idle = createIdleLock({
    win, doc, onIdle:() => locks++, wallNow:() => wall, monoNow:() => mono,
    setTimer(callback, delay) { timers.set(++serial, {callback, delay}); return serial },
    clearTimer(id) { timers.delete(id) },
  })
  return {
    idle, timers, locks:() => locks,
    advance(ms, monoMs = ms) { wall += ms; mono += monoMs },
    tick() {
      const [id, timer] = timers.entries().next().value
      timers.delete(id); timer.callback()
    },
    send(type, trusted = true) {
      const event = new Event(type, {cancelable:true})
      Object.defineProperty(event, 'isTrusted', {value:trusted})
      return (type === 'visibilitychange' || type === 'resume' ? doc : win).dispatchEvent(event)
    },
  }
}

test('per-user activity renews the deadline while background events leave it intact', () => {
  const f = fixture()
  f.idle.configure(1,true)
  f.advance(50_000); f.send('keydown')
  f.advance(10_000); f.tick()
  assert.equal(f.timers.size,1)
  assert.equal([...f.timers.values()][0].delay,50_000)
  f.advance(49_900); f.send('visibilitychange'); f.send('focus'); f.send('input',false)
  f.idle.configure(1,true)
  f.advance(100); f.tick()
  assert.equal(f.locks(),1)
  f.send('focus'); f.send('keydown')
  assert.equal(f.locks(),1)
  assert.equal(f.timers.size,0)
})

test('sleep or a delayed timer locks before accepting further input', () => {
  const f = fixture()
  f.idle.configure(5,true)
  f.advance(360_000,0)
  assert.equal(f.send('keydown'),false)
  assert.equal(f.locks(),1)
  assert.equal(f.timers.size,0)
  f.idle.configure(0,false); f.idle.configure(5,true)
  f.advance(300_000,0); f.send('pageshow')
  assert.equal(f.locks(),2)
  f.idle.configure(0,false); f.idle.configure(1,true)
  f.advance(-500_000,60_000); f.send('visibilitychange')
  assert.equal(f.locks(),3)
})

test('session-only, public content, changing the policy and teardown cancel outdated timers', () => {
  const f = fixture()
  f.idle.configure(0,true); f.advance(100_000); f.send('focus')
  assert.equal(f.timers.size,0)
  f.idle.configure(5,false); assert.equal(f.timers.size,0)
  f.idle.configure(5,true); assert.equal(f.timers.size,1)
  f.idle.configure(1,true); assert.equal(f.timers.size,1)
  f.advance(50_000); f.idle.configure(0,true)
  f.advance(20_000); f.send('focus'); assert.equal(f.locks(),0)
  f.idle.configure(13,true)
  assert.equal([...f.timers.values()][0].delay,780_000)
  f.idle.destroy(); f.advance(999_000); f.send('pointermove')
  assert.equal(f.locks(),0)
  assert.equal(f.timers.size,0)
})

test('old libraries default to session-only and large timers use a supported scheduling delay', () => {
  for (const invalid of [undefined,null,-1,1.5,Infinity,'5',Number.MAX_SAFE_INTEGER]) {
    assert.equal(normalizeIdleMinutes(invalid),0)
  }
  const f = fixture()
  f.idle.configure(50_000,true)
  assert.equal([...f.timers.values()][0].delay,2_147_483_647)
  f.advance(2_147_483_647); f.tick()
  assert.equal(f.locks(),0)
  f.advance(50_000 * 60_000 - 2_147_483_647); f.tick()
  assert.equal(f.locks(),1)
})

test('a timed note keeps its deadline through typing, sleep and clock rollback', () => {
  for (const [wallDelta, monoDelta] of [[10_000,0],[-60_000,10_000]]) {
    const f = fixture()
    f.advance(40_000)
    f.idle.until(60_000)
    f.advance(10_000)
    assert.ok(f.send('keydown'))
    f.advance(wallDelta, monoDelta)
    assert.equal(f.send('keydown'), false)
    assert.equal(f.locks(), 1)
    assert.equal(f.timers.size, 0)
  }
})

test('opening after a note deadline locks immediately and closing early cancels its timer', () => {
  const f = fixture()
  f.advance(1_000)
  f.idle.until(900)
  assert.equal(f.locks(), 1)
  assert.equal(f.timers.size, 0)
  f.idle.until(2_000)
  f.idle.destroy()
  f.advance(2_000)
  f.send('resume')
  assert.equal(f.locks(), 1)
  assert.equal(f.timers.size, 0)
})
