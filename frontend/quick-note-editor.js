import {icon} from './art.js'
import {tr, getLanguage} from './i18n.js'
import {appendRuns, readRuns, marksForElement, setCaret, safeLink, editorDialog, editorButton, noteRelations,
  noteDetails, notePrivacyButton, noteSearchButton, finishNoteSession, keepTabInEditor} from './editor.js'
import {createQuickEntry, quickNotePatch} from './quick-note.js'
import {openQuickNoteCapture} from './quick-note-capture.js'
import {readClipboardParagraphs} from './clipboard-runs.js'
import {sliceRuns} from './editor-text-range.js'
import {canRestoreRelations, packEditorHistory, restoreEditorHistory} from './editor-history.js'
import {createTagNavigator} from './note-tags.js'
import {createSearchReveal} from './search-reveal.js'
import {mountNoteFind} from './note-find.js'
import {replaceFindBody, replaceNoteString, richBodyFindRecords} from './note-find-text.js'
import {offsetAt, textRangeCursor} from './note-text-dom.js'
import {blockText} from './search-location.js'
import {historyDirection, primaryCommand, shortcutAria, shortcutLabel} from './shortcuts.js'
import {mountAgentTaskList} from './agent-task-list.js'
import {sameWorkspaceValue} from './workspace-merge.js'
import {isFolderPath, openFolder} from './folder-links.js'

function el(tag, className, value) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (value !== undefined) node.textContent = value
  return node
}

function quickButton(label, symbol, action) {
  const button = editorButton(label, null, action)
  const glyph = el('span')
  glyph.innerHTML = icon(symbol)
  button.append(glyph)
  return button
}

function isInstant(value) {
  return Number.isFinite(value) && Math.abs(value)<=8640000000000000
}

export function quickEditorEntries(note) {
  // Older clients can open these as ordinary text and create plain paragraphs.
  // Repair their entry identity in memory, then store it with the next edit.
  const reserved=new Set(note.body.map(block=>block.id)), seen=new Set()
  return note.body.map((block,index)=>{
    let {id,created}=block
    if (typeof id!=='string' || !id || seen.has(id)) {
      id='legacy-entry-'+index
      while (reserved.has(id)) id+='-'
      reserved.add(id)
    }
    seen.add(id)
    if (!isInstant(created)) created=isInstant(note.created)?note.created:null
    return id===block.id && created===block.created ? block : {...block,id,created}
  })
}

