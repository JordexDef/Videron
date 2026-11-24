import {tr} from './i18n.js'

// Keep paths as paths in the note. Only the desktop bridge opens a directory.
export function isFolderPath(path) {
  if (typeof path !== 'string' || /[\u0000-\u001f]/.test(path)) return false
  if (/^[\\/]{2}[?.][\\/]/.test(path)) return false
  if (/^[\\/]{2}/.test(path)) return /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path)
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('/')
}

export function folderLabel(path) {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  const leaf = parts.at(-1)
  return leaf && !/^[a-z]:$/i.test(leaf) ? leaf : path
}

export function canPickFolder() {
  return typeof window.go?.main?.App?.PickFolder === 'function'
}

export async function pickFolder() {
  if (!canPickFolder()) throw new Error('VD_FOLDER_DESKTOP')
  const path = await window.go.main.App.PickFolder(tr('Выберите папку', 'Choose a folder'))
  if (path && !isFolderPath(path)) throw new Error('VD_FOLDER_INVALID')
  return path || ''
}

export async function openFolder(path) {
  if (!isFolderPath(path)) throw new Error('VD_FOLDER_INVALID')
  if (!window.go?.main?.App?.OpenFolder) throw new Error('VD_FOLDER_DESKTOP')
  await window.go.main.App.OpenFolder(path)
}

export function folderError(error) {
  const code = String(error?.message || error).split('|')[0]
  switch (code) {
    case 'VD_FOLDER_INVALID': return tr('Укажите полный путь к папке.', 'Enter the full path to a folder.')
    case 'VD_FOLDER_MISSING': return tr('Папка не найдена. Возможно, её переименовали или переместили.', 'Folder not found. It may have been renamed or moved.')
    case 'VD_FOLDER_ACCESS': return tr('Нет доступа к папке.', 'Access to the folder was denied.')
    case 'VD_FOLDER_DESKTOP': return tr('Открыть папку можно в настольном приложении Videron.', 'Open this folder in the Videron desktop app.')
    default: return tr('Не удалось открыть папку.', 'Could not open the folder.')
  }
}
