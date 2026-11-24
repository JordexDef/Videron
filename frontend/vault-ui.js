import {icon} from './art.js'
import {tr} from './i18n.js'
import {normalizeIdleMinutes} from './idle-lock.js'
import {isLightTheme,setTheme} from './theme.js'

const openDialogs = new Set()

// A lock cannot abandon a password change or unlock already submitted to Go.
// Scrub all fields now, then let the caller wait for those operations to settle.
export async function interruptVaultDialogs() {
  await Promise.all([...openDialogs].map(interrupt => interrupt()))
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label, kind, action) {
  const node = el('button', 'button ' + kind, label)
  node.type = 'button'
  node.onclick = action
  return node
}

function vaultError(error) {
  const [code] = String(error?.message || error).split('|')
  switch (code) {
    case 'VD_PASSWORD': return tr('Проверьте пароль. Если он верен, зашифрованные данные могли быть повреждены.', 'Check the password. If it is correct, the encrypted data may be damaged.')
    case 'VD_WEAK_PASSWORD': return tr('Используйте пароль длиной от 8 символов.', 'Use a password with at least 8 characters.')
    case 'VD_CORRUPT': return tr('Данные повреждены. Попробуйте открыть резервную копию проекта.', 'The data is damaged. Try opening a project backup.')
    case 'VD_VERSION': return tr('Для открытия файла нужна более новая версия Videron.', 'This file requires a newer version of Videron.')
    case 'VD_LOCKED':
    case 'VD_NOT_LOADED': return tr('Сначала разблокируйте проект или заметку.', 'Unlock the project or note first.')
    case 'VD_WRITE': return tr('Ошибка записи. Проверьте доступ к файлу и свободное место.', 'Could not save the file. Check write access and free disk space.')
    case 'VD_READ': return tr('Ошибка чтения файла. Проверьте доступ к проекту.', 'Could not read the file. Check access to the project.')
    case 'VD_CHANGED': return tr('Файл проекта изменился на диске. Закройте и откройте проект снова.', 'The project file changed on disk. Close and reopen the project.')
    case 'VD_INVALID': return tr('Не удалось прочитать данные Videron.', 'Could not read the Videron data.')
    default: return tr('Не удалось выполнить действие. Попробуйте ещё раз.', 'The operation failed. Please try again.')
  }
}

// Native modal dialogs keep the map and editors inert, including their keyboard controls.
function dialog(startup = false) {
  const node = el('dialog', startup ? 'vault-dialog vault-startup' : 'vault-dialog')
  const panel = el('div', 'vault-panel')
  node.append(panel)
  let cancel = null, busy = false, interrupted = false, resolve
  const done = new Promise(r => { resolve = r })
  function clearFields() {
    for (const field of panel.querySelectorAll('input')) field.value = ''
  }
  function close(ok = false) {
    clearFields()
    openDialogs.delete(interrupt)
    node.close()
    node.remove()
    resolve(ok)
  }
  function content(title, onCancel) {
    clearFields()
    cancel = onCancel
    panel.replaceChildren()
    node.setAttribute('aria-label', title)
    if (startup) {
      const brand = el('div', 'vault-brand')
      const logo = el('img')
      logo.src = 'icon.svg'
      logo.alt = ''
      brand.append(logo, 'Videron')
      panel.append(brand)
    }
    const head = el('div', 'vault-heading')
    head.append(el('h2', '', title))
    if (onCancel) {
      const closeButton = el('button', 'icon-button')
      closeButton.type = 'button'
      closeButton.setAttribute('aria-label', tr('Закрыть', 'Close'))
      closeButton.innerHTML = icon('x')
      closeButton.onclick = () => { if (!busy) cancel() }
      head.append(closeButton)
    }
    panel.append(head)
  }
  function setBusy(value) {
    busy = value
    node.setAttribute('aria-busy', String(value))
    for (const control of panel.querySelectorAll('button,input,select')) control.disabled = value
  }
  function settled(ok) {
    if (interrupted) { close(ok); return false }
    setBusy(false)
    return true
  }
  function interrupt() {
    interrupted = true
    clearFields()
    node.inert = true
    if (!busy) close()
    return done
  }
  node.addEventListener('cancel', event => {
    event.preventDefault()
    if (!busy) cancel?.()
  })
  document.body.append(node)
  node.showModal()
  openDialogs.add(interrupt)
  return {node, panel, content, close, done, setBusy, settled, interrupt}
}

