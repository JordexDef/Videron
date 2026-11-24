import { tr, getLanguage } from './i18n.js'
import { mountAgentTaskList } from './agent-task-list.js'
import { isLightTheme } from './theme.js'
import { areaTreeRows, planAreaNotes } from './areas.js'
import { fullGridIds } from './area-grid.js'
import { mountBoard, normalizeBoard, boardSummary, emptyBoard } from './board.js'
import { openBoardFiles } from './board-files.js'
import { createInlineBoard } from './inline-board.js'
import { createDirectTables, isDirectTableBlock, newTableBlock } from './direct-tables.js'
import { noteWorkbooks, rebaseTableLinks, rebaseTableLinksAfterDelete, rewriteCells } from './board-tables.js'
import { uniqueTableName } from './table-engine.js'
import { createCodeBlockView, pastedCode } from './code-block-view.js'
import { attachTextToolbar } from './canvas-text-toolbar.js'
import { blockText, textTypes } from './search-location.js'
import { historyDirection, primaryCommand, shortcutAria, shortcutLabel } from './shortcuts.js'
import { blockTagText } from './board-rich-text.js'
import { readClipboardRuns } from './clipboard-runs.js'
import { isListStyle, listStyleOf, indentOf, listMarkers, atParentLevel, isTaskStyle, taskStateOf, taskCounts,
  withListStyle, toggleTask, listItemForPrefix, continuedListItem } from './note-lists.js'
import { createSearchReveal, rangeInText } from './search-reveal.js'
import { isProtectedNote, protectedNoteTitle } from './note-vault.js'
import { createTagNavigator, noteTags } from './note-tags.js'
import { canPickFolder, pickFolder, openFolder, isFolderPath, folderLabel, folderError } from './folder-links.js'

// Version 1 stores content as text runs and media blocks. DOM nodes are only an editing view.
const lightPaperInk = ['#303137', '#755841', '#295b86', '#a34340', '#68498e', '#84621a']
const darkPaperInk = ['#d4d4d4', '#e8dfc8', '#9dc9e2', '#e6aaa0', '#bba6db', '#dbbf79']
let taskTextId = 0
const icons = {
  padlock:'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3',
  openPadlock:'M5 10h14v11H5z M8 10V7a4 4 0 0 1 7.6-1.8',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 1 1 12 0m-1.5 4.5L21 21',
  back: 'M19 12H5m7 7-7-7 7-7', file: 'M6 3h8l4 4v14H6z M14 3v5h4',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z M3 9h18',
  bold: 'M6 4h7a4 4 0 0 1 0 8H6z M6 12h8a4 4 0 0 1 0 8H6z',
  italic: 'M19 4h-9m4 16H5m11-16-8 16', link: 'm10 13 4-4m-5 6-2 2a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 1 2-2a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0',
  image: 'M3 4h18v16H3z m0 12 5-5 4 4 3-3 6 6 M16 8h.01',
  pen: 'm4 20 5-1 11-11-4-4L5 15z m9-13 4 4', color: 'm5 16 6-12h2l6 12m-11-4h8 M5 20h14',
  undo: 'm9 4-5 5 5 5 M4 9h9a6 6 0 0 1 0 12', redo: 'm15 4 5 5-5 5m5-5h-9a6 6 0 0 0 0 12',
  close: 'm6 6 12 12m0-12L6 18', pin: 'm15 3 6 6-3 1-4 5-1 3-7-7 3-1 5-4z M9 15l-6 6',
  board: 'M3 4h18v16H3z M6.5 8h5v4h-5z M14 14h3.5v3H14z',
  table: 'M3 4h18v16H3z M3 9h18 M3 14h18 M9 9v11',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18',
  copy: 'M8 8h12v13H8z M16 8V3H3v13h5',
  continue: 'M20 5v7a3 3 0 0 1-3 3H4m5-5-5 5 5 5',
  details: 'M3 4h18v16H3z M15 4v16',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7m4-7v7',
  hash: 'M5 9h15 M4 15h15 M10 3 7 21m10-18-3 18', check: 'm4 12 5 5L20 6',
  task: 'M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M7.5 12l3 3 6-6',
  taskChoice: 'M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M8.5 8.5l7 7m0-7-7 7',
  indent: 'M4 5h16M12 10h8m-8 5h8M4 20h16M4 9l3 3-3 3',
  outdent: 'M4 5h16M12 10h8m-8 5h8M4 20h16M7 9l-3 3 3 3',
}
function el(tag, className, value) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (value !== undefined) n.textContent = value
  return n
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.classList.add('ve-icon')
  svg.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS(svg.namespaceURI, 'path')
  p.setAttribute('d', icons[name])
  svg.append(p)
  return svg
}
function button(label, symbol, action, visible = false) {
  const b = el('button', 've-btn')
  b.type = 'button'
  b.title = label
  b.setAttribute('aria-label', label)
  if (symbol) b.append(icon(symbol))
  if (visible) b.append(document.createTextNode(label))
  b.addEventListener('click', action)
  return b
}
const paragraph = () => ({type: 'paragraph', runs: []})
const option = (value, name) => new Option(name, value)
function keepTabInEditor(event, root){
  if(event.key!=='Tab')return
  const selectors='button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),[contenteditable=true],[tabindex="0"]'
  const controls=[...root.querySelectorAll(selectors)].filter(control=>control.getClientRects().length)
  if(!controls.length)return
  if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1).focus()}
  else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus()}
}
const safeColor = v => typeof v === 'string' && /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(v) ? v : ''
const safeImage = v => typeof v === 'string' && /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i.test(v)
function safeLink(value) {
  try { const url = new URL(value); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : '' }
  catch { return '' }
}
function appendRuns(parent, runs) {
  let previousLink = null, previousAddress = null
  for (const run of runs || []) {
    if (!run.text) continue
    let n = document.createTextNode(run.text)
    for (const [prop, tag] of [['bold','strong'],['italic','em'],['underline','u'],['color','span']]) {
      if (!run[prop]) continue
      const wrapper = el(tag)
      if (prop === 'color') { const color = safeColor(run.color); if (!color) continue; wrapper.style.color = color }
      wrapper.append(n); n = wrapper
    }
    const folder = isFolderPath(run.folderPath), href = run.href && safeLink(run.href)
    const address = folder ? run.folderPath : href
    if (address && previousLink && address === previousAddress) {
      previousLink.append(n)
      continue
    }
    previousLink = null; previousAddress = address
    if (address) {
      const link = el('a')
      if (folder) {
        link.href = '#'; link.dataset.folderPath = run.folderPath; link.tabIndex = 0
        link.title = tr('Открыть папку', 'Open folder') + ' · ' + run.folderPath
        link.draggable = false
      } else { link.href = href; link.rel = 'noreferrer' }
      link.append(n); n = previousLink = link
    }
    parent.append(n)
  }
}
function marksForElement(node, inherited) {
  const marks = {...inherited}, tag = node.tagName, style = node.style
  if (['STRONG','B'].includes(tag) || style?.fontWeight === 'bold' || Number(style?.fontWeight) >= 600) marks.bold = true
  if (['I','EM'].includes(tag) || style?.fontStyle === 'italic') marks.italic = true
  if (tag === 'U' || style?.textDecorationLine?.includes('underline')) marks.underline = true
  const color = safeColor(style?.color || node.getAttribute?.('color'))
  if (color) marks.color = color
  if (tag === 'A') {
    if (isFolderPath(node.dataset.folderPath)) marks.folderPath = node.dataset.folderPath
    else if (safeLink(node.getAttribute('href'))) marks.href = safeLink(node.getAttribute('href'))
  }
  return marks
}
function readRuns(root) {
  const runs = []
  function add(value, marks) {
    if (!value) return
    const last = runs.at(-1)
    if (last && ['bold','italic','underline','color','href','folderPath'].every(k => last[k] === marks[k])) last.text += value
    else runs.push({text: value, ...marks})
  }
  function walk(node, inherited) {
    if (node.nodeType === Node.TEXT_NODE) { add(node.data.replace(/\u00a0/g, ' '), inherited); return }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return
    const tag = node.tagName
    if (['SCRIPT','STYLE','IFRAME','OBJECT','TEMPLATE','NOSCRIPT'].includes(tag)) return
    if (tag === 'BR') { if (node.parentNode.childNodes.length > 1) add('\n', inherited); return }
    const marks = marksForElement(node, inherited)
    const block = ['P','DIV','LI','H1','H2','H3','BLOCKQUOTE','PRE','SECTION','TR'].includes(tag)
    if (block && node !== root && runs.length && !runs.at(-1).text.endsWith('\n')) add('\n', inherited)
    for (const child of node.childNodes) walk(child, marks)
    if (block && node !== root && node.nextSibling && runs.length && !runs.at(-1).text.endsWith('\n')) add('\n', inherited)
  }
  walk(root, {})
  return runs
}
function sliceRuns(runs, start, end = Infinity) {
  let pos = 0
  return runs.flatMap(r => {
    const str = r.text.slice(Math.max(0, start-pos), Math.max(0, end-pos))
    pos += r.text.length
    return str ? [{...r, text: str}] : []
  })
}
function offsetAt(root, node, offset) {
  const range = document.createRange()
  range.selectNodeContents(root); range.setEnd(node, offset)
  return range.toString().length
}
function setCaret(root, offset, end = offset) {
  root.focus({preventScroll: true})
  const selection = getSelection()
  selection.removeAllRanges(); selection.addRange(rangeInText(root,offset,end))
}
function modal(root, label, className = '', requestDismiss = dlg => dlg.close()) {
  const dialog = el('dialog', 've-dialog ' + className)
  const head = el('div', 've-dialog-head')
  head.append(el('h2', '', label), button(tr('Закрыть','Close'), 'close', () => requestDismiss(dialog)))
  dialog.append(head); root.append(dialog)
  dialog.setAttribute('aria-label', label)
  dialog.addEventListener('click', e => { if (e.target === dialog && (e.offsetX < 0 || e.offsetY < 0 || e.offsetX > dialog.clientWidth || e.offsetY > dialog.clientHeight)) requestDismiss(dialog) })
  dialog.addEventListener('close', () => dialog.remove(), {once: true})
  dialog.showModal()
  return dialog
}
const hasTables = block => block?.board?.elements?.some(e=>e.type==='table')

