import { tr, getLanguage } from './i18n.js'
import { areaTreeRows, descendantAreaIds } from './areas.js'
import { isPinned } from './area-grid.js'
import { isProtectedNote } from './note-vault.js'

import { icon } from './art.js'
import { findNotes, searchPreview, searchWorkerSource } from './search-worker.js'
import { searchTarget } from './search-location.js'

function el(tag, className, text) {
  const node=document.createElement(tag)
  if (className) node.className=className
  if (text !== undefined) node.textContent=text
  return node
}
function highlight(node, value, start, length) {
  if (!length || start >= value.length) { node.textContent=value; return }
  node.classList.add('vs-hit')
  if(start){
    const before=el('span','vs-before')
    before.append(el('bdi','',value.slice(0,start)));node.append(before)
  }
  node.append(el('mark','',value.slice(start,start+length)),el('span','vs-after',value.slice(start+length)))
}
export function openSearch({notes, areas=[], onOpen, initialQuery='', initialState={}, onDismiss, onClose, signal}) {
  if(signal?.aborted)return
  const previous=document.activeElement
  const selection=previous?.isContentEditable?window.getSelection():null
  const caret=selection?.rangeCount?selection.getRangeAt(0).cloneRange():null
  const shade=el('div','shade vs-shade'), panel=el('section','dialog wide vs-panel')
  panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label',tr('Поиск по заметкам','Search notes'))
  const heading=el('div','dialog-title')
  const escape=el('button','vs-escape','Esc')
  escape.type='button';escape.title=tr('Закрыть поиск','Close search');escape.setAttribute('aria-label',tr('Закрыть поиск','Close search'))
  heading.append(el('h2','',tr('Поиск по заметкам','Search notes')),escape)
  const queryRow=el('div','vs-query'),query=el('input','query')
  queryRow.innerHTML=icon('search');queryRow.append(query)
  query.type='text';query.autocomplete='off';query.spellcheck=false;query.placeholder=tr('Название, текст или #тег','Title, text, or #tag')
  query.value=initialState.query??initialQuery;query.setAttribute('aria-label',tr('Поисковый запрос','Search query'))
  query.setAttribute('role','combobox');query.setAttribute('aria-controls','vs-search-results')
  query.setAttribute('aria-autocomplete','list');query.setAttribute('aria-expanded','true')
  const options=el('div','options'),flags={regex:false,exactCase:false,pinned:false,...initialState.flags}
  let restoreId=initialState.activeId
  function toggle(key,label,title) {
    const b=el('button','option',label)
    b.type='button';b.title=title;b.setAttribute('aria-label',title);b.setAttribute('aria-pressed',String(flags[key]));b.classList.toggle('on',flags[key])
    b.onclick=()=>{flags[key]=!flags[key];b.classList.toggle('on',flags[key]);b.setAttribute('aria-pressed',String(flags[key]));schedule(0)}
    return b
  }
  const area=el('select','option vs-area')
  area.setAttribute('aria-label',tr('Область поиска','Search area'))
  area.add(new Option(tr('Все области','All areas'),''));area.add(new Option(tr('Без области','No area'),'_none'))
  const areaLabels=new Map(areaTreeRows(areas).map(row=>[row.area.id,row.pathLabel]))
  for(const [id,label] of areaLabels)area.add(new Option(label,id))
  area.value=initialState.area||''
  if(area.selectedIndex<0)area.selectedIndex=0
  options.append(toggle('regex','.*  Regex',tr('Регулярное выражение','Regular expression')),toggle('exactCase','Aa',tr('Учитывать регистр','Match case')),toggle('pinned',tr('Закреплённые','Pinned'),tr('Только закреплённые','Pinned only')),area)
  const status=el('div','vs-status'), results=el('div','results vs-results')
  const announcement=el('div','vs-announcement')
  announcement.setAttribute('role','status')
  status.setAttribute('aria-hidden','true')
  results.id='vs-search-results';results.setAttribute('role','listbox')
  results.setAttribute('aria-label',tr('Результаты поиска','Search results'))
  const rows=el('div','vs-rows')
  rows.setAttribute('role','presentation');results.append(rows)
  panel.append(heading,queryRow,options,status,results,announcement);shade.append(panel);document.body.append(shade)
  const background=document.querySelector('.vd-editor')||document.getElementById('shell')
  const wasInert=background?.inert
  if(background)background.inert=true
  const source=[], byId=new Map(), titleAreas=new Map(), ambiguousTitles=new Set()
  // Only the searchable projection goes to the worker. Keep editor records and attachments here.
  for(const note of notes){
    if(isProtectedNote(note))continue
    const title=note.title||tr('Без названия','Untitled'), id=note.areaId??null
    const entry={id:note.id,title,plain:(note.type==='data'?note.dataText:note.plain)||'',tags:(note.tags||[]).map(t=>'#'+t).join(' '),
      areaId:note.areaId,pinned:isPinned(note),modified:note.modified||0}
    source.push(entry);byId.set(note.id,{note,entry})
    if(!titleAreas.has(title))titleAreas.set(title,id)
    else if(titleAreas.get(title)!==id)ambiguousTitles.add(title)
  }
  const rowHeight=55, mounted=new Map()
  rows.style.setProperty('--vs-row-height',rowHeight+'px')
  let worker, blobURL, timer, limitTimer, busy=false, closed=false, serial=0, displayed=-1, list=[], active=-1
  let pendingTimer, announcementTimer, fallbackTimer
  let useModule=false, unavailable=false, openWhenReady=false
  function stopWorker(){
    worker?.terminate();worker=null;busy=false
    if(blobURL){URL.revokeObjectURL(blobURL);blobURL=null}
    clearTimeout(limitTimer);limitTimer=null
  }
  function interrupt(){close(false)}
  function close(restoreFocus=true){
    if(closed)return
    closed=true;clearTimeout(timer);clearTimeout(pendingTimer);clearTimeout(announcementTimer);clearTimeout(fallbackTimer)
    stopWorker();resize.disconnect();shade.remove()
    signal?.removeEventListener('abort',interrupt)
    source.length=0;byId.clear();list=[];mounted.clear();query.value='';rows.replaceChildren()
    if(background)background.inert=wasInert
    onClose?.()
    if(!restoreFocus)return
    previous?.focus?.({preventScroll:true})
    if(caret&&previous?.contains(caret.commonAncestorContainer)){
      selection.removeAllRanges();selection.addRange(caret)
    }
  }
  function dismiss(){if(!closed){close();onDismiss?.()}}
  function state(id=list[active]?.id){return {query:query.value,area:area.value,flags:{...flags},activeId:id}}
  dismiss.state=()=>closed?null:{...state(),selection:[query.selectionStart,query.selectionEnd,query.selectionDirection]}
  function open(result){
    if(closed || results.inert)return
    const id=result.id,note=byId.get(id)?.note
    if(!note || isProtectedNote(note))return
    const saved=state(id)
    const target=(note.modified||0)===result.modified?searchTarget(note,result.position):null
    close();onOpen?.(id,saved,target)
  }
  function createRow(i){
    const m=list[i], {entry}=byId.get(m.id), preview=searchPreview(entry,m)
    const row=el('button','result');row.type='button';row.tabIndex=-1
    row.id='vs-result-'+i;row.style.top=i*rowHeight+'px'
    row.setAttribute('role','option');row.setAttribute('aria-selected','false')
    row.setAttribute('aria-posinset',i+1);row.setAttribute('aria-setsize',list.length)
    row.innerHTML=icon(entry.pinned?'pin':'circle')
    const summary=el('span','note-summary'),title=el('strong'),excerpt=el('small')
    highlight(title,entry.title,...(m.title||[0,0]))
    highlight(excerpt,preview.snippet,preview.start,preview.length)
    if(ambiguousTitles.has(entry.title)){
      const header=el('span','vs-result-heading'),place=el('small','vs-location')
      place.title=areaLabels.get(entry.areaId)||tr('Без области','No area')
      place.append(el('bdi','',place.title));header.append(title,place);summary.append(header)
    }else summary.append(title)
    if(preview.snippet)summary.append(excerpt)
    row.append(summary);row.onclick=()=>open(m);row.onfocus=()=>mark(i)
    return row
  }
  function paint(){
    if(closed || results.inert)return
    const first=Math.max(0,Math.floor(results.scrollTop/rowHeight)-3)
    const end=Math.min(list.length,Math.ceil((results.scrollTop+results.clientHeight)/rowHeight)+3)
    for(const [i,row] of mounted)if(i!==active && (i<first || i>=end)){row.remove();mounted.delete(i)}
    // Keep the active option mounted for the keyboard and the combobox, even during mouse scrolling.
    const indices=[]
    if(active>=0 && active<first)indices.push(active)
    for(let i=first;i<end;i++)indices.push(i)
    if(active>=end && active>=0)indices.push(active)
    let next=null
    for(let j=indices.length-1;j>=0;j--){
      const i=indices[j]
      if(!mounted.has(i)){
        const row=createRow(i);rows.insertBefore(row,next);mounted.set(i,row)
      }
      next=mounted.get(i)
    }
  }
  const resize=new ResizeObserver(paint);resize.observe(results)
  results.addEventListener('scroll',paint,{passive:true})
  function mark(index,reveal=false){
    const previous=mounted.get(active)
    if(previous){previous.classList.remove('vs-active');previous.tabIndex=-1;previous.setAttribute('aria-selected','false')}
    active=index
    if(reveal && index>=0){
      const top=index*rowHeight,bottom=top+rowHeight
      if(top<results.scrollTop)results.scrollTop=top
      else if(bottom>results.scrollTop+results.clientHeight)results.scrollTop=bottom-results.clientHeight
    }
    paint()
    const current=mounted.get(index)
    if(current){
      current.classList.add('vs-active');current.tabIndex=0;current.setAttribute('aria-selected','true')
      query.setAttribute('aria-activedescendant',current.id)
    }else query.removeAttribute('aria-activedescendant')
  }
  function showStatus(message,state){
    status.dataset.state=state
    if(status.textContent!==message)status.textContent=message
    clearTimeout(announcementTimer)
    // Wait for typing to pause before announcing the current status.
    announcementTimer=setTimeout(()=>{
      if(announcement.textContent!==message)announcement.textContent=message
    },400)
  }
  function display(response){
    clearTimeout(pendingTimer)
    displayed=serial
    const openFirst=openWhenReady && document.activeElement===query
    openWhenReady=false
    list=response.matches||[];active=-1;mounted.clear();rows.replaceChildren()
    query.removeAttribute('aria-activedescendant');rows.style.height=list.length*rowHeight+'px'
    results.inert=false;results.removeAttribute('aria-busy')
    if(response.error){showStatus(response.error,'error');return}
    const summary=list.length?tr('Найдено заметок · ','Notes found · ')+list.length.toLocaleString(getLanguage()):(source.length?tr('Совпадений нет','No matches'):tr('В этом пространстве пока нет заметок','This workspace has no notes yet'))
    showStatus(summary,'ready')
    if(list.length){
      const index=restoreId?list.findIndex(match=>match.id===restoreId):-1
      results.scrollTop=index<0?0:index*rowHeight
      mark(Math.max(0,index),true)
      if(openFirst){open(list[active]);return}
    }
    restoreId=null
  }
  function lookup(){
    if(closed || displayed===serial)return
    const opts={...flags,query:query.value,area:area.value,language:getLanguage(),deferSnippets:true}
    if(opts.area && opts.area!=='_none')opts.areaIds=[...descendantAreaIds(areas,opts.area)]
    // Opening the dialog only needs recency and filters. Transfer bodies on the first nonempty query.
    if(!opts.query){display(findNotes(source,opts));return}
    if(busy)return
    const token=serial
    if(unavailable){
      if(opts.regex && opts.query) display({error:tr('Не удалось запустить обработчик регулярных выражений в этом окне.','Could not start the regular expression worker in this window.')})
      else {
        const matches=[]
        let i=0
        function scan(){
          if(closed || token!==serial)return
          const until=performance.now()+6
          do {
            const next=Math.min(source.length,i+32)
            matches.push(...findNotes(source.slice(i,next),opts).matches)
            i=next
          }while(i<source.length && performance.now()<until)
          if(i<source.length)fallbackTimer=setTimeout(scan,0)
          else display({matches:matches.sort((a,b)=>b.rank-a.rank || b.modified-a.modified)})
        }
        scan()
      }
      return
    }
    try {
      if(!worker){
        if(useModule)worker=new Worker(new URL('./search-worker.js',import.meta.url),{type:'module'})
        else{
          blobURL=URL.createObjectURL(new Blob([searchWorkerSource()],{type:'text/javascript'}))
          worker=new Worker(blobURL)
        }
        worker.postMessage({notes:source})
      }
      const currentWorker=worker
      worker.onerror=e=>{
        e.preventDefault()
        if(closed||worker!==currentWorker)return
        stopWorker()
        if(useModule)unavailable=true
        else useModule=true
        if(timer==null)lookup()
      }
      worker.onmessage=e=>{
        if(closed||worker!==currentWorker)return
        clearTimeout(limitTimer);limitTimer=null;busy=false
        if(token===serial)display(e.data)
        else if(timer==null)lookup()
      }
      busy=true
      worker.postMessage({options:opts})
      if(opts.regex && opts.query){
        limitTimer=setTimeout(()=>{
          stopWorker()
          if(!closed&&token===serial)display({error:tr('Поиск превысил лимит времени. Уточните выражение или сузьте область поиска.','Search timed out. Refine the expression or narrow the search area.')})
        },1200)
      }
    }catch{
      stopWorker()
      if(useModule)unavailable=true
      else useModule=true
      lookup()
    }
  }
  function schedule(delay){
    clearTimeout(timer);clearTimeout(fallbackTimer);serial++;openWhenReady=false
    // Reuse the worker's copy of the workspace for ordinary queries. A regex
    // can run indefinitely, so still interrupt it immediately when superseded.
    if(limitTimer!=null)stopWorker()
    results.inert=true;results.setAttribute('aria-busy','true')
    list=[];mark(-1)
    clearTimeout(pendingTimer);clearTimeout(announcementTimer)
    pendingTimer=setTimeout(()=>{
      const message=rows.childElementCount
        ? tr('Идёт поиск · показаны предыдущие результаты','Searching · showing previous results')
        : tr('Поиск…','Searching…')
      showStatus(message,'pending')
    },250)
    timer=setTimeout(()=>{timer=null;lookup()},delay)
  }
  area.onchange=()=>schedule(0);query.oninput=()=>schedule(50);query.onblur=()=>{openWhenReady=false}
  escape.onclick=dismiss
  shade.onpointerdown=e=>{if(e.target===shade)dismiss()}
  shade.onkeydown=e=>{
    if(e.defaultPrevented||e.isComposing||e.keyCode===229||e.ctrlKey||e.metaKey||e.altKey||(e.shiftKey&&e.key!=='Tab'))return
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();dismiss();return}
    const inResults=results.contains(e.target), atQuery=e.target===query
    if((inResults || atQuery) && list.length && (e.key==='ArrowDown'||e.key==='ArrowUp'||
       ((e.key==='Home'||e.key==='End') && inResults) || e.key==='PageDown' || e.key==='PageUp')){
      e.preventDefault()
      const page=Math.max(1,Math.floor(results.clientHeight/rowHeight))
      const index={ArrowDown:active+1,ArrowUp:active-1,PageDown:active+page,PageUp:active-page,Home:0,End:list.length-1}[e.key]
      mark(Math.max(0,Math.min(list.length-1,index)),true)
      if(inResults)mounted.get(active).focus({preventScroll:true})
    }else if(e.target===query&&e.key==='Enter'){
      e.preventDefault()
      if(e.repeat)return
      if(list[active])open(list[active])
      else openWhenReady=true
    }else if(e.key==='Tab'){
      const last=mounted.get(active)||area
      if(e.shiftKey&&e.target===escape){e.preventDefault();last.focus()}
      else if(!e.shiftKey&&e.target===last){e.preventDefault();escape.focus()}
    }
  }
  signal?.addEventListener('abort',interrupt,{once:true})
  query.focus()
  if(initialState.selection)query.setSelectionRange(...initialState.selection)
  else query.select()
  if(query.value)schedule(0)
  else lookup()
  return dismiss
}
