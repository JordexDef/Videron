import { tr, getLanguage } from './i18n.js'
import { areaTreeRows, descendantAreaIds } from './areas.js'
import { isPinned } from './area-grid.js'

import { icon } from './art.js'
import { findNotes, installSearchWorker } from './search-worker.js'
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
export function openSearch({notes, areas=[], onOpen, initialQuery='', initialState={}, onDismiss}) {
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
  status.setAttribute('role','status')
  results.id='vs-search-results';results.setAttribute('role','listbox')
  results.setAttribute('aria-label',tr('Результаты поиска','Search results'))
  const more=el('button','option vs-more',tr('Показать ещё','Show more'))
  more.hidden=true;more.type='button'
  panel.append(heading,queryRow,options,status,results,more);shade.append(panel);document.body.append(shade)
  const background=document.querySelector('.vd-editor')||document.getElementById('shell')
  if(background)background.inert=true
  const byId=new Map(notes.map(n=>[n.id,n]))
  const source=notes.map(n=>({
    id:n.id,title:n.title||tr('Без названия','Untitled'),plain:n.type==='data'?n.dataText:n.plain||'',tags:(n.tags||[]).map(t=>'#'+t).join(' '),
    areaId:n.areaId,pinned:isPinned(n),modified:n.modified||0,
  }))
  const titleAreas=new Map(), ambiguousTitles=new Set()
  for(const {title,areaId} of source){
    const id=areaId??null
    if(!titleAreas.has(title))titleAreas.set(title,id)
    else if(titleAreas.get(title)!==id)ambiguousTitles.add(title)
  }
  let worker, blobURL, timer, limitTimer, busy=false, closed=false, serial=0, list=[], shown=0, active=-1
  let useModule=false, unavailable=false, openWhenReady=false
  function stopWorker(){
    worker?.terminate();worker=null;busy=false
    if(blobURL){URL.revokeObjectURL(blobURL);blobURL=null}
    clearTimeout(limitTimer);limitTimer=null
  }
  function close(){
    if(closed)return
    closed=true;clearTimeout(timer);stopWorker();shade.remove()
    if(background)background.inert=false
    previous?.focus?.({preventScroll:true})
    if(caret&&previous?.contains(caret.commonAncestorContainer)){
      selection.removeAllRanges();selection.addRange(caret)
    }
  }
  function dismiss(){close();onDismiss?.()}
  function open(result){
    const id=result.id,note=byId.get(id)
    const state={query:query.value,area:area.value,flags:{...flags},activeId:id}
    const target=(note.modified||0)===result.modified?searchTarget(note,result.position):null
    close();onOpen?.(id,state,target)
  }
  function appendPage(){
    const end=Math.min(list.length,shown+60), frag=document.createDocumentFragment()
    for(let i=shown;i<end;i++){
      const m=list[i], note=byId.get(m.id)
      const row=el('button','result');row.type='button';row.tabIndex=-1
      row.id='vs-result-'+i;row.setAttribute('role','option');row.setAttribute('aria-selected','false')
      row.innerHTML=icon(isPinned(note)?'pin':'circle')
      const summary=el('span','note-summary'),title=el('strong'),excerpt=el('small')
      const name=note.title||tr('Без названия','Untitled')
      highlight(title,name,...(m.title||[0,0]))
      highlight(excerpt,m.snippet,m.start,m.length)
      if(ambiguousTitles.has(name)){
        const header=el('span','vs-result-heading'),place=el('small','vs-location')
        place.title=areaLabels.get(note.areaId)||tr('Без области','No area')
        place.append(el('bdi','',place.title));header.append(title,place);summary.append(header)
      }else summary.append(title)
      if(m.snippet)summary.append(excerpt)
      row.append(summary);row.onclick=()=>open(m)
      row.onfocus=()=>mark(i)
      frag.append(row)
    }
    results.append(frag);shown=end;more.hidden=shown>=list.length
  }
  function mark(index){
    const previous=results.children[active], current=results.children[index]
    if(previous){previous.classList.remove('vs-active');previous.tabIndex=-1;previous.setAttribute('aria-selected','false')}
    active=index
    if(current){
      current.classList.add('vs-active');current.tabIndex=0;current.setAttribute('aria-selected','true')
      query.setAttribute('aria-activedescendant',current.id)
    }else query.removeAttribute('aria-activedescendant')
  }
  function display(response){
    const openFirst=openWhenReady && document.activeElement===query
    openWhenReady=false
    list=response.matches||[];shown=0;mark(-1);results.replaceChildren();more.hidden=true
    results.inert=false;results.removeAttribute('aria-busy')
    if(response.error){status.textContent=response.error;status.classList.add('vs-error');return}
    status.classList.remove('vs-error')
    status.textContent=list.length?tr('Найдено заметок · ','Notes found · ')+list.length.toLocaleString(getLanguage()):(source.length?tr('Совпадений нет','No matches'):tr('В этом пространстве пока нет заметок','This workspace has no notes yet'))
    appendPage()
    if(list.length){
      const index=restoreId?list.findIndex(match=>match.id===restoreId):-1
      while(index>=shown)appendPage()
      mark(Math.max(0,index))
      if(openFirst){open(list[active]);return}
      if(index>=0)results.children[index].scrollIntoView({block:'nearest'})
      else results.scrollTop=0
    }
    restoreId=null
  }
  function lookup(){
    if(busy)return
    const opts={...flags,query:query.value,area:area.value,language:getLanguage()}
    if(opts.area && opts.area!=='_none')opts.areaIds=[...descendantAreaIds(areas,opts.area)]
    if(unavailable){
      if(opts.regex && opts.query) display({error:tr('Не удалось запустить обработчик регулярных выражений в этом окне.','Could not start the regular expression worker in this window.')})
      else display(findNotes(source,opts))
      return
    }
    const token=serial
    try {
      if(!worker){
        if(useModule)worker=new Worker(new URL('./search-worker.js',import.meta.url),{type:'module'})
        else{
          const code='('+installSearchWorker.toString()+')('+findNotes.toString()+')'
          blobURL=URL.createObjectURL(new Blob([code],{type:'text/javascript'}))
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
    clearTimeout(timer);serial++;openWhenReady=false
    // Reuse the worker's copy of the workspace for ordinary queries. A regex
    // can run indefinitely, so still interrupt it immediately when superseded.
    if(limitTimer!=null)stopWorker()
    list=[];shown=0;mark(-1);more.hidden=true
    results.inert=true;results.setAttribute('aria-busy','true')
    status.classList.remove('vs-error');status.textContent=tr('Поиск…','Searching…')
    timer=setTimeout(()=>{timer=null;lookup()},delay)
  }
  area.onchange=()=>schedule(0);query.oninput=()=>schedule(50);query.onblur=()=>{openWhenReady=false}
  more.onclick=()=>{
    const firstNew=shown
    appendPage()
    results.children[firstNew]?.focus()
  }
  escape.onclick=dismiss
  shade.onpointerdown=e=>{if(e.target===shade)dismiss()}
  shade.onkeydown=e=>{
    if(e.isComposing)return
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();dismiss();return}
    const inResults=e.target===query||results.contains(e.target)
    if(inResults && list.length && (e.key==='ArrowDown'||e.key==='ArrowUp')){
      e.preventDefault()
      const index=Math.max(0,Math.min(list.length-1,active+(e.key==='ArrowDown'?1:-1)))
      if(index>=shown)appendPage()
      mark(index);results.children[index].scrollIntoView({block:'nearest'})
      if(e.target!==query)results.children[index].focus()
    }else if(e.target===query&&e.key==='Enter'){
      e.preventDefault()
      if(list[active])open(list[active])
      else openWhenReady=true
    }else if(e.key==='Tab'){
      const last=more.hidden?(results.children[active]||area):more
      if(e.shiftKey&&e.target===escape){e.preventDefault();last.focus()}
      else if(!e.shiftKey&&e.target===last){e.preventDefault();escape.focus()}
    }
  }
  query.focus();query.select();lookup()
  return dismiss
}
