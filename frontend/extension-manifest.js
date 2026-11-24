import {parseLanguagePack, tr} from './i18n.js'

export const tagSpectrumId = 'videron.tag-spectrum'

function parseView(value) {
  if (!value || value.apiVersion !== 1) throw Error(tr('Укажите apiVersion со значением 1.', 'Set apiVersion to 1.'))
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(value.id)) {
    throw Error(tr('Идентификатор может содержать латинские буквы, цифры, точку, дефис и подчёркивание.', 'Use letters A–Z, digits, periods, hyphens or underscores in the extension ID.'))
  }
  if (typeof value.name !== 'string' || !value.name.trim() || typeof value.html !== 'string' || !value.html.trim()) {
    throw Error(tr('В манифесте нужны название name и содержимое html.', 'The manifest needs a name and HTML content in the html field.'))
  }
  if (value.description !== undefined && typeof value.description !== 'string') throw Error(tr('Поле description должно быть строкой.', 'The description field must be a string.'))
  return {apiVersion:1, id:value.id, name:value.name, description:value.description || '', html:value.html}
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
