import { icon } from './art.js'
import { getLanguage, tr } from './i18n.js'

function storageLabel({folder, encrypted}) {
  if (!folder) return tr('Локальное хранилище', 'Local storage')
  return encrypted ? tr('Папка с шифрованием', 'Encrypted folder') : tr('Хранилище в папке', 'Folder storage')
}

function connectionLabel(state) {
  const labels = {
    local: tr('Сервер не подключён', 'No server connected'),
    checking: tr('Проверка подключения…', 'Checking connection…'),
    connecting: tr('Подключение…', 'Connecting…'),
    paused: tr('Синхронизация на паузе', 'Sync paused'),
    online: tr('Сервер подключён', 'Server connected'),
    syncing: tr('Синхронизация…', 'Syncing…'),
    offline: tr('Сервер недоступен', 'Server unreachable'),
    error: tr('Ошибка синхронизации', 'Sync error'),
  }
  return labels[state] || labels.local
}

function lastSyncLabel(value) {
  const time = new Date(value)
  if (!value || !(time.getTime() > 0)) return tr('Нет данных', 'No sync recorded')
  return new Intl.DateTimeFormat(getLanguage(), {dateStyle: 'short', timeStyle: 'medium'}).format(time)
}

function shortAddress(address) {
  if (!address) return ''
  try {
    return new URL(address.includes('://') ? address : 'https://' + address).host || address
  } catch {
    return address
  }
}

// Keep the last acknowledgement visible during ordinary typing. Only a slow
// write or failure changes the glyph or triggers another live announcement.
export function createEditorSaveStatus() {
  const element = document.createElement('span'), badge = document.createElement('span')
  const glyph = document.createElement('i'), caption = document.createElement('span')
  element.className = 've-spacer ve-save-status'
  badge.setAttribute('role', 'status')
  glyph.setAttribute('aria-hidden', 'true')
  badge.append(glyph, caption)
  element.append(badge)
  const clock = new Intl.DateTimeFormat(getLanguage(), {hour: 'numeric', minute: '2-digit'})
  let edited = false, slowTimer

  function show(state, mark, label) {
    if (badge.dataset.state === state) return
    badge.dataset.state = state
    badge.title = label
    glyph.innerHTML = icon(mark)
    caption.textContent = label
  }

  return {
    element,
    edited() { edited = true },
    writing() {
      if (!edited || slowTimer || badge.dataset.state === 'failed') return
      slowTimer = setTimeout(() => show('writing', 'more', tr('Сохранение…', 'Saving…')), 650)
    },
    saved() {
      clearTimeout(slowTimer); slowTimer = null
      if (!edited && badge.dataset.state !== 'failed') return
      edited = false
      show('saved', 'check', tr('Сохранено на устройстве', 'Saved on this device'))
      const lastSave = tr('Последнее сохранение на устройстве в ', 'Last saved on this device at ') + clock.format(new Date())
      if (badge.title !== lastSave) badge.title = lastSave
    },
    failed() {
      clearTimeout(slowTimer); slowTimer = null
      show('failed', 'x', tr('Не сохранено', 'Save failed'))
    },
    close() { clearTimeout(slowTimer) }
  }
}

