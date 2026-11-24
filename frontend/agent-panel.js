import { tr } from './i18n.js';
import { agentProfiles, finishedRun } from './agent-session.js';

function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}
function action(label, click, primary = false) {
  const b = el('button',label);
  b.type = 'button'; b.className = 'button ' + (primary ? 'primary' : 'secondary'); b.onclick = click;
  return b;
}
function field(label, input) {
  const row = el('label');
  input.setAttribute('aria-label',label); row.append(el('span',label),input); return row;
}
function select(values) {
  const input = el('select');
  for (const [value,name] of values) input.add(new Option(name,value));
  return input;
}
export function agentStatus(status) {
  switch (status) {
    case 'starting':return tr('Запуск агента…','Starting agent…');
    case 'running':return tr('Агент работает','Agent is working');
    case 'permission':return tr('Нужно разрешение','Permission needed');
    case 'listening':return tr('Ожидание агента','Waiting for agent');
    case 'connected':return tr('Агент подключился','Agent connected');
    case 'completed':return tr('Работа завершена','Run finished');
    case 'failed':return tr('Не удалось завершить работу','Run failed');
    case 'cancelled':return tr('Работа остановлена','Run stopped');
    default:return tr('ИИ-агент','AI agent');
  }
}
function message(error) {
  const raw = String(error?.message || error);
  if (raw.includes('VD_AGENT_EXECUTABLE')) return tr('Приложение агента не найдено. Установите выбранный ACP-адаптер или укажите путь к нему.','Agent executable not found. Install the selected ACP adapter or enter its path.');
  if (raw.includes('VD_AGENT_FOLDER')) return tr('Рабочая папка недоступна.','The working folder is unavailable.');
  if (raw.includes('VD_AGENT_BUSY')) return tr('Сначала завершите текущую сессию агента.','End the current agent session first.');
  return raw;
}
const profileKey = 'videron.agent-profile.v1';
export function openAgentPanel({rootId, title, session, native, onClose}) {
  const dialog = el('dialog'); dialog.className = 'ai-agent-panel';
  const heading = el('h2',tr('ИИ-агент','AI agent'));
  const close = action('×',() => dialog.close());
  close.setAttribute('aria-label',tr('Закрыть','Close'));
  const header = el('header'); header.append(heading,close);
  const source = el('strong',title); source.className = 'ai-source';
  const content = el('div'); content.className = 'ai-body';
  dialog.append(header,source,content); dialog.setAttribute('aria-label',heading.textContent);
  document.body.append(dialog);
  dialog.addEventListener('close',() => {dialog.remove(); onClose()},{once:true});
  dialog.addEventListener('click',event => {if (event.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  }});
  let signature, hasActive = false;
  function setup() {
    const profile = select([...Object.entries(agentProfiles).map(([id,p]) => [id,p.name]),
      ['custom',tr('Свой ACP-агент…','Custom ACP agent…')],['external',tr('Подключить открытого агента (MCP)','Connect an existing agent (MCP)')]]);
    try {const saved = localStorage.getItem(profileKey); if (Array.from(profile.options).some(o => o.value === saved)) profile.value = saved} catch {}
    const rights = select([['tasks',tr('Читать и вести задачи','Read and manage tasks')],['read',tr('Только чтение','Read only')]]);
    const customCommand = el('input'), args = el('textarea');
    customCommand.placeholder = 'my-agent'; args.rows = 2; args.placeholder = '--acp';
    const custom = el('div');
    custom.append(field(tr('Путь к программе','Executable path'),customCommand),
      field(tr('Аргументы, каждый с новой строки','Arguments, one per line'),args));
    const request = el('textarea'); request.rows = 3; request.maxLength = 16000;
    request.value = tr('Разбей идею на задачи и приступи к работе.','Break the idea into tasks and start working on them.');
    const launchFields = el('div');
    const resume = el('input'); resume.type = 'checkbox';
    const resumeRow = el('label'); resumeRow.className='ai-resume'; resumeRow.append(resume,el('span',tr('Продолжить предыдущий диалог в той же папке','Continue the previous conversation in its working folder')));
    let cwd = '';
    const folder = action(tr('Выбрать рабочую папку…','Choose working folder…'),async () => {
      try {const picked = await native.PickFolder(tr('Рабочая папка агента','Agent working folder')); if (picked) {cwd = picked; folder.textContent = picked; clearFolder.hidden = false}}
      catch (error) {errorLine.textContent = message(error)}
    });
    const clearFolder = action('×',() => {cwd = ''; clearFolder.hidden = true; folder.textContent = tr('Выбрать рабочую папку…','Choose working folder…')});
    clearFolder.setAttribute('aria-label',tr('Убрать рабочую папку','Clear working folder')); clearFolder.hidden = true;
    const folderRow = el('div'); folderRow.className = 'ai-buttons'; folderRow.append(folder,clearFolder);
    const folderHint = el('p',tr('Чтобы сохранить файлы проекта, выберите папку. Временная папка удаляется после завершения работы агента.','Choose a folder to keep project files. The temporary folder is removed when the run ends.'));
    launchFields.append(field(tr('Поручение','Request'),request),folderRow,folderHint,resumeRow);
    const hint = el('p'), errorLine = el('p'); errorLine.setAttribute('role','alert');
    const submit = action('',async () => {
      if (profile.value === 'custom' && !customCommand.value.trim()) {customCommand.focus(); return}
      submit.disabled = true;
      try {
        localStorage.setItem(profileKey,profile.value);
      } catch {}
      try {
        await session.start(rootId,{mode:profile.value === 'external' ? 'external' : 'launch',profile:profile.value,
          custom:{command:customCommand.value.trim(),args:args.value.split(/\r?\n/).filter(Boolean)},
          write:rights.value === 'tasks',cwd:resume.checked ? session.previous(rootId,profile.value)?.cwd : cwd,prompt:request.value,resume:resume.checked});
      } catch (error) {errorLine.textContent = message(error); submit.disabled = false}
    },true);
    rights.onchange = () => {
      const plan = tr('Разбей идею на задачи и приступи к работе.','Break the idea into tasks and start working on them.');
      const read = tr('Прочитай заметку и кратко изложи основные идеи.','Read the note and summarize the main ideas.');
      if (request.value === plan || request.value === read) request.value = rights.value === 'tasks' ? plan : read;
      fields();
    };
    function fields() {
      const external = profile.value === 'external';
      custom.hidden = profile.value !== 'custom'; launchFields.hidden = external;
      const last=session.previous(rootId,profile.value);
      resume.checked=false;folderRow.hidden=false;
      resumeRow.hidden=!last || last.write!==(rights.value==='tasks');
      resume.onchange=()=>{folderRow.hidden=resume.checked};
      if(last)resumeRow.title=last.cwd;
      submit.textContent = external ? tr('Открыть доступ','Share note') : tr('Запустить агента','Run agent');
      hint.textContent = external ? tr('Доступ распространяется на эту заметку и её задачи. В следующем шаге можно скопировать настройки MCP.','Access covers this note and its tasks. You can copy the MCP configuration in the next step.') :
        tr('Адаптер запускается на этом компьютере. Обработку текста и доступ к рабочей папке определяют настройки агента.','The adapter runs on this computer. Its settings determine where the text is processed and how it can use the working folder.');
    }
    profile.onchange = fields; fields();
    content.replaceChildren(field(tr('Агент','Agent'),profile),custom,field(tr('Доступ к заметке','Note access'),rights),launchFields,hint,errorLine,submit);
  }
  function update() {
    const s = session.current;
    if (!s) {if (hasActive || !content.childElementCount) setup(); hasActive = false; signature = null; return}
    hasActive = true;
    const state = s.snapshot, key = JSON.stringify(state);
    if (signature === key) return;
    signature = key;
    const status = el('strong',agentStatus(state.status)); status.className = 'ai-status'; status.setAttribute('role','status');
    const nodes = [status];
    if (state.activity && !finishedRun(state.status)) nodes.push(el('p',state.activity));
    if (state.text) {const response = el('pre',state.text); nodes.push(response)}
    if (state.error) nodes.push(el('p',message(state.error)));
    const buttons = el('div'); buttons.className = 'ai-buttons';
    const err = el('p'); err.setAttribute('role','alert');
    if (s.config) {
      nodes.push(el('p',tr('Добавьте конфигурацию в настройки MCP вашего агента. Доступ действует до отключения, смены пространства или блокировки.','Add the configuration to your agent’s MCP settings. Access ends on disconnect, workspace switch or lock.')));
      buttons.append(action(tr('Скопировать настройки MCP','Copy MCP configuration'),async event => {
        const button = event.currentTarget;
        try {if (session.current !== s || !s.config) return;
          await window.runtime.ClipboardSetText(JSON.stringify(s.config,null,2)); button.textContent = tr('Скопировано','Copied');
        } catch (error) {err.textContent = message(error)}
      },true));
    }
    if (state.permission) {
      nodes.push(el('p',state.permission.title));
      for (const option of state.permission.options) buttons.append(action(option.name,async () => {
        try {await session.answer(option.optionId)} catch (error) {err.textContent = message(error)}
      }));
      buttons.append(action(tr('Отклонить запрос','Decline request'),() => session.answer('').catch(e => {err.textContent = message(e)})));
    }
    buttons.append(action(finishedRun(state.status) ? tr('Готово','Done') : tr('Завершить сессию','End session'),() => {
      void session.stop(); dialog.close();
    }));
    nodes.push(buttons,err); content.replaceChildren(...nodes);
  }
  update(); dialog.showModal();
  return {update,close:() => {if (dialog.open) dialog.close()}};
}
