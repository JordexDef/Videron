import { normalizeBoard } from './board.js'
import { openBoardFiles } from './board-files.js'
import { deleteTableAxes, insertTableCells, isSheetObject, renamedTable, withoutObjects } from './board-tables.js'
import { createChartView, updateChartView } from './table-charts.js'
import { normalizeTable } from './table-engine.js'
import { makeTableUI } from './table-view.js'
import { tr } from './i18n.js'

export function isDirectTableBlock(block) {
  const elements = block.board?.elements
  return block.presentation !== 'drawing' && Array.isArray(elements) &&
    elements.length > 0 && elements.every(isSheetObject)
}

export function newTableBlock(name) {
  const table = {
    type:'table', id:crypto.randomUUID(), x:0, y:0, w:450, h:205,
    ...normalizeTable({ name })
  }
  return { type:'drawing', board:{ version:2, elements:[table] } }
}

function action(label, glyph, run) {
  const button = document.createElement('button')
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.textContent = glyph
  button.onclick = event => { event.stopPropagation(); run() }
  return button
}

export function createDirectTables(initial, callbacks) {
  const row = document.createElement('div')
  row.className = 've-direct-tables'
  row.dataset.noteEmbed = 'tables'
  row.tabIndex = -1
  let block = initial, doc = normalizeBoard(initial), mounted = false, closeFiles, finishResize
  const nodes = new Map()
  const getItem = id => doc.elements.find(e => e.id === id)
  const ui = makeTableUI({
    getTable:getItem,
    onChange(id, patch) {
      const item = getItem(id)
      if (!item || item.locked) return
      const next = { ...item, ...patch }
      // Pasting a matrix can grow the grid without using an insertion handle.
      if (next.cols > item.cols && patch.w === undefined) next.w += (next.cols - item.cols) * 88
      if (next.rows > item.rows && patch.h === undefined) next.h += (next.rows - item.rows) * 29
      for (const [key,height] of [['showName',33],['showColumnLetters',24]]) {
        if ((next[key] === false) !== (item[key] === false)) next.h += next[key] === false ? -height : height
      }
      replace(id, next)
    },
    onRename(id, name) {
      if (!callbacks.canRenameTable(id, name)) return false
      const elements = renamedTable(doc.elements, id, name)
      if (elements) commit(elements)
      return !!elements
    },
    onInsert(id, axis, index, count) {
      const structure = index < getItem(id)?.[axis] ? {kind:'insert',id,axis,index,count} : undefined
      return commit(insertTableCells(doc.elements,id,axis,index,count), structure)
    },
    onDeleteAxes(id, axis, indices) {
      return commit(deleteTableAxes(doc.elements,id,axis,indices), {kind:'delete',id,axis,indices})
    },
    onRemoveTable:remove,
    onFile(id, anchor) {
      ui.finishEdit()
      closeFiles?.()
      closeFiles = openBoardFiles({
        anchor, getDocument:() => doc, getWorkbook:() => callbacks.workbook(doc.elements),
        replaceDocument(input) {
          const next = normalizeBoard(input)
          const updated = { ...block, board:next }
          if (isDirectTableBlock(updated)) { block = updated; doc = next; render() }
          callbacks.change(updated, true)
        },
        onClose() { closeFiles = null }
      })
    },
    onUndo:callbacks.undo,
    onReferenceError:callbacks.message,
    onChart(id, range) {
      const source = getItem(id)
      if (!source) return
      const chart = {
        id:crypto.randomUUID(), type:'chart', tableId:id, chartType:'line',
        range:range.start + ':' + range.end,
        x:source.x, y:source.y + source.h + 24, w:Math.max(360, source.w), h:225
      }
      const last = doc.elements.findLastIndex(e => e.id === id || e.tableId === id)
      const elements = doc.elements.slice()
      elements.splice(last + 1, 0, chart)
      commit(elements)
      nodes.get(chart.id)?.scrollIntoView({block:'nearest'})
    }
  })
  function replace(id, next) {
    return commit(doc.elements.map(e => e.id === id ? next : e))
  }
  function commit(elements, structure) {
    if (elements === doc.elements) return false
    doc = { ...doc, version:2, elements }
    block = { ...block, board:doc }
    render()
    callbacks.change(block, true, structure)
    return true
  }
  function remove(id) {
    const item = getItem(id)
    if (!item || item.locked) return
    const deleted = new Set([id])
    for (const e of doc.elements) if (e.type === 'chart' && e.tableId === id && !e.locked) deleted.add(e.id)
    const remaining = withoutObjects(doc.elements, deleted)
    if (remaining.length) {
      const restoreFocus = nodes.get(id)?.contains(document.activeElement)
      commit(remaining)
      if (restoreFocus) row.focus({preventScroll:true})
    }
    else callbacks.remove()
  }
  function addSizeHandle(element, id) {
    const handle = document.createElement('button')
    handle.type = 'button'
    handle.className = 've-sheet-resize'
    const label = tr('Размер таблицы', 'Table size')
    handle.title = label + tr(' · Потяните за угол', ' · Drag the corner')
    handle.setAttribute('aria-label', label)
    element.append(handle)
    function limits(item, width, height) {
      const head = (item.showName === false ? 0 : 33) + (item.showColumnLetters === false ? 0 : 24) + 3
      return {
        w:Math.round(Math.max(160, Math.min(row.parentElement.clientWidth, width))),
        h:Math.round(Math.max(item.rows * 26 + head, Math.min(item.rows * 100 + head, height))),
        head
      }
    }
    handle.onpointerdown = event => {
      if (event.button !== 0 || getItem(id).locked) return
      event.preventDefault(); event.stopPropagation()
      finishResize?.(false)
      ui.finishEdit()
      handle.focus({preventScroll:true})
      const item = getItem(id), width = element.offsetWidth, startX = event.clientX, startY = event.clientY
      let pending
      const controller = new AbortController(), options = {signal:controller.signal}
      handle.setPointerCapture(event.pointerId)
      finishResize = cancel => {
        finishResize = null
        controller.abort()
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
        if (pending && !cancel) replace(id, { ...getItem(id), w:pending.w, h:pending.h })
        else if (pending) {
          element.style.width = item.w + 'px'
          element.style.setProperty('--vt-row', Math.max(26,(item.h-pending.head)/item.rows) + 'px')
        }
      }
      handle.addEventListener('pointermove', e => {
        if (e.pointerId !== event.pointerId) return
        pending = limits(item, width + e.clientX - startX, item.h + e.clientY - startY)
        element.style.width = pending.w + 'px'
        element.style.setProperty('--vt-row', (pending.h-pending.head)/item.rows + 'px')
      }, options)
      handle.addEventListener('pointerup', e => { if (e.pointerId === event.pointerId) finishResize(false) }, options)
      handle.addEventListener('lostpointercapture', () => finishResize?.(true), options)
      handle.addEventListener('pointercancel', () => finishResize?.(true), options)
      window.addEventListener('blur', () => finishResize?.(true), options)
    }
    handle.onkeydown = e => {
      if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) return
      e.preventDefault(); e.stopPropagation()
      const item = getItem(id), step = e.shiftKey ? 40 : 8
      const { w,h } = limits(item,element.offsetWidth + (e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0),
        item.h + (e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0))
      replace(id, { ...item, w,h })
    }
    return handle
  }
  function makeNode(item) {
    let element
    if (item.type === 'table') {
      element = ui.makeView(item)
      addSizeHandle(element,item.id)
    }
    else {
      element = createChartView((id, chartType) => replace(id, { ...getItem(id), chartType }))
      element.tabIndex = 0
      const removeChart = action(tr('Удалить график', 'Remove chart'), '×', () => remove(item.id))
      removeChart.className = 've-chart-remove'
      element.querySelector('.vt-chart-controls').append(removeChart)
    }
    element.dataset.sheetId = item.id
    element.dataset.sheetKind = item.type
    return element
  }
  function render() {
    if (!mounted) return
    const workbook = callbacks.workbook(doc.elements)
    const keep = new Set(doc.elements.map(e => e.id))
    for (const [id, element] of nodes) if (!keep.has(id)) {
      if (element.matches('.vt-table')) ui.removeView(element)
      nodes.delete(id); element.remove()
    }
    doc.elements.forEach((item, index) => {
      let element = nodes.get(item.id)
      if (element && element.dataset.sheetKind !== item.type) {
        if (element.matches('.vt-table')) ui.removeView(element)
        element.remove(); element=null
      }
      if (!element) { element = makeNode(item); nodes.set(item.id, element) }
      if (row.children[index] !== element) row.insertBefore(element, row.children[index] || null)
      element.style.width = Math.max(160, item.w) + 'px'
      if (item.type === 'table') {
        element.querySelector('.ve-sheet-resize').disabled = !!item.locked
        ui.updateView(element, item, workbook)
      }
      else {
        element.style.aspectRatio = Math.max(1, item.w) + '/' + Math.max(1, item.h)
        element.querySelector('.ve-chart-remove').disabled = !!item.locked
        updateChartView(element, item, workbook, doc.elements, '#171717')
      }
      if (item.locked && !element.querySelector('.ve-sheet-unlock')) {
        const unlock = action(tr('Разблокировать', 'Unlock'), '◇', () => {
          const next = { ...getItem(item.id) }
          delete next.locked
          replace(item.id, next)
        })
        unlock.className = 've-sheet-unlock'
        element.append(unlock)
      } else if (!item.locked) element.querySelector('.ve-sheet-unlock')?.remove()
    })
  }
  function focus() {
    const first = doc.elements.find(e => e.type === 'table' && !e.locked)
    if (first) ui.focusCell(first.id, 'A1')
    else row.querySelector('.vt-chart,.vt-table')?.focus({preventScroll:true})
  }
  row.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.target.matches('input,textarea,select,[contenteditable="true"]')) return
    const chart = event.target.closest('[data-sheet-kind="chart"]')
    if (chart && ['Delete','Backspace'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation()
      remove(chart.dataset.sheetId)
      return
    }
    if (event.target === row && event.key === 'Enter') {
      event.preventDefault(); focus()
    } else if ((event.ctrlKey || event.metaKey) && ['KeyZ','KeyY'].includes(event.code)) {
      event.preventDefault(); event.stopPropagation()
      callbacks.undo(event.shiftKey || event.code === 'KeyY')
    }
  })
  return {
    row, key:callbacks.key, direct:true, focus,
    mount() { if (!mounted) { mounted = true; render() } },
    update(next) {
      if (next.board !== block.board) {
        ui.finishEdit(true)
        doc = normalizeBoard(next)
        block = next
        render()
      } else block = next
    },
    setActive(active) {
      row.classList.toggle('is-active',active)
      if (!active) { finishResize?.(false); closeFiles?.(); ui.clearSelection() }
    },
    tableAt(target) {
      const id = target.closest('[data-vt-addr]')?.closest('[data-table-id]')?.dataset.tableId
      return id && getItem(id)
    },
    pickExternalCell:(event,table,allowed) => ui.pickExternalCell(event,table.name,allowed),
    refreshWorkbook:render,
    flush() { finishResize?.(false); ui.finishEdit() },
    commitDraft: ui.commitDraft,
    prepareClose() { finishResize?.(false); ui.finishEdit() },
    destroy() {
      mounted = false; finishResize?.(true); closeFiles?.(); ui.finishEdit(true); ui.destroy(); nodes.clear()
    }
  }
}