export { button as editorButton, noteRelations, noteDetails, notePrivacyButton, noteSearchButton, finishNoteSession, keepTabInEditor }

function noteRelations(note) {
  return {links:[...(note.links || [])], pinned:!!note.pinned, areaId:note.areaId || null, slot:note.slot ?? null}
}

function noteDetails({root,note,notes,areas,current,update,openNote,openTag}) {
  const panel=el('aside','ve-side'), tags=el('div','ve-tags')
  panel.id='ve-note-details'
  const caption=tr('Область и связи','Area and links')
  panel.setAttribute('aria-label',caption)
  let expanded=false
  try { expanded=localStorage.getItem('videron.note-details.v1')==='open' } catch {}
  function show(){
    panel.hidden=!expanded
    root.classList.toggle('ve-with-details',expanded)
    toggle.setAttribute('aria-expanded',String(expanded))
  }
  function setExpanded(value){
    expanded=value
    show()
    if(expanded)sync()
    try { localStorage.setItem('videron.note-details.v1',expanded?'open':'closed') } catch {}
  }
  const toggle=button(caption,'details',()=>setExpanded(!expanded),true)
  toggle.classList.add('ve-details-toggle')
  toggle.setAttribute('aria-controls',panel.id)
  show()

  const areaSelect=el('select','ve-input')
  const areaSpace={areas,notes:notes.some(n=>n.id===note.id)?notes:[...notes,note]}
  const gridOptions=[]
  areaSelect.setAttribute('aria-label',tr('Область заметки','Note area'))
  areaSelect.add(option('',tr('Без области','No area')))
  for(const {area,pathLabel} of areaTreeRows(areas)){
    const choice=option(area.id,pathLabel)
    areaSelect.add(choice)
    if(area.grid)gridOptions.push({area,choice,pathLabel})
  }
  areaSelect.onchange=()=>{
    const id=areaSelect.value||null, plan=planAreaNotes(areaSpace,[note.id],id)
    if(!plan.ok){sync();return}
    const next=plan.after[0]
    if(next)update({areaId:id,slot:next.slot},{x:next.x,y:next.y})
  }
  const pin=button(tr('Закрепить на карте','Pin to map'),'pin',()=>update({pinned:!current().pinned}),true)
  pin.classList.add('ve-pin')
  const connections=el('div','ve-connections'),backlinks=el('section','ve-backlinks')
  const available=el('select','ve-input')
  available.setAttribute('aria-label',tr('Связать с заметкой','Link to a note'))
  available.onchange=()=>{
    if(available.value)update({links:[...current().links,available.value]})
  }
  const areaLabel=el('label','ve-side-label',tr('Область','Area'))
  areaLabel.append(areaSelect)
  const linksSection=el('section','ve-side-links')
  linksSection.append(el('h3','',tr('Связи','Links')),connections,available)
  panel.append(areaLabel,pin,linksSection,backlinks,tags)

  function connectionRow(other, name){
    const row=el('div','ve-connection')
    row.append(icon('link'))
    if(openNote){
      const link=button(name,null,()=>openNote(other.id),true)
      link.classList.add('ve-note-link')
      row.append(link)
    } else row.append(el('span','',name))
    return row
  }
  function sync(){
    if(!expanded)return
    const {areaId,pinned,links}=current()
    areaSelect.value=areaId||''
    const full=gridOptions.length && fullGridIds(areaSpace,[note.id])
    for(const {area,choice,pathLabel} of gridOptions){
      choice.disabled=area.id!==areaId && full.has(area.id)
      choice.textContent=pathLabel+(choice.disabled?tr(' · мест нет',' · full'):'')
    }
    const seated=gridOptions.some(({area})=>area.id===areaId)
    pin.disabled=seated
    pin.lastChild.textContent=seated?tr('На месте в сетке','Pinned to grid'):pinned?tr('Закреплена','Pinned'):tr('Закрепить на карте','Pin to map')
    pin.title=seated?pin.lastChild.textContent:pinned?tr('Открепить от карты','Unpin from map'):tr('Закрепить на карте','Pin to map')
    pin.setAttribute('aria-label',pin.title)
    pin.setAttribute('aria-pressed',String(seated||pinned))
    connections.replaceChildren();backlinks.replaceChildren()
    const choices=document.createDocumentFragment()
    choices.append(option('',tr('Добавить связь…','Add a link…')))
    for(const other of notes){
      if(other.id===note.id)continue
      const name=isProtectedNote(other)?protectedNoteTitle(other):other.title||tr('Без названия','Untitled')
      if(links.includes(other.id)){
        const row=connectionRow(other,name)
        row.append(button(tr('Убрать связь с «{name}»','Remove link to “{name}”',{name}),'close',()=>{
          update({links:current().links.filter(id=>id!==other.id)})
        }))
        connections.append(row)
      } else choices.append(option(other.id,name))
      if(other.links?.includes(note.id)){
        if(!backlinks.children.length)backlinks.append(el('h3','',tr('Обратные ссылки','Backlinks')))
        backlinks.append(connectionRow(other,name))
      }
    }
    available.replaceChildren(choices)
    available.disabled=available.options.length===1
    if(available.disabled)available.options[0].text=notes.length<2?tr('Других заметок пока нет','No other notes yet'):tr('Все заметки связаны','All notes are linked')
  }
  let lastTags=[]
  function setTags(values) {
    if(lastTags.length===values.length && values.every((tag,i)=>lastTags[i]===tag))return
    lastTags=values
    tags.replaceChildren(...values.map(tag=>{
      const chip=el(openTag?'button':'span','ve-tag','#'+tag)
      if(openTag){chip.type='button';chip.onclick=()=>openTag(tag,chip)}
      return chip
    }))
  }
  function uncoverNote(){
    if(expanded && getComputedStyle(panel).position==='fixed'){expanded=false;show()}
  }
  root.addEventListener('keydown',event=>{
    if(event.key==='Escape' && !event.defaultPrevented && !event.isComposing &&
        expanded && getComputedStyle(panel).position==='fixed' && !event.target.closest('dialog,[popover]')){
      event.preventDefault();event.stopPropagation()
      setExpanded(false);toggle.focus({preventScroll:true})
    }
  })
  root.addEventListener('pointerdown',event=>{
    if(expanded && !panel.contains(event.target) && !toggle.contains(event.target) &&
        !event.target.closest('dialog,[popover]') && getComputedStyle(panel).position==='fixed')setExpanded(false)
  })
  return {panel,toggle,sync,setTags,uncoverNote}
}

function noteSearchButton(onSearch){
  const label=tr('Поиск по заметкам','Search notes')
  const control=button(label,'search',onSearch)
  control.title=label+' ('+shortcutLabel('Ctrl+Shift+F')+')'
  control.setAttribute('aria-keyshortcuts',shortcutAria('Ctrl+Shift+F'))
  return control
}

function notePrivacyButton(manageProtection, isProtected) {
  const control = button('', null, async () => {
    control.disabled = true
    try { await manageProtection() }
    finally { control.disabled = false; refresh() }
  })
  function refresh() {
    const protectedNow = isProtected()
    const label = protectedNow ? tr('Снять шифрование заметки', 'Remove note encryption') : tr('Зашифровать заметку', 'Encrypt note')
    control.title = label
    control.setAttribute('aria-label', label)
    control.setAttribute('aria-haspopup', 'dialog')
    control.replaceChildren(icon(protectedNow ? 'padlock' : 'openPadlock'))
  }
  refresh()
  return control
}

async function finishNoteSession(root, beforeClose) {
  if (!beforeClose) return true
  const previous = document.activeElement, wasInert = root.inert
  let closing = false
  root.inert = true
  try { closing = await beforeClose(); return closing }
  finally {
    if (!closing) {
      root.inert = wasInert
      if (root.contains(previous) && document.activeElement === document.body) previous.focus({preventScroll:true})
    }
  }
}

