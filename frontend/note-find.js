import { tr } from './i18n.js';
import { isMacPlatform, primaryCommand, shortcutLabel } from './shortcuts.js';
import { findNoteMatches, replacementText, trackFindSelection } from './note-find-matches.js';

const glyphs = {
  expand:'m9 5 7 7-7 7', prev:'M12 19V5m-6 6 6-6 6 6',
  next:'M12 5v14m-6-6 6 6 6-6', close:'m6 6 12 12M18 6 6 18',
  scope:'M4 6h16M8 10h12M4 14h16M8 18h12',
  one:'M3 6h10m-3-3 3 3-3 3M4 12h9v7H4zm13 1 3 3-3 3',
  all:'M3 5h11m-3-3 3 3-3 3M3 10h10v7H3zm4 11h10v-7m2-5 3 3-3 3'
};
function el(tag,cls) {
  const node=document.createElement(tag);
  node.className=cls;
  return node;
}
function button(key,label,action,glyph,text) {
  const node=el('button','nf-button');
  node.type='button';
  node.dataset.findAction=key;
  node.title=label;
  node.setAttribute('aria-label',label);
  if (glyph) node.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+glyphs[glyph]+'"/></svg>';
  else node.textContent=text;
  node.addEventListener('click',action);
  return node;
}
function input(label) {
  const field=el('input','nf-input');
  field.type='text';
  field.placeholder=label;
  field.setAttribute('aria-label',label);
  field.autocomplete='off';
  field.spellcheck=false;
  return field;
}

// Regexes are interruptible even on WebViews that load the UI from a custom scheme.
function runWorker(data, done) {
  let worker, url, timeout, cancelled=false;
  function stop() {
    clearTimeout(timeout);
    worker?.terminate();
    if (url) URL.revokeObjectURL(url);
    worker=null;url=null;
  }
  function start(module) {
    try {
      if (module) worker=new Worker(new URL('./note-find-worker.js',import.meta.url),{type:'module'});
      else {
        const script='const find='+findNoteMatches.toString()+';onmessage=({data})=>postMessage(find(data.records,data.options,data.ranges))';
        url=URL.createObjectURL(new Blob([script],{type:'text/javascript'}));
        worker=new Worker(url);
      }
      worker.onmessage=e=>{stop();if (!cancelled) done(e.data)};
      worker.onerror=e=>{e.preventDefault();failed()};
      worker.postMessage(data);
      timeout=setTimeout(()=>{stop();if (!cancelled) done({matches:[],error:'timeout'})},2000);
    } catch { failed(); }
    function failed() {
      stop();
      if (cancelled) return;
      if (!module) start(true);
      else done(data.options.regex ? {matches:[],error:'worker'} : findNoteMatches(data.records,data.options,data.ranges));
    }
  }
  start(false);
  return ()=>{cancelled=true;stop()};
}

