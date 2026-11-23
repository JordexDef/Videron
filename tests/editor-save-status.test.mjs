import test from 'node:test'
import assert from 'node:assert/strict'
import {createEditorSaveStatus} from '../frontend/workspace-status.js'

test('editor save feedback follows acknowledged writes and keeps ordinary autosaves quiet', t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const previousDocument = globalThis.document
  globalThis.document = {createElement:() => ({
    dataset:{}, children:[], glyphUpdates:0, announcements:[],
    append(...children) { this.children.push(...children) },
    setAttribute(name, value) { this[name] = value },
    set innerHTML(markup) { this.glyphUpdates++ },
    set textContent(value) { this.announcements.push(value) },
  })}
  t.after(() => {
    if (previousDocument) globalThis.document = previousDocument
    else delete globalThis.document
  })
  const feedback = createEditorSaveStatus(), [badge] = feedback.element.children
  const [glyph, caption] = badge.children
  assert.equal(badge.role, 'status')
  feedback.saved()
  assert.equal(badge.dataset.state, undefined)

  feedback.edited(); feedback.writing(); feedback.saved()
  t.mock.timers.tick(1000)
  assert.equal(badge.dataset.state, 'saved')
  feedback.edited(); feedback.writing(); feedback.saved()
  assert.equal(glyph.glyphUpdates, 1)
  assert.equal(caption.announcements.length, 1)

  feedback.edited(); feedback.writing()
  t.mock.timers.tick(300)
  assert.equal(badge.dataset.state, 'saved')
  feedback.edited(); feedback.writing()
  t.mock.timers.tick(400)
  assert.equal(badge.dataset.state, 'writing')
  feedback.failed(); feedback.edited(); feedback.writing()
  t.mock.timers.tick(1000)
  assert.equal(badge.dataset.state, 'failed')
  feedback.saved()
  assert.equal(badge.dataset.state, 'saved')

  feedback.edited(); feedback.writing(); feedback.close()
  t.mock.timers.tick(1000)
  assert.equal(badge.dataset.state, 'saved')
})
