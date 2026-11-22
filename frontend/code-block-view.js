import { tr } from './i18n.js'
import { CODE_LANGUAGES, codeLanguage, detectCodeLanguage, formatJSON, highlightCode, indentCodeSelection } from './code-block.js'

const languageNames = {
  json: 'JSON', javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', powershell: 'PowerShell',
  go: 'Go', rust: 'Rust', html: 'HTML', css: 'CSS', shell: 'Shell', yaml: 'YAML', sql: 'SQL',
}
const autoLabel = () => tr('Авто', 'Auto')

export function pastedCode(raw, emptyParagraph) {
  const source = raw.replace(/\r\n?/g, '\n')
  const fence = /^(`{3,}|~{3,})([\w+#.-]*)[^\S\n]*\n([\s\S]*?)\n\1[ \t]*(?:\n)?$/.exec(source)
  if (fence) return {type: 'code', language: codeLanguage(fence[2]), text: fence[3]}
  if (emptyParagraph && /^\s*[\[{]/.test(source)) {
    try {
      JSON.parse(source)
      return {type: 'code', language: 'json', text: source}
    } catch {}
  }
  return null
}

export function createCodeBlockView(block, {el, button, index, activate, beforeEdit, change, move, remove, history}) {
  const row = el('section', 've-code')
  const header = el('div', 've-code-header')
  const language = el('select', 've-code-language')
  language.setAttribute('aria-label', tr('Язык кода', 'Code language'))
  for (const id of CODE_LANGUAGES) {
    const label = id === 'auto' ? autoLabel() : id === 'plain' ? tr('Простой текст', 'Plain text') : languageNames[id]
    language.add(new Option(label, id))
  }
  language.value = codeLanguage(block.language)
  const status = el('span', 've-code-status')
  status.setAttribute('role', 'status')
  const surface = el('div', 've-code-surface')
  const mirror = el('pre', 've-code-mirror')
  mirror.setAttribute('aria-hidden', 'true')
  const source = el('textarea', 've-code-source')
  function setIndex(value){
    index=value
    source.setAttribute('aria-label', tr('Код, блок ', 'Code, block ') + (index + 1))
  }
  setIndex(index)
  source.setAttribute('autocapitalize', 'off')
  source.setAttribute('autocomplete', 'off')
  source.setAttribute('autocorrect', 'off')
  source.wrap = 'off'
  source.spellcheck = false
  source.value = typeof block.text === 'string' ? block.text : ''
  source.placeholder = tr('Введите или вставьте код…', 'Type or paste code…')
  const nextLabel = tr('Продолжить заметку (Ctrl+Enter)', 'Continue note (Ctrl+Enter)')
  const format = button(tr('Форматировать JSON', 'Format JSON'), null, () => {
    const result = formatJSON(source.value)
    if (!result.ok) {
      const lines = source.value.split('\n', result.line)
      const lineStart = lines.slice(0, -1).reduce((size, line) => size + line.length + 1, 0)
      const offset = lineStart + Array.from(lines.at(-1)).slice(0, result.column - 1).join('').length
      source.focus()
      source.setSelectionRange(offset, offset)
      status.textContent = tr('Ошибка JSON · строка ', 'Invalid JSON · line ') + result.line + tr(', столбец ', ', column ') + result.column
      source.setAttribute('aria-invalid', 'true')
      return
    }
    if (result.text !== source.value) {
      beforeEdit()
      source.value = result.text
      update()
    }
    status.textContent = tr('JSON отформатирован', 'JSON formatted')
  }, true)
  const copy = button(tr('Копировать код', 'Copy code'), 'copy', async () => {
    const value = source.value
    try {
      if (window.runtime?.ClipboardSetText) await window.runtime.ClipboardSetText(value)
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
      else {
        const {selectionStart, selectionEnd} = source
        const previousFocus = document.activeElement
        source.select()
        const copied = document.execCommand('copy')
        source.setSelectionRange(selectionStart, selectionEnd)
        previousFocus?.focus({preventScroll: true})
        if (!copied) throw new Error()
      }
      status.textContent = tr('Скопировано', 'Copied')
    } catch { status.textContent = tr('Не удалось скопировать код', 'Could not copy code') }
  })
  header.append(language, status, format, copy, button(nextLabel, 'continue', () => move(index,1,true)),
    button(tr('Убрать блок кода', 'Remove code block'), 'trash', () => remove(index)))
  surface.append(mirror, source)
  row.append(header, surface)

  function syncScroll() {
    mirror.scrollLeft = source.scrollLeft
    mirror.scrollTop = source.scrollTop
  }
  function paint() {
    const value = source.value
    const resolved = language.value === 'auto' ? detectCodeLanguage(value) : language.value
    language.querySelector('option[value="auto"]').textContent = language.value === 'auto' && languageNames[resolved]
      ? autoLabel() + ' · ' + languageNames[resolved] : autoLabel()
    format.hidden = resolved !== 'json' && !(language.value === 'auto' && /^\s*[\[{]/.test(value))
    const tokens = document.createDocumentFragment()
    for (const {text, kind} of highlightCode(value, resolved)) {
      tokens.append(kind === 'plain' ? document.createTextNode(text) : el('span', 've-code-' + kind, text))
    }
    mirror.replaceChildren(tokens)
    syncScroll()
  }
  function update() {
    status.textContent = ''
    source.removeAttribute('aria-invalid')
    paint()
    change({type: 'code', language: language.value, text: source.value},index)
  }
  let pendingInput = false
  row.onfocusin = () => activate(index)
  language.onchange = () => { beforeEdit(); update() }
  source.onbeforeinput = event => {
    if (event.cancelable && (event.inputType === 'historyUndo' || event.inputType === 'historyRedo')) {
      event.preventDefault()
      history(event.inputType === 'historyRedo')
      return
    }
    beforeEdit('code-' + index)
    pendingInput = true
  }
  source.oninput = () => {
    if (!pendingInput) beforeEdit('code-' + index)
    pendingInput = false
    update()
  }
  source.onscroll = syncScroll
  source.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229 || event.altKey) return
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      move(index,1,true)
    } else if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey) {
      const {selectionStart, selectionEnd, selectionDirection} = source
      if (event.shiftKey && selectionStart === selectionEnd) return
      event.preventDefault()
      if (selectionStart === selectionEnd) {
        beforeEdit()
        source.setRangeText('\t', selectionStart, selectionEnd, 'end')
      } else {
        const edit = indentCodeSelection(source.value, selectionStart, selectionEnd, event.shiftKey)
        if (source.value.slice(edit.from, edit.to) === edit.replacement) return
        beforeEdit()
        source.setRangeText(edit.replacement, edit.from, edit.to)
        source.setSelectionRange(edit.selectionStart, edit.selectionEnd, selectionDirection)
      }
      update()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      move(index,1,true)
    } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && source.selectionStart === source.selectionEnd) {
      const atStart = source.selectionStart === 0 && ['ArrowUp','ArrowLeft'].includes(event.key)
      const atEnd = source.selectionEnd === source.value.length && ['ArrowDown','ArrowRight'].includes(event.key)
      if ((atStart || atEnd) && move(index,atStart ? -1 : 1,false)) event.preventDefault()
    }
  }
  paint()
  return {row,setIndex}
}