function canvasEditor({note,notes,areas,onChange,onClose,onOpenNote,onSearch,backLabel,onReturn,beforeClose,manageProtection,isProtected,textAreaDefaults,saveIndicator,agentButton,agentTaskActions}){
  const previousFocus=document.activeElement
  const root=el('section','vd-editor ve-canvas-editor'), head=el('header','ve-head')
  root.setAttribute('role','dialog');root.setAttribute('aria-modal','true')
  root.setAttribute('aria-label',tr('Заметка-холст','Canvas note'))
  const title=el('input','ve-canvas-title')
  title.type='text';title.value=note.title||'';title.placeholder=tr('Холст без названия','Untitled canvas')
  title.setAttribute('aria-label',tr('Название заметки','Note title'))
  const searchReveal=createSearchReveal({root,title})
  const workspace=el('div','ve-board-layout'), host=el('div','ve-board-host')
  const crumb=el('div','ve-crumb')
  crumb.append(icon('board'),el('span','',tr('Холст','Canvas')))
  let boardDoc=normalizeBoard(note.board), summary=boardSummary(boardDoc), relations=noteRelations(note)
  let finished=false, closePending, navigating=false, savedTitle=title.value
  async function navigateTo(id){
    if(navigating||!onOpenNote)return
    navigating=true
    try{if(await close())onOpenNote(id)}finally{navigating=false}
  }
  const tagNav=createTagNavigator({root,notes,noteId:note.id,onOpenNote:onOpenNote && navigateTo})
  tagNav.trackTitle(title)
  const details=noteDetails({root,note,notes,areas,current:()=>relations,update:(patch,point)=>{
    relations={...relations,...patch};onChange?.({...patch,...point});details.sync()
  },openNote:onOpenNote && navigateTo,openTag:onOpenNote && tagNav.open})
  function emit(){
    savedTitle=title.value
    const tags=noteTags(title.value,summary.tagText)
    details.setTags(tags)
    onChange?.({title:title.value,type:'canvas',board:boardDoc,plain:summary.plain,tags,weight:summary.weight})
  }
  title.oninput=emit
  const back=button(backLabel,'back',goBack,true)
  head.append(back,el('span','ve-head-divider'),crumb,title,saveIndicator ?? el('span','ve-spacer'))
  if(onSearch)head.append(noteSearchButton(onSearch))
  if(agentButton)head.append(agentButton)
  if(manageProtection)head.append(notePrivacyButton(manageProtection,isProtected))
  head.append(details.toggle)
  const tasks=mountAgentTaskList(note.id,notes,{...agentTaskActions,openNote:navigateTo})
  workspace.append(host,details.panel);root.append(head,workspace,tasks.element);document.body.append(root)
  const board=mountBoard(host,{document:boardDoc,onFileMenu:openBoardFiles,textAreaDefaults,
    mountRichText:(host,options)=>openEditor({
      note:{id:note.id,body:options.body,plain:options.text},notes,
      onChange:options.onChange,onOpenNote:onOpenNote && navigateTo,embed:{...options,host}
    }),onChange:doc=>{
    boardDoc=doc;summary=boardSummary(doc);emit()
  }})
  function focus(){
    if(!title.value)title.focus()
    else board.focus()
  }
  function commitDraft(){
    if(title.value!==savedTitle)emit()
    return board.commitDraft()
  }
  function close(reason){
    if(finished)return Promise.resolve(true)
    if(closePending)return closePending
    closePending=(async()=>{
      if(title.value!==savedTitle)emit()
      if(!await board.prepareClose())return false
      if(!await finishNoteSession(root,beforeClose))return false
      searchReveal.clear();tagNav.destroy();board.destroy();root.remove();finished=true
      previousFocus?.focus?.({preventScroll:true})
      onClose?.(reason)
      return true
    })().finally(()=>{closePending=null})
    return closePending
  }
  async function goBack(){if(await close('back'))onReturn?.()}
  title.onkeydown=e=>{
    if(e.key==='Enter'&&!e.isComposing)board.focus()
  }
  root.addEventListener('keydown',e=>{
    if(e.defaultPrevented||e.isComposing||e.keyCode===229)return
    const direction=historyDirection(e)
    if(direction &&
        !host.contains(e.target) && !e.target.closest('dialog,input,select,textarea,[contenteditable="true"]')){
      e.preventDefault();e.stopPropagation()
      board.undo(direction==='redo')
      return
    }
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();goBack()}
    keepTabInEditor(e,root)
  })
  details.sync();details.setTags(noteTags(title.value,summary.tagText));focus()
  return {element:root,focus,close,commitDraft,prepareClose:close,refreshAgentTasks:tasks.refresh,revealSearchMatch(target){
    if(target?.kind==='canvasText')board.revealTextBlock(target.id,target.match)
    else if(target?.kind==='canvasLabel')board.revealTextBlock(target.id,target)
    else if(target?.kind==='tableCell')board.revealTableCell(target.id,target.address)
    else searchReveal.reveal(target)
  }}
}

