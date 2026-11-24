import {parseLanguagePack, tr} from './i18n.js'

export const tagSpectrumId = 'videron.tag-spectrum'

const identifier = /^[a-z0-9][a-z0-9._-]{0,95}$/i
const supportedPermissions = new Set(['notes.read', 'notes.append', 'notes.create'])
const noteTypes = new Set(['text', 'canvas', 'data'])

export function supportsNoteCommand(action, note) {
  if (!note || action?.scope !== 'note') return false
  const type = note.type ?? 'text'
  return noteTypes.has(type) && (!action.noteTypes || action.noteTypes.includes(type))
}

function parseCommands(values) {
  if (!Array.isArray(values) || values.length > 32)
    throw Error(tr('В commands нужен список до 32 команд.', 'Use an array of up to 32 commands.'))
  const ids = new Set()
  return values.map(command => {
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        Object.keys(command).some(key => !['id', 'title', 'scope', 'noteTypes'].includes(key)) ||
        typeof command.id !== 'string' || !identifier.test(command.id) ||
        typeof command.title !== 'string' || !command.title.trim() || command.title.length > 120 ||
        /[\u0000-\u001f\u007f]/u.test(command.title) || !['note', 'workspace'].includes(command.scope))
      throw Error(tr('Проверьте идентификатор, название и scope команды (note или workspace).', 'Check each command’s ID, title and scope (note or workspace).'))
    const key = command.id.toLowerCase()
    if (ids.has(key)) throw Error(tr('Идентификаторы команд должны быть уникальными.', 'Command IDs must be unique within an extension.'))
    ids.add(key)
    const result = {id:command.id, title:command.title.trim(), scope:command.scope}
    if (Object.hasOwn(command, 'noteTypes')) {
      const types = command.noteTypes
      if (command.scope !== 'note' || !Array.isArray(types) || !types.length || types.length > noteTypes.size ||
          types.some(type => !noteTypes.has(type)) || new Set(types).size !== types.length)
        throw Error(tr('Для команды заметки укажите в noteTypes типы text, canvas или data без повторов.', 'For a note command, use distinct entries from text, canvas and data in noteTypes.'))
      result.noteTypes = [...types]
    }
    return result
  })
}

function parsePermissions(values) {
  if (!Array.isArray(values) || values.length > supportedPermissions.size ||
      values.some(value => !supportedPermissions.has(value)) || new Set(values).size !== values.length)
    throw Error(tr('Проверьте список разрешений расширения. Удалите повторы и неизвестные разрешения.', 'Check the extension permissions. Remove duplicates and unknown permissions.'))
  return [...values]
}

function parseView(value) {
  if (!value || value.apiVersion !== 1) throw Error(tr('Укажите apiVersion со значением 1.', 'Set apiVersion to 1.'))
  if (typeof value.id !== 'string' || !identifier.test(value.id)) {
    throw Error(tr('Идентификатор может содержать латинские буквы, цифры, точку, дефис и подчёркивание.', 'Use letters A–Z, digits, periods, hyphens or underscores in the extension ID.'))
  }
  if (typeof value.name !== 'string' || !value.name.trim() || typeof value.html !== 'string' || !value.html.trim()) {
    throw Error(tr('В манифесте нужны название name и содержимое html.', 'The manifest needs a name and HTML content in the html field.'))
  }
  if (value.description !== undefined && typeof value.description !== 'string') throw Error(tr('Поле description должно быть строкой.', 'The description field must be a string.'))
  const view = {apiVersion:1, id:value.id, name:value.name, description:value.description || '', html:value.html}
  if (Object.hasOwn(value, 'commands')) view.commands = parseCommands(value.commands)
  if (Object.hasOwn(value, 'permissions')) view.permissions = parsePermissions(value.permissions)
  return view
}

export function readExtensionManifests(values, installed = []) {
  const ids = new Set([tagSpectrumId, ...installed.map(plugin => plugin.id.toLowerCase())])
  const locales = new Set(installed.filter(plugin => plugin.type === 'language').map(pack => pack.locale))
  return values.map(value => {
    const extension = value?.type === 'language' ? parseLanguagePack(value) : parseView(value)
    const id = extension.id.toLowerCase()
    if (ids.has(id)) throw Error(tr('Расширение с таким идентификатором уже установлено.', 'An extension with this ID is already installed.'))
    if (extension.type === 'language') {
      if (locales.has(extension.locale)) throw Error(tr('Пакет для этого языка уже установлен.', 'A pack for this language is already installed.'))
      locales.add(extension.locale)
    }
    ids.add(id)
    return extension
  })
}
