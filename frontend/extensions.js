import { getLanguage, tr } from './i18n.js';
import { appearanceOf } from './icons/node-art.js';
import { isProtectedNote } from './note-vault.js';
import { isLightTheme } from './theme.js';

function renderTagSpectrum() {
  const content = document.querySelector('#content');
  const heading = document.querySelector('h2');
  const count = document.querySelector('#count');

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'videron:data') return;
    const { notes, areas, language } = event.data;
    document.documentElement.lang = language;
    const local = (ru, en) => language === 'en' ? en : ru;
    const tags = new Map();
    const areaNames = new Map(areas.map(area => [area.id, area.name]));
    for (const note of notes) {
      for (const tag of note.tags) {
        if (!tags.has(tag)) tags.set(tag, []);
        tags.get(tag).push(note);
      }
    }
    const compareTags = new Intl.Collator(language).compare;
    const sorted = [...tags.entries()].sort((a, b) =>
      b[1].length - a[1].length || compareTags(a[0], b[0]));

    let observer;
    function list(items, makeRow) {
      const rows = element('div');
      const more = element('button', 'more', local('Показать ещё', 'Show more'));
      let next = 0;
      function appendPage() {
        const page = document.createDocumentFragment();
        const end = Math.min(next + 80, items.length);
        for (; next < end; next++) page.append(makeRow(items[next]));
        const first = page.firstElementChild;
        const moveFocus = document.activeElement === more;
        rows.append(page);
        more.hidden = next >= items.length;
        if (moveFocus) first?.focus();
        if (more.hidden) observer?.disconnect();
      }
      more.onclick = appendPage;
      appendPage();
      return {rows, more, appendPage};
    }

    function show(listing, back) {
      observer?.disconnect();
      content.replaceChildren(...(back ? [back] : []), listing.rows, listing.more);
      if (!listing.more.hidden && typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver(entries => {
          if (entries.some(e => e.isIntersecting) && listing.more.isConnected && !listing.more.hidden) listing.appendPage();
        }, {rootMargin:'200px'});
        observer.observe(listing.more);
      }
    }

    function showTag(tag, items, tagButton) {
      const listScrollY = scrollY;
      heading.textContent = '#' + tag;
      count.textContent = local('Заметок · ', 'Notes · ') + items.length;
      const back = element('button', 'back', local('← Все теги', '← All tags'));
      back.onclick = () => {
        showAll();
        tagButton.focus({preventScroll:true});
        scrollTo(0, listScrollY);
      };
      const notesList = list(items, note => {
        const row = element('button', 'row');
        row.append(element('span', 'title', note.title || local('Без названия', 'Untitled')));
        const area = areaNames.get(note.areaId);
        if (area) row.append(element('span', 'subtitle', area));
        row.onclick = () => parent.postMessage({ type: 'videron:open-note', id: note.id }, '*');
        return row;
      });
      show(notesList, back);
      back.focus({preventScroll:true});
      scrollTo(0, 0);
    }

    const tagList = list(sorted, ([tag, items]) => {
      const row = element('button', 'row tag');
      const track = element('span', 'track');
      const bar = element('i');
      row.setAttribute('aria-label', '#' + tag + local(', заметок: ', ', notes: ') + items.length);
      track.setAttribute('aria-hidden', 'true');
      bar.style.width = items.length / sorted[0][1].length * 100 + '%';
      track.append(bar);
      row.append(element('span', '', '#' + tag), track, element('b', '', String(items.length)));
      row.onclick = () => showTag(tag, items, row);
      return row;
    });
    function showAll() {
      heading.textContent = local('Частота тегов', 'Tag frequency');
      count.textContent = local('Тегов · ', 'Tags · ') + tags.size;
      show(tagList);
      if (!sorted.length) {
        content.append(element('p', 'empty', local('Добавьте в текст заметки #тег. Здесь появятся теги и число заметок, в которых они встречаются.', 'Add a #tag to a note to see how many notes share it.')));
      }
    }
    showAll();
  });
  parent.postMessage({ type: 'videron:ready' }, '*');
}
const builtIn = {
  apiVersion: 1,
  id: 'videron.tag-spectrum',
  get name() { return tr('Спектр тегов', 'Tag spectrum'); },
  get description() { return tr('Частота тегов и заметки, которые их связывают.', 'Explore tags by frequency and open the notes that share them.'); },
  html: `<style>
    *{box-sizing:border-box}
    :root{color-scheme:dark;font-family:"Segoe UI",system-ui,sans-serif;color:#e3e4e6;background:#191a1b}
    body{margin:0;padding:22px}header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}
    h2{min-width:0;margin:0;font-size:17px;letter-spacing:-.4px;font-weight:550;overflow-wrap:anywhere}
    #count{flex:none;color:#a7a9ad;font:11px ui-monospace,monospace}
    button{font:inherit;color:inherit;cursor:pointer}
    .row{border:0;background:transparent;padding:11px 3px;width:100%;text-align:left;display:grid;grid-template-columns:minmax(0,1fr);border-bottom:1px solid #323438}
    button:focus-visible{outline:1px solid #d9dade;outline-offset:-1px}.row:hover{background:#26272a}
    .tag{grid-template-columns:minmax(75px,1.1fr) minmax(60px,1.8fr) 34px;gap:13px;align-items:center}
    .tag span:first-child,.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tag span:first-child{color:#dddfe3;font-size:13px}.tag b{color:#c2c4ca;font:12px ui-monospace,monospace;text-align:right}
    .track{height:7px;border-radius:3px;background:#303236;overflow:hidden}.track i{display:block;height:100%;background:#bfc2c7;border-radius:3px}
    .title{font-size:14px}.subtitle{color:#9da0a5;font-size:11px;margin-top:3px;overflow-wrap:anywhere}
    .back{display:block;color:#d9dade;background:transparent;border:0;padding:2px 0 12px;font-size:12px}
    .more{border:1px solid #323438;border-radius:5px;background:transparent;padding:5px 12px;margin-top:12px;font-size:12px}
    .empty{margin:26px 0;color:#a8aaaf;font-size:13px;line-height:1.7}
    :root[data-theme=light]{color-scheme:light;color:#252629;background:#fafafa}
    [data-theme=light] :is(#count,.subtitle,.empty){color:#60636b}
    [data-theme=light] :is(.row,.more){border-color:#d6d7db}
    [data-theme=light] .row:hover{background:#ebebee}
    [data-theme=light] button:focus-visible{outline-color:#50535c}
    [data-theme=light] :is(.tag span:first-child,.back){color:#252629}
    [data-theme=light] .tag b{color:#42454c}
    [data-theme=light] .track{background:#e4e5e9}
    [data-theme=light] .track i{background:#747882}
  </style>
  <header><h2></h2><span id="count"></span></header><section id="content"></section>
  <script>(${renderTagSpectrum.toString()})()</script>`
};

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(text, action, className = 'button secondary') {
  const el = node('button', className, text);
  el.type = 'button';
  el.onclick = action;
  return el;
}

