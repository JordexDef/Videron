import { getLanguage, tr } from './i18n.js';
import { readExtensionManifests, supportsNoteCommand, tagSpectrumId } from './extension-manifest.js';
import { setupExtensionAPI } from './extension-sdk.js';
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
    const { notes, areas, language, labels } = event.data;
    document.documentElement.lang = language;
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
      const more = element('button', 'more', labels.more);
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
      count.textContent = labels.notes + items.length;
      const back = element('button', 'back', labels.allTags);
      back.onclick = () => {
        showAll();
        tagButton.focus({preventScroll:true});
        scrollTo(0, listScrollY);
      };
      const notesList = list(items, note => {
        const row = element('button', 'row');
        row.append(element('span', 'title', note.title));
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
      row.setAttribute('aria-label', '#' + tag + labels.noteCount + items.length);
      track.setAttribute('aria-hidden', 'true');
      bar.style.width = items.length / sorted[0][1].length * 100 + '%';
      track.append(bar);
      row.append(element('span', '', '#' + tag), track, element('b', '', String(items.length)));
      row.onclick = () => showTag(tag, items, row);
      return row;
    });
    function showAll() {
      heading.textContent = labels.frequency;
      count.textContent = labels.tags + tags.size;
      show(tagList);
      if (!sorted.length) {
        content.append(element('p', 'empty', labels.empty));
      }
    }
    showAll();
  });
  parent.postMessage({ type: 'videron:ready' }, '*');
}
const builtIn = {
  apiVersion: 1,
  id: tagSpectrumId,
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
function setupPluginHost(ticket) {
  let requestPort;
  if (ticket) {
    // This endpoint belongs to the original document, even if the iframe later navigates.
    const channel = new MessageChannel();
    const port = channel.port1;
    requestPort = port;
    port.onmessage = ({data}) => {
      if (data.kind === 'verify') port.postMessage({kind:'request', message:data.message});
      if (data.kind === 'event') dispatchEvent(new MessageEvent('message', {
        data:data.message, origin:data.origin, source:parent
      }));
    };
    parent.postMessage({type:'videron:session', ticket}, '*', [channel.port2]);
    addEventListener('pagehide', () => { port.postMessage({kind:'leave'}); port.close(); }, {once:true});
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'videron:theme') return;
    const {theme} = event.data;
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  });
  addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    parent.postMessage({type:'videron:back'}, '*');
  }, true);
  addEventListener('error', event => parent.postMessage({type:'videron:error', message:String(event.message || '')}, '*'));
  return message => {
    if (requestPort && message.type === 'videron:request') requestPort.postMessage({kind:'request', message});
    else parent.postMessage(message, '*');
  };
}
const pluginHead = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${pluginPolicy}"><meta name="referrer" content="no-referrer"><style>:where(html[data-theme=light]){color-scheme:light}:where(html[data-theme=dark]){color-scheme:dark}</style>`;

let activeManager = null;

export function dismissExtensions() {
  activeManager?.();
}