export function mountNoteFind(root,adapter) {
  const panel=el('section','note-find');
  panel.hidden=true;
  panel.setAttribute('role','search');
  panel.setAttribute('aria-label',tr('Поиск по заметке','Find in note'));
  const search=input(tr('Найти','Find')), replacement=input(tr('Заменить на','Replace with'));
  const options={matchCase:false,wholeWord:false,regex:false,preserveCase:false};
  const history=new Map([[search,[]],[replacement,[]]]),historyState=new Map();
  let matches=[], current=-1, records=[], anchor, selectionRanges, scoped=false;
  let selectionRecords, inputLocation;
  let cancelWorker, timer, pending=false, scanning=false, refreshQueued=false, returnFocus, destroyed=false;
  function toggle(key,label,mark) {
    const node=button(key,label,()=>{
      options[key]=!options[key];
      node.setAttribute('aria-pressed',String(options[key]));
      if (key!=='preserveCase') scan(true);
    },null,mark);
    node.setAttribute('aria-pressed','false');
    return node;
  }
  const cases=toggle('matchCase',tr('Учитывать регистр','Match case')+' (Alt+C)','Aa');
  const words=toggle('wholeWord',tr('Слово целиком','Match whole word')+' (Alt+W)','ab');
  const regex=toggle('regex',tr('Регулярное выражение','Regular expression')+' (Alt+R)','.*');
  const preserve=toggle('preserveCase',tr('Сохранять регистр','Preserve case'),'AB');
  const scope=button('scope',tr('Искать в выделенном','Find in selection'),()=>{
    scoped=!scoped;
    scope.setAttribute('aria-pressed',String(scoped));scan(true);
  },'scope');
  scope.setAttribute('aria-pressed','false');
  const count=el('output','nf-count');
  count.setAttribute('aria-live','polite');
  const prev=button('previous',tr('Предыдущее совпадение','Previous match')+' (Shift+Enter)',()=>move(-1),'prev');
  const next=button('next',tr('Следующее совпадение','Next match')+' (Enter)',()=>move(1),'next');
  const one=button('replace',tr('Заменить совпадение','Replace match'),()=>replace(false),'one');
  const all=button('replaceAll',tr('Заменить все','Replace all')+' ('+shortcutLabel('Ctrl+Alt+Enter')+')',()=>replace(true),'all');
  const expand=button('expand',tr('Показать или скрыть замену','Toggle replace'),()=>{
    showReplace(replaceRow.hidden);
    (replaceRow.hidden?search:replacement).focus();
  },'expand');
  const closeButton=button('close',tr('Закрыть поиск','Close find')+' (Esc)',()=>close(),'close');
  const row=el('div','nf-row'), replaceRow=el('div','nf-row nf-replace-row');
  const findBox=el('div','nf-field'), replaceBox=el('div','nf-field');
  findBox.append(search,cases,words,regex);replaceBox.append(replacement,preserve);
  row.append(findBox,count,prev,next,scope,closeButton);replaceRow.append(replaceBox,one,all);
  panel.append(expand,row,replaceRow);root.append(panel);showReplace(false);
  const events=new AbortController();
  const toolbar=root.querySelector(':scope > .ve-under-head');
  if (toolbar) {
    const position=()=>{panel.style.insetBlockStart=toolbar.offsetTop+toolbar.offsetHeight+6+'px'};
    const resize=new ResizeObserver(position);
    resize.observe(toolbar);position();
    events.signal.addEventListener('abort',()=>resize.disconnect(),{once:true});
  }
  root.addEventListener('keydown',keydown,{capture:true,signal:events.signal});
  root.addEventListener('beforeinput',e=>{
    inputLocation=null;
    if (!selectionRanges?.length || panel.contains(e.target) || e.target.closest('.ve-credentials,input[type=password]')) return;
    const mark=adapter.selection?.();
    if (mark?.id!=null) inputLocation={id:mark.id,from:mark.from,to:mark.to,type:e.inputType};
  },{capture:true,signal:events.signal});
  root.addEventListener('input',e=>{if (!panel.contains(e.target)) refresh()},{signal:events.signal});
  // Keep native input undo and typing out of the editor's formatting shortcuts.
  panel.addEventListener('keydown',e=>{if (e.key!=='Tab') e.stopPropagation()});
  // WebKit otherwise blurs the query to the document body when clicking a button.
  panel.addEventListener('mousedown',e=>{
    const control=e.target.closest('button');
    if (!control || control.disabled || e.button!==0) return;
    e.preventDefault();
    if (!panel.contains(document.activeElement))
      (replaceRow.contains(control)?replacement:search).focus({preventScroll:true});
  });
  search.addEventListener('input',()=>{historyState.delete(search);scan(true)});
  replacement.addEventListener('input',()=>historyState.delete(replacement));

  function showReplace(visible) {
    replaceRow.hidden=!visible;
    expand.setAttribute('aria-expanded',String(visible));
  }
  function remember(field) {
    if (!field.value) return;
    const list=history.get(field);
    const i=list.indexOf(field.value);
    if (i>=0) list.splice(i,1);
    list.unshift(field.value);
    if (list.length>20) list.pop();
    historyState.delete(field);
  }
  function recall(field,direction) {
    const list=history.get(field);
    if (!list.length) return;
    const state=historyState.get(field) ?? {index:-1,draft:field.value};
    state.index=Math.max(-1,Math.min(list.length-1,state.index+direction));
    historyState.set(field,state);
    field.value=state.index===-1?state.draft:list[state.index];
    field.select();
    if (field===search) scan(true);
  }
  function open(withReplace=false) {
    if (destroyed) return;
    const focused=document.activeElement;
    if (panel.hidden || !panel.contains(focused)) {
      returnFocus=focused;
      const sel=focused?.closest('.ve-credentials,input[type=password]')?null:adapter.selection?.();
      anchor=sel?.id!=null?{id:sel.id,from:sel.from}:null;
      selectionRanges=sel?.ranges?.length?sel.ranges.map(r=>({...r})):sel?.to>sel?.from?[{id:sel.id,from:sel.from,to:sel.to}]:null;
      selectionRecords=null;inputLocation=null;
      if (sel?.text && !/[\r\n]/.test(sel.text)) search.value=sel.text;
      scoped=false;scope.disabled=!selectionRanges;scope.setAttribute('aria-pressed','false');
    }
    if (withReplace) showReplace(true);
    panel.hidden=false;
    const field=withReplace && search.value?replacement:search;
    field.focus();field.select();scan(true,anchor);
  }
  function paint(reveal) {
    const field=document.activeElement;
    scanning=true;
    try {
      adapter.paint(matches,current,{reveal});
      if (panel.contains(field) && document.activeElement!==field) field.focus({preventScroll:true});
    } finally { scanning=false; }
  }
  function cancel() {
    clearTimeout(timer);cancelWorker?.();cancelWorker=null;pending=false;
  }
  function close(restore=true) {
    if (panel.hidden) return;
    remember(search);remember(replacement);
    const active=matches[current];
    cancel();panel.hidden=true;matches=[];current=-1;records=[];selectionRanges=null;anchor=null;
    selectionRecords=null;inputLocation=null;
    paint(false);
    if (restore) {
      if (active && adapter.focus) adapter.focus(active);
      else if (returnFocus?.isConnected && returnFocus!==document.body) returnFocus.focus({preventScroll:true});
      else adapter.focus?.();
    }
    returnFocus=null;
  }
  function update(error) {
    const before=document.activeElement;
    const value=error==='syntax'?tr('Ошибка выражения','Invalid regex'):
      error==='timeout'?tr('Поиск занял слишком долго','Search timed out'):
      error==='worker'?tr('Обработчик поиска недоступен','Search worker unavailable'):
      scoped && !selectionRanges?.length?tr('Выделите заново','Reselect text'):
      pending?'…':!search.value?'':matches.length?(current+1)+' / '+matches.length:tr('Совпадений нет','No matches');
    if (count.textContent!==value) count.textContent=value;
    count.title=scoped && !selectionRanges?.length
      ? shortcutLabel(tr('Выделите текст в заметке и нажмите Ctrl+F','Select text in the note and press Ctrl+F')) : value;
    if (error) search.setAttribute('aria-invalid','true'); else search.removeAttribute('aria-invalid');
    prev.disabled=next.disabled=pending || !matches.length;
    one.disabled=pending || !matches[current] || !!matches[current].readOnly;
    all.disabled=pending || !matches.some(match=>!match.readOnly);
    if (panel.contains(before) && before.disabled) {
      (before===one || before===all?replacement:search).focus({preventScroll:true});
    }
  }
  function choose(at) {
    if (!matches.length || !at) return matches.length?0:-1;
    const recordIndex=records.findIndex(record=>record.id===at.id);
    let later=false;
    for (let i=0;i<matches.length;i++) {
      const match=matches[i];
      if (match.id===at.id) {
        later=true;
        if (match.from>=at.from) return i;
      } else if (later) return i;
    }
    // The replacement can eliminate every match in the current block.
    const nextIds=new Set(records.slice(recordIndex+1).map(record=>record.id));
    const index=matches.findIndex(match=>nextIds.has(match.id));
    return Math.max(0,index);
  }
  function scan(reveal,at=matches[current] ?? anchor) {
    if (panel.hidden || destroyed) return;
    cancel();
    matches=[];current=-1;
    records=search.value || selectionRanges?.length?adapter.records().map(({id,text,readOnly})=>({id,text,readOnly:!!readOnly})):[];
    if (selectionRanges?.length) {
      selectionRanges=trackFindSelection(selectionRanges,selectionRecords,records,inputLocation);
      selectionRecords=selectionRanges.length?records:null;
    }
    inputLocation=null;
    scope.disabled=!scoped && !selectionRanges?.length;
    const data={records,options:{...options,query:search.value},ranges:scoped?selectionRanges:null};
    function done(result) {
      if (panel.hidden || destroyed) return;
      pending=false;matches=result.matches;current=choose(at);update(result.error);paint(reveal);
    }
    if (scoped && !selectionRanges?.length) done({matches:[]});
    else if (search.value && (options.regex || records.reduce((n,r)=>n+r.text.length,0)>250000)) {
      pending=true;update();paint(false);
      timer=setTimeout(()=>{cancelWorker=runWorker(data,done)},45);
    } else done(findNoteMatches(records,data.options,data.ranges));
  }
  function refresh() {
    if (panel.hidden || scanning || refreshQueued) return;
    refreshQueued=true;
    queueMicrotask(()=>{refreshQueued=false;if (!panel.hidden && !destroyed) scan(false)});
  }
  function move(direction) {
    if (pending || !matches.length) return;
    remember(search);current=(current+direction+matches.length)%matches.length;
    update();paint(true);
  }
  function replace(every) {
    if (pending || (every?all:one).disabled) return;
    // A remote edit, a freshly committed canvas field or undo can invalidate offsets.
    const live=adapter.records();
    if (live.length!==records.length || live.some((r,i)=>r.id!==records[i].id || r.text!==records[i].text || !!r.readOnly!==records[i].readOnly)) {
      scan(true);return;
    }
    remember(search);remember(replacement);
    const edits=[];
    for (const hit of every?matches:[matches[current]]) {
      if (hit.readOnly) continue;
      const text=replacementText(hit,replacement.value,options);
      if (text!==hit.value) edits.push({id:hit.id,from:hit.from,to:hit.to,text});
    }
    if (!edits.length) { if (!every) move(1); return; }
    const first=edits[0], at={id:first.id,from:first.from+first.text.length+(first.from===first.to?1:0)};
    const focused=document.activeElement;
    scanning=true;
    try { adapter.replace(edits); } finally { scanning=false; }
    if (scoped) {
      const deltas=new Map();
      for (const edit of edits) deltas.set(edit.id,(deltas.get(edit.id)??0)+edit.text.length-(edit.to-edit.from));
      for (const range of selectionRanges) range.to+=deltas.get(range.id)??0;
      selectionRecords=null;
    }
    if (panel.contains(focused) && focused!==document.activeElement) focused.focus({preventScroll:true});
    scan(true,at);
  }
  function keydown(e) {
    if (e.defaultPrevented || e.isComposing || e.keyCode===229 || root.inert || root.closest('[inert]')) return;
    const dialog=e.target.closest?.('dialog,[aria-modal=true]');
    if (dialog && dialog!==root && root.contains(dialog)) return;
    const command=primaryCommand(e), macReplace=isMacPlatform() && e.metaKey && e.altKey && !e.ctrlKey && e.code==='KeyF';
    let action;
    if (!e.shiftKey && ((command && (e.code==='KeyF' || e.code==='KeyH')) || macReplace))
      action=()=>open(e.code==='KeyH' || macReplace);
    else if (!panel.hidden) {
      if (e.key==='Escape') action=()=>close();
      else if (e.key==='F3' && !e.altKey && !e.ctrlKey && !e.metaKey) action=()=>move(e.shiftKey?-1:1);
      else if (panel.contains(e.target)) {
        const field=e.target===search || e.target===replacement;
        if (field && e.key==='Enter' && !e.isComposing) {
          if ((e.ctrlKey || e.metaKey) && e.altKey) action=()=>replace(true);
          else if (!e.ctrlKey && !e.metaKey && !e.altKey) action=e.target===replacement?()=>replace(false):()=>move(e.shiftKey?-1:1);
        } else if (field && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key==='ArrowUp' || e.key==='ArrowDown'))
          action=()=>recall(e.target,e.key==='ArrowUp'?1:-1);
        else if (e.altKey && !e.ctrlKey && !e.metaKey) {
          const toggle={KeyC:cases,KeyW:words,KeyR:regex}[e.code];
          if (toggle) action=()=>toggle.click();
        }
      }
    }
    if (action) { e.preventDefault();e.stopPropagation();action(); }
  }
  return {open,close,refresh,destroy(){
    close(false);destroyed=true;events.abort();history.clear();historyState.clear();
    search.value=replacement.value='';panel.remove();
  }};
}