export function mountWorkspaceStatus({onManage, onRetry, onRetrySave}) {
  const get = id => document.getElementById(id)
  const toggle = get('workspace-status-toggle'), panel = get('workspace-status-details')
  const glyph = get('workspace-status-icon'), host = get('workspace-status-host'), status = get('status')
  const closeButton = get('workspace-status-close'), facts = get('workspace-status-facts'), error = get('workspace-status-error')
  const manage = get('workspace-status-manage'), retry = get('workspace-status-retry'), retrySave = get('workspace-status-save')
  let current = {}

  function renderDetails() {
    const {state = 'local', folder, encrypted, spaceName, address, transport, lastSync, storageState} = current
    const rows = []
    function fact(label, value) {
      if (!value) return
      const term = document.createElement('dt'), description = document.createElement('dd')
      term.textContent = label
      description.textContent = value
      rows.push(term, description)
    }
    fact(tr('Состояние', 'Status'), connectionLabel(state))
    if(current.serverProjectDeleted)fact(tr('Проект на сервере','Server project'),tr('Удалён. На этом компьютере доступна рабочая копия.','Deleted. The working copy is available on this computer.'))
    if (address) {
      fact(tr('Адрес сервера', 'Server address'), address)
      if (transport === 'direct') fact(tr('Тип подключения', 'Connection type'), tr('Прямое соединение', 'Direct connection'))
      if (transport === 'cloudflare') fact(tr('Тип подключения', 'Connection type'), 'Cloudflare Tunnel')
      fact(tr('Последняя синхронизация', 'Last sync'), lastSyncLabel(lastSync))
    }
    fact(tr('Пространство', 'Space'), spaceName)
    if (folder) fact(encrypted ? tr('Папка с шифрованием', 'Encrypted folder') : tr('Папка', 'Folder'), folder)
    else fact(tr('Хранилище', 'Storage'), tr('Локальная библиотека', 'Local library'))
    facts.replaceChildren(...rows)
    const issues = []
    if (storageState === 'failed') issues.push(tr('Не удалось сохранить изменения.', 'Could not save your changes.'))
    if (storageState === 'unavailable') issues.push(tr('Хранилище недоступно.', 'Storage unavailable.'))
    if (current.error) issues.push(current.error)
    error.textContent = issues.join(' ')
    error.hidden = !issues.length

    const focused = document.activeElement
    retrySave.hidden = storageState !== 'failed'
    retry.hidden = state !== 'offline' && state !== 'error' && state !== 'paused'
    retry.textContent = state === 'paused' ? tr('Подключиться', 'Connect') : tr('Повторить подключение', 'Retry connection')
    manage.hidden = !current.canManage
    manage.disabled = state === 'checking'
    manage.textContent = address ? tr('Настройки сервера', 'Server settings') : tr('Подключить сервер', 'Connect a server')
    if ((focused === retrySave || focused === retry || focused === manage) && (focused.hidden || focused.disabled)) {
      closeButton.focus({preventScroll: true})
    }
  }

  function position() {
    if (!panel.open) return
    const box = toggle.getBoundingClientRect()
    const left = Math.max(8, Math.min(box.left, window.innerWidth - panel.offsetWidth - 8))
    panel.style.left = left + 'px'
    panel.style.setProperty('--status-bottom', Math.max(8, window.innerHeight - box.top + 5) + 'px')
  }

  function close() {
    if (!panel.open) return
    panel.close()
    toggle.setAttribute('aria-expanded', 'false')
  }

  function outside(event) {
    if (panel.open && !panel.contains(event.target) && !toggle.contains(event.target)) close()
  }
  toggle.addEventListener('click', () => {
    if (panel.open) { close(); return }
    renderDetails()
    toggle.setAttribute('aria-expanded', 'true')
    panel.show()
    position()
  })
  closeButton.addEventListener('click', close)
  document.addEventListener('keydown', event => {
    if (!panel.open || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
    toggle.focus({preventScroll: true})
  }, true)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('focusin', outside)
  window.addEventListener('resize', () => {
    if (panel.open && getComputedStyle(toggle).visibility === 'hidden') close()
    else position()
  })
  retrySave.addEventListener('click', () => onRetrySave())
  retry.addEventListener('click', () => onRetry())
  manage.addEventListener('click', () => { close(); onManage() })

  function update(model) {
    current = model
    const {state = 'local', storageState, folder, encrypted, address} = model
    const busy = ['checking', 'connecting', 'syncing'].includes(state)
    const storageProblem = storageState === 'failed' || storageState === 'unavailable'
    let label = state === 'local' ? storageLabel(model) : connectionLabel(state)
    let mark = state === 'local' ? (encrypted ? 'lock' : folder ? 'folder' : 'layers') : 'link'
    if (busy) mark = 'busy'
    if (state === 'offline') mark = 'globe'
    if (state === 'error') mark = 'x'
    if (storageProblem) {
      label = storageState === 'failed' ? tr('Ошибка сохранения', 'Save failed') : tr('Хранилище недоступно', 'Storage unavailable')
      mark = 'x'
    }
    if (glyph.dataset.mark !== mark) {
      glyph.dataset.mark = mark
      glyph.innerHTML = mark === 'busy' ? '' : icon(mark)
    }
    host.textContent = shortAddress(address)
    host.hidden = !address
    status.toggleAttribute('data-connected', !!address && !storageProblem && (state === 'online' || state === 'syncing'))
    status.textContent = label
    toggle.title = tr('Сведения о подключении', 'Connection details')
    if (panel.open) { renderDetails(); position() }
  }

  update({})
  return {update, close}
}
