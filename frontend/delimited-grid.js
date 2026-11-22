import { tr, getLanguage } from './i18n.js'
import { openDelimitedSession } from './delimited-worker.js'

const rowHeight = 28, headerHeight = 34, columnWidth = 164, gutter = 62
// Keep the physical scroll offset within single-pixel precision in WebViews.
const maxExtent = 16_000_000
const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
function columnLetter(index) {
  let label = ''
  for (let n=index+1; n; n=Math.floor((n-1)/26)) label = String.fromCharCode(65+(n-1)%26)+label
  return label
}
function node(tag, className, text) {
  const el = document.createElement(tag)
  el.className = className
  if (text !== undefined) el.textContent = text
  return el
}
function button(className, label) {
  const el = node('button','ve-btn '+className,label)
  el.type = 'button'
  return el
}

// The scroll surface stays within browser layout limits. All cell and header DOM
// lives in a viewport-sized sticky layer, so even the last row uses small CSS coordinates.
export function mountDelimitedGrid(host, {source,format,header=true,restore,onChange,onHeaderChange,onSourceRange}) {
  const numeric = new Intl.NumberFormat(getLanguage())
  const root = node('div','vd-grid-root'), toolbar = node('div','vd-grid-toolbar')
  const first = node('input','vd-grid-first-row'); first.type = 'checkbox'; first.checked = header
  const headerLabel = node('label','vd-grid-header-option')
  headerLabel.append(first,document.createTextNode(tr('Первая строка — заголовки','First row contains headers')))
  const unique = button('vd-grid-unique',tr('Удалить дубликаты','Remove duplicates'))
  const keys = node('span','vd-grid-key-count')
  unique.append(keys)
  unique.title = tr('Отметьте столбцы для сравнения. Первое совпадение сохраняется.','Check columns to compare. The first occurrence is kept.')
  toolbar.append(headerLabel,unique)
  const scroll = node('div','vd-grid-scroll'), space = node('div','vd-grid-space'), plane = node('div','vd-grid-plane')
  scroll.tabIndex = 0; scroll.setAttribute('role','grid'); scroll.setAttribute('aria-label',tr('Таблица данных','Data table'))
  scroll.setAttribute('aria-readonly','true')
  const head = node('div','vd-grid-header'), corner = node('div','vd-grid-corner','#'), headClip = node('div','vd-grid-head-clip')
  head.setAttribute('role','row'); head.setAttribute('aria-rowindex','1')
  corner.setAttribute('role','columnheader')
  const headings = node('div','vd-grid-headings'), bodyClip = node('div','vd-grid-body'), body = node('div','vd-grid-rows')
  const numberClip = node('div','vd-grid-number-clip'), numbers = node('div','vd-grid-numbers')
  numberClip.setAttribute('aria-hidden','true')
  headClip.append(headings); head.append(corner,headClip)
  bodyClip.append(body); numberClip.append(numbers); plane.append(head,numberClip,bodyClip); space.append(plane); scroll.append(space)
  const foot = node('div','vd-grid-footer'), count = node('span','vd-grid-count'), status = node('span','vd-grid-status')
  status.setAttribute('role','status')
  const cancel = button('vd-grid-cancel',tr('Отмена','Cancel'))
  const edit = button('vd-grid-edit',tr('Открыть в тексте','Open in text'))
  foot.append(count,status,cancel,edit)
  root.append(toolbar,scroll,foot); host.replaceChildren(root)
  root.style.setProperty('--vd-grid-row',rowHeight+'px'); root.style.setProperty('--vd-grid-head',headerHeight+'px')
  root.style.setProperty('--vd-grid-col',columnWidth+'px'); root.style.setProperty('--vd-grid-gutter',gutter+'px')

  const checked = new Set(), id = 'vd-grid-'+crypto.randomUUID()
  let session, meta, windowData, request, sort, task, frame, errorOffset
  let active = null, headFirst = -1, headNames = [], finished = false, state = 'opening'
  function setState(value,message='') {
    state = value; root.dataset.state = state; status.textContent = message
    scroll.setAttribute('aria-busy', String(state==='opening' || state==='working'))
    first.disabled = state!=='ready'
    cancel.hidden = state!=='working'
    edit.hidden = !onSourceRange || (state==='error' ? errorOffset==null : state!=='ready' || !active)
    refreshControls()
  }
  function refreshControls() {
    unique.disabled = state!=='ready' || !checked.size || dataRows()<2
    keys.textContent = checked.size ? String(checked.size) : ''
    for (const cell of headings.children) {
      const column = Number(cell.dataset.column), chosen = checked.has(column)
      const sorted = sort?.column===column ? sort.direction : null
      cell.classList.toggle('vd-grid-key',chosen)
      cell.setAttribute('aria-sort',sorted==='asc'?'ascending':sorted==='desc'?'descending':'none')
      const check = cell.firstChild, target = cell.lastChild
      check.disabled = target.disabled = state!=='ready'
      check.checked = chosen
      target.querySelector('.vd-grid-arrow').textContent = sorted==='asc'?'↑':sorted==='desc'?'↓':'↕'
    }
    for (const cell of body.querySelectorAll('[data-column]')) cell.classList.toggle('vd-grid-key',checked.has(+cell.dataset.column))
  }
  const headerOffset = () => Number(first.checked && !!meta?.rowCount)
  function dataRows(){return (meta?.rowCount || 0)-headerOffset()}
  function layOut() {
    const rows=dataRows(), columns=meta?.columnCount||0
    const width=gutter+columns*columnWidth, height=headerHeight+rows*rowHeight
    // Read back the real scroll range for engines that clamp below maxExtent.
    space.style.width=Math.max(scroll.clientWidth,Math.min(width,maxExtent))+'px'
    space.style.height=Math.max(scroll.clientHeight,Math.min(height,maxExtent))+'px'
    plane.style.width=scroll.clientWidth+'px'; plane.style.height=scroll.clientHeight+'px'
    scroll.setAttribute('aria-rowcount',String(rows+1)); scroll.setAttribute('aria-colcount',String(columns+1))
    count.textContent=meta ? tr('Строк: ','Rows: ')+numeric.format(rows)+' · '+tr('Столбцов: ','Columns: ')+numeric.format(columns) : ''
  }
  function geometry() {
    const width=scroll.clientWidth,height=scroll.clientHeight
    const maxX=Math.max(0,gutter+(meta?.columnCount||0)*columnWidth-width)
    const maxY=Math.max(0,headerHeight+dataRows()*rowHeight-height)
    const physicalX=Math.max(0,scroll.scrollWidth-width), physicalY=Math.max(0,scroll.scrollHeight-height)
    return {width,height,maxX,maxY,physicalX,physicalY,
      x:physicalX?clamp(scroll.scrollLeft,0,physicalX)*maxX/physicalX:0,
      y:physicalY?clamp(scroll.scrollTop,0,physicalY)*maxY/physicalY:0}
  }
  function move(g) {
    if (!windowData) return
    const x=Math.round(windowData.col*columnWidth-g.x), y=Math.round(windowData.row*rowHeight-g.y)
    body.style.transform='translate('+x+'px,'+y+'px)'
    numbers.style.transform='translateY('+y+'px)'
    headings.style.transform='translateX('+x+'px)'
  }
  function paintActive() {
    const old=body.querySelector('.vd-grid-active'); if(old){old.classList.remove('vd-grid-active');old.removeAttribute('aria-selected')}
    scroll.removeAttribute('aria-activedescendant')
    if(active){
      const el=document.getElementById(id+'-'+active.row+'-'+active.col)
      if(el){el.classList.add('vd-grid-active');el.setAttribute('aria-selected','true');scroll.setAttribute('aria-activedescendant',el.id)}
    }
    edit.hidden = !onSourceRange || (state==='error' ? errorOffset==null : state!=='ready' || !active)
  }
  function paintHead(col, labels) {
    if(headFirst===col && labels.length===headNames.length && labels.every((name,i)=>name===headNames[i]))return
    const focus = headings.contains(document.activeElement) ? document.activeElement.dataset : null
    headFirst=col;headNames=labels
    const next=document.createDocumentFragment()
    labels.forEach((label,i)=>{
      const index=col+i, title=label || columnLetter(index)
      const cell=node('div','vd-grid-heading');cell.dataset.column=index;cell.setAttribute('role','columnheader')
      cell.setAttribute('aria-colindex',String(index+2))
      const check=node('input','vd-grid-keybox');check.type='checkbox';check.dataset.key=index
      const hint=tr('Сравнивать по столбцу ','Compare duplicates by column ')+title
      check.title=hint;check.setAttribute('aria-label',hint)
      const target=button('vd-grid-sort','');target.dataset.sort=index
      target.append(node('span','vd-grid-col-name',title),node('span','vd-grid-arrow'))
      target.setAttribute('aria-label',tr('Сортировать по столбцу ','Sort by column ')+title)
      target.title=title+' · '+tr('Сортировать. Ctrl/⌘ + щелчок — выбрать для поиска дубликатов','Sort. Ctrl/⌘ + click to select for duplicate removal')
      target.lastChild.setAttribute('aria-hidden','true')
      cell.append(check,target);next.append(cell)
    })
    headings.replaceChildren(next)
    if(focus){
      const target=focus.sort!=null ? headings.querySelector('[data-sort="'+focus.sort+'"]') : headings.querySelector('[data-key="'+focus.key+'"]')
      target?.focus({preventScroll:true})
    }
  }
  function paintWindow(view) {
    const next=document.createDocumentFragment(), indices=document.createDocumentFragment()
    view.values.forEach((record,i)=>{
      const rowIndex=view.row+i, row=node('div','vd-grid-row')
      row.dataset.record=rowIndex+headerOffset();row.setAttribute('role','row');row.setAttribute('aria-rowindex',String(rowIndex+2))
      indices.append(node('div','vd-grid-number',numeric.format(rowIndex+1)))
      for(let j=0;j<view.cols;j++){
        const col=view.col+j, raw=record[j]||'', preview=raw.slice(0,2048)
        const cell=node('div','vd-grid-cell',preview.replace(/\r\n?|\n/g,' ↵ ')+(raw.length>2048?'…':''))
        cell.id=id+'-'+rowIndex+'-'+col;cell.dataset.column=col;cell.setAttribute('role','gridcell');cell.setAttribute('aria-colindex',String(col+2))
        if(preview)cell.title=preview
        row.append(cell)
      }
      next.append(row)
    })
    body.replaceChildren(next);numbers.replaceChildren(indices)
    paintHead(view.col,view.labels);refreshControls();paintActive();move(geometry())
  }
  function schedule() {
    if(!frame && !finished)frame=requestAnimationFrame(()=>{frame=0;void draw()})
  }
  async function draw() {
    if(!meta || finished)return
    const g=geometry();move(g)
    const cols=meta.columnCount,rows=dataRows(),c0=Math.floor(g.x/columnWidth),r0=Math.floor(g.y/rowHeight)
    const c1=Math.min(cols,Math.ceil((g.x+Math.max(0,g.width-gutter))/columnWidth))
    const r1=Math.min(rows,Math.ceil((g.y+Math.max(0,g.height-headerHeight))/rowHeight))
    if(windowData && r0>=windowData.row && c0>=windowData.col &&
      r1<=windowData.row+windowData.values.length && c1<=windowData.col+windowData.cols)return
    if(request)return request.promise
    const col=Math.max(0,c0-2), row=Math.max(0,r0-12)
    const nc=Math.min(cols,c1+2)-col, nr=Math.min(rows,r1+12)-row
    const current=session, firstRow=headerOffset(), token={};request=token
    const labels=firstRow && nc ? (headFirst===col && headNames.length===nc ? Promise.resolve([headNames]) : current.read(0,1,col,nc,256)) : Promise.resolve([])
    token.promise=(async()=>{
      try {
        const [values,names]=await Promise.all([nr&&nc?current.read(row+firstRow,nr,col,nc,2049):[],labels])
        if(finished || request!==token)return
        windowData={col,row,cols:nc,values,labels:Array.from({length:nc},(_,i)=>String(names[0]?.[i]||'').slice(0,256))}
        paintWindow(windowData)
      }catch(error){if(request===token && !finished)showError(error)}
      finally{if(request===token){request=null;if(state!=='error')schedule()}}
    })()
    return token.promise
  }
  function clearWindow(){
    request=null;windowData=null;headFirst=-1;headNames=[]
    headings.replaceChildren();body.replaceChildren();numbers.replaceChildren()
  }
  function showError(error){
    meta=null;clearWindow();layOut()
    errorOffset=Number.isInteger(error?.offset)?error.offset:null
    setState('error',error?.code==='MALFORMED'
      ? tr('Не удалось разобрать запись ','Could not parse record ')+numeric.format(error.row)+tr('. Проверьте кавычки.','. Check the quotes.')
      : tr('Не удалось открыть таблицу','Could not open table'))
  }
  async function load(raw,message,bookmark,committing=false) {
    if(finished)return false
    task?.abort();task=null
    if(!committing)session?.close()
    source=raw;meta=null;errorOffset=null;clearWindow()
    setState('opening',tr('Открытие таблицы…','Opening table…'))
    const current=committing?session:openDelimitedSession(raw,format==='tsv'?'\t':',');session=current
    try {
      // Re-index the already accepted text in the same worker. Sending it
      // back from the editor would copy the entire file a second time.
      const info=await (committing?current.commit():current.ready)
      if(session!==current || finished)return false
      meta=info
      if(bookmark){
        for(const col of bookmark.columns || [])if(Number.isInteger(col) && col>=0)checked.add(col)
        const validPosition=bookmark.active
        if(validPosition && Number.isInteger(validPosition.row) && validPosition.row>=0 &&
            Number.isInteger(validPosition.col) && validPosition.col>=0)active={...validPosition}
        const lastSort=bookmark.sort
        if(lastSort && Number.isInteger(lastSort.column) && lastSort.column>=0 && lastSort.column<meta.columnCount &&
            ['asc','desc'].includes(lastSort.direction))sort={...lastSort}
      }
      for(const col of checked)if(col>=meta.columnCount)checked.delete(col)
      if(active && (active.row>=dataRows() || active.col>=meta.columnCount))active=null
      layOut()
      if(bookmark){scroll.scrollTop=bookmark.scrollTop || 0;scroll.scrollLeft=bookmark.scrollLeft || 0;restore=null}
      await draw()
      if(session!==current || finished || state==='error')return false
      setState('ready',message);paintActive()
      return true
    }catch(error){if(!finished && session===current)showError(error);return false}
  }
  function toggleKey(column) {
    if(state!=='ready')return
    if(checked.has(column))checked.delete(column);else checked.add(column)
    refreshControls()
  }
  async function run(op) {
    if(state!=='ready')return
    const current=session, controller=new AbortController();task=controller
    setState('working',op.kind==='sort'?tr('Сортировка…','Sorting…'):tr('Поиск дубликатов…','Finding duplicates…'))
    try{
      const result=await current.transform({...op,header:first.checked,language:getLanguage()})
      if(finished || task!==controller || controller.signal.aborted)return
      const message=op.kind==='sort'?tr('Отсортировано','Sorted'):
        result.removed ? tr('Удалено повторов: ','Duplicates removed: ')+numeric.format(result.removed) : tr('Дубликатов нет','No duplicates')
      if(result.text!==null){
        await onChange(result.text,controller.signal)
        if(finished || task!==controller || controller.signal.aborted)return
      }
      if(op.kind==='sort')sort={column:op.column,direction:op.direction}
      if(result.text!==null){task=null;await load(result.text,message,null,true)}
      else{task=null;setState('ready',message)}
    }catch(error){
      if(!finished && task===controller){
        task=null;setState('ready',error?.name==='AbortError'?tr('Операция отменена','Operation cancelled'):tr('Не удалось применить изменение','Could not apply change'))
      }
    }
  }
  function sortColumn(col) {
    void run({kind:'sort',column:col,direction:sort?.column===col && sort.direction==='asc'?'desc':'asc'})
  }
  headings.addEventListener('change',event=>{if(event.target.matches('[data-key]'))toggleKey(+event.target.dataset.key)})
  headings.addEventListener('click',event=>{
    const target=event.target.closest('[data-sort]')
    if(!target)return
    if(event.ctrlKey || event.metaKey)toggleKey(+target.dataset.sort);else sortColumn(+target.dataset.sort)
  })
  unique.onclick=()=>{if(checked.size)void run({kind:'unique',columns:[...checked]})}
  cancel.onclick=()=>{if(task)void load(source,tr('Операция отменена','Operation cancelled'))}
  first.onchange=()=>{
    sort=null;active=null;onHeaderChange?.(first.checked);clearWindow();layOut();refreshControls();schedule()
  }
  function setActive(row,col,ensure=false) {
    if(state!=='ready' || !dataRows() || !meta.columnCount)return
    active={row:clamp(row,0,dataRows()-1),col:clamp(col,0,meta.columnCount-1)}
    if(ensure){
      const g=geometry(), x=active.col*columnWidth, y=active.row*rowHeight
      const left=clamp(g.x,x-Math.max(0,g.width-gutter-columnWidth),x)
      const top=clamp(g.y,y-Math.max(0,g.height-headerHeight-rowHeight),y)
      if(g.maxX)scroll.scrollLeft=Math.round(left*g.physicalX/g.maxX)
      if(g.maxY)scroll.scrollTop=Math.round(top*g.physicalY/g.maxY)
      schedule()
    }
    paintActive()
  }
  async function openSource() {
    if(!onSourceRange)return
    if(state==='error' && errorOffset!=null){onSourceRange(errorOffset,errorOffset);return}
    if(state!=='ready' || !active)return
    const current=session, selection=active
    try{
      const range=await current.cellRange(selection.row+headerOffset(),selection.col)
      if(!finished && current===session && selection===active)onSourceRange(range.from,range.to)
    }catch{if(!finished && current===session)status.textContent=tr('Не удалось открыть ячейку','Could not open cell')}
  }
  body.addEventListener('click',event=>{
    const cell=event.target.closest('[data-column]');if(!cell)return
    scroll.focus({preventScroll:true});setActive(+cell.parentNode.dataset.record-headerOffset(),+cell.dataset.column)
    if(event.detail===2)void openSource()
  })
  edit.onclick=openSource
  scroll.addEventListener('keydown',event=>{
    if(event.target!==scroll || state!=='ready' || event.altKey || event.shiftKey)return
    const row=active?.row??0,col=active?.col??0, command=event.ctrlKey||event.metaKey
    const step=Math.max(1,Math.floor((scroll.clientHeight-headerHeight)/rowHeight)-1)
    switch(event.key){
      case 'ArrowDown':setActive(row+1,col,true);break
      case 'ArrowUp':setActive(row-1,col,true);break
      case 'ArrowLeft':setActive(row,col-1,true);break
      case 'ArrowRight':setActive(row,col+1,true);break
      case 'PageDown':setActive(row+step,col,true);break
      case 'PageUp':setActive(row-step,col,true);break
      case 'Home':setActive(command?0:row,0,true);break
      case 'End':setActive(command?dataRows()-1:row,meta.columnCount-1,true);break
      case 'Enter':case 'F2':void openSource();break
      default:return
    }
    event.preventDefault();event.stopPropagation()
  })
  scroll.addEventListener('scroll',schedule,{passive:true})
  const resize=new ResizeObserver(()=>{if(meta){layOut();schedule()}});resize.observe(scroll)
  const ready=load(source,'',restore)
  return {ready,focus(){scroll.focus({preventScroll:true})},
    snapshot(){
      if(!meta && restore && state==='opening')return restore
      return {scrollTop:scroll.scrollTop,scrollLeft:scroll.scrollLeft,columns:[...checked],
        active:active && {...active},sort:sort && {...sort}}
    },
    refresh(raw){sort=null;return load(raw,'')},
    destroy(){finished=true;task?.abort();task=null;session?.close();resize.disconnect();cancelAnimationFrame(frame);root.remove()}}
}
