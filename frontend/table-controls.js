import { tr } from './i18n.js';
import { TABLE_LIMITS, addressOf, parseAddress } from './table-engine.js';

const rowLabel = () => tr('Добавить строку', 'Add row');
const columnLabel = () => tr('Добавить столбец', 'Add column');

export function mountTableControls(v, { interactive, select, anchor, contextAxes, cellContext, currentAxis,
  deleteAxes, finish, focusCell, insert, change, rename, remove, file }) {
  const { root, actions, menu } = v;
  const handles = new Map();
  let stopGesture, stopMenu;
  // A top-layer menu stays readable at any canvas zoom, including rotated tables.
  const popover = typeof menu.showPopover === 'function';
  if (popover) menu.setAttribute('popover', 'manual');
  actions.setAttribute('aria-haspopup', 'menu');
  actions.setAttribute('aria-expanded', 'false');

  function closeMenu() {
    stopMenu?.abort();
    stopMenu = null;
    if (popover && menu.matches(':popover-open')) menu.hidePopover();
    menu.hidden = true;
    actions.setAttribute('aria-expanded', 'false');
  }

  function addCells(axis, index, count, location) {
    if (!interactive() || count < 1) return;
    finish();
    if (!insert(v.id, axis, index, count)) return;
    focusCell(v.id, addressOf(axis === 'rows' ? index : location.row, axis === 'cols' ? index : location.col));
  }

  function growthHandle(axis) {
    const rows = axis === 'rows';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vt-grow vt-grow-' + axis;
    const label = rows ? rowLabel() : columnLabel();
    b.setAttribute('aria-label', label);
    b.title = label + tr(' · Потяните, чтобы добавить несколько', ' · Drag to add several');
    b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="' +
      (rows ? 'M4 6h8M4 10h8' : 'M6 4v8M10 4v8') + '"/></svg>';
    root.append(b);
    handles.set(axis, b);
    b.onclick = (e) => {
      // Pointer gestures commit once on pointerup. Keyboard activation has detail 0.
      if (!e.detail) addCells(axis, v.item[axis], 1, anchor());
    };
    b.onpointerdown = (e) => {
      if (e.button !== 0 || !interactive()) return;
      e.preventDefault();
      e.stopPropagation();
      stopGesture?.();
      finish();
      const location = anchor();
      select();
      b.focus({ preventScroll: true });
      b.setPointerCapture(e.pointerId);
      const startSize = v.item[axis], remaining = TABLE_LIMITS[axis] - startSize;
      const cell = root.querySelector('.vt-cell');
      const step = Math.max(1, (rows ? cell?.offsetHeight : cell?.offsetWidth) || (rows ? 26 : 86));
      const board = root.closest('.vb');
      const angle = board ? (v.item.angle || 0) * Math.PI / 180 : 0;
      const inverseZoom = board ? Number(getComputedStyle(board).getPropertyValue('--vb-inverse')) || 1 : 1;
      const preview = document.createElement('div');
      preview.className = 'vt-grow-preview vt-preview-' + axis;
      preview.style.setProperty('--vt-grow-step', step + 'px');
      preview.hidden = true;
      const countLabel = document.createElement('span');
      preview.append(countLabel);
      root.append(preview);
      let moved = false, count = 1;
      const events = new AbortController(), opts = { signal: events.signal };
      function track(event) {
        const dx = event.clientX - e.clientX, dy = event.clientY - e.clientY;
        if (Math.hypot(dx, dy) > 4) moved = true;
        if (!moved) return;
        const delta = (rows ? -dx * Math.sin(angle) + dy * Math.cos(angle) : dx * Math.cos(angle) + dy * Math.sin(angle)) * inverseZoom;
        count = Math.min(remaining, delta > 0 ? Math.max(1, Math.round(delta / step)) : 0);
        preview.hidden = !count;
        preview.style[rows ? 'height' : 'width'] = count * step + 'px';
        countLabel.textContent = '+' + count;
      }
      const stop = () => {
        events.abort();
        if (b.hasPointerCapture(e.pointerId)) b.releasePointerCapture(e.pointerId);
        preview.remove();
        stopGesture = null;
      };
      stopGesture = stop;
      b.addEventListener('pointermove', event => { if (event.pointerId === e.pointerId) track(event); }, opts);
      b.addEventListener('pointerup', event => {
        if (event.pointerId !== e.pointerId) return;
        track(event);
        stop();
        if (v.item[axis] === startSize) addCells(axis, startSize, count, location);
      }, opts);
      b.addEventListener('lostpointercapture', stop, opts);
      b.addEventListener('pointercancel', stop, opts);
      window.addEventListener('blur', stop, opts);
      b.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); stop(); }
      }, opts);
    };
  }
  growthHandle('rows');
  growthHandle('cols');

  function action(label, run, { checked, disabled = false } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (checked !== undefined) b.setAttribute('aria-checked', String(checked));
    b.onclick = () => {
      if (!interactive()) { closeMenu(); return; }
      // Restore focus before actions that open a name field or move the selected cell.
      if (checked === undefined) {
        closeMenu();
        root.focus({ preventScroll: true });
      }
      run();
      if (checked !== undefined) b.setAttribute('aria-checked', String(b.getAttribute('aria-checked') !== 'true'));
    };
    menu.append(b);
  }
  function divider() {
    const separator = document.createElement('div');
    separator.setAttribute('role', 'separator');
    menu.append(separator);
  }
  function headerOption(axis, selected, label) {
    const key = axis === 'rows' ? 'headerRows' : 'headerCols';
    const marked = selected.filter(i => v.item[key]?.includes(i)).length;
    action(label, () => {
      const indices = new Set(v.item[key] || []);
      const allMarked = selected.every(i => indices.has(i));
      for (const i of selected) {
        if (allMarked) indices.delete(i); else indices.add(i);
      }
      change(v.id, { [key]: [...indices].sort((a, b) => a - b) });
    }, { checked: marked === selected.length ? true : marked ? 'mixed' : false });
  }
  function appearance() {
    action(tr('Переименовать', 'Rename'), () => rename(v));
    divider();
    for (const [key, label] of [
      ['showName', tr('Название таблицы', 'Table name')],
      ['showRowNumbers', tr('Номера строк', 'Row numbers')],
      ['showColumnLetters', tr('Буквы столбцов', 'Column letters')]
    ]) action(label, () => change(v.id, { [key]: v.item[key] === false }), { checked: v.item[key] !== false });
    divider();
    headerOption('rows', [0], tr('Первая строка заголовков', 'Header in first row'));
    headerOption('cols', [0], tr('Первый столбец заголовков', 'Header in first column'));
    if (file || remove) {
      divider();
      if (file) action(tr('Файл…', 'File…'), () => file(v.id, actions));
      if (remove) action(tr('Удалить таблицу', 'Remove table'), () => remove(v.id));
    }
  }
  function insertionMenu(location, groups) {
    const axes = Object.keys(groups);
    for (const axis of axes) {
      const rows = axis === 'rows';
      const i = rows ? location.row : location.col;
      const disabled = v.item[axis] >= TABLE_LIMITS[axis];
      action(rows ? tr('Вставить строку выше', 'Insert row above') : tr('Вставить столбец слева', 'Insert column left'),
        () => addCells(axis, i, 1, location), { disabled });
      action(rows ? tr('Вставить строку ниже', 'Insert row below') : tr('Вставить столбец справа', 'Insert column right'),
        () => addCells(axis, i + 1, 1, location), { disabled });
    }
    divider();
    for (const axis of axes) {
      const rows = axis === 'rows', picked = groups[axis];
      const label = rows
        ? picked.length > 1 ? tr('Удалить выбранные строки', 'Delete selected rows') : tr('Удалить строку', 'Delete row')
        : picked.length > 1 ? tr('Удалить выбранные столбцы', 'Delete selected columns') : tr('Удалить столбец', 'Delete column');
      action(picked.length > 1 ? label + ' (' + picked.length + ')' : label, () => deleteAxes(axis, picked));
    }
    divider();
    for (const axis of axes) {
      const rows = axis === 'rows';
      headerOption(axis, groups[axis],
        rows ? tr('Строка заголовков', 'Header row') : tr('Столбец заголовков', 'Header column'));
    }
  }
  function openMenu(draw, point) {
    closeMenu();
    menu.replaceChildren();
    draw();
    menu.hidden = false;
    if (popover) menu.showPopover();
    actions.setAttribute('aria-expanded', 'true');
    if (popover) {
      const bounds = menu.getBoundingClientRect();
      const left = Math.max(4, Math.min(window.innerWidth - bounds.width - 4, point.x));
      const top = Math.max(4, Math.min(window.innerHeight - bounds.height - 4, point.y));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    } else {
      const bounds = root.getBoundingClientRect();
      menu.style.left = Math.max(0, (point.x - bounds.left) * root.offsetWidth / (bounds.width || 1)) + 'px';
      menu.style.top = Math.max(0, (point.y - bounds.top) * root.offsetHeight / (bounds.height || 1)) + 'px';
    }
    stopMenu = new AbortController();
    const opts = { signal: stopMenu.signal, capture: true };
    const outside = e => { if (!menu.contains(e.target) && !actions.contains(e.target)) closeMenu(); };
    document.addEventListener('pointerdown', outside, opts);
    document.addEventListener('focusin', outside, opts);
    window.addEventListener('blur', closeMenu, { signal: stopMenu.signal });
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  menu.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); root.focus({ preventScroll: true }); return; }
    if (!['Home','End','ArrowDown','ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const choices = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = choices.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? choices.length - 1 :
      (index + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    choices[next]?.focus({ preventScroll: true });
  });
  actions.onclick = () => {
    if (!interactive()) return;
    if (!menu.hidden) { closeMenu(); return; }
    finish();
    select();
    const bounds = actions.getBoundingClientRect();
    openMenu(appearance, { x: bounds.right - 180, y: bounds.bottom + 3 });
  };
  root.addEventListener('contextmenu', event => {
    if (event.target.closest('input, .vt-menu') || !interactive()) return;
    const cell = event.target.closest('[data-vt-addr]');
    const row = event.target.closest('[data-vt-row]'), col = event.target.closest('[data-vt-col]');
    const keyboard = !event.clientX && !event.clientY;
    if (!cell && !row && !col && !keyboard) return;
    event.preventDefault();
    event.stopPropagation();
    finish();
    const location = cell ? parseAddress(cell.dataset.vtAddr) : anchor();
    if (row) location.row = Number(row.dataset.vtRow);
    if (col) location.col = Number(col.dataset.vtCol);
    const axis = row ? 'rows' : col ? 'cols' : keyboard ? currentAxis() : undefined;
    const groups = axis ? { [axis]: contextAxes(axis, axis === 'rows' ? location.row : location.col) } : cellContext(location);
    const bounds = v.cells.get(addressOf(location.row, location.col))?.cell.getBoundingClientRect() || root.getBoundingClientRect();
    openMenu(() => insertionMenu(location, groups),
      { x: keyboard ? bounds.left : event.clientX, y: keyboard ? bounds.bottom : event.clientY });
  });
  return {
    update() {
      for (const [axis, b] of handles) b.disabled = !!v.item.locked || v.item[axis] >= TABLE_LIMITS[axis];
    },
    closeMenu,
    destroy() { stopGesture?.(); closeMenu(); }
  };
}
