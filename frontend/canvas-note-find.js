import {richBodyFindRecords, replaceFindBody, replaceNoteString} from './note-find-text.js';
import {richPlain, richBlocks} from './board-rich-text.js';
import {boardShapes} from './board-summary.js';
import {DEFAULT_COLS, DEFAULT_ROWS, parseAddress} from './table-engine.js';

// Tuple keys also support imported object IDs containing punctuation.
export function canvasFindRecords(elements) {
  const records = [];
  for (const item of elements) {
    const add = (kind, key, text, readOnly = !!item.locked) =>
      records.push({id:JSON.stringify([item.id,kind,key]),text,readOnly});
    if (item.type === 'text') {
      if (item.folderPath) continue;
      if (item.body) {
        for (const block of richBodyFindRecords(item.body)) add('body',block.id,block.text);
      } else add('text',null,item.text || '');
    } else if (boardShapes.has(item.type) && item.label) add('label',null,item.label);
    else if (item.type === 'table') {
      for (const [address,raw] of Object.entries(item.cells || {})) {
        const at = parseAddress(address);
        if (at && at.row < (item.rows ?? DEFAULT_ROWS) && at.col < (item.cols ?? DEFAULT_COLS) &&
          (typeof raw === 'string' || Number.isFinite(raw))) add('cell',address,String(raw));
      }
    }
  }
  return records;
}

export function replaceCanvasMatches(elements, edits) {
  const changes = new Map();
  for (const edit of edits) {
    const [id,kind,key] = JSON.parse(edit.id);
    if (!changes.has(id)) changes.set(id,new Map());
    const fields = changes.get(id);
    if (!fields.has(key)) fields.set(key,{kind,edits:[]});
    fields.get(key).edits.push({...edit,id:key});
  }
  let changed = false;
  const next = elements.map(item => {
    const fields = changes.get(item.id);
    if (!fields || item.locked || item.folderPath) return item;
    if (item.type === 'text' && item.body) {
      const edits = [...fields.values()].filter(f => f.kind === 'body').flatMap(f => f.edits);
      if (!edits.length) return item;
      const body = replaceFindBody(item.body,edits);
      changed = true;
      return {...item,body,text:richPlain(richBlocks(body))};
    }
    if (item.type === 'table') {
      let cells = item.cells;
      for (const [address,field] of fields) {
        if (field.kind !== 'cell' || !cells || !Object.hasOwn(cells,address)) continue;
        const source = String(cells[address]);
        const raw = replaceNoteString(source,field.edits);
        if (raw === source) continue;
        if (cells === item.cells) cells = {...cells};
        if (raw) cells[address] = raw;
        else delete cells[address];
      }
      if (cells === item.cells) return item;
      changed = true;
      return {...item,cells};
    }
    const field = fields.get(null);
    if (!field || !(field.kind === 'label' && boardShapes.has(item.type) ||
        field.kind === 'text' && item.type === 'text')) return item;
    const text = replaceNoteString(item[field.kind] || '',field.edits);
    if (text === item[field.kind]) return item;
    changed = true;
    return {...item,[field.kind]:text};
  });
  return changed ? next : elements;
}

export function canvasFindSelection(elements, selected, views) {
  const field = document.activeElement, item = field?.closest('.vb-object')?.dataset.id;
  if (item && field.closest('.vb-rich-item')) {
    const mark = views.get(item)?.rich?.findSelection?.();
    if (mark) {
      const onCanvas = r => ({...r,id:JSON.stringify([item,'body',r.id])});
      return mark.ranges ? {...mark,ranges:mark.ranges.map(onCanvas)} : onCanvas(mark);
    }
  }
  if (item && field.matches('.vb-text,.vb-shape-label-input')) {
    const kind = field.matches('.vb-text') ? 'text' : 'label';
    const from = field.selectionStart, to = field.selectionEnd;
    return {id:JSON.stringify([item,kind,null]),from,to,text:field.value.slice(from,to)};
  }
  if (!selected.size) return null;
  const ranges = canvasFindRecords(elements.filter(item => selected.has(item.id)))
    .filter(record => record.text.length).map(({id,text}) => ({id,from:0,to:text.length}));
  return ranges.length ? {ranges} : null;
}

// Keep search decoration outside the board document and its undo history.
export function canvasFindPainter(views, tableUI, panTo) {
  let decorated = [], clearActive, previous;
  return function paint(matches, active, reveal) {
    clearActive?.(); clearActive = null;
    if (matches !== previous) {
      previous = matches;
      for (const wrap of decorated) wrap.classList.remove('vb-find-object');
      decorated = [];
      let lastRecord, view;
      for (const hit of matches) {
        if (hit.id === 'title' || lastRecord === hit.id) continue;
        lastRecord = hit.id;
        const next = views.get(JSON.parse(hit.id)[0]);
        if (!next || next === view) continue;
        view = next;
        view.wrap.classList.add('vb-find-object');
        decorated.push(view.wrap);
      }
    }
    const hit = matches[active];
    if (!hit || hit.id === 'title') return;
    const [id,kind,key] = JSON.parse(hit.id), view = views.get(id);
    if (!view) return;
    const {from,to} = hit;
    let marker = view.wrap, cleanup;
    if (kind === 'cell') {
      marker = (reveal ? tableUI.revealSearchCell(id,key,true) : view.content.querySelector('[data-vt-addr="'+key+'"]')) || marker;
    } else if (kind === 'body' && view.rich) {
      view.rich.revealSearchMatch({kind:'body',ranges:[{index:Number(key),start:from,end:to}]},{persistent:true,scrollTo:reveal});
      cleanup = () => view.rich.clearSearchMatch();
    } else if (kind === 'label' && view.caption) {
      view.caption.highlight(from,to,true);
      marker = view.wrap.querySelector('.vb-find-mark') || view.wrap;
      cleanup = () => view.caption.clearHighlight();
    } else if (kind === 'text') {
      const field = view.content, mirror = document.createElement('div'), mark = document.createElement('span');
      mirror.className = 'vb-text vb-find-mirror'; mirror.style.cssText = field.style.cssText;
      mirror.setAttribute('aria-hidden','true');
      mark.className = 'vb-find-mark'; mark.textContent = field.value.slice(from,to);
      mirror.append(field.value.slice(0,from),mark,field.value.slice(to));
      view.wrap.append(mirror); mirror.scrollTop = field.scrollTop; mirror.scrollLeft = field.scrollLeft;
      marker = mark; cleanup = () => mirror.remove();
    }
    marker.classList.add('vb-find-active');
    if (reveal && !(kind === 'body' && view.rich)) panTo(marker.getBoundingClientRect());
    clearActive = () => {marker.classList.remove('vb-find-active'); cleanup?.();};
  };
}
