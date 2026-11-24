import {
  EditorState, EditorView, Compartment, StateField, StateEffect, Decoration, Transaction,
  keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder,
  defaultKeymap, history, historyKeymap, undo, redo, undoDepth, redoDepth, indentWithTab, isolateHistory,
  search, searchKeymap, openSearchPanel, gotoLine, HighlightStyle, syntaxHighlighting, bracketMatching,
  indentOnInput, StreamLanguage, tags, json, javascript, python, sql, html, css
} from './vendor/codemirror/editor-core.js'
import { tr, getLanguage } from './i18n.js'
import { isLightTheme } from './theme.js'
import { historyDirection, primaryCommand, shortcutAria, shortcutLabel } from './shortcuts.js'
import { editorButton, noteRelations, noteDetails, notePrivacyButton, noteSearchButton,
  finishNoteSession, keepTabInEditor } from './editor.js'
import { createTagNavigator, noteTags } from './note-tags.js'
import { createSearchReveal } from './search-reveal.js'
import { transformDataLines } from './data-transform.js'
import { lineEndingSupport, sourceSlice, insertedEndings, tableTransformEndings, editorOffset } from './data-line-endings.js'
import { textDocument, buildDataDocument } from './data-document.js'
import { mountDelimitedGrid } from './delimited-grid.js'

function element(tag, className, label) {
  const node = document.createElement(tag)
  node.className = className
  if (label) node.textContent = label
  return node
}

function delimited(separator) {
  return StreamLanguage.define({
    startState: () => ({quoted:false}),
    token(stream, state) {
      if (!state.quoted && stream.eat(separator)) return 'separator'
      if (!state.quoted && stream.peek() !== '"') {
        while (!stream.eol() && stream.peek() !== separator) stream.next()
        return null
      }
      if (!state.quoted) { stream.next(); state.quoted = true }
      while (!stream.eol()) {
        if (stream.next() === '"' && !stream.eat('"')) { state.quoted = false; break }
      }
      return 'string'
    }
  })
}

