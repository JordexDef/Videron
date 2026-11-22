import { tr } from './i18n.js'
import { checkNote } from './data.js'
import { openVaultPassword } from './vault-ui.js'

export function isProtectedNote(record) {
  return !!record && Object.hasOwn(record, 'sealed')
}

export function protectedNoteTitle() {
  return tr('Зашифрованная заметка', 'Encrypted note')
}

// Only these map fields belong outside the individual note's envelope.
// Start from an allowlist so new editor block types and extensions stay private.
function mapFields(record) {
  const result = {}
  for (const field of ['id', 'x', 'y', 'pinned', 'areaId', 'slot', 'links', 'opens', 'created', 'modified']) {
    if (Object.hasOwn(record, field)) result[field] = record[field]
  }
  return result
}

function lockedRecord(record, sealed) {
  if (typeof sealed !== 'string' || !sealed) throw new Error('VD_INVALID')
  return {...mapFields(record), title:'', body:[], tags:[], plain:'', weight:0, sealed}
}

function replaceRecord(record, next) {
  for (const field of Object.keys(record)) delete record[field]
  Object.assign(record, next)
}

function decodeNote(raw, record) {
  let note
  try { note = JSON.parse(raw) } catch { throw new Error('VD_INVALID') }
  checkNote(note)
  if (note.id !== record.id || isProtectedNote(note)) throw new Error('VD_INVALID')
  return {...note, ...mapFields(record)}
}

// The open editor gets a separate object. Search, extensions, undo and every
// serialization path continue to see only the map placeholder and ciphertext.
export async function openNoteSession({record, bridge, dirty, persist, onPrivacyChange, onError, hasPlainHistory=false, prompt = openVaultPassword}) {
  let note, hasKey = false
  const id = record.id
  async function releaseKey() {
    if (!hasKey) return
    await bridge.LockNote(id)
    hasKey = false
  }
  if (isProtectedNote(record)) {
    if (!bridge) throw new Error('VD_UNAVAILABLE')
    const opened = await prompt({mode:'unlock', scope:'note', onSubmit:async ({password}) => {
      const raw = await bridge.UnlockNote(id, record.sealed, password)
      hasKey = true
      try { note = decodeNote(raw, record) }
      catch (error) { await releaseKey(); throw error }
    }})
    if (!opened) {
      await releaseKey()
      return null
    }
  } else note = {...record}

  let revision = 0, sealedRevision = 0, preparingSeal, pendingSeal, managing = false, closed = false
  function currentNote() { return {...note, ...mapFields(record)} }

  function changed(patch) {
    if (closed) return
    const next = {...patch, modified:Date.now()}
    Object.assign(note, next)
    Object.assign(record, isProtectedNote(record) ? mapFields(next) : next)
    revision++
    dirty()
  }

  function flush() {
    // Autosave may run while the native password derivation is in flight.
    // Wait for the record and its public map references to switch together.
    if (preparingSeal) return preparingSeal.then(flush)
    if (pendingSeal) return pendingSeal
    if (!isProtectedNote(record) || sealedRevision === revision) return Promise.resolve()
    pendingSeal = (async () => {
      while (isProtectedNote(record) && sealedRevision !== revision) {
        const saving = revision
        const sealed = await bridge.SealNote(id, JSON.stringify(currentNote()))
        if (typeof sealed !== 'string' || !sealed) throw new Error('VD_INVALID')
        record.sealed = sealed
        sealedRevision = saving
        dirty() // The ciphertext can finish after an earlier record snapshot was captured.
      }
    })().finally(() => { pendingSeal = null })
    return pendingSeal
  }

  function policyChanged() {
    dirty()
    onPrivacyChange?.()
  }
  async function protect({password}) {
    preparingSeal = (async () => {
      if (pendingSeal) await pendingSeal
      const saving = revision
      const sealed = await bridge.ProtectNote(id, JSON.stringify(currentNote()), password)
      hasKey = true
      replaceRecord(record, lockedRecord(record, sealed))
      sealedRevision = saving
      policyChanged()
    })().finally(() => { preparingSeal = null })
    await preparingSeal
    // A folder save can succeed before the catalog write reports an error.
    // Keep the envelope and key for subsequent edits, autosave and lock retries.
    await persist()
  }

  async function removeProtection({currentPassword}) {
    await persist()
    await bridge.UnlockNote(id, record.sealed, currentPassword)
    const previous = record.sealed
    const previousRevision = sealedRevision
    replaceRecord(record, currentNote())
    policyChanged()
    try { await persist() }
    catch (error) {
      replaceRecord(record, lockedRecord(record, previous))
      sealedRevision = previousRevision
      policyChanged()
      throw error
    }
    await releaseKey()
  }

  async function manageProtection() {
    if (!bridge || closed || managing) return false
    managing = true
    try {
      const secured = isProtectedNote(record)
      return await prompt({mode:secured ? 'remove' : 'set', scope:'note',hasPlainHistory:!secured && hasPlainHistory,
        onSubmit:secured ? removeProtection : protect})
    } finally { managing = false }
  }

  async function beforeClose() {
    if (managing) return false
    if (closed) return true
    try {
      if (isProtectedNote(record)) {
        await flush()
        await persist()
      }
      await releaseKey()
      closed = true
      return true
    } catch (error) {
      if (!onError) throw error
      onError(error)
      return false
    }
  }
  return {note, changed, flush, manageProtection, beforeClose, get protected() { return isProtectedNote(record) }}
}