function actionTitle(mode, note) {
  switch (mode) {
    case 'set': return note ? tr('Зашифровать заметку', 'Encrypt note') : tr('Зашифровать библиотеку', 'Encrypt library')
    case 'change': return note ? tr('Сменить пароль заметки', 'Change note password') : tr('Сменить пароль библиотеки', 'Change library password')
    case 'remove': return note ? tr('Снять пароль заметки', 'Remove note password') : tr('Снять пароль библиотеки', 'Remove library password')
    default: return note ? tr('Разблокировать заметку', 'Unlock note') : tr('Разблокировать библиотеку', 'Unlock library')
  }
}

function passwordForm(view, {mode, scope, onSubmit, onSuccess, onCancel, hasPlainHistory=false}) {
  const note = scope === 'note'
  const setting = mode === 'set' || mode === 'change'
  const space=scope==='space'
  const title=space ? (setting ? tr('Зашифровать пространство','Encrypt space') : tr('Разблокировать пространство','Unlock space')) : actionTitle(mode,note)
  view.content(title, onCancel)
  const form = el('form', 'vault-form')
  form.autocomplete = 'off'
  form.noValidate = true
  const help = setting
    ? tr('Выберите парольную фразу длиной от 8 символов и сохраните её в надёжном месте. Для расшифровки потребуется этот пароль.', 'Choose a passphrase of at least 8 characters and keep it in a safe place. You will need it to decrypt your data.')
    : mode === 'remove'
      ? note ? tr('Заметка будет сохраняться без отдельного пароля.', 'This note will be saved without its own password.')
             : tr('Локальная библиотека будет сохраняться в открытом виде. Заметки с отдельным паролем останутся зашифрованными.', 'The local library will be saved in plaintext. Notes with their own password will stay encrypted.')
      : space ? tr('Введите пароль пространства, чтобы открыть карту и заметки.', 'Enter the space password to open its map and notes.')
      : note ? tr('Введите пароль этой заметки.', 'Enter the password for this note.')
             : tr('Введите пароль, чтобы открыть заметки и карту.', 'Enter your password to open your notes and map.')
  form.append(el('p', 'vault-hint', help))
  if(hasPlainHistory)form.append(el('p','vault-hint',tr('Прежние версии останутся читаемыми в истории папки и её резервных копиях. При синхронизации они попадут на сервер и другие устройства в том же виде.','Earlier versions remain readable in this folder’s history and its backups. Sync also copies those versions to the server and other devices in readable form.')))
  function field(label) {
    const wrap = el('label', 'vault-field')
    const input = el('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.required = true
    wrap.append(el('span', '', label), input)
    form.append(wrap)
    return input
  }
  const current = mode === 'change' || mode === 'remove' ? field(tr('Текущий пароль', 'Current password')) : null
  const password = mode !== 'remove' ? field(setting ? tr('Новый пароль', 'New password') : tr('Пароль', 'Password')) : null
  const confirm = setting ? field(tr('Повторите новый пароль', 'Confirm new password')) : null
  const errorText = el('div', 'vault-error')
  errorText.setAttribute('role', 'alert')
  const actions = el('div', 'vault-actions')
  if (onCancel) actions.append(button(tr('Отмена', 'Cancel'), 'secondary', onCancel))
  const labels = {
    set: tr('Зашифровать', 'Encrypt'),
    unlock: tr('Разблокировать', 'Unlock'),
    change: tr('Сменить пароль', 'Change password'),
    remove: tr('Снять пароль', 'Remove password'),
  }
  const submit = el('button', 'button primary', labels[mode])
  submit.type = 'submit'
  actions.append(submit)
  form.append(errorText, actions)
  view.panel.append(form)
  const first = current || password
  first.focus()
  let pending = false
  function invalid(input, message) {
    errorText.textContent = message
    input.setAttribute('aria-invalid', 'true')
    input.focus()
    input.select()
  }
  form.oninput = () => {
    errorText.textContent = ''
    for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid')
  }
  form.onsubmit = async event => {
    event.preventDefault()
    if (pending) return
    for (const input of [current, password, confirm]) {
      if (input && !input.value) return invalid(input, tr('Введите пароль в это поле.', 'Enter a password in this field.'))
    }
    if (setting && Array.from(password.value).length < 8) return invalid(password, vaultError('VD_WEAK_PASSWORD'))
    if (confirm && confirm.value !== password.value) return invalid(confirm, tr('Пароли различаются. Повторите новый пароль.', 'Passwords differ. Enter the new password again.'))
    pending = true
    view.setBusy(true)
    const label = submit.textContent
    submit.classList.add('is-busy')
    submit.textContent = {
      set: tr('Шифруем…', 'Encrypting…'),
      unlock: tr('Разблокируем…', 'Unlocking…'),
      change: tr('Меняем пароль…', 'Changing password…'),
      remove: tr('Снимаем пароль…', 'Removing password…')
    }[mode]
    try {
      await onSubmit({password:password?.value, currentPassword:current?.value})
    } catch (error) {
      pending = false
      if (!view.settled(false)) return
      submit.classList.remove('is-busy')
      submit.textContent = label
      const message = vaultError(error)
      if (String(error?.message || error).split('|')[0] === 'VD_PASSWORD') {
        first.value = ''
        invalid(first, message)
      } else {
        errorText.textContent = message
        first.focus()
      }
      return
    }
    if (view.settled(true)) onSuccess()
  }
}

export function openVaultPassword({mode, scope = 'note', onSubmit, signal, hasPlainHistory=false}) {
  if (signal?.aborted) return Promise.resolve(false)
  const view = dialog()
  passwordForm(view, {mode, scope, onSubmit, hasPlainHistory, onSuccess:() => view.close(true), onCancel:() => view.close()})
  if (!signal) return view.done
  signal.addEventListener('abort',view.interrupt,{once:true})
  return view.done.finally(()=>signal.removeEventListener('abort',view.interrupt))
}

export function showVaultUnlock({onUnlock}) {
  const view = dialog(true)
  passwordForm(view, {mode:'unlock', scope:'project', onSubmit:({password}) => onUnlock(password), onSuccess:() => view.close(true)})
  return view.done
}

function idleSettings(view, initialMinutes, commit) {
  const presets = [1, 5, 15, 30, 60]
  const section = el('section', 'vault-settings-section')
  const label = el('label', 'vault-field')
  label.append(el('span', '', tr('После бездействия в Videron', 'After inactivity in Videron')))
  const select = el('select')
  select.id = 'auto-lock-delay'
  select.add(new Option(tr('Только при новой сессии', 'Only in a new session'), '0'))
  for (const minutes of presets) select.add(new Option(tr(minutes + ' мин', minutes + ' min'), String(minutes)))
  select.add(new Option(tr('Другой интервал…', 'Custom interval…'), 'custom'))
  label.append(select)
  section.append(el('h3', '', tr('Автоблокировка', 'Auto-lock')),label)
  const custom = el('form', 'vault-custom-delay'), field = el('label', 'vault-field')
  const input = el('input')
  input.type = 'number'; input.min = '1'; input.step = '1'; input.required = true
  field.append(el('span', '', tr('Минуты', 'Minutes')), input)
  const apply = el('button', 'button secondary', tr('Применить', 'Apply'))
  apply.type = 'submit'
  custom.append(field, apply)
  section.append(custom)
  if (/Windows|Win32|Win64/i.test(navigator.userAgentData?.platform || navigator.platform)) {
    section.append(el('p', 'vault-hint', tr('При блокировке Windows также блокируются зашифрованная библиотека, все разблокированные пространства и открытая заметка с паролем.', 'Locking Windows also locks the encrypted library, all unlocked spaces, and any open password-protected note.')))
  }
  const errorText = el('div', 'vault-error')
  errorText.setAttribute('role', 'alert')
  section.append(errorText)
  let saved = normalizeIdleMinutes(initialMinutes)
  function showValue() {
    select.value = saved && !presets.includes(saved) ? 'custom' : String(saved)
    custom.hidden = select.value !== 'custom'
    input.value = String(saved || 10)
  }
  async function save(minutes) {
    errorText.textContent = ''
    if (saved === minutes) { showValue(); select.focus(); return }
    view.setBusy(true)
    try {
      await commit(minutes)
      saved = minutes
    } catch (error) {
      if (!view.settled(false)) return
      showValue(); errorText.textContent = vaultError(error); select.focus()
      return
    }
    if (view.settled(true)) { showValue(); select.focus() }
  }
  select.onchange = () => {
    errorText.textContent = ''
    if (select.value === 'custom') {
      custom.hidden = false; input.focus(); input.select()
    } else {
      custom.hidden = true
      save(Number(select.value))
    }
  }
  custom.onsubmit = event => {
    event.preventDefault()
    const minutes = normalizeIdleMinutes(input.valueAsNumber)
    if (minutes) save(minutes)
    else {
      errorText.textContent = tr('Введите целое число минут больше нуля.', 'Enter a positive whole number of minutes.')
      input.focus()
    }
  }
  showValue()
  return section
}

function themeSettings() {
  const group = el('fieldset', 'theme-settings')
  group.append(el('legend', '', tr('Тема оформления', 'Theme')))
  const choices = el('div', 'theme-options')
  for (const [value, name] of [['dark', tr('Тёмная', 'Dark')], ['light', tr('Светлая', 'Light')]]) {
    const label = el('label', 'theme-option')
    const input = el('input')
    input.type = 'radio'; input.name = 'app-theme'; input.value = value
    input.checked = value === (isLightTheme() ? 'light' : 'dark')
    input.onchange = () => { if (input.checked) setTheme(value) }
    const swatch = el('span', 'theme-sample ' + value)
    swatch.setAttribute('aria-hidden', 'true')
    label.append(swatch, name, input)
    choices.append(label)
  }
  group.append(choices)
  return group
}

export function openVaultSettings({protected:encrypted = false, available = true, canLock = false, onEnable, onChange, onDisable, onLock, idleMinutes = 0, onIdleMinutesChange}) {
  const view = dialog()
  function edit(mode) {
    const callbacks = {
      set: ({password}) => onEnable(password),
      change: ({currentPassword, password}) => onChange(currentPassword, password),
      remove: ({currentPassword}) => onDisable(currentPassword),
    }
    passwordForm(view, {
      mode, scope:'project', onSubmit:callbacks[mode], onCancel:show,
      onSuccess:() => { encrypted = mode !== 'remove'; show() },
    })
  }
  function show() {
    view.content(tr('Настройки', 'Settings'), () => view.close())
    view.panel.append(themeSettings())
    const section = el('section', 'vault-settings-section')
    section.append(el('h3', '', tr('Шифрование библиотеки', 'Library encryption')))
    view.panel.append(section)
    const description = !available
      ? tr('Шифрование доступно в настольном приложении Videron.', 'Encryption is available in the Videron desktop app.')
      : tr('Этот пароль защищает пространства в локальной библиотеке. Для пространства в отдельной папке можно задать свой пароль при создании.', 'This password protects spaces in your local library. For a space in its own folder, you can set a separate password when creating it.')
    section.append(el('p', 'vault-hint', description))
    const actions = el('div', 'vault-settings-actions')
    if (available && (encrypted || canLock) && onLock) {
        const lock = button(tr('Заблокировать сейчас', 'Lock now'), 'primary', () => {
          view.close(true)
          onLock()
        })
        actions.append(lock)
    }
    if (available && encrypted) {
      actions.append(button(tr('Сменить пароль', 'Change password'), 'secondary', () => edit('change')),
        button(tr('Снять пароль', 'Remove password'), 'secondary', () => edit('remove')))
    } else if (available) {
      actions.append(button(tr('Задать пароль', 'Set password'), 'primary', () => edit('set')))
    }
    section.append(actions)
    if (available && onIdleMinutesChange) {
      view.panel.append(idleSettings(view, idleMinutes, async minutes => {
        await onIdleMinutesChange(minutes)
        idleMinutes = minutes
      }))
    }
    view.panel.querySelector('.theme-option input:checked').focus()
  }
  show()
  return view.done
}
