const minute = 60_000
const maxTimerDelay = 2_147_483_647

export function normalizeIdleMinutes(value) {
  return Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value * minute) ? value : 0
}

// The wall clock catches suspend. The monotonic clock keeps elapsed time if
// the system clock is set back. Focus and visibility only check the deadline.
export function createIdleLock({
  onIdle, win = window, doc = document,
  wallNow = () => Date.now(), monoNow = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let delay = 0, active = false, armed = false, fixed = false, timer = null
  let lastWall = 0, lastMono = 0
  const listeners = new AbortController()
  const capture = {capture:true, signal:listeners.signal}

  function disarm() {
    armed = false
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  function remaining(wall, mono) {
    return delay - Math.max(0, wall - lastWall, mono - lastMono)
  }
  function expire() {
    disarm()
    onIdle()
  }
  function check() {
    if (armed && remaining(wallNow(), monoNow()) <= 0) expire()
  }
  function tick() {
    timer = null
    if (!armed) return
    const left = remaining(wallNow(), monoNow())
    if (left <= 0) expire()
    else timer = setTimer(tick, Math.min(maxTimerDelay, left))
  }
  function input(event) {
    if (!armed || !event.isTrusted) return
    const wall = wallNow(), mono = monoNow()
    // A throttled timer may still be pending on the first click after resume.
    if (remaining(wall, mono) <= 0) {
      if (event.cancelable) event.preventDefault()
      event.stopImmediatePropagation()
      expire()
      return
    }
    if (!fixed) { lastWall = wall; lastMono = mono }
    // Reuse the pending timer, even during high-frequency pointer movement.
  }
  for (const type of ['pointerdown','pointermove','pointerup','keydown','wheel','input','click']) {
    win.addEventListener(type, input, {...capture, passive:false})
  }
  for (const type of ['focus','pageshow']) win.addEventListener(type, check, capture)
  for (const type of ['visibilitychange','resume']) doc.addEventListener(type, check, capture)

  function arm(next, enabled, absolute, wall = wallNow()) {
    disarm()
    delay = next
    active = !!enabled
    fixed = absolute
    if (!active) return
    lastWall = wall
    lastMono = monoNow()
    armed = true
    if (delay <= 0) expire()
    else timer = setTimer(tick, Math.min(maxTimerDelay, delay))
  }
  function configure(minutes, enabled) {
    const next = normalizeIdleMinutes(minutes) * minute
    enabled = !!enabled && next > 0
    if (!fixed && next === delay && enabled === active) return
    arm(next, enabled, false)
  }
  function until(timestamp) {
    const wall = wallNow()
    arm(timestamp - wall, true, true, wall)
  }
  function destroy() {
    disarm()
    listeners.abort()
  }
  return {configure, until, destroy}
}