function parseManifest(value) {
  if (!value || value.apiVersion !== 1) throw Error(tr('Укажите apiVersion со значением 1.', 'Set apiVersion to 1.'));
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(value.id)) {
    throw Error(tr('Идентификатор может содержать латинские буквы, цифры, точку, дефис и подчёркивание.', 'Use letters A–Z, digits, periods, hyphens or underscores in the extension ID.'));
  }
  if (typeof value.name !== 'string' || !value.name.trim() || typeof value.html !== 'string' || !value.html.trim()) {
    throw Error(tr('В манифесте нужны название name и содержимое html.', 'The manifest needs a name and HTML content in the html field.'));
  }
  if (value.description !== undefined && typeof value.description !== 'string') throw Error(tr('Поле description должно быть строкой.', 'The description field must be a string.'));
  return { apiVersion: 1, id: value.id, name: value.name, description: value.description || '', html: value.html };
}

export function projectWorkspace(workspace) {
  const hiddenIds = new Set();
  const visible = workspace.notes.filter(note => {
    if (!isProtectedNote(note)) return true;
    hiddenIds.add(note.id);
    return false;
  });
  return {
    type: 'videron:data',
    apiVersion: 1,
    language: getLanguage(),
    notes: visible.map(n => ({
      id: n.id, title: n.title || tr('Без названия', 'Untitled'),
      type: n.type==='canvas'||n.type==='data'?n.type:'text', appearance: appearanceOf(n),
      tags: Array.isArray(n.tags) ? [...new Set(n.tags.map(t => String(t).replace(/^#/, '').toLowerCase()).filter(Boolean))] : [],
      areaId: typeof n.areaId === 'string' ? n.areaId : null,
      pinned: !!n.pinned,
      opens: Number.isFinite(n.opens) ? Math.max(0, n.opens) : 0,
      x: Number.isFinite(n.x) ? n.x : 0,
      y: Number.isFinite(n.y) ? n.y : 0,
      weight: Number.isFinite(n.weight) ? Math.max(0, n.weight) : 0,
      links: Array.isArray(n.links) ? [...new Set(n.links.filter(id => typeof id === 'string' && !hiddenIds.has(id)))] : [],
    })),
    areas: workspace.areas.map(a => ({ id: a.id, name: a.name, color: a.color, parentId: a.parentId ?? null })),
  };
}

const pluginPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'";
const pluginHead = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${pluginPolicy}"><meta name="referrer" content="no-referrer"><script>addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();parent.postMessage({type:'videron:back'},'*')}},true);addEventListener('error',event=>{parent.postMessage({type:'videron:error',message:String(event.message || '')},'*')});<\/script>`;

let activeManager = null;

export function dismissExtensions() {
  activeManager?.();
}

export function openExtensions({ workspace, plugins = [], onSavePlugins, onOpenNote, notify }) {
  activeManager?.();
  let installed = [...plugins], disposeFrame = null;
  const previousFocus = document.activeElement;
  const shade = node('div', 'shade');
  const dialog = node('div', 'dialog wide');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const heading = node('h2', '', tr('Расширения', 'Extensions'));
  heading.id = 'extensions-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  const header = node('div', 'dialog-title');
  const closeButton = button(tr('Закрыть', 'Close'), close);
  header.append(heading, closeButton);
  const content = node('div');
  dialog.append(header, content);
  shade.append(dialog);
  document.body.append(shade);

  function close() {
    if (activeManager !== close) return;
    disposeFrame?.();
    document.removeEventListener('keydown', handleKey, true);
    shade.remove();
    activeManager = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  }

  function handleKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (disposeFrame) renderList(); else close();
    } else if (event.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), iframe')];
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault(); focusable.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
        event.preventDefault(); focusable[0]?.focus();
      }
    }
  }
  document.addEventListener('keydown', handleKey, true);
  shade.addEventListener('click', e => { if (e.target === shade) close(); });

  function showPlugin(plugin) {
    disposeFrame?.();
    heading.textContent = plugin.name;
    dialog.className = 'dialog full';
    const frame = node('iframe', 'extension-view');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = plugin.name;
    const status = node('p', 'hint', tr('Подключение расширения…', 'Connecting to the extension…'));
    status.setAttribute('role','status');
    const back = button(tr('← Все расширения', '← All extensions'), renderList, 'text-button');
    back.style.marginBottom = '10px';
    const hintTimer = setTimeout(() => {
      status.hidden = false;
      status.textContent = tr('Расширение не сообщило о готовности. Проверьте обработчик videron:ready.', 'The extension did not signal readiness. Check its videron:ready message.');
    }, 3500);
    let sent = false;
    function receive(event) {
      if (event.source !== frame.contentWindow || event.origin !== 'null' || !event.data) return;
      const msg = event.data;
      if (msg.type === 'videron:ready' && !sent) {
        sent = true; clearTimeout(hintTimer); status.hidden = true;
        frame.contentWindow.postMessage(projectWorkspace(workspace), '*');
      } else if (msg.type === 'videron:open-note' && sent && workspace.notes.some(n => n.id === msg.id && !isProtectedNote(n))) {
        close();
        onOpenNote(msg.id);
      } else if (msg.type === 'videron:back') {
        renderList();
      } else if (msg.type === 'videron:error') {
        clearTimeout(hintTimer); status.hidden = false;
        status.textContent = tr('Ошибка расширения · ', 'Extension error · ') + String(msg.message || tr('Сбой выполнения', 'Script error')).slice(0, 200);
      }
    }
    window.addEventListener('message', receive);
    disposeFrame = () => {
      clearTimeout(hintTimer);
      window.removeEventListener('message', receive);
      frame.remove();
      disposeFrame = null;
    };
    const theme = isLightTheme() ? 'light' : 'dark';
    frame.srcdoc = `<!doctype html><html data-theme="${theme}">` + pluginHead + plugin.html;
    content.replaceChildren(back, status, frame);
    back.focus();
  }

  function renderList() {
    disposeFrame?.();
    dialog.className = 'dialog wide';
    heading.textContent = tr('Расширения', 'Extensions');
    content.replaceChildren();
    const error = node('p', 'hint');
    error.setAttribute('role', 'alert');
    const input = node('input');
    input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        let manifest;
        let source;
        try { source = await file.text(); }
        catch { throw Error(tr('Не удалось прочитать файл.', 'Could not read the file.')); }
        if (!input.isConnected) return;
        try { manifest = JSON.parse(source.replace(/^\uFEFF/, '')); }
        catch { throw Error(tr('Файл не содержит корректный JSON.', 'The file does not contain valid JSON.')); }
        const imported = parseManifest(manifest);
        if ([builtIn, ...installed].some(p => p.id === imported.id)) throw Error(tr('Расширение с таким идентификатором уже установлено.', 'An extension with this ID is already installed.'));
        const next = [...installed, imported];
        onSavePlugins(next);
        installed = next;
        renderList();
        notify?.(tr('Расширение установлено', 'Extension installed'));
      } catch (e) {
        error.textContent = tr('Ошибка импорта · ', 'Import failed · ') + e.message;
      } finally { input.value = ''; }
    };
    for (const plugin of [builtIn, ...installed]) {
      const row = node('article', 'extension');
      const info = node('div');
      info.append(node('h3', '', plugin.name), node('p', '', plugin.description));
      const actions = node('span', 'extension-actions');
      actions.append(button(tr('Открыть', 'Open'), () => showPlugin(plugin)));
      if (plugin !== builtIn) {
        const remove = button(tr('Удалить', 'Remove'), () => {
          const next = installed.filter(p => p.id !== plugin.id);
          try {
            onSavePlugins(next); installed = next; renderList();
            notify?.(tr('Расширение удалено', 'Extension removed'));
          } catch (e) { error.textContent = tr('Ошибка удаления · ', 'Removal failed · ') + e.message; }
        });
        remove.setAttribute('aria-label',tr('Удалить «' + plugin.name + '»', 'Remove “' + plugin.name + '”'));
        actions.append(remove);
      }
      row.append(info, actions); content.append(row);
    }
    const footer = node('div', 'dialog-actions');
    footer.append(button(tr('Установить из JSON', 'Install from JSON'), () => input.click()));
    content.append(input, error, footer);
    closeButton.focus();
  }
  activeManager = close;
  renderList();
  return { close };
}