export function openExtensions({ workspace, getWorkspace = () => workspace, hasWorkspace = true, plugins = [], command, onRequest,
  onSavePlugins, onOpenNote, onSelectLanguage, notify }) {
  activeManager?.();
  let installed = [...plugins], disposeFrame = null, leaveView = null;
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
      (leaveView || close)();
    } else if (event.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), summary, iframe')].filter(el => el.getClientRects().length);
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault(); focusable.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
        event.preventDefault(); focusable[0]?.focus();
      }
    }
  }
  document.addEventListener('keydown', handleKey, true);
  shade.addEventListener('click', e => { if (e.target === shade) close(); });

  function showPlugin(plugin, action = null, noteId = null, direct = false) {
    disposeFrame?.();
    leaveView = direct ? close : renderList;
    if (plugin.unavailableReason) {
      notify?.(plugin.unavailableReason);
      leaveView();
      return;
    }
    const target = () => {
      const note = noteId ? getWorkspace()?.notes.find(item => item.id === noteId) : null;
      return supportsNoteCommand(action, note) && !isProtectedNote(note) ? note : null;
    };
    const targetNote = noteId ? target() : null;
    if (action?.scope === 'note' && !targetNote) {
      notify?.(tr('Заметка недоступна.', 'The note is unavailable.'));
      leaveView();
      return;
    }
    const grants = new Set(hasWorkspace ? (plugin.permissions || []).filter(permission =>
      permission === 'notes.create' || (targetNote && (permission === 'notes.read' ||
        (permission === 'notes.append' && (targetNote.type ?? 'text') === 'text')))) : []);
    if (!grants.size) return startFrame(plugin, action, noteId, grants, target);

    heading.textContent = action?.title || plugin.name;
    dialog.className = 'dialog wide';
    const intro = node('p', '', tr('Разрешить «{name}» на время этого запуска?', 'Allow “{name}” to do the following for this run?', {name:plugin.name}));
    const list = node('ul', 'extension-permissions');
    const title = targetNote?.title || tr('Без названия', 'Untitled');
    if (grants.has('notes.read')) list.append(node('li', '', tr('Прочитать текст заметки «{title}»', 'Read the text of “{title}”', {title})));
    if (grants.has('notes.append')) list.append(node('li', '', tr('Дописывать текст в «{title}»', 'Append text to “{title}”', {title})));
    if (grants.has('notes.create')) list.append(node('li', '', tr('Создавать заметки в этом пространстве', 'Create notes in this workspace')));
    const actions = node('div', 'dialog-actions');
    const cancel = button(tr('Отмена', 'Cancel'), leaveView);
    const allow = button(tr('Разрешить на этот раз', 'Allow for this run'), () => {
      if (allow.isConnected && activeManager === close) startFrame(plugin, action, noteId, grants, target);
    }, 'button primary');
    actions.append(cancel, allow);
    content.replaceChildren(intro, list, actions);
    cancel.focus();
  }

  function startFrame(plugin, action, noteId, grants, target) {
    disposeFrame?.();
    heading.textContent = action?.title || plugin.name;
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
    let sent = false, loaded = false, port = null;
    const ticket = grants.size ? Array.from(crypto.getRandomValues(new Uint8Array(20))).join('.') : '';
    const active = () => activeManager === close && frame.isConnected;
    const deliver = message => {
      if (ticket) port?.postMessage({kind:'event', message, origin:location.origin});
      else frame.contentWindow?.postMessage(message, '*');
    };
    function handleRequest(msg) {
      if (!sent || !active() || typeof msg.requestId !== 'string' || !msg.requestId || msg.requestId.length > 128) return;
      const response = {type:'videron:response', requestId:msg.requestId};
      try {
        if (!getWorkspace() || !grants.has(msg.method) || typeof onRequest !== 'function') {
          throw Error(tr('У расширения нет разрешения на это действие.', 'The extension does not have permission for this action.'));
        }
        const params = msg.params === undefined ? {} : msg.params;
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error(tr('Некорректные параметры запроса.', 'Invalid request parameters.'));
        const note = noteId ? target() : null;
        if (msg.method !== 'notes.create' && (!note || (params.id !== undefined && params.id !== noteId) ||
            (msg.method === 'notes.append' && (note.type ?? 'text') !== 'text'))) {
          throw Error(tr('Эта заметка недоступна расширению.', 'This note is unavailable to the extension.'));
        }
        response.result = onRequest(msg.method, params, {noteId});
      } catch (error) {
        response.error = String(error.message || tr('Не удалось выполнить запрос.', 'The request failed.')).slice(0, 300);
      }
      if (active()) deliver(response);
    }
    function receive(event) {
      if (!active() || event.source !== frame.contentWindow || event.origin !== 'null' || !event.data) return;
      const msg = event.data;
      if (ticket && msg.type === 'videron:session' && msg.ticket === ticket && !port && event.ports[0]) {
        port = event.ports[0];
        port.onmessage = ({data}) => {
          if (!active()) return;
          if (data?.kind === 'request') handleRequest(data.message);
          if (data?.kind === 'leave') leaveView();
        };
        syncTheme();
        return;
      }
      if (ticket && !port) return;
      if (msg.type === 'videron:ready' && !sent) {
        const current = getWorkspace();
        if (!current || (noteId && !target())) { leaveView(); return; }
        sent = true; clearTimeout(hintTimer); status.hidden = true;
        const data = projectWorkspace(current);
        if (plugin === builtIn) data.labels = {
          more:tr('Показать ещё', 'Show more'), allTags:tr('← Все теги', '← All tags'),
          notes:tr('Заметок · ', 'Notes · '), noteCount:tr(', заметок: ', ', notes: '),
          frequency:tr('Частота тегов', 'Tag frequency'), tags:tr('Тегов · ', 'Tags · '),
          empty:tr('Добавьте в текст заметки #тег. Здесь появятся теги и число заметок, в которых они встречаются.', 'Add a #tag to a note to see how many notes share it.')
        };
        deliver(data);
        if (action) deliver({type:'videron:command', id:action.id, noteId});
      } else if (msg.type === 'videron:request' && sent) {
        // Low-level postMessage clients use the same document-bound channel as the SDK.
        if (port) port.postMessage({kind:'verify', message:msg});
        else handleRequest(msg);
      } else if (msg.type === 'videron:open-note' && sent && getWorkspace()?.notes.some(n => n.id === msg.id && !isProtectedNote(n))) {
        close();
        onOpenNote(msg.id);
      } else if (msg.type === 'videron:back') {
        leaveView();
      } else if (msg.type === 'videron:error') {
        clearTimeout(hintTimer); status.hidden = false;
        status.textContent = tr('Ошибка расширения · ', 'Extension error · ') + String(msg.message || tr('Сбой выполнения', 'Script error')).slice(0, 200);
      }
    }
    window.addEventListener('message', receive);
    const syncTheme = () => deliver({type:'videron:theme', theme:isLightTheme() ? 'light' : 'dark'});
    frame.addEventListener('load', () => {
      if (!active()) return;
      if (loaded && ticket) { leaveView(); return; }
      loaded = true; syncTheme();
    });
    window.addEventListener('videron:themechange', syncTheme);
    disposeFrame = () => {
      clearTimeout(hintTimer);
      port?.close();
      window.removeEventListener('message', receive);
      window.removeEventListener('videron:themechange', syncTheme);
      frame.remove();
      disposeFrame = null;
    };
    const theme = isLightTheme() ? 'light' : 'dark';
    frame.srcdoc = `<!doctype html><html data-theme="${theme}">${pluginHead}<script>(${setupExtensionAPI.toString()})((${setupPluginHost.toString()})(${JSON.stringify(ticket)}))<\/script>` + plugin.html;
    content.replaceChildren(...(leaveView === close ? [] : [back]), status, frame);
    (leaveView === close ? closeButton : back).focus();
  }

  function renderList() {
    disposeFrame?.();
    leaveView = null;
    dialog.className = 'dialog wide';
    heading.textContent = tr('Расширения', 'Extensions');
    closeButton.textContent = tr('Закрыть', 'Close');
    content.replaceChildren();
    const error = node('p', 'hint');
    error.setAttribute('role', 'alert');
    const input = node('input');
    input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
    let updateTarget = null;
    function chooseManifest(target = null) {
      updateTarget = target;
      input.click();
    }
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
        const [imported] = readExtensionManifests([manifest], installed.filter(plugin => plugin !== updateTarget));
        if (updateTarget && (imported.type !== 'language' || imported.id !== updateTarget.id || imported.locale !== updateTarget.locale)) {
          throw Error(tr('Выберите пакет с тем же идентификатором и кодом языка.', 'Choose a pack with the same ID and language code.'));
        }
        const next = updateTarget ? installed.map(plugin => plugin === updateTarget ? imported : plugin) : [...installed, imported];
        onSavePlugins(next, imported);
        installed = next;
        renderList();
        notify?.(updateTarget ? tr('Языковой пакет обновлён', 'Language pack updated') : tr('Расширение установлено', 'Extension installed'));
      } catch (e) {
        error.textContent = tr('Ошибка импорта · ', 'Import failed · ') + e.message;
      } finally { input.value = ''; }
    };
    for (const plugin of [builtIn, ...installed]) {
      const row = node('article', 'extension');
      const info = node('div');
      const languagePack = plugin.type === 'language';
      const title = node('h3', '', plugin.name);
      if (languagePack) title.lang = plugin.locale;
      info.append(title);
      if (languagePack) info.append(node('p', '', tr('Языковой пакет', 'Language pack') + ' · ' + plugin.locale));
      if (plugin.description) info.append(node('p', '', plugin.description));
      const actions = node('span', 'extension-actions');
      if (plugin.unavailableReason) {
        info.append(node('p', '', plugin.unavailableReason));
      } else if (languagePack) {
        const active = getLanguage() === plugin.locale;
        const apply = button(active ? tr('Текущий язык', 'Current language') : tr('Включить язык', 'Use language'), () => {
          onSelectLanguage(plugin.locale);
          renderList();
        });
        apply.disabled = active;
        actions.append(apply, button(tr('Обновить…', 'Update…'), () => chooseManifest(plugin)));
      } else {
        actions.append(button(tr('Открыть', 'Open'), () => showPlugin(plugin)));
        const commands = plugin.commands || [];
        const noteCommands = commands.filter(action => action.scope === 'note').map(action => action.title);
        if (noteCommands.length) info.append(node('p', '', tr('Щёлкните заметку правой кнопкой, чтобы вызвать {commands}.',
          'Right-click a note to run {commands}.', {commands:noteCommands.join(' · ')})));
        if (hasWorkspace) {
          const workspaceCommands = commands.filter(action => action.scope === 'workspace');
          const buttons = workspaceCommands.map(action => button(action.title, () => showPlugin(plugin, action)));
          if (buttons.length === 1) actions.append(...buttons);
          if (buttons.length > 1) {
            const details = node('details');
            const choices = node('span', 'extension-actions');
            choices.append(...buttons);
            details.append(node('summary', '', tr('Команды пространства ({count})', 'Workspace commands ({count})', {count:buttons.length})), choices);
            info.append(details);
          }
        }
      }
      if (plugin !== builtIn) {
        const remove = button(tr('Удалить', 'Remove'), () => {
          const next = installed.filter(p => p.id !== plugin.id);
          try {
            onSavePlugins(next, plugin); installed = next; renderList();
            notify?.(tr('Расширение удалено', 'Extension removed'));
          } catch (e) { error.textContent = tr('Ошибка удаления · ', 'Removal failed · ') + e.message; }
        });
        remove.setAttribute('aria-label',tr('Удалить «{name}»', 'Remove “{name}”', {name:plugin.name}));
        actions.append(remove);
      }
      row.append(info, actions); content.append(row);
    }
    const footer = node('div', 'dialog-actions');
    const saveTemplate = button(tr('Сохранить шаблон языка…', 'Save language template…'), async () => {
      saveTemplate.disabled = true;
      error.textContent = '';
      try {
        if (window.go?.main?.App) {
          const saved = await window.go.main.App.SaveLanguageTemplate(saveTemplate.textContent);
          if (saved) notify?.(tr('Шаблон сохранён', 'Template saved'));
        } else {
          const response = await fetch(new URL('./languages/template.json', import.meta.url));
          if (!response.ok) throw Error(response.statusText);
          const download = document.createElement('a');
          const url = URL.createObjectURL(await response.blob());
          download.href = url;
          download.download = 'Videron.language.json';
          document.body.append(download);
          download.click();
          download.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      } catch {
        error.textContent = tr('Не удалось сохранить шаблон языка.', 'Could not save the language template.');
      } finally { saveTemplate.disabled = false; }
    });
    footer.append(saveTemplate, button(tr('Установить из JSON', 'Install from JSON'), () => chooseManifest()));
    content.append(input, error, footer);
    closeButton.focus();
  }
  activeManager = close;
  if (command) {
    const plugin = installed.find(entry => entry.type !== 'language' && !entry.unavailableReason && entry.id === command.pluginId);
    const action = plugin?.commands?.find(entry => entry.id === command.id);
    if (hasWorkspace && action) showPlugin(plugin, action, action.scope === 'note' ? command.noteId : null, true);
    else { close(); notify?.(tr('Команда расширения недоступна.', 'The extension command is unavailable.')); }
  } else renderList();
  return { close };
}