export function openQuickNoteEditor({note, notes=[], areas=[], onChange, onClose, onOpenNote, onSearch, onReturn,
  beforeClose, manageProtection, isProtected, saveIndicator, agentButton, agentTaskActions, historySession,
  backLabel=tr('К карте','Back to map')}) {
  const previousFocus = document.activeElement
  const root = el('section','vd-editor ve-quick-editor')
  root.setAttribute('role','region')
  root.setAttribute('aria-label',tr('Быстрая заметка','Quick note'))
  const head = el('header','ve-head')
  const titleBox = el('input','ve-head-title')
  titleBox.type = 'text'
  titleBox.value = note.title
  titleBox.placeholder = tr('Без названия','Untitled')
  titleBox.setAttribute('aria-label',tr('Название заметки','Note title'))
  const toolbar = el('div','ve-toolbar ve-under-head ve-quick-tools')
  toolbar.setAttribute('role','group')
  toolbar.setAttribute('aria-label',tr('Форматирование текста','Text formatting'))
  const scroll = el('div','ve-scroll'), layout = el('div','ve-layout')
  const main = el('main','ve-main'), list = el('div','ve-quick-list')
  const empty = editorButton(tr('Добавить первую запись','Add the first entry'),null,()=>openCapture(empty),true)
  empty.classList.add('ve-quick-empty')
  const count = el('span','ve-count')
  const live = el('span','ve-quick-live')
  live.setAttribute('role','status')
  const dateFormat = new Intl.DateTimeFormat(getLanguage(),{dateStyle:'medium',timeStyle:'short'})
  let title = note.title, body = quickEditorEntries(note), relations = noteRelations(note)
  let views = [], mark, drag, captureClose, closing, finished = false
  let lastGroup = '', lastInput = 0
  const mapRecord = notes.find(item=>item.id===note.id) || note
  const state = ()=>({title,body,relations,point:{x:mapRecord.x,y:mapRecord.y}})
  const checkpoint=()=>({...state(),mark:mark && {...mark,index:entryIndex(mark.id)},
    inTitle:document.activeElement===titleBox,titleOffset:titleBox.selectionStart})
  const {past,future} = restoreEditorHistory(historySession?.take(),state())

  const tagNav = createTagNavigator({root,notes,noteId:note.id,onOpenNote:onOpenNote && navigateTo})
  const details = noteDetails({root,note,notes,areas,current:()=>relations,openNote:onOpenNote && navigateTo,
    openTag:onOpenNote && tagNav.open,update(patch,point){
      remember(); relations = {...relations,...patch}; emit(point); details.sync()
    }})
  const searchReveal = createSearchReveal({root,title:titleBox,scroll,focusBlock:focusAt,
    blockAt:index=>views[index] && {node:views[index].field}})
  const add = quickButton(tr('Добавить запись','Add entry'),'plus',()=>openCapture(add))
  const bold = editorButton(tr('Жирный','Bold'),'bold',()=>format('bold'))
  const italic = editorButton(tr('Курсив','Italic'),'italic',()=>format('italic'))
  const link = editorButton(tr('Вставить ссылку','Insert link'),'link',addLink)
  const color = el('input','ve-quick-color')
  color.type = 'color'; color.value = '#777777'
  color.title = tr('Цвет текста','Text color'); color.setAttribute('aria-label',color.title)
  color.onchange = ()=>format('foreColor',color.value)
  const findButton = editorButton(tr('Найти в заметке','Find in note'),'findInNote',()=>find.open())
  const undo = editorButton(tr('Отменить','Undo'),'undo',()=>step(false))
  const redo = editorButton(tr('Повторить','Redo'),'redo',()=>step(true))
  for (const [button,key] of [[bold,'Ctrl+B'],[italic,'Ctrl+I'],[link,'Ctrl+K'],[findButton,'Ctrl+F'],[undo,'Ctrl+Z'],[redo,'Ctrl+Shift+Z']]) {
    button.title += ' ('+shortcutLabel(key)+')'; button.setAttribute('aria-keyshortcuts',shortcutAria(key))
  }
  toolbar.append(add,el('span','ve-divider'),bold,italic,color,link,el('span','ve-divider'),findButton,undo,redo)
  toolbar.onmousedown = event=>{if (event.target.closest('button')) event.preventDefault()}
  head.append(editorButton(backLabel,'back',goBack,true),el('span','ve-head-divider'),titleBox,el('span','ve-spacer'),saveIndicator || count)
  if (saveIndicator) head.append(count)
  if (onSearch) head.append(noteSearchButton(onSearch))
  if (agentButton) head.append(agentButton)
  if (manageProtection) head.append(notePrivacyButton(()=>{flush();return manageProtection()},isProtected))
  head.append(details.toggle)
  const tasks = mountAgentTaskList(note.id,notes,{...agentTaskActions,openNote:navigateTo})
  main.append(empty,list,tasks.element); layout.append(main,details.panel); scroll.append(layout)
  root.append(head,toolbar,scroll,live); document.body.append(root)
  tagNav.trackTitle(titleBox)

  let paintedMatches, paintedPage
  const find = mountNoteFind(root,{
    records:()=>[{id:'title',text:title},...richBodyFindRecords(body)],
    selection(){
      if (document.activeElement===titleBox) return {id:'title',from:titleBox.selectionStart,to:titleBox.selectionEnd,
        text:title.slice(titleBox.selectionStart,titleBox.selectionEnd)}
      const point=selection()
      const index=point && entryIndex(point.id)
      if (index==null || index<0) return null
      return {id:String(index),from:point.start,to:point.end,text:blockText(body[index]).slice(point.start,point.end)}
    },
    paint(matches,current,{reveal=true}={}) {
      const pageSize=2000,page=Math.floor(Math.max(0,current)/pageSize),registry=globalThis.CSS?.highlights
      if ((paintedMatches!==matches || paintedPage!==page) && registry && globalThis.Highlight) {
        paintedMatches=matches;paintedPage=page
        const highlight=new Highlight()
        let previousId, cursor
        for (const {id,from,to} of matches.slice(page*pageSize,(page+1)*pageSize)) {
          if (id!==previousId) {
            previousId=id
            const field=views[Number(id)]?.field
            cursor=field && textRangeCursor(field)
          }
          if (cursor && to>from) highlight.add(cursor(from,to))
        }
        if (highlight.size) registry.set('videron-find-match',highlight)
        else registry.delete('videron-find-match')
      }
      const hit=matches[current]
      if (hit) searchReveal.reveal(findTarget(hit),{persistent:true,scrollTo:reveal})
      else searchReveal.clear()
    },
    replace(edits){
      if (!edits.length || finished) return
      remember()
      const titleEdits=edits.filter(edit=>edit.id==='title')
      if (titleEdits.length) titleBox.value=title=replaceNoteString(title,titleEdits).replace(/[\r\n]+/g,' ')
      body=replaceFindBody(body,edits.filter(edit=>edit.id!=='title'))
      render(); emit()
    },
    focus(hit){
      if (!hit) {focus();return}
      if (hit.id==='title') {titleBox.focus();titleBox.setSelectionRange(hit.from,hit.to)}
      else focusAt(Number(hit.id),hit.from,hit.to)
    },
  })

  function findTarget(hit) {
    return hit.id==='title'?{kind:'title',start:hit.from,end:hit.to}:
      {kind:'body',ranges:[{index:Number(hit.id),start:hit.from,end:hit.to}]}
  }
  const entryIndex = id=>body.findIndex(entry=>entry.id===id)
  function selection() {
    const range=getSelection()?.rangeCount ? getSelection().getRangeAt(0) : null
    if (!range) return null
    const field=(range.startContainer.parentElement?.closest('.ve-quick-entry-text') ||
      (range.startContainer instanceof Element && range.startContainer.closest('.ve-quick-entry-text')))
    if (!field || !list.contains(field) || !field.contains(range.endContainer)) return null
    return {id:field.dataset.entryId,start:offsetAt(field,range.startContainer,range.startOffset),
      end:offsetAt(field,range.endContainer,range.endOffset)}
  }
  function syncTools() {
    const active=list.contains(document.activeElement) && selection()
    if (active) mark=active
    const field=views[entryIndex(mark?.id)]?.field
    for (const control of [bold,italic,link,color]) control.disabled=!field
    for (const [control,kind] of [[bold,'bold'],[italic,'italic']])
      control.setAttribute('aria-pressed',String(!!active && document.queryCommandState(kind)))
    undo.disabled=!past.length; redo.disabled=!future.length
  }
  function remember(group='') {
    const now=performance.now()
    if (!group || lastGroup!==group || now-lastInput>750) {
      past.push(checkpoint())
      if (past.length>80) past.shift()
    }
    future.length=0;lastGroup=group;lastInput=now
  }
  function emit(point) {
    const patch=quickNotePatch(title,body)
    onChange?.({...patch,...relations,...point})
    details.setTags(patch.tags); tagNav.syncTitle(); syncTools(); find.refresh()
  }
  function updateEntryRuns(index,runs) {
    const next=body.slice()
    next[index]={...next[index],runs}
    body=next
  }
  function captureInput(index) {
    const field=views[index]?.field
    if (!field) return
    const runs=readRuns(field)
    if (sameWorkspaceValue(runs,body[index].runs)) return
    remember(body[index].id)
    updateEntryRuns(index,runs)
    tagNav.paint(field); emit()
  }
  function replaceRuns(point, runs) {
    const index=entryIndex(point?.id)
    if (index<0) return
    const entry=body[index]
    const next=[...sliceRuns(entry.runs,0,point.start),...runs,...sliceRuns(entry.runs,point.end)]
    writeRuns(index,next,point.start+runs.reduce((length,run)=>length+run.text.length,0))
  }
  function writeRuns(index,runs,start,end=start) {
    const {field}=views[index]
    remember()
    field.replaceChildren()
    appendRuns(field,runs)
    updateEntryRuns(index,readRuns(field))
    tagNav.paint(field)
    focusAt(index,start,end); emit()
  }
  function format(command,value) {
    const point=selection() || mark
    const index=entryIndex(point?.id)
    if (index<0) return
    if (point.start<point.end) {
      const runs=body[index].runs,key=command==='foreColor'?'color':command
      const selected=sliceRuns(runs,point.start,point.end)
      const enabled=value || !selected.every(run=>run[key])
      const marked=selected.map(run=>{
        const copy={...run}
        if (enabled) copy[key]=enabled
        else delete copy[key]
        return copy
      })
      writeRuns(index,[...sliceRuns(runs,0,point.start),...marked,...sliceRuns(runs,point.end)],point.start,point.end)
      return
    }
    focusAt(index,point.start,point.end)
    lastGroup=''
    document.execCommand(command,false,value)
    captureInput(index); lastGroup=''; syncTools()
  }
  function addLink() {
    const point=selection() || mark,index=entryIndex(point?.id)
    if (index<0) return
    const dialog=editorDialog(root,tr('Вставить ссылку','Insert link')), form=el('form','ve-link-form')
    const input=el('input','ve-input'), name=el('input','ve-input')
    const urlLabel=el('label','',tr('Адрес ссылки','Link address')), nameLabel=el('label','',tr('Текст ссылки','Link text'))
    input.placeholder='https://';input.required=true
    name.value=blockText(body[index]).slice(point.start,point.end)
    urlLabel.append(input);nameLabel.append(name)
    const actions=el('div','ve-actions')
    const save=el('button','ve-btn ve-primary',tr('Вставить','Insert'));save.type='submit'
    actions.append(editorButton(tr('Отмена','Cancel'),null,()=>dialog.close(),true),save)
    form.append(urlLabel,nameLabel,actions);dialog.append(form);input.focus()
    input.oninput=()=>input.setCustomValidity('')
    form.onsubmit=event=>{
      event.preventDefault()
      const href=safeLink(input.value.trim())
      if (!href) {
        input.setCustomValidity(tr('Введите веб-адрес или ссылку mailto:.','Enter a web address or a mailto: link.'))
        input.reportValidity();return
      }
      const selected=sliceRuns(body[index].runs,point.start,point.end)
      const runs=name.value===selected.map(run=>run.text).join('') && selected.length
        ? selected.map(({folderPath,...run})=>({...run,href})) : [{text:name.value || href,href}]
      dialog.close();replaceRuns(point,runs)
    }
  }
  function openCapture(anchor) {
    captureClose=openQuickNoteCapture({title: title.trim() || tr('Быстрая заметка','Quick note'),anchor,
      focusTarget:anchor,onClose:()=>{captureClose=null},onSave(text){
        const entry=createQuickEntry(text)
        if (!entry || finished || closing) return false
        remember();body=[entry,...body];render();emit();scroll.scrollTop=0
        requestAnimationFrame(()=>{
          if (!finished && body[0]?.id===entry.id) focusAt(0,blockText(entry).length)
        })
      }})
  }
  function focusAt(index,start=0,end=start) {
    const view=views[index]
    if (!view) return
    setCaret(view.field,start,end)
    mark={id:body[index].id,start,end}
    syncTools()
  }
  function focus() {
    const index=entryIndex(mark?.id)
    if (views.length) focusAt(index<0?0:index,index<0?0:mark.end)
    else add.focus({preventScroll:true})
  }
  function remove(id) {
    const index=entryIndex(id)
    if (index<0) return
    remember();body=body.filter(entry=>entry.id!==id)
    mark=null;render();emit()
    ;(views[Math.min(index,views.length-1)]?.handle || add).focus({preventScroll:true})
    live.textContent=tr('Запись удалена','Entry deleted')
  }
  function move(id,to) {
    const from=entryIndex(id)
    if (from<0 || from===to || to<0 || to>=body.length) return
    remember()
    const next=body.slice(),[entry]=next.splice(from,1)
    next.splice(to,0,entry); body=next; render();emit()
    views[to].handle.focus({preventScroll:true})
    live.textContent=tr('Запись перемещена на позицию {position}','Entry moved to position {position}',{position:to+1})
  }
  function endDrag(event,commit) {
    if (!drag || event.pointerId!==drag.pointer) return
    const {id,boundary}=drag,from=entryIndex(id)
    drag=null;list.classList.remove('is-reordering')
    for (const {row} of views) {
      delete row.dataset.dragging;delete row.dataset.dropBefore;delete row.dataset.dropAfter
    }
    if (commit && boundary!=null) move(id,boundary-Number(boundary>from))
  }
  function trackDrag(event) {
    if (!drag || event.pointerId!==drag.pointer || (drag.boundary==null && Math.abs(event.clientY-drag.y)<4)) return
    const view=scroll.getBoundingClientRect()
    if (event.clientY<view.top+30) scroll.scrollTop-=18
    else if (event.clientY>view.bottom-30) scroll.scrollTop+=18
    const boundary=views.findIndex(({row})=>{
      const box=row.getBoundingClientRect()
      return event.clientY<box.top+box.height/2
    })
    drag.boundary=boundary<0?views.length:boundary
    list.classList.add('is-reordering')
    for (const [index,{row}] of views.entries()) {
      row.toggleAttribute('data-dragging',body[index].id===drag.id)
      row.toggleAttribute('data-drop-before',index===drag.boundary)
      row.toggleAttribute('data-drop-after',drag.boundary===views.length && index===views.length-1)
    }
  }

  function render() {
    const activeId=mark?.id
    tagNav.clearPaint()
    const next=body.map((entry,index)=>{
      const row=el('article','ve-quick-entry')
      row.dataset.entryId=entry.id
      const header=el('div','ve-quick-entry-head'), actions=el('div','ve-quick-entry-actions')
      const time=el('time')
      if (isInstant(entry.created)) {
        time.textContent=dateFormat.format(entry.created)
        time.dateTime=new Date(entry.created).toISOString()
      }
      const field=el('div','ve-text ve-quick-entry-text')
      field.dataset.entryId=entry.id
      field.contentEditable='true';field.spellcheck=true
      field.setAttribute('role','textbox');field.setAttribute('aria-multiline','true')
      field.setAttribute('aria-label',tr('Запись {position}','Entry {position}',{position:index+1}))
      field.dataset.placeholder=tr('Текст записи','Entry text')
      appendRuns(field,entry.runs);tagNav.paint(field)
      field.onfocus=()=>{lastGroup='';mark={id:entry.id,start:0,end:0};syncTools()}
      function commit() {
        if (views[index]?.field===field && body[index]?.id===entry.id) captureInput(index)
      }
      field.oninput=event=>{if (!event.isComposing) commit()}
      field.oncompositionend=field.onblur=commit
      field.onbeforeinput=event=>{
        if (event.isComposing) return
        if (event.inputType==='historyUndo' || event.inputType==='historyRedo') {
          event.preventDefault();step(event.inputType==='historyRedo');return
        }
        if (!['insertParagraph','insertLineBreak'].includes(event.inputType)) return
        const point=selection()
        if (!point) return
        event.preventDefault()
        const text=body[index].runs, sameStyle=sliceRuns(text,Math.max(0,point.start-1),point.start)[0]
        replaceRuns(point,[{...sameStyle,text:'\n'}])
      }
      field.onpaste=event=>{
        event.preventDefault()
        const html=event.clipboardData?.getData('text/html'), template=html && el('template')
        if (template) template.innerHTML=html
        const lines=readClipboardParagraphs(template?.content,event.clipboardData?.getData('text/plain') || null,marksForElement)
        if (lines.length) replaceRuns(selection(),lines.flatMap((runs,i)=>i?[{text:'\n'},...runs]:runs))
      }
      field.ondragover=field.ondrop=event=>event.preventDefault()
      field.onkeydown=event=>tagNav.keydown(event,field)
      field.onclick=event=>{
        const anchor=event.target.closest('a')
        if (!anchor) {tagNav.activate(event,field);return}
        event.preventDefault()
        if (!primaryCommand(event)) return
        const href=safeLink(anchor.href)
        if (isFolderPath(anchor.dataset.folderPath)) {
          openFolder(anchor.dataset.folderPath).catch(()=>{live.textContent=tr('Не удалось открыть папку.','Could not open folder.')})
        } else if (href) {
          if (window.runtime?.BrowserOpenURL) window.runtime.BrowserOpenURL(href)
          else window.open(href,'_blank','noopener')
        }
      }
      const handle=editorButton(tr('Переместить запись','Move entry'),null,()=>{})
      handle.classList.add('ve-quick-grip')
      handle.title+=' · ↑ / ↓'
      handle.setAttribute('aria-keyshortcuts','ArrowUp ArrowDown')
      handle.onkeydown=event=>{
        if (['ArrowUp','ArrowDown'].includes(event.key)) {
          event.preventDefault();move(entry.id,index+(event.key==='ArrowUp'?-1:1))
        }
      }
      handle.onpointerdown=event=>{
        if (event.button!==0 || body.length<2 || drag) return
        drag={id:entry.id,pointer:event.pointerId,y:event.clientY}
        handle.setPointerCapture(event.pointerId)
      }
      handle.onpointermove=trackDrag
      handle.onpointerup=event=>endDrag(event,true)
      handle.onpointercancel=handle.onlostpointercapture=event=>endDrag(event,false)
      actions.append(handle,quickButton(tr('Удалить запись','Delete entry'),'trash',()=>remove(entry.id)))
      header.append(time,actions);row.append(header,field)
      return {row,field,handle}
    })
    views=next
    list.replaceChildren(...next.map(view=>view.row))
    if (activeId && entryIndex(activeId)<0) mark=null
    count.textContent=tr('Записей · {count}','Entries · {count}',{count:body.length})
    empty.hidden=!!body.length
    paintedMatches=null;syncTools()
  }
  function step(redoing) {
    const from=redoing?future:past,to=redoing?past:future, next=from.at(-1)
    if (!next) return
    if (!canRestoreRelations(note.id,relations,next.relations,notes,areas)) {from.length=0;syncTools();return}
    to.push(checkpoint())
    from.pop()
    const moved=next.relations.areaId!==relations.areaId || next.relations.slot!==relations.slot
    ;({title,body,relations,mark}=next);titleBox.value=title;lastGroup=''
    render();emit(moved?next.point:null);details.sync()
    if (next.inTitle) {titleBox.focus();titleBox.setSelectionRange(next.titleOffset,next.titleOffset)}
    else focus()
  }
  function clearHistory() {
    past.length=future.length=0;lastGroup='';syncTools()
  }
  function flush() {
    if (finished) return true
    const index=views.findIndex(view=>view.field===document.activeElement)
    if (index>=0) captureInput(index)
    if (title!==titleBox.value) {remember('title');title=titleBox.value;emit()}
    return true
  }
  function close(reason) {
    if (finished) return Promise.resolve(true)
    if (closing) return closing
    captureClose?.()
    closing=(async()=>{
      flush()
      if (!await finishNoteSession(root,beforeClose,()=>historySession?.save(packEditorHistory(state(),past,future)))) return false
      finished=true; find.destroy(); searchReveal.clear(); tagNav.destroy()
      document.removeEventListener('selectionchange',syncTools)
      root.remove();previousFocus?.focus?.({preventScroll:true});onClose?.(reason)
      return true
    })().finally(()=>{closing=null})
    return closing
  }
  async function goBack() {if (await close('back')) onReturn?.()}
  async function navigateTo(id) {if (await close()) onOpenNote?.(id)}
  titleBox.oninput=()=>{remember('title');title=titleBox.value;emit()}
  root.addEventListener('keydown',event=>{
    if (event.defaultPrevented || event.isComposing || event.keyCode===229 || event.target.closest('dialog,.note-find,[popover]')) return
    const direction=historyDirection(event), command=primaryCommand(event)
    const keys={KeyB:()=>format('bold'),KeyI:()=>format('italic'),KeyK:addLink}
    if (direction) {event.preventDefault();step(direction==='redo');return}
    if (command && !event.shiftKey && list.contains(event.target) && keys[event.code]) {
      event.preventDefault();keys[event.code]();return
    }
    if (event.key==='Escape') {event.preventDefault();event.stopPropagation();if (!event.repeat) goBack();return}
    keepTabInEditor(event,root)
  })
  document.addEventListener('selectionchange',syncTools)
  render();details.sync();details.setTags(note.tags);focus()
  function revealSearchMatch(target) {
    if (target?.kind==='body') details.uncoverNote()
    searchReveal.reveal(target)
  }
  return {element:root,focus,close,prepareClose:close,flush,commitDraft:flush,clearHistory,revealSearchMatch,refreshAgentTasks:tasks.refresh}
}