export function openEditor({note, notes = [], areas = [], onChange, onClose, onOpenNote, onSearch, onReturn, beforeClose, manageProtection, isProtected, textAreaDefaults, saveIndicator, agentButton, agentTaskActions, embed, backLabel=tr('К карте','Back to map')}) {
  if(note.type==='canvas')return canvasEditor({note,notes,areas,onChange,onClose,onOpenNote,onSearch,backLabel,onReturn,beforeClose,manageProtection,isProtected,textAreaDefaults,saveIndicator,agentButton,agentTaskActions})
  let body = Array.isArray(note.body) && note.body.length ? note.body :
    (note.plain || '').split('\n').map(s => ({type:'paragraph',runs:s ? [{text:s}] : []}))
  if (!body.length) body = [paragraph()]
  let title = note.title || '', relations = noteRelations(note), navigating=false
  let active = 0, finished = false, closePending, lastKey = '', lastInput = 0
  const pendingImages = new Set()
  const inlineIds = new WeakMap(), inlineViews = new Map()
  let activeInline = null
  const past = [], future = []
  const previousFocus = document.activeElement
  const root = el('section',embed?'vd-editor ve-embedded-editor':'vd-editor')
  if(!embed){root.setAttribute('role','dialog');root.setAttribute('aria-modal','true')}
  root.setAttribute('aria-label',embed?tr('Текстовая область','Text area'):tr('Редактор заметки','Note editor'))
  const head = el('header','ve-head'), crumb = el('div','ve-crumb'), scroll = el('div','ve-scroll'), layout = el('div','ve-layout')
  const main = el('main','ve-main')
  const titleBox = el('textarea','ve-title')
  titleBox.rows=1; titleBox.placeholder=tr('Без названия','Untitled');titleBox.setAttribute('aria-label',tr('Название заметки','Note title'));titleBox.value=title
  const toolbar=el('div','ve-toolbar'), content=el('div','ve-content'), count=el('span','ve-count'), message=el('span','ve-message')
  toolbar.setAttribute('role','group')
  toolbar.setAttribute('aria-label',tr('Форматирование текста','Text formatting'))
  message.setAttribute('role','status')
  let blockRefs = [], codeViews = new Map()
  async function navigateTo(id){
    if(navigating||!onOpenNote)return
    navigating=true
    try{if(embed || await prepareClose())onOpenNote(id)}finally{navigating=false}
  }
  const tagNav=createTagNavigator({root,notes,noteId:note.id,onOpenNote:onOpenNote && navigateTo})
  if(!embed)tagNav.trackTitle(titleBox)
  const searchReveal=createSearchReveal({root,scroll:embed?content:scroll,title:titleBox,focusBlock,
    visibleTop:embed?undefined:()=>toolbar.getBoundingClientRect().bottom,
    onSearchPoint:embed?.onSearchPoint,blockAt(index){
    const block=body[index],row=blockRefs[index]
    if(!row||!block)return null
    if(block.type==='code')return {node:row.querySelector('.ve-code-mirror'),input:row.querySelector('.ve-code-source')}
    if(!textTypes.has(block.type))return null
    // A native line break in a still-open contenteditable may currently be a
    // <br>. Restore the saved runs before mapping its searchable text offsets.
    if(row.textContent!==blockText(block)){row.replaceChildren();appendRuns(row,block.runs);tagNav.paint(row)}
    return {node:row}
  }})
  const resizeTitle=()=>{
    titleBox.style.height='auto'
    titleBox.style.height=titleBox.scrollHeight+'px'
    tagNav.syncTitle()
  }
  // offsetHeight/clientHeight are layout pixels, independent of board zoom and rotation.
  const overflowHeight=()=>Math.max(0,content.offsetHeight-embed.host.clientHeight)
  const sizeObserver = new ResizeObserver(entries => {
    if(embed){if(overflowHeight())embed.onOverflow?.();return}
    for(const {target,contentRect} of entries){
      if(target===toolbar)scroll.style.scrollPaddingTop=(toolbar.offsetHeight+4)+'px'
      if(target===titleBox && sizeObserver.lastWidth!==contentRect.width){sizeObserver.lastWidth=contentRect.width;resizeTitle()}
    }
  })
  function currentSelection() {
    if (body[active]?.type === 'code') {
      const input = blockRefs[active]?.querySelector('.ve-code-source')
      if (input) return {index:active,start:input.selectionStart,end:input.selectionEnd}
    }
    const sel = getSelection()
    if (!sel.rangeCount) return null
    const r = sel.getRangeAt(0), root = blockRefs[active]
    if (!root || !root.contains(r.startContainer) || !root.contains(r.endContainer) || !textTypes.has(body[active]?.type)) return null
    return {index:active,start:offsetAt(root,r.startContainer,r.startOffset),end:offsetAt(root,r.endContainer,r.endOffset)}
  }
  const mapRecord=notes.find(n=>n.id===note.id)||note
  function capture() {
    return {title, body, relations, point:{x:mapRecord.x,y:mapRecord.y}, mark:currentSelection() || {index:active,start:0}, inTitle:document.activeElement === titleBox, titleOffset:titleBox.selectionStart}
  }
  let checkpoint=false
  function remember(key) {
    const now=performance.now()
    checkpoint=!key || key!==lastKey || now-lastInput>750
    if (!embed && checkpoint) {
      past.push(capture())
      if(past.length>80)past.shift()
    }
    future.length=0;lastKey=key||'';lastInput=now
  }
  function meta() {
    let mediaWeight=0
    const tagParts=[]
    const parts=body.map(block=>{
      if(block.type==='drawing' && block.board){
        const {plain,tagText,weight}=boardSummary(block.board)
        tagParts.push(tagText)
        mediaWeight+=150+weight-plain.length
        return plain
      }
      if(block.type==='image')mediaWeight+=300
      if(block.type==='drawing')mediaWeight+=150+(block.strokes?.length||0)*8
      const text=blockText(block)
      tagParts.push(blockTagText(block,text))
      return text
    })
    const plain=parts.join('\n')
    return {title,bodyVersion:1,body,plain,tags:noteTags(title,tagParts.join('\n')),weight:plain.length+mediaWeight,...relations}
  }
  function indicators(data) {
    if(embed){refreshEmbeddedHistory();return}
    const words=data.plain.trim() ? data.plain.trim().split(/\s+/u).length : 0
    const wordCount={count:words.toLocaleString(getLanguage())}
    const summary=[words===1?tr('{count} сл.','{count} word',wordCount):tr('{count} сл.','{count} words',wordCount)]
    const {pending,done,cancelled}=taskCounts(body)
    const total=pending+done
    if(total+cancelled>=2){
      if(total)summary.push(tr('Готово {done} из {total}','{done} of {total} done',{done,total}))
      if(cancelled)summary.push(tr('Отменено {count}','{count} cancelled',{count:cancelled}))
    }
    count.textContent=summary.join(' · ')
    undoBtn.disabled=!past.length;redoBtn.disabled=!future.length
    details.setTags(data.tags)
    activeInline?.refreshHistory?.()
  }
  function emit(point){
    const data=meta()
    if(embed)onChange?.({body,plain:data.plain},checkpoint)
    else onChange?.(point?{...data,...point}:data)
    checkpoint=false
    indicators(data)
  }
  function refreshEmbeddedHistory(){
    const available=embed.historyState()
    undoBtn.disabled=!available.undo;redoBtn.disabled=!available.redo
  }
  function history(redo) {
    if(embed){lastKey='';embed.onUndo(redo);return}
    activeInline?.flush()
    const from=redo?future:past,to=redo?past:future
    if(!from.length)return
    to.push(capture())
    const snap=from.pop()
    const moved=snap.relations.areaId!==relations.areaId||snap.relations.slot!==relations.slot
    ;({title,body,relations}=snap)
    lastKey='';titleBox.value=title;resizeTitle()
    render();emit(moved?snap.point:null);details.sync()
    if(activeInline && content.contains(activeInline.row) && activeInline.row.contains(document.activeElement)) {
      active=blockRefs.indexOf(activeInline.row)
    } else if(snap.inTitle){titleBox.focus();titleBox.setSelectionRange(snap.titleOffset,snap.titleOffset)}
    else focusBlock(snap.mark.index,snap.mark.start,snap.mark.end)
  }
  function focusBlock(i,offset=0,end=offset,showCaret=true){
    if (!body.length) return
    active=Math.max(0,Math.min(i,body.length-1))
    if(textTypes.has(body[active].type)){
      setCaret(blockRefs[active],offset,end)
      if(showCaret)revealTextCaret(blockRefs[active])
    }
    else if(body[active].type==='code'){
      const input=blockRefs[active].querySelector('.ve-code-source')
      input.focus({preventScroll:true});input.setSelectionRange(offset,end)
    }else blockRefs[active]?.focus()
    syncTools()
  }
  function revealTextCaret(row){
    if(embed)return
    const sel=getSelection()
    if(!sel.rangeCount || !row.contains(sel.focusNode))return
    const range=document.createRange()
    range.setStart(sel.focusNode,sel.focusOffset);range.collapse(true)
    const box=range.getBoundingClientRect(),caret=box.height?box:row.getBoundingClientRect()
    const view=scroll.getBoundingClientRect(), top=Math.max(view.top,toolbar.getBoundingClientRect().bottom)+4
    if(caret.top<top)scroll.scrollTop+=caret.top-top
    else if(caret.bottom>view.bottom-4)scroll.scrollTop+=caret.bottom-view.bottom+4
  }
  // Closing can interrupt input-method composition. Compare the editing
  // surface with the model before an awaited import or board flush can redraw it.
  function finishTextInput(){
    let updated=title!==titleBox.value
    title=titleBox.value
    const block=body[active], row=blockRefs[active]
    if(row && textTypes.has(block?.type)){
      const runs=readRuns(row)
      if(runs.map(run=>run.text).join('')!==blockText(block)){
        body=[...body];body[active]={...block,runs};updated=true
      }
    }else if(row && block?.type==='code'){
      const input=row.querySelector('.ve-code-source')
      if(input && input.value!==(block.text||'').replace(/\r\n?/g,'\n')){
        body=[...body];body[active]={...block,text:input.value};updated=true
      }
    }
    if(updated){checkpoint=true;emit()}
  }
  async function flush(closing=true){
    if(finished)return true
    finishTextInput()
    if((await Promise.all([...inlineViews.values()].map(v=>closing?v.prepareClose():v.commitDraft()))).includes(false))return false
    if(pendingImages.size)await Promise.allSettled([...pendingImages])
    if(embed){
      const loading=[...content.querySelectorAll('img')].filter(image=>!image.complete)
      await Promise.allSettled(loading.map(image=>image.decode()))
    }
    return true
  }
  let removeFloatingTools, stopColorPicker
  function destroy(){
    if(finished)return
    removeFloatingTools?.()
    stopColorPicker?.()
    finished=true;searchReveal.clear();tagNav.destroy();sizeObserver.disconnect()
    for(const v of inlineViews.values())v.destroy()
    inlineViews.clear()
    document.removeEventListener('selectionchange',syncTools)
    root.remove()
  }
  function close(reason){
    if(finished)return Promise.resolve(true)
    if(closePending)return closePending
    closePending=(async()=>{
      if(!await flush())return false
      if(!await finishNoteSession(root,beforeClose))return false
      destroy();previousFocus?.focus?.({preventScroll:true})
      onClose?.(reason)
      return true
    })().finally(()=>{closePending=null})
    return closePending
  }
  const prepareClose=close
  async function goBack(){if(await close('back'))onReturn?.()}
  function applyBody(next, focus, offset, end=offset) {
    body=next.length?next:[paragraph()]
    active=Math.min(Math.max(0,focus),body.length-1)
    render();focusBlock(active,offset,end)
    emit()
  }
  function ensureText(){
    if(textTypes.has(body[active]?.type)) {
      if(!currentSelection())focusBlock(active,blockText(body[active]).length)
    } else {
      remember()
      const next=[...body];next.splice(active+1,0,paragraph());applyBody(next,active+1,0)
    }
  }
  function format(command,value){
    ensureText()
    // Native rich editing preserves selection and IME behavior in WebView2 and WebKit.
    document.execCommand(command,false,value)
    syncTools()
  }
  function replaceAtMark(blocks,{index,start,end},appendText=false){
    remember()
    index=Math.min(index,body.length-1)
    const b=body[index], next=[...body]
    if(textTypes.has(b.type)){
      const before=sliceRuns(b.runs,0,start), after=sliceRuns(b.runs,end)
      const inserted=[]
      if(before.length)inserted.push({...b,runs:before})
      inserted.push(...blocks)
      const focus=index+inserted.length
      if(after.length||appendText){
        const keepTask=after.length && !before.length
        if(isTaskStyle(listStyleOf(b)) && !keepTask)inserted.push(continuedListItem(b,after))
        else inserted.push({...(listStyleOf(b) ? b : paragraph()),runs:after})
      }
      next.splice(index,1,...inserted)
      applyBody(next,Math.min(focus,next.length-1),0)
    }else{
      const trailing=appendText && !textTypes.has(next[index+1]?.type)?[paragraph()]:[]
      next.splice(index+1,0,...blocks,...trailing)
      applyBody(next,index+blocks.length+Number(appendText),0)
    }
  }
  function position(){
    return currentSelection() || {index:active,start:blockText(body[active]).length,end:blockText(body[active]).length}
  }
  const filePicker=el('input','ve-hidden')
  filePicker.type='file';filePicker.multiple=true;filePicker.accept='image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif'
  let imageMark
  function insertImages(files, mark) {
    const images=[...files].filter(f=>/^image\/(?:png|jpe?g|webp|gif|bmp|avif)$/i.test(f.type))
    if(!images.length){message.textContent=tr('Выберите PNG, JPEG, WebP, GIF, BMP или AVIF','Choose a PNG, JPEG, WebP, GIF, BMP, or AVIF image.');return}
    const anchor = body[mark.index]
    const task=Promise.all(images.map(file=>new Promise((resolve,reject)=>{
        const reader=new FileReader()
        reader.onload=()=>resolve({type:'image',src:reader.result,alt:file.name||''})
        reader.onerror=()=>reject(reader.error)
        reader.readAsDataURL(file)
    }))).then(blocks=>{
      if(!finished){
        const i=body.indexOf(anchor)
        replaceAtMark(blocks,i<0?position():{...mark,index:i},true);message.textContent=''
      }
    }).catch(()=>{message.textContent=tr('Не удалось прочитать изображение','Could not read the image.')})
      .finally(()=>pendingImages.delete(task))
    pendingImages.add(task)
    return task
  }
  filePicker.onchange=()=>{insertImages(filePicker.files,imageMark||position());filePicker.value=''}
  function paste(e) {
    e.preventDefault()
    if(e.clipboardData.files.length){insertImages(e.clipboardData.files,position());return}
    const mark=position()
    const plain=e.clipboardData.getData('text/plain')
    const snippet=pastedCode(plain,blockText(body[mark.index]).trim()==='')
    if(snippet){insertCode(snippet,mark);return}
    const html=e.clipboardData.getData('text/html')
    const template=html ? el('template') : null
    // Template contents are inert. Only validated text marks are rebuilt in the editor.
    if(template)template.innerHTML=html
    const runs=readClipboardRuns(template?.content,plain || null,marksForElement)
    if(!runs.length)return
    const clean=el('div')
    appendRuns(clean,runs)
    document.execCommand('insertHTML',false,clean.innerHTML)
  }
  function autoList(e,i){
    if(e.isComposing || !e.cancelable || e.inputType!=='insertText' || e.data!==' ' || body[i].type!=='paragraph')return
    const mark=currentSelection()
    if(!mark || mark.start!==mark.end || mark.start>5)return
    const block=body[i], item=listItemForPrefix(block,blockText(block).slice(0,mark.start))
    if(!item)return
    e.preventDefault();remember()
    const next=[...body]
    next[i]={...item,runs:sliceRuns(block.runs,mark.start)}
    applyBody(next,i,0)
  }
  function visualLineEdge(row, direction) {
    const selection=getSelection(), saved=selection.getRangeAt(0).cloneRange()
    selection.modify('move',direction,'lineboundary')
    const edge=row.contains(selection.focusNode)?offsetAt(row,selection.focusNode,selection.focusOffset):null
    selection.removeAllRanges();selection.addRange(saved)
    return edge
  }
  function moveVertically(i,offset,up) {
    const next=up?i-1:i+1
    if(!body[next])return false
    const limit=up?0:blockText(body[i]).length
    const row=blockRefs[i]
    const edge=up?blockText(body[next]).length:0
    if(!getSelection().modify){
      if(offset!==limit)return false
      focusBlock(next,edge);return true
    }
    if(offset!==limit && visualLineEdge(row,up?'backward':'forward')!==limit)return false
    const column=up?offset:offset-(visualLineEdge(row,'backward')??offset)
    focusBlock(next,edge)
    if(!textTypes.has(body[next].type))return true
    const other=visualLineEdge(blockRefs[next],up?'backward':'forward')??edge
    const text=blockText(body[next])
    let target=Math.min(Math.min(edge,other)+column,Math.max(edge,other))
    if(target>0 && /[\uDC00-\uDFFF]/.test(text.charAt(target)))target--
    setCaret(blockRefs[next],target)
    revealTextCaret(blockRefs[next])
    return true
  }
  function textKeys(e,i){
    if(e.isComposing || e.keyCode===229)return
    const mark=currentSelection()
    if(!mark)return
    if(primaryCommand(e) && !e.shiftKey && ['KeyB','KeyI','KeyK'].includes(e.code)){
      e.preventDefault();e.stopPropagation()
      if(!e.repeat){
        if(e.code==='KeyK')linkDialog()
        else format(e.code==='KeyB'?'bold':'italic')
      }
      return
    }
    if(!e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && mark.start===mark.end){
      if((e.key==='ArrowUp'||e.key==='ArrowDown') && moveVertically(i,mark.start,e.key==='ArrowUp')){
        e.preventDefault();return
      }
      if(e.key==='ArrowLeft'&&mark.start===0&&i>0){
        e.preventDefault();focusBlock(i-1,blockText(body[i-1]).length);return
      }
      if(e.key==='ArrowRight'&&mark.end===blockText(body[i]).length&&i+1<body.length){
        e.preventDefault();focusBlock(i+1,0);return
      }
    }
    const block=body[i], style=listStyleOf(block)
    if(isTaskStyle(style) && primaryCommand(e) && !e.shiftKey && e.key==='Enter'){
      e.preventDefault();e.stopPropagation()
      if(!e.repeat)changeTask(i,'done')
      return
    }
    if(style && e.key==='Tab' && !e.altKey && !e.ctrlKey && !e.metaKey){
      e.preventDefault();e.stopPropagation();indent(e.shiftKey?-1:1);return
    }
    const emptyEnter=e.key==='Enter' && blockText(block)===''
    const initialBackspace=e.key==='Backspace' && mark.start===0 && mark.end===0
    if(style && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (emptyEnter || initialBackspace)){
      e.preventDefault();remember()
      const next=[...body];next[i]=atParentLevel(body,i);applyBody(next,i,0);return
    }
    if(e.key==='Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey){
      e.preventDefault()
      if(!e.altKey && block.type==='paragraph' && !style && mark.start===3 && mark.end===3 && blockText(block)==='---'){
        insertDivider(mark,true)
        return
      }
      remember()
      const b=body[i],next=[...body]
      const first=sliceRuns(b.runs,0,mark.start), rest=sliceRuns(b.runs,mark.end)
      if(isTaskStyle(style) && !mark.start && !mark.end && rest.length){
        next.splice(i,1,continuedListItem(b,first),{...b,runs:rest})
      }else next.splice(i,1,{...b,runs:first},continuedListItem(b,rest))
      applyBody(next,i+1,0)
    }else if(mark.start===mark.end && ((e.key==='Backspace' && mark.start===0 && i>0)||(e.key==='Delete'&&mark.end===blockText(body[i]).length&&i+1<body.length))){
      e.preventDefault()
      const left=e.key==='Backspace'?i-1:i,right=left+1
      const adjacent=e.key==='Backspace'?left:right
      if(body[adjacent].type==='divider' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey){
        removeBlock(adjacent,left,mark.start);return
      }
      if(!textTypes.has(body[left].type)||!textTypes.has(body[right].type)){
        focusBlock(e.key==='Backspace'?left:right,0);return
      }
      remember()
      const offset=blockText(body[left]).length,next=[...body]
      next.splice(left,2,{...body[left],runs:[...body[left].runs,...body[right].runs]})
      applyBody(next,left,offset)
    }
  }
  function external(e){
    const a=e.target.closest('a')
    if(!a)return
    e.preventDefault()
    if(a.dataset.folderPath){
      if(!getSelection()?.isCollapsed && e.detail) return
      message.textContent=''
      openFolder(a.dataset.folderPath).catch(error=>{message.textContent=folderError(error)})
      return
    }
    const href=safeLink(a.href)
    if (!href || (!e.ctrlKey && !e.metaKey))return
    if(window.runtime?.BrowserOpenURL)window.runtime.BrowserOpenURL(href)
    else window.open(href,'_blank','noopener,noreferrer')
  }
  content.addEventListener('keydown',event=>{
    if(event.key==='Enter' && event.target.matches('a[data-folder-path]')){
      event.stopPropagation();external(event)
    }
  },true)
  function removeBlock(i,focus=i,offset=0) {
    remember()
    const next=[...body];next.splice(i,1)
    applyBody(next,focus,offset)
  }
  function insertDivider({index,start},fromTyping=false) {
    activeInline?.flush()
    remember()
    const block=body[index], inserted=[]
    const isText=textTypes.has(block.type), splitText=isText && !fromTyping
    const before=splitText ? sliceRuns(block.runs,0,start) : []
    const after=splitText ? sliceRuns(block.runs,start) : []
    if(before.length)inserted.push({...block,runs:before})
    else if(!isText)inserted.push(block)
    inserted.push({type:'divider'})
    const focus=index+inserted.length
    if(after.length){
      const splitTask=before.length && isTaskStyle(listStyleOf(block))
      inserted.push(splitTask ? continuedListItem(block,after) : {...block,runs:after})
    }
    else if(!textTypes.has(body[index+1]?.type))inserted.push(paragraph())
    const next=[...body]
    next.splice(index,1,...inserted)
    applyBody(next,focus,0)
  }
  function insertCode(snippet,mark=position()) {
    activeInline?.flush()
    const selection=textTypes.has(body[mark.index].type) ? blockText(body[mark.index]).slice(mark.start,mark.end) : ''
    const block=snippet||{type:'code',language:'auto',text:selection}
    replaceAtMark([block],mark,true)
    const index=body.indexOf(block)
    focusBlock(index,block.text.length)
    blockRefs[index].scrollIntoView({block:'nearest'})
  }
  function moveFromBlock(index,direction,continueText) {
    const next=index+direction
    if(continueText && !textTypes.has(body[next]?.type)){
      remember()
      const blocks=[...body];blocks.splice(index+1,0,paragraph())
      applyBody(blocks,index+1,0)
    }else if(next>=0 && next<body.length){
      focusBlock(next,direction<0?blockText(body[next]).length:0)
    }else if(direction<0 && !embed){titleBox.focus();return true}else return false
    blockRefs[active]?.scrollIntoView({block:'nearest'})
    return true
  }
  const inlineRows = new WeakMap()
  const workbooks = noteWorkbooks()
  let refreshedRevision = -1
  function refreshWorkbooks(){
    if(refreshedRevision===workbooks.revision)return
    for(const view of inlineViews.values())view.refreshWorkbook()
    refreshedRevision=workbooks.revision
  }
  function updatedPeers(index,next,structure){
    const before=body[index].board?.elements, after=next.board?.elements
    if(!before || !after || before===after)return []
    const names=new Map()
    const updatedTables=new Map(after.filter(e=>e.type==='table').map(e=>[e.id,e]))
    for(const item of before){
      if(item.type!=='table' || !item.name)continue
      const updated=updatedTables.get(item.id)
      if(!updated || updated.name===item.name)continue
      // A duplicated old name could only have resolved inside its own block.
      if(uniqueTableName(workbooks.peers(inlineIds.get(body[index])),item.name)===item.name)names.set(item.name,updated.name)
    }
    const sourceKey=inlineIds.get(body[index])
    const sourceTable=structure && updatedTables.get(structure.id)
    if(!names.size && !sourceTable)return []
    let deletedIndices
    if(sourceTable && structure.kind==='delete'){
      const previous=before.find(item=>item.type==='table' && item.id===sourceTable.id)
      deletedIndices=[...structure.indices].filter(i=>Number.isInteger(i) && i>=0 && i<previous[structure.axis])
    }
    const affected=[]
    body.forEach((block,i)=>{
      if(i===index || !hasTables(block))return
      const original=block.board.elements
      let elements=original
      if(names.size)elements=elements.map(e=>e.type==='table'?rewriteCells(e,names):e)
      if(sourceTable && workbooks.canReference(inlineIds.get(block),sourceKey,sourceTable)){
        elements=deletedIndices
          ? rebaseTableLinksAfterDelete(elements,sourceTable.name,structure.axis,deletedIndices)
          : rebaseTableLinks(elements,sourceTable.name,structure.axis,structure.index,structure.count)
      }
      if(elements!==original && elements.some((e,j)=>e!==original[j])) {
        affected.push([i,{...block,board:{...block.board,elements}}])
      }
    })
    return affected
  }
  function activateInline(view){
    if(!view || finished)return
    if(activeInline!==view){
      const previous=activeInline
      activeInline=view
      previous?.setActive(false)
    }
    const index=blockRefs.indexOf(view.row)
    if(index>=0)active=index
    view.setActive(true)
    syncTools()
  }
  function leaveInline(){
    const previous=activeInline
    activeInline=null
    previous?.setActive(false)
  }
  function inlineFor(block){
    let id=inlineIds.get(block)
    if(!id){id=Symbol();inlineIds.set(block,id)}
    if(!hasTables(block))workbooks.forget(id)
    let view=inlineViews.get(id)
    const direct=isDirectTableBlock(block)
    if(view && Boolean(view.direct)!==direct){
      if(activeInline===view)activeInline=null
      inlineViews.delete(id);view.destroy();view=null
    }
    if(view){view.update(block);return view}
    const index=()=>body.findIndex(b=>inlineIds.get(b)===id)
    const createView=direct?createDirectTables:createInlineBoard
    view=createView(block,{
      key:id,
      peerTables:()=>workbooks.peers(id),
      workbook:elements=>workbooks.workbook(id,elements),
      canRenameTable:(_table,name)=>uniqueTableName(workbooks.peers(id),name)===name.trim(),
      activate:()=>activateInline(view),
      exit(){
        const i=index()
        leaveInline()
        if(i>=0 && textTypes.has(body[i+1]?.type))focusBlock(i+1)
        else if(i>0 && textTypes.has(body[i-1]?.type))focusBlock(i-1,blockText(body[i-1]).length)
        else titleBox.focus({preventScroll:true})
      },
      remove(){const i=index();if(i>=0)removeBlock(i)},
      undo:history,
      message:text=>{message.textContent=text},
      historyState:()=>({undo:!!past.length,redo:!!future.length}),
      change(next,checkpoint,structure){
        const i=index()
        if(i<0 || finished || inlineViews.get(id)!==view)return
        if(checkpoint)remember()
        const switchView=Boolean(view.direct)!==isDirectTableBlock(next)
        const affected=workbooks.revision===refreshedRevision && !structure && !switchView ? [] : updatedPeers(i,next,structure)
        inlineIds.set(next,id)
        body=[...body];body[i]=next
        if(!hasTables(next))workbooks.forget(id)
        for(const [index,other] of affected){
          const key=inlineIds.get(body[index])
          inlineIds.set(other,key);body[index]=other
          inlineViews.get(key)?.update(other)
        }
        if(switchView){
          render()
          const replacement=inlineViews.get(id)
          activateInline(replacement);replacement.row.focus({preventScroll:true})
        }
        refreshWorkbooks()
        emit()
      }
    })
    inlineViews.set(id,view);inlineRows.set(view.row,view)
    return view
  }
  function insertInline(table){
    activeInline?.flush()
    const mark=position()
    const block=table
      ? newTableBlock(uniqueTableName(workbooks.peers(),tr('Таблица 1','Table 1')))
      : {type:'drawing',presentation:'drawing',board:emptyBoard()}
    replaceAtMark([block],mark,true)
    const view=inlineViews.get(inlineIds.get(block))
    activateInline(view)
    view.row.scrollIntoView({block:'nearest'})
    if(table)view.focus()
    else view.startDrawing()
  }
  function trackInline(event){
    const frame=event.target.closest('[data-note-embed]')
    if(frame){
      const target=inlineRows.get(frame)
      if(event.type==='pointerdown' && target && activeInline && target!==activeInline){
        const table=target.tableAt(event.target)
        if(table && activeInline.pickExternalCell(event,table,workbooks.canReference(activeInline.key,target.key,table)))return
      }
      activateInline(target)
    }
    else if(tableBtn.contains(event.target))return
    else if(activeInline && !event.target.closest('dialog'))leaveInline()
  }
  root.addEventListener('pointerdown',trackInline,true)
  root.addEventListener('focusin',trackInline,true)
  function syncTaskRow(wrapper,block){
    const state=taskStateOf(block)
    wrapper.dataset.taskState=state
    for(const control of wrapper.querySelectorAll('.ve-task-control')){
      const done=control.dataset.outcome==='done', selected=state===control.dataset.outcome
      control.setAttribute('aria-checked',String(selected))
      const action=selected ? tr('Вернуть в работу','Reopen task') :
        done ? tr('Отметить выполненной','Mark complete') : tr('Отменить задачу','Cancel task')
      control.title=done ? action+' ('+shortcutLabel('Ctrl+Enter')+')' : action
    }
  }
  function changeTask(i,outcome){
    const next=toggleTask(body[i],outcome)
    if(next===body[i])return
    remember()
    body=[...body];body[i]=next
    // Keep the native selection, keyboard focus and any adjacent editor intact.
    syncTaskRow(blockRefs[i].parentNode,next)
    emit()
  }
  function taskRow(row,block,i){
    const wrapper=el('div','ve-task-row'), controls=el('div','ve-task-controls')
    wrapper.style.marginInlineStart=indentOf(block)*20+'px'
    row.id='ve-task-text-'+(++taskTextId)
    for(const outcome of block.listStyle==='task-choice'?['done','cancelled']:['done']){
      const done=outcome==='done'
      const control=el('button','ve-task-control')
      control.type='button';control.dataset.outcome=outcome
      control.setAttribute('role','checkbox')
      control.setAttribute('aria-label',done?tr('Задача выполнена','Task complete'):tr('Задача отменена','Task cancelled'))
      control.setAttribute('aria-describedby',row.id)
      control.append(icon(done?'check':'close'))
      control.onmousedown=e=>{if(e.button===0)e.preventDefault()}
      control.onfocus=()=>{active=i;syncTools()}
      control.onclick=()=>changeTask(i,outcome)
      controls.append(control)
    }
    row.setAttribute('aria-keyshortcuts',shortcutAria('Ctrl+Enter'))
    wrapper.append(controls,row)
    syncTaskRow(wrapper,block)
    return wrapper
  }
  function render() {
    tagNav.clearPaint()
    blockRefs=[]
    const previousCodeViews=codeViews
    codeViews=new Map()
    const keep=new Set()
    const markers=listMarkers(body)
    const rows=body.map((b,i)=>{
      if(textTypes.has(b.type)){
        const row=el('div','ve-text ve-'+b.type);row.contentEditable='true'
        const task=isTaskStyle(listStyleOf(b))
        if(!task)row.style.marginInlineStart=indentOf(b)*20+'px'
        row.spellcheck=true;row.setAttribute('role','textbox');row.setAttribute('aria-multiline','true')
        const label=tr('Текст заметки, блок ','Note text, block ')+(i+1)
        if(markers[i] && !task){
          row.classList.add('ve-list-item')
          row.dataset.marker=markers[i]
          row.style.setProperty('--ve-marker-width',Math.max(2,markers[i].length)+'ch')
        }
        row.setAttribute('aria-label',task ? tr('Текст задачи, блок ','Task text, block ')+(i+1) :
          markers[i]?label+' · '+tr('Пункт списка','List item')+' '+markers[i]:label)
        row.dataset.placeholder=task?tr('Задача…','Task…'):body.length===1?tr('Начните писать…','Start writing…'):''
        appendRuns(row,b.runs)
        tagNav.paint(row)
        row.onfocus=()=>{active=i;syncTools()}
        row.onkeydown=e=>{if(!tagNav.keydown(e,row))textKeys(e,i)}
        row.onbeforeinput=e=>autoList(e,i);row.onpaste=paste
        row.onclick=e=>{if(!tagNav.activate(e,row))external(e)}
        row.oninput=()=>{
          remember('block-'+i);body=[...body];body[i]={...body[i],runs:readRuns(row)}
          tagNav.paint(row)
          emit();syncTools()
        }
        blockRefs.push(row);return task?taskRow(row,b,i):row
      }
      if(b.type==='code'){
        let view=previousCodeViews.get(b)
        if(view)view.setIndex(i)
        else view=createCodeBlockView(b,{el,button,index:i,
          activate:index=>{active=index;syncTools()},
          beforeEdit:remember,history,
          change(next,index){
            codeViews.delete(body[index]);codeViews.set(next,view)
            body=[...body];body[index]=next;emit()
          },
          move:moveFromBlock,remove:removeBlock,
        })
        codeViews.set(b,view)
        blockRefs.push(view.row);return view.row
      }
      if(b.type==='divider'){
        const row=el('hr','ve-rule')
        row.tabIndex=0;row.setAttribute('aria-label',tr('Горизонтальная линия','Horizontal rule'))
        row.onfocus=()=>{active=i;syncTools()}
        row.onkeydown=e=>{
          if(e.isComposing || e.keyCode===229 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)return
          if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();removeBlock(i);return}
          if(['ArrowUp','ArrowLeft','ArrowDown','ArrowRight','Enter'].includes(e.key)){
            e.preventDefault()
            moveFromBlock(i,e.key==='ArrowUp'||e.key==='ArrowLeft'?-1:1,e.key==='Enter')
          }
        }
        blockRefs.push(row);return row
      }
      if(b.type==='drawing'&&(Array.isArray(b.strokes)||b.board)){
        const view=inlineFor(b)
        keep.add(inlineIds.get(b));blockRefs.push(view.row)
        return view.row
      }
      const row=el('figure','ve-media');blockRefs.push(row);row.tabIndex=0
      row.onfocus=()=>{active=i;syncTools()}
      row.onkeydown=e=>{if(e.target===row&&(e.key==='Backspace'||e.key==='Delete')){e.preventDefault();removeBlock(i)}}
      const ops=el('div','ve-media-actions')
      if(b.type==='image' && safeImage(b.src)){
        const img=el('img');img.src=b.src;img.alt=b.alt||tr('Изображение','Image');img.draggable=false;row.append(img)
      }else row.append(el('figcaption','',tr('Вложение','Attachment')))
      ops.append(button(tr('Убрать блок','Remove block'),'trash',()=>removeBlock(i)))
      row.append(ops)
      row.addEventListener('click',e=>{if(!e.target.closest('button'))row.focus()})
      return row
    })
    for(const [id,view] of inlineViews)if(!keep.has(id)){
      if(activeInline===view)activeInline=null
      inlineViews.delete(id);workbooks.forget(id);view.destroy()
    }
    // Keep surviving board nodes attached so a text edit in a neighbouring
    // paragraph preserves their viewport, input focus and pending imports.
    const scrollTop=scroll.scrollTop, retained=new Set(rows)
    for(const row of [...content.children])if(!retained.has(row))row.remove()
    rows.forEach((row,i)=>{if(content.children[i]!==row)content.insertBefore(row,content.children[i]||null)})
    if(scrollTop)scroll.scrollTop=scrollTop
    for(const view of inlineViews.values())view.mount()
    refreshWorkbooks()
    syncTools()
  }
  function insertLinkAt(mark, link) {
    const block=body[mark.index]
    if(!textTypes.has(block.type)){
      replaceAtMark([{...paragraph(),runs:[link]}],mark)
      return
    }
    const next=[...body], after=sliceRuns(block.runs,mark.end)
    const selected=sliceRuns(block.runs,mark.start,mark.end)
    const runs=selected.length && selected.map(r=>r.text).join('')===link.text
      ? selected.map(({href,folderPath,...run})=>({...run,...link,text:run.text}))
      : [link]
    remember()
    next[mark.index]={...block,runs:[...sliceRuns(block.runs,0,mark.start),...runs,...after]}
    applyBody(next,mark.index,mark.start+link.text.length)
    // Position subsequent typing outside the editable link, including at the end of a paragraph.
    const selection=getSelection(), anchor=selection.focusNode?.parentElement?.closest('a')
    if(anchor && blockRefs[mark.index].contains(anchor)){
      const range=document.createRange()
      range.setStartAfter(anchor);range.collapse(true)
      selection.removeAllRanges();selection.addRange(range)
    }
  }
  async function insertFolder(){
    if(!canPickFolder()){linkDialog(true);return}
    const mark=position(), block=body[mark.index]
    message.textContent=''
    try{
      const path=await pickFolder()
      if(!path||finished||closePending||document.querySelector('.vault-lock-screen'))return
      const index=body.indexOf(block)
      if(index<0)return
      const label=blockText(block).slice(mark.start,mark.end)
      insertLinkAt({...mark,index},{text:label||folderLabel(path),folderPath:path})
    }catch(error){message.textContent=folderError(error)}
  }
  function linkDialog(folderOnly=false){
    ensureText()
    const mark=currentSelection()
    const existing=mark.start===mark.end ? linkAtCursor(mark) : null
    if(existing){mark.start=existing.start;mark.end=existing.end}
    const selected=blockText(body[mark.index]).slice(mark.start,mark.end)
    const dlg=modal(root,folderOnly?tr('Ссылка на папку','Folder link'):tr('Вставить ссылку','Insert link')),form=el('form','ve-link-form')
    const label=el('label','',folderOnly?tr('Путь к папке','Folder path'):tr('Адрес ссылки или путь к папке','Link address or folder path')),input=el('input','ve-input')
    input.placeholder=folderOnly?'C:\\…':'https://';input.type='text';input.required=true
    input.value=existing?.address||(isFolderPath(selected)?selected:safeLink(selected))||'';label.append(input)
    const textLabel=el('label','',tr('Текст ссылки','Link text')),linkText=el('input','ve-input')
    linkText.value=selected;linkText.placeholder=tr('Текст или адрес','Text or URL');textLabel.append(linkText)
    const actions=el('div','ve-actions'),cancel=button(tr('Отмена','Cancel'),null,()=>dlg.close(),true)
    const save=el('button','ve-btn ve-primary',tr('Вставить','Insert'));save.type='submit'
    actions.append(cancel,save);form.append(label,textLabel,actions);dlg.append(form);input.focus()
    input.oninput=()=>input.setCustomValidity('')
    input.oninvalid=()=>{if(!input.value.trim())input.setCustomValidity(tr('Введите адрес ссылки.','Enter a link address.'))}
    form.onsubmit=e=>{
      e.preventDefault()
      const address=input.value.trim(), folder=isFolderPath(address), href=!folderOnly && safeLink(address)
      if(!folder && !href){
        input.setCustomValidity(folderOnly?folderError('VD_FOLDER_INVALID'):tr('Введите веб-адрес, mailto: или полный путь к папке.','Enter a web address, mailto: link or full folder path.'))
        input.reportValidity();return
      }
      const link=folder?{text:linkText.value||folderLabel(address),folderPath:address}:{text:linkText.value||href,href}
      dlg.close();insertLinkAt(mark,link)
    }
  }
  function linkAtCursor(mark){
    const runs=body[mark.index].runs
    let end=0
    for(let i=0;i<runs.length;i++){
      const start=end, address=runs[i].folderPath||runs[i].href
      end+=runs[i].text.length
      if(!address)continue
      while(i+1<runs.length && (runs[i+1].folderPath||runs[i+1].href)===address)end+=runs[++i].text.length
      if(start<=mark.start && mark.start<end)return {start,end,address}
    }
    return null
  }
  function colors(){
    ensureText();const range=getSelection().getRangeAt(0).cloneRange()
    const dlg=modal(root,tr('Цвет текста','Text color')), choices=el('div','ve-color-choices')
    const apply=color=>{
      dlg.close();blockRefs[active].focus()
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range)
      format('foreColor',color)
    }
    const frame=root.closest('.vb-rich-frame')
    const custom=el('input');custom.type='color';custom.setAttribute('aria-label',tr('Произвольный цвет текста','Custom text color'))
    let customPicked=false
    custom.oninput=()=>{customPicked=true}
    function syncPalette(){
      const ink=(frame ? frame.dataset.light==='true' : isLightTheme()) ? lightPaperInk : darkPaperInk
      ink.forEach((color,index)=>{
        let swatch=choices.children[index]
        const name=tr('Выбрать ','Choose ')+color
        if(!swatch){
          swatch=button(name,null,()=>apply(swatch.dataset.color))
          swatch.classList.add('ve-swatch');choices.append(swatch)
        }
        swatch.dataset.color=color;swatch.title=name;swatch.setAttribute('aria-label',name)
        swatch.style.setProperty('--ve-ink',color)
      })
      if(!customPicked)custom.value=ink[0]
    }
    stopColorPicker?.()
    syncPalette()
    window.addEventListener('videron:themechange',syncPalette)
    const stop=()=>window.removeEventListener('videron:themechange',syncPalette)
    stopColorPicker=stop
    dlg.addEventListener('close',()=>{stop();if(stopColorPicker===stop)stopColorPicker=null},{once:true})
    const actions=el('div','ve-actions'),pick=button(tr('Применить цвет','Apply color'),null,()=>apply(custom.value),true)
    actions.append(custom,pick);dlg.append(choices,actions)
  }
  const kind=el('select','ve-kind');kind.setAttribute('aria-label',tr('Стиль абзаца','Paragraph style'))
  for(const [name,label] of [['paragraph',tr('Текст','Paragraph')],['heading',tr('Заголовок','Heading')],['subheading',tr('Подзаголовок','Subheading')],['quote',tr('Цитата','Quote')]])kind.add(option(name,label))
  kind.add(option('bullet',tr('• Список','• List')))
  kind.add(option('decimal',tr('1. Список','1. List')))
  kind.add(option('parenthesis',tr('1) Список','1) List')))
  kind.add(option('task',tr('☐ Задача','☐ Task')))
  kind.add(option('task-choice',tr('☐ Задача с отменой','☐ Cancellable task')))
  const insertGroup=el('optgroup');insertGroup.label=tr('Вставить','Insert')
  insertGroup.append(option('divider',tr('Горизонтальная линия','Horizontal rule')));kind.append(insertGroup)
  let typeMark
  kind.onpointerdown=()=>{typeMark=position()}
  kind.onblur=()=>{typeMark=null}
  kind.onkeydown=e=>{
    if(e.key!=='Escape'||e.isComposing)return
    e.stopPropagation()
    const mark=typeMark||position()
    focusBlock(mark.index,mark.start,mark.end)
  }
  function setParagraphStyle(type,mark){
    const block=body[mark.index]
    if(!block || block.type==='code')return
    const isText=textTypes.has(block.type)
    const base=isText?block:paragraph()
    const styled=isListStyle(type)?withListStyle(base,type):{...withListStyle(base,null),type}
    const index=isText?mark.index:mark.index+1
    remember()
    const next=[...body]
    next.splice(index,isText?1:0,styled)
    applyBody(next,index,isText?mark.start:0,isText?mark.end:0)
  }
  kind.onchange=()=>{
    const type=kind.value, mark=typeMark||position();typeMark=null
    if(type==='divider')insertDivider(mark)
    else setParagraphStyle(type,mark)
  }
  const taskFormats=el('div','ve-task-formats')
  taskFormats.setAttribute('role','group')
  taskFormats.setAttribute('aria-label',tr('Формат задачи','Task format'))
  function taskFormatButton(style,label,symbol){
    const control=button(label,symbol,()=>{
      const mark=position()
      setParagraphStyle(listStyleOf(body[mark.index])===style?'paragraph':style,mark)
    },true)
    control.dataset.taskStyle=style
    return control
  }
  const taskBtn=taskFormatButton('task',tr('Задача','Task'),'task')
  const taskChoiceBtn=taskFormatButton('task-choice',tr('Задача с отменой','Cancellable task'),'taskChoice')
  taskFormats.append(taskBtn,taskChoiceBtn)
  const boldBtn=button(shortcutLabel(tr('Полужирный (Ctrl+B)','Bold (Ctrl+B)')),'bold',()=>format('bold')),italicBtn=button(shortcutLabel(tr('Курсив (Ctrl+I)','Italic (Ctrl+I)')),'italic',()=>format('italic'))
  function indent(delta){
    ensureText()
    const index=active, mark=position(), block=body[index], depth=indentOf(block)
    const level=Math.max(0,Math.min(8,depth+delta))
    if(level===depth && !(listStyleOf(block) && delta<0))return
    remember();const next=[...body]
    next[index]=listStyleOf(block) && delta<0 ? atParentLevel(body,index) : {...block,indent:level}
    applyBody(next,index,mark.start,mark.end)
  }
  const undoBtn=button(shortcutLabel(tr('Отменить (Ctrl+Z)','Undo (Ctrl+Z)')),'undo',()=>history(false)),redoBtn=button(shortcutLabel(tr('Повторить (Ctrl+Shift+Z)','Redo (Ctrl+Shift+Z)')),'redo',()=>history(true))
  const imageBtn=button(tr('Вставить изображение','Insert image'),'image',()=>{imageMark=position();filePicker.click()})
  const sketchBtn=button(tr('Вставить рисунок','Insert drawing'),'pen',()=>insertInline(false))
  const tableBtn=button(tr('Вставить таблицу','Insert table'),'table',()=>insertInline(true))
  const codeBtn=button(tr('Вставить блок кода','Insert code block'),'code',()=>insertCode())
  const colorBtn=button(tr('Цвет текста','Text color'),'color',colors),linkBtn=button(tr('Вставить ссылку','Insert link'),'link',()=>linkDialog())
  linkBtn.title+=' ('+shortcutLabel('Ctrl+K')+')'
  for(const [control,key] of [[boldBtn,'Ctrl+B'],[italicBtn,'Ctrl+I'],[linkBtn,'Ctrl+K']])control.setAttribute('aria-keyshortcuts',shortcutAria(key))
  const folderBtn=button(tr('Ссылка на папку','Link to folder'),'folder',insertFolder)
  const outdentBtn=button(tr('Уменьшить отступ','Decrease indent'),'outdent',()=>indent(-1)),indentBtn=button(tr('Увеличить отступ','Increase indent'),'indent',()=>indent(1))
  toolbar.append(kind,el('span','ve-divider'),taskFormats,el('span','ve-divider'),boldBtn,italicBtn,colorBtn,linkBtn,folderBtn,el('span','ve-divider'),outdentBtn,indentBtn,el('span','ve-divider'),imageBtn,...(embed?[]:[sketchBtn,tableBtn]),codeBtn,el('span','ve-spacer'),undoBtn,redoBtn)
  toolbar.addEventListener('mousedown',e=>{if(e.target.closest('button'))e.preventDefault()})
  function syncTools(){
    const b=body[active]
    if(!b)return
    const style=listStyleOf(b)
    kind.value=style || (textTypes.has(b.type)?b.type:'paragraph')
    for(const control of [kind,taskBtn,taskChoiceBtn,boldBtn,italicBtn,colorBtn,linkBtn,folderBtn,outdentBtn,indentBtn])control.disabled=b.type==='code'
    for(const control of [taskBtn,taskChoiceBtn]){
      const pressed=style===control.dataset.taskStyle
      control.setAttribute('aria-pressed',String(pressed))
      control.title=pressed?tr('Убрать чекбокс и оставить текст','Remove the checkbox and keep the text'):
        control===taskBtn?tr('Добавить чекбокс для выполнения','Add a task you can check off'):tr('Добавить задачу с галочкой и крестиком','Add a task you can complete or cancel')
    }
    // May be called before toolbar insertion on initial render.
    for(const [btn,cmd] of [[boldBtn,'bold'],[italicBtn,'italic']])btn.setAttribute('aria-pressed',String(!!currentSelection()&&document.queryCommandState(cmd)))
  }
  const details=embed?null:noteDetails({root,note,notes,areas,current:()=>relations,update:(patch,point)=>{
    remember();relations={...relations,...patch};emit(point);details.sync()
  },openNote:onOpenNote && navigateTo,openTag:onOpenNote && tagNav.open})
  titleBox.oninput=()=>{remember('title');title=titleBox.value;resizeTitle();emit()}
  titleBox.onkeydown=e=>{
    if(!e.isComposing&&e.key==='Enter'){e.preventDefault();focusBlock(0,0)}
  }
  titleBox.onpaste=e=>{
    e.preventDefault();const str=e.clipboardData.getData('text/plain').replace(/[\r\n]+/g,' ')
    document.execCommand('insertText',false,str)
  }
  function editorKeydown(e){
    if(e.target.closest('dialog'))return
    if(e.defaultPrevented||e.isComposing||e.keyCode===229)return
    const direction=historyDirection(e)
    const frame=e.target.closest('[data-note-embed]')
    if(frame && root.contains(frame)){
      if(direction && !e.target.closest('input,textarea,select,[contenteditable="true"]')){
        e.preventDefault();e.stopPropagation();history(direction==='redo')
      }
      else if(e.key==='Escape' && !e.defaultPrevented){
        e.preventDefault();e.stopPropagation()
        leaveInline()
        if(textTypes.has(body[active+1]?.type))focusBlock(active+1);else titleBox.focus({preventScroll:true})
      }
      return
    }
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(embed)embed.onExit();else goBack();return}
    if(direction){
      e.preventDefault();e.stopPropagation()
      history(direction==='redo')
    }
    if(!embed)keepTabInEditor(e,root)
  }
  root.addEventListener('keydown',editorKeydown)
  content.ondragover=e=>{if(!e.target.closest('.ve-inline-board') && !(e.target.matches('.ve-code-source') && !e.dataTransfer.types.includes('Files'))){e.preventDefault();e.dataTransfer.dropEffect=e.dataTransfer.types.includes('Files')?'copy':'none'}}
  content.ondrop=e=>{
    if(e.target.closest('.ve-inline-board') || (e.target.matches('.ve-code-source') && !e.dataTransfer.files.length))return
    e.preventDefault()
    const target=blockRefs.indexOf(e.target.closest('.ve-text,.ve-code,.ve-media,.ve-rule,[data-note-embed]'))
    if(target>=0)active=target
    if(e.dataTransfer.files.length)insertImages(e.dataTransfer.files,position())
  }
  if(embed){
    root.append(toolbar,content,message,filePicker)
    embed.host.append(root)
    removeFloatingTools=attachTextToolbar(root,toolbar,editorKeydown)
    sizeObserver.observe(content)
    function caretBounds(){
      const field=document.activeElement
      if(!content.contains(field))return null
      if(field.matches('.ve-code-source')){
        const mirror=field.closest('.ve-code').querySelector('.ve-code-mirror')
        const rect=rangeInText(mirror,field.selectionEnd).getBoundingClientRect()
        return rect.height ? rect : field.getBoundingClientRect()
      }
      const selection=getSelection()
      if(!field.matches('.ve-text') || !selection?.isCollapsed || !field.contains(selection.focusNode))return null
      const rect=selection.getRangeAt(0).getBoundingClientRect()
      if(rect.height)return rect
      const row=field.getBoundingClientRect()
      return new DOMRect(row.left,row.top,0,row.height)
    }
    content.addEventListener('keyup',event=>{
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key))embed.onCaretMove?.()
    })
    root.addEventListener('focusin',()=>document.addEventListener('selectionchange',syncTools))
    root.addEventListener('focusout',event=>{
      if(!root.contains(event.relatedTarget)){
        lastKey=''
        document.removeEventListener('selectionchange',syncTools)
      }
    })
    content.addEventListener('pointerdown',event=>{
      if(event.target===content){
        event.preventDefault()
        focusBlock(body.length-1,blockText(body[body.length-1]).length)
      }
    })
    render()
    return {focus:()=>focusBlock(active,blockText(body[active]).length),flush,prepareClose:flush,destroy,overflowHeight,caretBounds,
      refreshHistory:refreshEmbeddedHistory,revealSearchMatch:target=>searchReveal.reveal(target),
      update(next){
        if(next?.length && body!==next){
          const focused=content.contains(document.activeElement), mark=focused && currentSelection()
          body=next;lastKey='';active=Math.min(active,body.length-1)
          render()
          if(focused)focusBlock(active,mark?.start||0,mark?.end||0)
        }
        refreshEmbeddedHistory()
      }}
  }
  crumb.append(icon('file'),el('span','',tr('Заметка','Note')))
  head.append(button(backLabel,'back',goBack,true),el('span','ve-head-divider'),crumb,saveIndicator ?? el('span','ve-spacer'),message,count)
  if(onSearch)head.append(noteSearchButton(onSearch))
  if(agentButton)head.append(agentButton)
  if(manageProtection)head.append(notePrivacyButton(manageProtection,isProtected))
  head.append(details.toggle)
  const tasks=mountAgentTaskList(note.id,notes,{...agentTaskActions,openNote:navigateTo})
  main.append(titleBox,toolbar,content,tasks.element)
  layout.append(main,details.panel);scroll.append(layout);root.append(head,scroll,filePicker)
  document.body.append(root);sizeObserver.observe(titleBox);sizeObserver.observe(toolbar);document.addEventListener('selectionchange',syncTools)
  render();details.sync();indicators(meta());resizeTitle()
  const focus=()=>{
    if(!title||body[0]?.type==='drawing'){titleBox.focus();if(!title)titleBox.select()}
    else focusBlock(0,0,0,false)
  }
  focus()
  function revealSearchMatch(target){
    if(target?.kind==='tableCell'){
      details.uncoverNote()
      const view=inlineRows.get(blockRefs[target.index])
      if(!view)return
      view.mount()
      activateInline(view)
      const cell=view.revealTableCell(target.id,target.address)
      if(cell){
        const bounds=scroll.getBoundingClientRect(), box=cell.getBoundingClientRect()
        if(box.top<bounds.top+32 || box.bottom>bounds.bottom-16)
          scroll.scrollTop+=(box.top+box.bottom-bounds.top-bounds.bottom)/2
      }
      return
    }
    if(target?.kind==='body')details.uncoverNote()
    searchReveal.reveal(target)
  }
  return {element:root,close,focus,commitDraft:()=>flush(false),prepareClose,refreshAgentTasks:tasks.refresh,revealSearchMatch}
}
