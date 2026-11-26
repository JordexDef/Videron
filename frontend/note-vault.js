import { tr } from './i18n.js'
import { checkNote, hasCredentialBlock } from './data.js'
import { appearanceOf } from './icons/node-art.js'
import { openVaultPassword } from './vault-ui.js'
import { validMapGroupId } from './map-groups.js'

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
  if (Object.hasOwn(record, 'appearance')) result.appearance = appearanceOf(record)
  if (validMapGroupId(record.mapGroupId)) result.mapGroupId = record.mapGroupId
  return result
}

function noteWithMapFields(note, record) {
  const fields = mapFields(record)
  // An extension's private data in the original appearance object stays inside the envelope.
  if (fields.appearance) {
    const original = {...note.appearance}
    // These optional overrides disappear from the public style when reset on a locked note.
    delete original.radius
    delete original.badgeSize
    delete original.leftIcon
    delete original.rightIcon
    fields.appearance = {...original, ...fields.appearance}
  }
  const current = {...note, ...fields}
  // The note might have been ungrouped after its last encryption.
  if (validMapGroupId(note.mapGroupId) && !fields.mapGroupId) delete current.mapGroupId
  return current
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
  checkNote(note,{insideEnvelope:true})
  if (note.id !== record.id || isProtectedNote(note)) throw new Error('VD_INVALID')
  return noteWithMapFields(note, record)
}

// The open editor gets a separate object. Search, extensions, undo and every
// serialization path continue to see only the map placeholder and ciphertext.
export async function openNoteSession({record, bridge, dirty, persist, onPrivacyChange, onError, hasPlainHistory=false,
  spaceId, tryResume=false, onRemember=()=>{}, prompt = openVaultPassword}) {
  let note, hasKey = false, remembered = false, expiresAt = 0
  const id = record.id
  const allowRemember = !!(spaceId && bridge?.UnlockNoteFor && bridge.ResumeNote && bridge.CloseNoteEditor)
  async function releaseKey(keepAccess=false) {
    if (!hasKey) return
    if (keepAccess && remembered) await bridge.CloseNoteEditor(id)
    else {
      await bridge.LockNote(id)
      onRemember(id, null)
      remembered = false; expiresAt = 0
    }
    hasKey = false
  }
  async function acceptUnlock({plain,remembered:reuse=false,expiresAt:deadline=0}) {
    hasKey = true
    try { note = decodeNote(plain, record) }
    catch (error) { await releaseKey(); throw error }
    remembered = reuse
    expiresAt = deadline
    onRemember(id, reuse ? deadline : null)
  }
  if (isProtectedNote(record)) {
    if (!bridge) throw new Error('VD_UNAVAILABLE')
    if (allowRemember && tryResume) {
      try { await acceptUnlock(await bridge.ResumeNote(spaceId,id,record.sealed)) }
      catch (error) {
        onRemember(id,null)
        if (String(error?.message || error).split('|')[0] !== 'VD_LOCKED') throw error
      }
    }
    if (!note) {
      const opened = await prompt({mode:'unlock', scope:'note', allowRemember, onSubmit:async ({password,rememberMinutes=0}) => {
        const result = allowRemember ? await bridge.UnlockNoteFor(spaceId,id,record.sealed,password,rememberMinutes)
          : {plain:await bridge.UnlockNote(id,record.sealed,password)}
        await acceptUnlock(result)
      }})
      if (!opened) { await releaseKey(); return null }
    }
  } else note = {...record}

  let revision = 0, sealedRevision = 0, preparingSeal, pendingSeal, managing = false, closed = false
  function currentNote() {
    const current = noteWithMapFields(note, record)
    if (record.mapLabel) current.legacyMapLabel = record.mapLabel
    return current
  }

  function changed(patch) {
    if (closed) return
    if (!isProtectedNote(record) && hasCredentialBlock(patch.body)) throw new Error('VD_CREDENTIALS_REQUIRE_LOCK')
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
    if (!isProtectedNote(record) || (sealedRevision === revision && !record.mapLabel)) return Promise.resolve()
    pendingSeal = (async () => {
      while (isProtectedNote(record) && (sealedRevision !== revision || record.mapLabel)) {
        const saving = revision
        const legacyLabel = record.mapLabel
        const sealed = await bridge.SealNote(id, JSON.stringify(currentNote()))
        if (typeof sealed !== 'string' || !sealed) throw new Error('VD_INVALID')
        record.sealed = sealed
        if (legacyLabel && record.mapLabel === legacyLabel) {
          // Retain old aliases only as private compatibility data.
          note.legacyMapLabel = legacyLabel
          delete record.mapLabel
        }
        sealedRevision = saving
        dirty() // The ciphertext can finish after an earlier record snapshot was captured.
      }
    })().finally(() => { pendingSeal = null })
    return pendingSeal
  }

  function policyChanged() {
    dirty()
    return onPrivacyChange?.()
  }
  async function protect({password}) {
    // Include task status updates that arrived while this editor was open.
    Object.assign(note,record)
    preparingSeal = (async () => {
      if (pendingSeal) await pendingSeal
      const saving = revision
      const sealed = await bridge.ProtectNote(id, JSON.stringify(currentNote()), password)
      hasKey = true
      replaceRecord(record, lockedRecord(record, sealed))
      sealedRevision = saving
      await policyChanged()
    })().finally(() => { preparingSeal = null })
    await preparingSeal
    // A folder save can succeed before the catalog write reports an error.
    // Keep the envelope and key for subsequent edits, autosave and lock retries.
    await persist()
  }

  async function removeProtection({currentPassword}) {
    if (hasCredentialBlock(note.body)) throw new Error('VD_CREDENTIALS_REQUIRE_LOCK')
    await persist()
    await bridge.UnlockNote(id, record.sealed, currentPassword)
    const previous = record.sealed
    const publicLabel = record.mapLabel
    const hadMapAppearance = Object.hasOwn(record, 'appearance')
    const previousRevision = sealedRevision
    replaceRecord(record, currentNote())
    await policyChanged()
    try { await persist() }
    catch (error) {
      // An older note may have a private style that was never visible on its map.
      if (!hadMapAppearance) delete record.appearance
      replaceRecord(record, lockedRecord(record, previous))
      if (publicLabel) record.mapLabel = publicLabel
      sealedRevision = previousRevision
      await policyChanged()
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

  async function beforeClose(beforeRelease) {
    if (managing) return false
    if (closed) return true
    try {
      if (isProtectedNote(record)) {
        await flush()
        await persist()
      }
      await beforeRelease?.()
      await releaseKey(true)
      closed = true
      return true
    } catch (error) {
      if (!onError) throw error
      onError(error)
      return false
    }
  }
  return {note, changed, flush, manageProtection, beforeClose, get expiresAt() {return expiresAt}, get protected() { return isProtectedNote(record) }}
}
