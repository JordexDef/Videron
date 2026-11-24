import { getLanguage, tr } from './i18n.js'
import { checkNote } from './data.js'
import { listMarkers, taskStateOf } from './note-lists.js'
import { taskTextContainer } from './task-preview.js'
import { openVaultPassword } from './vault-ui.js'

const raster = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i
const sealed = value => value && Object.hasOwn(value, 'sealed')
let dismissCurrent = null

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(text, kind, action) {
  const node = el('button', 'button ' + kind, text)
  node.type = 'button'
  node.onclick = action
  return node
}

function printed(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function labelFor(conflict) {
  if (conflict.kind === 'note') {
    const note = [conflict.local, conflict.remote].find(n => n && !sealed(n))
    return note ? note.title || tr('Без названия', 'Untitled') : tr('Зашифрованная заметка', 'Encrypted note')
  }
  if (conflict.kind === 'setting') return conflict.id === 'name' ? tr('Название пространства', 'Space name') : conflict.id
  return conflict.local?.name || conflict.remote?.name || conflict.id
}

// Hold on to the common prefix/suffix only as offsets. A change near the end
// of a long paragraph remains visible without shortening either version.
function changedRange(text, other) {
  if (text === other) return null
  let start = 0, end = text.length, otherEnd = other.length
  while (start < end && start < otherEnd && text[start] === other[start]) start++
  if (start === end && start === otherEnd) return null
  while (end > start && otherEnd > start && text[end-1] === other[otherEnd-1]) { end--; otherEnd-- }
  return [start, end]
}

function appendText(node, text, other) {
  const range = typeof other === 'string' && changedRange(text, other)
  if (!range) { node.textContent = text; return }
  const [start, end] = range
  const mark = el('mark', 'conflict-difference', text.slice(start, end))
  node.append(document.createTextNode(text.slice(0,start)), mark, document.createTextNode(text.slice(end)))
}

function readText(block) {
  if (!block) return ''
  return typeof block.text === 'string' ? block.text : Array.isArray(block.runs) ? block.runs.map(run => run?.text || '').join('') : ''
}

const previewBoards = new WeakMap()
function paintPreview(canvas) {
  import('./board.js').then(({renderBoardPreview}) => {
    if (canvas.isConnected) return renderBoardPreview(canvas, previewBoards.get(canvas))
  }).catch(() => { canvas.replaceWith(el('p','',tr('Предпросмотр холста недоступен.', 'Canvas preview unavailable.'))) })
}

function boardContent(node, board) {
  const items = board?.elements || []
  const canvas = el('canvas', 'conflict-board')
  canvas.width = 700; canvas.height = 320
  canvas.setAttribute('role','img')
  canvas.setAttribute('aria-label', tr('Холст, объектов · ', 'Canvas, objects · ') + (items.length || board?.strokes?.length || 0))
  node.append(canvas)
  previewBoards.set(canvas, board)
  paintPreview(canvas)
  // Provide full-size readable text, including formulas and cells outside
  // the visible portion of a canvas/table thumbnail.
  for (const item of items) {
    if (!item) continue
    if (item.type === 'table') {
      const details = el('details'), name = item.name || tr('Таблица','Table')
      details.append(el('summary','',name + ' · ' + item.rows + ' × ' + item.cols))
      const lines = Object.entries(item.cells || {}).map(([address,value]) => address + '   ' + value)
      details.append(el('pre','',lines.join('\n') || tr('Пустая таблица','Empty table'))); node.append(details)
    } else if (item.type === 'text' && Array.isArray(item.body)) {
      for (const block of item.body) {
        if (block?.type === 'divider') node.append(el('hr'))
        else {
          const part = el('p')
          taskTextContainer(part, taskStateOf(block)).textContent = block?.alt || readText(block)
          node.append(part)
        }
      }
    } else if (item.type === 'text' || item.label || item.alt) {
      const text = item.text || item.label || item.alt
      if (text) node.append(el('p','',text))
    }
  }
}

function dataContent(node, text, other) {
  const width = 4096, pages = Math.max(1, Math.ceil(text.length / width))
  const difference = typeof other === 'string' ? changedRange(text, other) : null
  let page = Math.min(pages - 1, Math.floor((difference?.[0] || 0) / width))
  const pre = el('pre'), nav = el('div','conflict-data-pages'), number = el('span')
  const previous = button(tr('Назад','Previous'),'secondary',()=>show(page-1))
  const next = button(tr('Далее','Next'),'secondary',()=>show(page+1))
  function show(index) {
    page = index
    const start = page * width, end = Math.min(start + width, text.length)
    const touchesPage = difference && (difference[0] === difference[1]
      ? difference[0] >= start && (difference[0] < end || end === text.length)
      : difference[0] < end && difference[1] > start)
    if (touchesPage) {
      const from = Math.max(start, difference[0]), to = Math.min(end, difference[1])
      pre.replaceChildren(text.slice(start,from), el('mark','conflict-difference',text.slice(from,to)), text.slice(to,end))
    } else pre.textContent = text.slice(start,end)
    previous.disabled = page === 0
    next.disabled = page === pages - 1
    number.textContent = (page + 1) + ' / ' + pages
  }
  if (pages > 1) { nav.append(previous,number,next); node.append(nav) }
  node.append(pre)
  show(page)
}

function noteContent(node, note, other) {
  const title = el('h3')
  const openOther = other && !sealed(other) ? other : null
  appendText(title,note.title || tr('Без названия','Untitled'),openOther?.title)
  node.append(title)
  if (note.type === 'data') dataContent(node, note.dataText, openOther?.dataText)
  else if (note.type === 'canvas') boardContent(node, note.board)
  else {
    const blocks = note.body?.length ? note.body : [{type:'paragraph', text:note.plain || ''}]
    const markers = listMarkers(blocks)
    for (const [i, block] of blocks.entries()) {
      if (!block) continue
      const counterpart = openOther?.body?.[i]
      if (block.type === 'divider') {
        node.append(el('hr',openOther && counterpart?.type !== 'divider' ? 'conflict-divider-change' : ''))
        continue
      }
      if (block.type === 'drawing') { boardContent(node, block.board || block); continue }
      if (block.type === 'image') {
        const image = el('img')
        image.alt = block.alt || tr('Изображение','Image')
        if (typeof block.src === 'string' && raster.test(block.src)) { image.src = block.src; node.append(image) }
        else node.append(el('p','',image.alt))
        continue
      }
      const part = el(block.type==='code'?'pre':block.type==='heading'||block.type==='subheading'?'h4':block.type==='quote'?'blockquote':'p')
      const state = taskStateOf(block)
      const text = taskTextContainer(part, state, openOther && taskStateOf(counterpart) !== state ? 'conflict-difference' : '')
      if (block.type === 'code' || !Array.isArray(block.runs) || !block.runs.length) {
        appendText(text,readText(block),counterpart?readText(counterpart):openOther?.plain)
      } else {
        if (markers[i] && !state) part.append(markers[i]+' ')
        if (block.indent) part.style.paddingInlineStart = Math.min(8, Math.max(0,block.indent))+'em'
        const otherRuns=counterpart?.runs || []
        for (const [j,run] of block.runs.entries()) {
          if (typeof run?.text!=='string')continue
          const span=el('span')
          if (run.bold) span.style.fontWeight='bold'
          if (run.italic) span.style.fontStyle='italic'
          if (run.underline) span.style.textDecoration='underline'
          if (/^#[\da-f]{6}$/i.test(run.color)) span.style.color=run.color
          if (run.href || run.folderPath) {span.style.textDecoration='underline';span.title=run.href || run.folderPath}
          appendText(span,run.text || '',otherRuns[j]?.text ?? (openOther?'':undefined))
          text.append(span)
        }
      }
      node.append(part)
    }
  }
  if (!openOther) return
  const mapNames = {dataLanguage:tr('Формат данных','Data format'),dataHasHeader:tr('Первая строка — заголовки','First row is a header'),areaId:tr('Область','Area'), slot:tr('Место в сетке','Grid seat'), links:tr('Связи','Links'),
    tags:tr('Теги','Tags'),color:tr('Цвет','Color'),mapExcerpt:tr('Закреплённый фрагмент','Pinned passage'),
    pinned:tr('Закрепление','Pin'), appearance:tr('Внешний вид','Appearance'), mapMetric:tr('График','Chart')}
  if(note.pinned || openOther.pinned){
    mapNames.x=tr('Координата X','X coordinate')
    mapNames.y=tr('Координата Y','Y coordinate')
  }
  for (const [key,name] of Object.entries(mapNames)) {
    if (JSON.stringify(note[key])===JSON.stringify(openOther[key])) continue
    const details=el('details')
    details.append(el('summary','',name),el('pre','',printed(note[key]) ?? '—'))
    node.append(details)
  }
}

export function dismissWorkspaceConflicts() { dismissCurrent?.() }

export function openWorkspaceConflicts({conflicts, spaceName, previewSealed}) {
  dismissWorkspaceConflicts()
  if (!conflicts.length) return Promise.resolve({})
  return new Promise(resolve => {
    const dialog = el('dialog','workspace-conflicts')
    const top=el('header'), heading=el('h2','',tr('Какую версию оставить?', 'Which version should be kept?'))
    heading.id='conflict-dialog-title';dialog.setAttribute('aria-labelledby',heading.id)
    const context=el('p','conflict-context'); context.setAttribute('aria-live','polite')
    top.append(heading,context)
    const versions=el('div','conflict-versions')
    const foot=el('footer'), choices=new Map(), lifetime=new AbortController()
    window.addEventListener('videron:themechange', () => {
      versions.querySelectorAll('canvas.conflict-board').forEach(paintPreview)
    }, {signal:lifetime.signal})
    let index=0
    function finish(result){
      if (dismissCurrent!==dismiss) return
      dismissCurrent=null
      lifetime.abort()
      dialog.close();dialog.replaceChildren();dialog.remove()
      choices.clear();resolve(result)
    }
    const dismiss=()=>finish(null)
    dismissCurrent=dismiss
    const later=button(tr('Позже','Later'),'secondary',dismiss)
    const back=button(tr('Назад','Back'),'secondary',()=>show(index-1))
    const next=button('','primary',()=>{
      if (!choices.has(conflicts[index].key)) return
      if(index===conflicts.length-1)finish(Object.fromEntries(choices))
      else show(index+1)
    })
    foot.append(later,back,next)
    dialog.append(top,versions,foot);document.body.append(dialog)
    dialog.oncancel=e=>{e.preventDefault();dismiss()}

    function show(position) {
      index=position
      const conflict=conflicts[index]
      context.textContent=[spaceName,conflicts.length>1?(index+1)+' / '+conflicts.length:'',labelFor(conflict)].filter(Boolean).join(' · ')
      versions.replaceChildren()
      for (const side of ['local','remote']) {
        const value=conflict[side], other=conflict[side==='local'?'remote':'local']
        const version=el('section','conflict-version')
        const caption=side==='local'?tr('Этот компьютер','This computer'):tr('Общая копия','From the shared space')
        const choice=el('label','conflict-source'), radio=el('input')
        radio.type='radio';radio.name='conflict-version';radio.value=side;radio.checked=choices.get(conflict.key)===side
        radio.onchange=()=>{ choices.set(conflict.key,side);next.disabled=false }
        choice.append(radio,el('span','',caption))
        const stamp=value?.modified
        if (Number.isFinite(stamp) && stamp>0) {
          const date=new Date(stamp)
          if (Number.isFinite(date.valueOf())) {
            const time=el('time','',date.toLocaleString(getLanguage(),{dateStyle:'short',timeStyle:'short'}))
            time.dateTime=date.toISOString();choice.append(time)
          }
        }
        const body=el('div','conflict-body')
        body.tabIndex=0;body.setAttribute('role','region');body.setAttribute('aria-label',caption)
        if (value==null) body.append(el('p','conflict-empty',tr('Удалено','Deleted')))
        else if (conflict.kind==='note' && sealed(value)) {
          body.append(el('p','conflict-empty',tr('Заметка защищена отдельным паролем.','This note has its own password.')))
          if (previewSealed) {
            const unlock=button(tr('Показать содержимое','Show contents'),'secondary',async()=>{
              let note
              const ok=await openVaultPassword({mode:'unlock',scope:'note',signal:lifetime.signal,onSubmit:async({password})=>{
                note=JSON.parse(await previewSealed(value.id,value.sealed,password))
                checkNote(note)
                if(note.id!==value.id || sealed(note))throw new Error('VD_INVALID')
              }})
              if(ok && note && body.isConnected) { body.replaceChildren();noteContent(body,note,other);body.focus() }
            })
            body.append(unlock)
          }
        } else if (conflict.kind==='note') noteContent(body,value,other)
        else {
          const part=el('pre')
          appendText(part,printed(value),other==null?undefined:printed(other))
          body.append(part)
        }
        version.append(choice,body);versions.append(version)
      }
      back.hidden=index===0
      next.disabled=!choices.has(conflict.key)
      next.textContent=index===conflicts.length-1?tr('Применить выбор','Apply choices'):tr('Далее','Next')
      if(dialog.open)focusVersion()
      requestAnimationFrame(()=>{
        if (!dialog.isConnected || position!==index) return
        for (const body of versions.querySelectorAll('.conflict-body')) {
          const first=body.querySelector('mark,.conflict-divider-change')
          if (first && first.offsetTop>body.clientHeight-28) body.scrollTop=Math.max(0, first.offsetTop-40)
        }
      })
    }
    function focusVersion(){ (versions.querySelector('input:checked') || versions.querySelector('input')).focus({preventScroll:true}) }
    show(0);dialog.showModal();focusVersion()
  })
}
