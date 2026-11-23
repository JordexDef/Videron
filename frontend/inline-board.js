import { mountBoard } from './board.js'
import { openBoardFiles } from './board-files.js'
import { tr } from './i18n.js'

function frameButton(className, label, path) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.title = label
  b.setAttribute('aria-label', label)
  b.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="' + path + '"/></svg>'
  return b
}

export function createInlineBoard(initial, callbacks) {
  const row = document.createElement('figure')
  row.className = 've-inline-board'
  row.dataset.noteEmbed = 'drawing'
  row.tabIndex = 0
  const host = document.createElement('div')
  host.className = 've-inline-host'
  const remove = frameButton('ve-inline-remove', tr('Убрать область из заметки', 'Remove area from note'),
    'M4 5h12M7 5V3h6v2M5 7l1 10h8l1-10M8 8v6m4-6v6')
  const resize = frameButton('ve-inline-resize', tr('Изменить размер области', 'Resize area'),
    'M5 15 15 5m-4 10 4-4')
  resize.title += tr(' · Перетащите угол или используйте клавиши со стрелками',
    ' · Drag the corner or use the arrow keys')
  row.append(host, remove, resize)
  let block = initial, board, drag = null

  function showFrame(frame) {
    row.style.width = Number.isFinite(frame?.width) ? Math.max(240, frame.width) + 'px' : ''
    row.style.height = Number.isFinite(frame?.height) ? Math.max(185, frame.height) + 'px' : ''
  }
  function update(next) {
    const changed = next.board !== block.board || next.strokes !== block.strokes
    block = next
    const elements = next.board?.elements || []
    const table = elements.some(e => e.type === 'table')
    row.classList.toggle('ve-inline-table', table)
    row.classList.toggle('ve-inline-single-table', table && elements.length === 1)
    row.setAttribute('aria-label', table ? tr('Таблицы в заметке', 'Tables in note') : tr('Рисунок в заметке', 'Drawing in note'))
    if (!drag) showFrame(next.frame)
    if (changed && board) board.syncDocument(next)
  }
  function setActive(active) {
    row.classList.toggle('is-active', active)
    board?.setActive(active)
  }
  function mount() {
    if (board) return
    board = mountBoard(host, {
      document: block, inline: true,
      onActivate: callbacks.activate, onExit: callbacks.exit,
      onUndo: callbacks.undo, historyState: callbacks.historyState,
      peerTables: callbacks.peerTables, workbook: callbacks.workbook, canRenameTable: callbacks.canRenameTable,
      onFileMenu: openBoardFiles,
      onChange(doc, state) {
        // A callback from this board already contains the mounted scene.
        const { strokes, ...rest } = block
        block = { ...rest, presentation:'drawing', board: doc }
        callbacks.change(block, state?.checkpoint !== false, state?.structure)
        update(block)
      }
    })
    if (row.classList.contains('is-active')) board.setActive(true)
  }
  function changeSize(width, height) {
    const limit = row.parentElement?.clientWidth || width
    const frame = {
      width: Math.round(Math.max(Math.min(240, limit), Math.min(limit, width))),
      height: Math.round(Math.max(185, Math.min(2400, height)))
    }
    showFrame(frame)
    return frame
  }
  function commitSize(frame) {
    if (frame.width === block.frame?.width && frame.height === block.frame?.height) return
    block = { ...block, frame }
    callbacks.change(block, true)
  }
  function endResize(cancel) {
    if (!drag) return
    const saved = drag
    drag = null
    if (resize.hasPointerCapture(saved.id)) resize.releasePointerCapture(saved.id)
    if (cancel || !saved.frame) showFrame(block.frame)
    else commitSize(saved.frame)
  }
  resize.onpointerdown = event => {
    if (event.button !== 0 || drag) return
    event.preventDefault()
    callbacks.activate()
    resize.focus({preventScroll:true})
    const bounds = row.getBoundingClientRect()
    drag = { id:event.pointerId, x:event.clientX, y:event.clientY, width:bounds.width, height:bounds.height }
    resize.setPointerCapture(event.pointerId)
  }
  resize.onpointermove = event => {
    if (drag?.id !== event.pointerId) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    if (dx || dy) drag.frame = changeSize(drag.width + dx, drag.height + dy)
  }
  resize.onpointerup = e => { if (drag?.id === e.pointerId) endResize(false) }
  resize.onpointercancel = resize.onlostpointercapture = e => { if (drag?.id === e.pointerId) endResize(true) }
  resize.onkeydown = e => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    const step = e.shiftKey ? 40 : 8
    const width = row.offsetWidth + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0)
    const height = row.offsetHeight + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
    commitSize(changeSize(width, height))
  }
  remove.onclick = callbacks.remove
  row.addEventListener('keydown', e => {
    if (e.target === row && ['Delete','Backspace'].includes(e.key)) {
      e.preventDefault();e.stopPropagation()
      callbacks.remove()
    } else if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();e.stopPropagation()
      board.focus()
    }
  })
  update(initial)
  return {
    row, update, mount, setActive, key: callbacks.key,
    revealTableCell: (id, address) => board?.revealTableCell(id, address),
    tableAt(target) {
      const id = target.closest('[data-vt-addr]')?.closest('[data-table-id]')?.dataset.tableId
      return id && board?.getDocument().elements.find(e => e.type === 'table' && e.id === id)
    },
    pickExternalCell: (event, table, allowed) => board.pickExternalCell(event, table, allowed),
    refreshWorkbook: () => board?.refreshWorkbook(),
    startDrawing: () => board.setTool('pen'),
    flush() { endResize(false);board?.flush() },
    refreshHistory: () => board?.refreshHistory(),
    prepareClose() { endResize(false); return board?.prepareClose() },
    commitDraft() { return board?.commitDraft() },
    destroy() { endResize(true);board?.destroy() }
  }
}
