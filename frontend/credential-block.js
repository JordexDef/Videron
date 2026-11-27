import { icon } from './art.js'
import { tr } from './i18n.js'
import { historyDirection } from './shortcuts.js'
import { attachVerticalReorder, moveListItem } from './vertical-reorder.js'

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function action(label, symbol, run, withText = false) {
  const button = element('button', 've-credential-action')
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  if (symbol) button.innerHTML = icon(symbol)
  if (withText) button.append(document.createTextNode(label))
  button.onclick = run
  return button
}

const grip = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/></svg>'

function reorderButton(label, className) {
  const button = action(label, null, null)
  button.classList.add('ve-credential-grip', className)
  button.innerHTML = grip
  return button
}

export function createCredentialBlock({block, onChange, onRemove, moveBlock}) {
  let entries = Array.isArray(block.entries) ? block.entries : []
  const row = element('section', 've-credentials')
  row.tabIndex = -1
  const heading = tr('Учётные данные', 'Credentials')
  row.setAttribute('aria-label', heading)
  const tools = element('div', 've-credential-tools')
  const bar = element('header', 've-credential-bar')
  const title = element('strong', 've-credential-title')
  title.innerHTML = icon('lock')
  title.append(document.createTextNode(heading))
  const searchLabel = tr('Найти ресурс или логин', 'Find a resource or login')
  const searchWrap = element('label', 've-credential-search')
  searchWrap.innerHTML = icon('search')
  const search = element('input')
  search.type = 'search'
  search.placeholder = searchLabel
  search.setAttribute('aria-label', searchLabel)
  search.autocomplete = 'off'
  search.spellcheck = false
  searchWrap.append(search)
  const fields = element('div', 've-credential-entries')
  const empty = element('p', 've-credential-empty')
  const status = element('span', 've-credential-status')
  status.setAttribute('role', 'status')
  const add = action(tr('Добавить запись', 'Add entry'), 'plus', () => {
    search.value = ''
    update([...entries,{resource:'',login:'',password:''}])
    renderEntries()
    fields.lastElementChild.querySelector('input').focus()
  }, true)
  if (moveBlock) {
    const handle = reorderButton(tr('Переместить блок учётных данных', 'Move credentials block'), 've-credential-block-grip')
    bar.append(handle)
    moveBlock(handle, row)
  }
  bar.append(title,searchWrap,add,action(tr('Удалить блок учётных данных', 'Remove credentials block'), 'trash', onRemove))
  tools.append(bar)
  row.append(tools,fields,empty,status)

  function update(next, group) {
    entries = next
    onChange({...block,entries},group)
    status.textContent = ''
  }
  function filter() {
    const query = search.value.trim().toLowerCase()
    row.classList.toggle('ve-credential-empty-block', !entries.length)
    let matches = 0
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const visible = !query || [entry.resource,entry.login].some(value =>
        typeof value === 'string' && value.toLowerCase().includes(query))
      fields.children[i].hidden = !visible
      fields.children[i].querySelector('.ve-credential-entry-grip').disabled = entries.length < 2 || !!query
      if (visible) matches++
    }
    empty.hidden = matches > 0
    empty.textContent = !entries.length ? tr('Пока нет записей', 'No entries yet') : tr('Записи не найдены', 'No matching entries')
  }
  search.oninput = filter
  search.onkeydown = event => {
    if (historyDirection(event)) event.stopPropagation()
    if (event.key === 'Escape' && search.value) {
      event.preventDefault()
      event.stopPropagation()
      search.value = ''
      filter()
    }
  }

  // Float the tools outside the entries so hovering a copy button keeps it under the pointer.
  function placeTools() {
    const bounds = row.getBoundingClientRect()
    const scroll = row.closest('.ve-scroll')?.getBoundingClientRect()
    const prepend = row === row.parentElement?.firstElementChild &&
      row.closest('.ve-main')?.querySelector(':scope > .ve-add-text-above:not([hidden])')
    const top = Math.max(0, scroll?.top ?? 0, prepend ? prepend.getBoundingClientRect().bottom : 0)
    const previous = row.previousElementSibling?.getBoundingClientRect().bottom ?? top
    const bottom = Math.min(window.innerHeight, scroll?.bottom ?? window.innerHeight)
    const height = bar.offsetHeight
    row.style.setProperty('--ve-credential-tools-inset', (height + top - (scroll?.top ?? 0)) + 'px')
    row.dataset.toolsEdge = bounds.top - Math.max(top, previous) < height && bottom - bounds.bottom >= height ? 'below' : 'above'
  }
  row.addEventListener('pointerenter', placeTools)
  row.addEventListener('focusin', placeTools)
  row.addEventListener('pointerdown', () => row.classList.add('ve-credential-pointer'))
  row.addEventListener('keydown', event => {
    if (event.key === 'Tab') row.classList.remove('ve-credential-pointer')
  })
  row.addEventListener('focusout', event => {
    if (!row.contains(event.relatedTarget)) row.classList.remove('ve-credential-pointer')
  })

  let lastCopy = 0
  function copyAction(label, readValue) {
    let resetTimer, latestAttempt
    const button = action(label, 'copy', async () => {
      const attempt = ++lastCopy
      latestAttempt = attempt
      let copied = false
      try {
        const value = readValue()
        if (window.runtime?.ClipboardSetText) {
          copied = await window.runtime.ClipboardSetText(value) !== false
        } else {
          await navigator.clipboard.writeText(value)
          copied = true
        }
      } catch { /* Report clipboard failures in the block. */ }
      if (latestAttempt !== attempt || !button.isConnected) return
      clearTimeout(resetTimer)
      button.classList.toggle('is-copied', copied)
      if (copied) resetTimer = setTimeout(reset, 1400)
      if (attempt === lastCopy) {
        status.classList.toggle('is-error', !copied)
        status.textContent = copied ? tr('Скопировано', 'Copied') : tr('Не удалось скопировать', 'Could not copy')
      }
    })
    function reset() { button.classList.remove('is-copied') }
    button.classList.add('ve-credential-copy')
    button.insertAdjacentHTML('beforeend', icon('check'))
    return button
  }

  const names = {
    resource:tr('Ресурс', 'Resource'), login:tr('Логин', 'Login'), password:tr('Пароль', 'Password'),
  }
  function renderEntries() {
    fields.replaceChildren()
    entries.forEach((entry, index) => {
      const group = element('div', 've-credential-entry')
      group.setAttribute('role', 'group')
      group.setAttribute('aria-label', tr('Запись {number}', 'Entry {number}', {number:index + 1}))
      const handle = reorderButton(tr('Переместить запись учётных данных', 'Move credential entry'), 've-credential-entry-grip')
      attachVerticalReorder(handle, fields, group, (from,to) => {
        update(moveListItem(entries,from,to))
        renderEntries()
        fields.children[to].querySelector('.ve-credential-entry-grip').focus({preventScroll:true})
      })
      group.append(handle)
      const pair = copyAction(tr('Скопировать логин:пароль', 'Copy login:password'), () => {
        const {login,password} = entries[index]
        return login + ':' + password
      })
      pair.classList.add('ve-credential-pair')
      pair.append(document.createTextNode('a:b'))
      pair.disabled = !entry.login || !entry.password
      let conceal
      for (const key of Object.keys(names)) {
        const cell = element('div', 've-credential-cell')
        const label = element('label', 've-credential-field')
        const input = element('input')
        input.type = key === 'password' ? 'password' : 'text'
        input.autocomplete = 'off'
        input.spellcheck = false
        input.setAttribute('autocapitalize','off')
        input.setAttribute('autocorrect','off')
        input.dataset.credentialField = key
        input.value = typeof entry[key] === 'string' ? entry[key] : ''
        label.append(element('span','',names[key]),input)
        cell.append(label)
        let copyButton
        if (key === 'password') {
          const toggle = element('button', 've-credential-action ve-credential-reveal')
          toggle.type = 'button'
          const eye = () => {
            const visible = input.type === 'text'
            toggle.title = visible ? tr('Скрыть пароль', 'Hide password') : tr('Показать пароль', 'Show password')
            toggle.setAttribute('aria-label', toggle.title)
            toggle.setAttribute('aria-pressed', String(visible))
          }
          toggle.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="ve-credential-eye-slash" d="m3 3 18 18"/></svg>'
          toggle.onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; eye() }
          conceal = () => { if (input.type === 'text') { input.type = 'password'; eye() } }
          eye()
          cell.append(toggle)
        }
        if (key !== 'resource') {
          copyButton = copyAction(key === 'login' ? tr('Скопировать логин','Copy login') : tr('Скопировать пароль','Copy password'),
            () => input.value)
          copyButton.disabled = !input.value
          cell.append(copyButton)
        }
        input.oninput = () => {
          if (copyButton) copyButton.disabled = !input.value
          const next = entries.slice()
          next[index] = {...next[index],[key]:input.value}
          pair.disabled = !next[index].login || !next[index].password
          update(next,index + ':' + key)
        }
        group.append(cell)
      }
      group.onfocusout = event => {
        if (group.contains(event.relatedTarget)) return
        conceal()
        if (search.value && group.isConnected && fields.children.length === entries.length) filter()
      }
      const actions = element('div', 've-credential-row-actions')
      actions.append(pair,action(tr('Удалить запись','Remove entry'), 'minus', () => {
        update(entries.filter((_, i) => i !== index))
        renderEntries()
        const rows = [...fields.children]
        const next = rows.find((el,i) => i >= index && !el.hidden) || rows.reverse().find(el => !el.hidden)
        const focusTarget = next?.querySelector('input') || add
        focusTarget.focus()
      }))
      group.append(actions)
      fields.append(group)
    })
    filter()
  }
  renderEntries()
  // A drag gesture must never export a password from a revealed field.
  row.ondragstart = event => event.preventDefault()
  return row
}