const formats = {
  text: {label:() => tr('Текст','Plain text'), extension:() => []},
  csv: {label:'CSV', extension:() => delimited(',')},
  tsv: {label:'TSV', extension:() => delimited('\t')},
  json: {label:'JSON', extension:json},
  jsonl: {label:'JSON Lines', extension:() => StreamLanguage.define({
    token(stream) {
      if (stream.eatSpace()) return null
      if (stream.match(/"(?:[^"\\]|\\.)*(?:"|$)/)) return stream.match(/^\s*:/,false) ? 'propertyName' : 'string'
      if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return 'number'
      if (stream.match(/^(?:true|false|null)\b/)) return 'atom'
      stream.next(); return null
    }
  })},
  javascript: {label:'JavaScript', extension:javascript},
  typescript: {label:'TypeScript', extension:() => javascript({typescript:true})},
  python: {label:'Python', extension:python},
  sql: {label:'SQL', extension:sql},
  html: {label:'HTML', extension:html},
  css: {label:'CSS', extension:css}
}
const extensions = {txt:'text', log:'text', csv:'csv', tsv:'tsv', json:'json', jsonl:'jsonl', ndjson:'jsonl',
  js:'javascript', mjs:'javascript', cjs:'javascript', ts:'typescript', py:'python', sql:'sql', html:'html', htm:'html', css:'css'}
const operations = [
  ['sort-asc','Сортировать по возрастанию','Sort ascending'],
  ['sort-desc','Сортировать по убыванию','Sort descending'],
  ['unique','Удалить дубликаты строк','Remove duplicate lines'],
  ['remove-empty','Удалить пустые строки','Remove blank lines'],
  ['trim','Обрезать пробелы по краям','Trim surrounding whitespace']
]
const russianPhrases = {
  Find:'Найти', Replace:'Заменить', next:'Далее', previous:'Назад', all:'Все', 'match case':'С учётом регистра',
  regexp:'Рег. выражение', 'by word':'Слово целиком', replace:'Заменить', 'replace all':'Заменить все',
  close:'Закрыть', 'Go to line':'Перейти к строке', go:'Перейти', 'current match':'Совпадение', 'on line':'в строке',
  'replaced match on line $':'Замена в строке $', 'replaced $ matches':'Выполнено замен: $'
}
const palette = HighlightStyle.define([
  {tag:[tags.keyword,tags.modifier,tags.operatorKeyword], color:'var(--ve-keyword,#c8b1df)'},
  {tag:[tags.string,tags.special(tags.string)], color:'var(--ve-string,#d2bd9b)'},
  {tag:[tags.number,tags.bool,tags.null,tags.atom], color:'var(--ve-number,#d5a9a5)'},
  {tag:[tags.propertyName,tags.attributeName,tags.function(tags.variableName)], color:'var(--ve-key,#a8c6e0)'},
  {tag:[tags.typeName,tags.className,tags.tagName], color:'var(--ve-type,#ccc39f)'},
  {tag:[tags.comment,tags.meta], color:'var(--ve-comment,#989898)', fontStyle:'italic'},
  {tag:[tags.separator,tags.bracket,tags.operator], color:'var(--ve-operator,#b5adb9)'}
])
const darkEditor = EditorView.theme({}, {dark:true})
const lightEditor = EditorView.theme({}, {dark:false})
const currentScheme = () => isLightTheme() ? lightEditor : darkEditor
const flash = StateEffect.define()
const highlights = StateField.define({
  create:() => Decoration.none,
  update(value,tr) {
    for (const effect of tr.effects) if (effect.is(flash)) return effect.value
    return tr.docChanged ? Decoration.none : value
  },
  provide:field => EditorView.decorations.from(field)
})

function lineSpan({doc, selection}) {
  const {from,to,empty} = selection.main
  if (empty) return {from:0,to:doc.length}
  const last = doc.lineAt(to)
  return {from:doc.lineAt(from).from, to:last.from === to ? to : Math.min(doc.length,last.to+1)}
}
function readTextFile(file,signal) {
  const reader = new FileReader()
  return new Promise((resolve,reject) => {
    const abort = () => reader.abort()
    signal.addEventListener('abort',abort,{once:true})
    reader.onloadend = () => {
      signal.removeEventListener('abort',abort)
      if (signal.aborted) {reject(new DOMException('Cancelled','AbortError')); return}
      if (reader.error) {reject(reader.error); return}
      const bytes = new Uint8Array(reader.result)
      const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' :
        bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8'
      try {resolve(new TextDecoder(encoding,{fatal:true}).decode(bytes))}
      catch {reject(new Error('encoding'))}
    }
    reader.readAsArrayBuffer(file)
  })
}

export function openDataEditor({note,notes=[],areas=[],onChange,onClose,onOpenNote,onSearch,onReturn,
  beforeClose,manageProtection,isProtected,saveIndicator,backLabel=tr('К карте','Back to map')}) {
  const previousFocus = document.activeElement
  const root = element('section','vd-editor ve-data-editor')
  root.setAttribute('role','dialog'); root.setAttribute('aria-modal','true')
  root.setAttribute('aria-label',tr('Редактор данных','Data editor'))
  const header = element('header','ve-head'), workspace = element('div','ve-board-layout')
  const main = element('main','vd-data-main'), bar = element('div','vd-data-bar')
  const host = element('div','vd-data-host'), footer = element('footer','vd-data-footer')
  const tableHost = element('div','vd-data-table-host')
  tableHost.hidden = true
  const title = element('input','ve-canvas-title')
  title.value = note.title || ''; title.placeholder = tr('Без названия','Untitled')
  title.setAttribute('aria-label',tr('Название заметки','Note title'))
  const titleReveal = createSearchReveal({root,title})
  const format = element('select','vd-data-format')
  format.setAttribute('aria-label',tr('Формат данных','Data format'))
  for (const [id,{label}] of Object.entries(formats))
    format.add(new Option(typeof label === 'function' ? label() : label,id))
  format.value = Object.hasOwn(formats,note.dataLanguage) ? note.dataLanguage : 'text'
  let source = note.dataText || ''
  let relations = noteRelations(note), finished = false, dirty = false, closePending, running
  let idleTimer, maxTimer, flashTimer, view, sourceDoc, grid, tableState, textScroll
  let hasHeader = note.dataHasHeader !== false, docRevision = 0, lastTableView, gridFormat
  const languageSlot = new Compartment(), themeSlot = new Compartment()
  const tagNav = createTagNavigator({root,notes,noteId:note.id,onOpenNote:onOpenNote && navigateTo})
  const details = noteDetails({root,note,notes,areas,current:() => relations,update(patch,point) {
    relations = {...relations,...patch}; onChange?.({...patch,...point}); details.sync()
  },openNote:onOpenNote && navigateTo,openTag:onOpenNote && tagNav.open})
  header.append(editorButton(backLabel,'back',goBack,true),element('span','ve-head-divider'),
    element('span','ve-crumb',tr('Данные','Data')),title,saveIndicator ?? element('span','ve-spacer'))
  if (onSearch) header.append(noteSearchButton(() => {flush(); onSearch()}))
  if (manageProtection) header.append(notePrivacyButton(() => {flush(); return manageProtection()},isProtected))
  header.append(details.toggle)

  const menuHost = element('div','vd-data-menu-host'), menu = element('div','vd-data-menu')
  menu.hidden = true; menu.setAttribute('role','menu'); menu.id = 'vd-data-operations'
  const menuButton = editorButton(tr('Строки','Lines'),null,() => showMenu(menu.hidden),true)
  menuButton.classList.add('vd-data-menu-button')
  menuButton.setAttribute('aria-haspopup','menu'); menuButton.setAttribute('aria-controls',menu.id)
  menuButton.setAttribute('aria-expanded','false')
  const scope = element('div','vd-data-scope')
  menu.append(scope)
  for (const [id,ru,en] of operations) {
    const action = editorButton(tr(ru,en),null,() => runOperation(id),true)
    action.setAttribute('role','menuitem'); action.dataset.operation = id; menu.append(action)
  }
  function showMenu(open) {
    menu.hidden = !open; menuButton.setAttribute('aria-expanded',String(open))
    if (open) {
      scope.textContent = view.state.selection.main.empty ? tr('Весь документ','Entire document') : tr('Выделенные строки','Selected lines')
      menu.querySelector('button').focus()
    }
  }
  menuHost.append(menuButton,menu)
  menu.addEventListener('keydown',event => {
    const choices = Array.from(menu.querySelectorAll('button')), i = choices.indexOf(document.activeElement)
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); showMenu(false); menuButton.focus()}
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault()
      choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length-1 :
        (i + (event.key === 'ArrowUp' ? -1 : 1) + choices.length) % choices.length].focus()
    }
  })
  root.addEventListener('focusin',e => {if (!menu.hidden && !menuHost.contains(e.target)) showMenu(false)})
  root.addEventListener('pointerdown',e => {if (!menu.hidden && !menuHost.contains(e.target)) showMenu(false)})

  const fileInput = element('input',''); fileInput.type = 'file'; fileInput.hidden = true
  fileInput.accept = ['text/*', ...Object.keys(extensions).map(ext => '.'+ext)].join(',')
  const insertFile = editorButton(tr('Вставить файл…','Insert file…'),'folder',() => fileInput.click(),true)
  const mode = element('div','vd-data-view-switch')
  mode.setAttribute('role','group'); mode.setAttribute('aria-label',tr('Представление данных','Data view'))
  const textButton = editorButton(tr('Текст','Text'),null,() => {showText(); view.focus()},true)
  const tableButton = editorButton(tr('Таблица','Table'),null,showTable,true)
  textButton.dataset.dataView = 'text'; tableButton.dataset.dataView = 'table'
  mode.append(textButton,tableButton)
  const find = editorButton(tr('Найти и заменить','Find and replace'),'search',findInText)
  const undoButton = editorButton(tr('Отменить','Undo'),'undo',() => applyHistory(undo))
  const redoButton = editorButton(tr('Повторить','Redo'),'redo',() => applyHistory(redo))
  const divider = element('span','ve-divider')
  bar.append(format,mode,divider,menuHost,insertFile,fileInput,element('span','ve-spacer'),find,undoButton,redoButton)
  const lines = element('span','vd-data-lines'), message = element('span','vd-data-message')
  message.setAttribute('role','status')
  function cancelTextOperation() {
    if (!running) return false
    running.abort(); return true
  }
  const cancel = editorButton(tr('Отмена','Cancel'),null,cancelTextOperation,true)
  cancel.hidden = true
  const cursor = editorButton(tr('Перейти к строке','Go to line'),'hash',() => gotoLine(view),true)
  for (const [control, chord] of [[find,'Ctrl+F'], [cursor,'Ctrl+G'], [undoButton,'Ctrl+Z'], [redoButton,'Ctrl+Shift+Z'], [cancel,'Escape']]) {
    control.title += ' ('+shortcutLabel(chord)+')'
    control.setAttribute('aria-keyshortcuts',shortcutAria(chord))
  }
  footer.append(lines,element('span','ve-spacer'),message,cancel,cursor)
  main.append(bar,host,tableHost,footer); workspace.append(main,details.panel); root.append(header,workspace); document.body.append(root)
  tagNav.trackTitle(title)
  const numbers = new Intl.NumberFormat(getLanguage())
  function status(state) {
    const pos = state.selection.main.head, line = state.doc.lineAt(pos)
    lines.textContent = tr('Строк: ','Lines: ') + numbers.format(state.doc.lines)
    cursor.lastChild.textContent = tr('Стр ','Ln ') + numbers.format(line.number) + tr(', стлб ',', Col ') + numbers.format(pos-line.from+1)
    undoButton.disabled = !undoDepth(state); redoButton.disabled = !redoDepth(state)
  }
  function flush() {
    clearTimeout(idleTimer); clearTimeout(maxTimer); maxTimer = null
    if (!dirty || finished) return
    const state = tableState ?? view.state
    if (sourceDoc !== state.doc) {
      source = sourceSlice(state)
      sourceDoc = state.doc
    }
    dirty = false
    onChange?.({dataText:source, plain:source.slice(0,240), weight:source.length})
  }
  function scheduleFlush() {
    dirty = true
    clearTimeout(idleTimer); idleTimer = setTimeout(flush,320)
    maxTimer ??= setTimeout(flush,1500)
  }
  function setTitle() {
    const tags = noteTags(title.value,'')
    details.setTags(tags); tagNav.syncTitle(); onChange?.({title:title.value,tags})
  }
  function setLanguage() {
    showText()
    view.dispatch({effects:languageSlot.reconfigure(formats[format.value].extension())})
    onChange?.({dataLanguage:format.value})
  }
  format.onchange = () => {setLanguage(); view.focus()}
  const state = EditorState.create({doc:textDocument(source), extensions:[
    lineEndingSupport(source), languageSlot.of(formats[format.value].extension()), syntaxHighlighting(palette), indentOnInput(),
    bracketMatching(), history(), lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
    search({top:true}), highlights, themeSlot.of(currentScheme()), EditorState.tabSize.of(4),
    keymap.of([{key:'Mod-g',run:gotoLine},{win:'Ctrl-Shift-z',run:redo,preventDefault:true},
      ...searchKeymap,{key:'Escape',run:cancelTextOperation},...historyKeymap,indentWithTab,...defaultKeymap]),
    EditorState.phrases.of(getLanguage() === 'ru' ? russianPhrases : {}),
    EditorView.contentAttributes.of({'aria-label':tr('Содержимое заметки данных','Data note contents'), spellcheck:'false'}),
    placeholder(tr('Введите данные или вставьте файл…','Type data or insert a file…')),
    EditorView.updateListener.of(update => {
      if (update.docChanged) {
        docRevision++
        if (!update.transactions.some(transaction =>
          transaction.isUserEvent('input.transform') || transaction.isUserEvent('input.import'))) running?.abort()
        scheduleFlush()
      }
      if (update.docChanged || update.selectionSet) status(update.state)
    })
  ]})
  function applyTheme() {
    const effects = themeSlot.reconfigure(currentScheme())
    if (tableState) tableState = tableState.update({effects}).state
    else view.dispatch({effects})
  }
  view = new EditorView({state,parent:host})
  window.addEventListener('videron:themechange',applyTheme)
  sourceDoc = state.doc
  syncViewButtons()
  status(state); details.sync(); details.setTags(noteTags(title.value,''))
  title.oninput = setTitle
  title.onkeydown = e => {if (e.key === 'Enter' && !e.isComposing) focusContent()}

  function syncViewButtons() {
    mode.hidden = format.value !== 'csv' && format.value !== 'tsv'
    const tabular = !tableHost.hidden
    textButton.setAttribute('aria-pressed',String(!tabular))
    tableButton.setAttribute('aria-pressed',String(tabular))
    host.hidden = footer.hidden = divider.hidden = menuHost.hidden = insertFile.hidden = tabular
  }
  function focusContent() { if (grid) grid.focus(); else view.focus() }
  function releaseTable() {
    if (grid) {
      lastTableView = {format:gridFormat, revision:docRevision, state:grid.snapshot()}
      grid.destroy(); grid = null
    }
  }
  function showText() {
    releaseTable()
    tableHost.hidden = true
    syncViewButtons()
    if (tableState) {
      view = new EditorView({state:tableState,parent:host,scrollTo:textScroll})
      tableState = null; textScroll = undefined
    } else view.requestMeasure()
  }
  function findInText() { showText(); openSearchPanel(view) }
  function applyTableTransaction(transaction) {
    tableState = transaction.state
    if (transaction.docChanged) { textScroll = undefined; docRevision++; scheduleFlush() }
    status(tableState)
  }
  function applyHistory(command) {
    if (grid) {
      if (command({state:tableState,dispatch:applyTableTransaction})) {
        flush()
        grid.refresh(source)
      }
    } else command(view)
    focusContent()
  }
  function showTable() {
    if (grid) { grid.focus(); return }
    if (format.value !== 'csv' && format.value !== 'tsv') return
    running?.abort(); showMenu(false); flush()
    clearTimeout(flashTimer)
    if (view.state.field(highlights).size) view.dispatch({effects:flash.of(Decoration.none)})
    // A display:none editor has no measurable viewport. A full replacement
    // there can lay out every line. Keep the document and undo history only.
    textScroll = view.scrollSnapshot()
    tableState = view.state; view.destroy(); view = null
    tableHost.hidden = false
    syncViewButtons()
    gridFormat = format.value
    let restore = lastTableView?.format === gridFormat ? lastTableView.state : null
    if (restore && lastTableView.revision !== docRevision)
      restore = {scrollTop:restore.scrollTop,scrollLeft:restore.scrollLeft}
    grid = mountDelimitedGrid(tableHost,{
      source, format:gridFormat, header:hasHeader, restore,
      onHeaderChange(enabled) {
        hasHeader = enabled
        onChange?.({dataHasHeader:enabled})
      },
      async onChange(text,signal) {
        const current = grid, original = tableState.doc
        const inserted = await buildDataDocument(text,signal)
        if (signal.aborted || finished || grid !== current || tableState?.doc !== original)
          throw new DOMException('Cancelled','AbortError')
        applyTableTransaction(tableState.update({changes:{from:0,to:original.length,insert:inserted},
          effects:tableTransformEndings(tableState,text),
          selection:{anchor:0}, annotations:[Transaction.userEvent.of('input.transform'),isolateHistory.of('full')]}))
        source = text; sourceDoc = tableState.doc
      },
      onSourceRange(start,end) {
        showText()
        const from = editorOffset(view.state,source,start), to = editorOffset(view.state,source,end)
        view.dispatch({selection:{anchor:from,head:to},effects:EditorView.scrollIntoView(from,{y:'center'})})
        view.focus()
      }
    })
    grid.focus()
  }

  function taskStarted(text) {
    running?.abort()
    running = new AbortController()
    cancel.hidden = false; menuButton.disabled = true; insertFile.disabled = true; message.textContent = text
    return running
  }
  function taskEnded(task,label) {
    if (running !== task) return
    running = null; cancel.hidden = true; menuButton.disabled = false; insertFile.disabled = false; message.textContent = label
  }
  async function runOperation(id) {
    showMenu(false); view.focus()
    const {doc,selection} = view.state, {from,to} = lineSpan(view.state)
    const task = taskStarted(tr('Обработка строк…','Processing lines…'))
    try {
      const wholeDocument = from === 0 && to === doc.length
      const input = wholeDocument && sourceDoc === doc ? source : sourceSlice(view.state,from,to)
      const output = await transformDataLines(input,id,{language:getLanguage(),signal:task.signal})
      if (task.signal.aborted) throw new DOMException('Cancelled','AbortError')
      if (output === input) { taskEnded(task,tr('Без изменений','Already up to date')); return }
      const inserted = await buildDataDocument(output,task.signal), end = from+inserted.length
      if (finished || task.signal.aborted || view?.state.doc !== doc) throw new DOMException('Cancelled','AbortError')
      const caret = Math.min(selection.main.head,end)
      view.dispatch({changes:{from,to,insert:inserted}, effects:insertedEndings(view.state,from,to,output,inserted),
        selection:selection.main.empty ? {anchor:caret} : {anchor:from,head:end},
        annotations:[Transaction.userEvent.of('input.transform'),isolateHistory.of('full')]})
      if (wholeDocument) {source = output; sourceDoc = view.state.doc}
      taskEnded(task,tr('Готово','Done'))
    } catch (error) {
      taskEnded(task,error.name === 'AbortError' ? tr('Операция отменена','Operation cancelled') : tr('Ошибка обработки строк','Line operation failed'))
    }
  }
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0]; fileInput.value = ''
    if (!file || !view) return
    const {doc,selection} = view.state, {from,to} = selection.main
    const task = taskStarted(tr('Чтение файла…','Reading file…'))
    try {
      const content = await readTextFile(file,task.signal)
      const imported = await buildDataDocument(content,task.signal)
      if (finished || task.signal.aborted || view?.state.doc !== doc) throw new DOMException('Cancelled','AbortError')
      if (!doc.length) {
        const inferred = extensions[file.name.split('.').at(-1).toLowerCase()]
        if (inferred && format.value !== inferred) {format.value = inferred; setLanguage()}
        if (!title.value) {title.value = file.name; setTitle()}
      }
      view.dispatch({changes:{from,to,insert:imported},selection:{anchor:from},effects:insertedEndings(view.state,from,to,content,imported),
        annotations:[Transaction.userEvent.of('input.import'),isolateHistory.of('full')]})
      if (from === 0 && to === doc.length) {source = content; sourceDoc = view.state.doc}
      taskEnded(task,'')
      view.focus()
    } catch (error) {
      const label = error.name === 'AbortError' ? tr('Вставка отменена','Insertion cancelled') :
        error.message === 'encoding' ? tr('Сохраните файл в UTF-8 или UTF-16 с BOM','Use a UTF-8 file or UTF-16 with BOM') :
        tr('Не удалось прочитать файл','Could not read file')
      taskEnded(task,label)
    }
  }
  function focus() {if (!title.value) title.focus(); else focusContent()}
  function close(reason) {
    if (finished) return Promise.resolve(true)
    if (closePending) return closePending
    closePending = (async () => {
      running?.abort(); releaseTable(); flush()
      if (!await finishNoteSession(root,beforeClose)) {showText(); return false}
      finished = true; clearTimeout(flashTimer)
      window.removeEventListener('videron:themechange',applyTheme)
      titleReveal.clear(); tagNav.destroy(); view?.destroy(); tableState = null; root.remove()
      previousFocus?.focus?.({preventScroll:true}); onClose?.(reason)
      return true
    })().finally(() => {closePending = null})
    return closePending
  }
  async function navigateTo(id) { if (await close()) onOpenNote?.(id) }
  async function goBack() { if (await close('back')) onReturn?.() }
  root.addEventListener('keydown',event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if (primaryCommand(event)) {
      const direction=grid && historyDirection(event)
      if (direction && !event.target.closest('input:not([type=checkbox]),textarea,[contenteditable=true]')) {
        event.preventDefault(); applyHistory(direction==='redo' ? redo : undo); return
      }
      if (!event.shiftKey && !event.target.closest('.cm-panel')) {
        if (event.code === 'KeyF') {event.preventDefault(); findInText(); return}
        if (event.code === 'KeyG') {event.preventDefault(); showText(); gotoLine(view); return}
      }
    }
    if (event.key === 'Escape' && !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.target.closest('.cm-panel')) {
      event.preventDefault(); event.stopPropagation()
      if (event.repeat) return
      if (!cancelTextOperation() && !grid?.cancelOperation()) goBack()
      return
    }
    keepTabInEditor(event,root)
  })
  function revealSearchMatch(target) {
    if (target?.kind !== 'data') {titleReveal.reveal(target); return}
    showText()
    details.uncoverNote(); flush()
    const from = editorOffset(view.state,source,target.start), to = Math.max(from,editorOffset(view.state,source,target.end))
    const marks = from < to ? Decoration.set([Decoration.mark({class:'vd-data-search-hit'}).range(from,to)]) : Decoration.none
    view.dispatch({selection:{anchor:from},effects:[flash.of(marks),EditorView.scrollIntoView(from,{y:'center'})]})
    view.focus()
    clearTimeout(flashTimer); flashTimer = setTimeout(() => view.dispatch({effects:flash.of(Decoration.none)}),2200)
  }
  focus()
  return {element:root,focus,close,prepareClose:close,flush,revealSearchMatch}
}
