import { tr } from './i18n.js';
import { agentProgress, agentTaskInfo, isAgentPlanLive } from './agent-tasks.js';
import { isProtectedNote } from './note-vault.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(task) {
  switch (task.status) {
    case 'working': return isAgentPlanLive(task.rootId) ? tr('В работе', 'Working') : tr('На паузе', 'Paused');
    case 'done': return tr('Готово', 'Done');
    case 'blocked': return tr('Нужна помощь', 'Blocked');
    case 'cancelled': return tr('Отменено', 'Cancelled');
    default: return tr('В очереди', 'Pending');
  }
}

export function mountAgentTaskList(noteId, notes, {openNote, setStatus} = {}) {
  const panel = element('section', 've-agent-tasks');
  panel.setAttribute('aria-label', tr('Задачи агента', 'Agent tasks'));

  function link(note) {
    const button = element('button', 've-agent-link', note.title || tr('Без названия', 'Untitled'));
    button.type = 'button';
    button.dataset.focusKey = 'open-' + note.id;
    button.onclick = () => openNote?.(note.id);
    return button;
  }
  function row(note, isChildView) {
    const task = note.agentTask, label = statusLabel(task);
    const item = element('div', 've-agent-task');
    item.dataset.status = task.status;
    const check = element('input', 've-agent-check');
    check.type = 'checkbox';
    check.checked = task.status === 'done';
    check.disabled = !setStatus;
    check.dataset.focusKey = 'task-' + note.id;
    check.setAttribute('aria-label', (note.title || tr('Без названия', 'Untitled')) + ' · ' + label);
    check.title = check.checked ? tr('Вернуть в очередь', 'Mark as pending') : tr('Отметить выполненной', 'Mark as done');
    check.onchange = () => setStatus?.(task.rootId, task.key, check.checked ? 'done' : 'pending');
    item.append(check);
    if (!isChildView) item.append(link(note));
    if (isChildView || task.status !== 'pending' && task.status !== 'done') {
      item.append(element('span', 've-agent-status', label));
    }
    return item;
  }
  function refresh(records = notes) {
    const focused = panel.contains(document.activeElement) && document.activeElement.dataset.focusKey;
    const collapsed = panel.querySelector('details')?.open === false;
    const current = records.find(note => note.id === noteId);
    const fragment = document.createDocumentFragment();
    if (current && !isProtectedNote(current)) {
      const own = agentTaskInfo(current);
      const parent = own && records.find(note => note.id === own.rootId && !isProtectedNote(note));
      if (parent) {
        const meta = element('div', 've-agent-parent');
        meta.append(element('span', '', tr('Идея', 'Idea')), link(parent), row(current, true));
        fragment.append(meta);
        if (own.result) {
          const result = element('div', 've-agent-result');
          result.append(element('strong', '', tr('Результат', 'Result')), element('p', '', own.result));
          fragment.append(result);
        }
      }
      const children = records.filter(note => agentTaskInfo(note)?.rootId === noteId);
      if (children.length) {
        const list = element('details', 've-agent-plan');
        list.open = !collapsed;
        const progress = agentProgress(children.map(note => note.agentTask));
        const summary = element('summary', '', tr('Задачи агента', 'Agent tasks'));
        if (progress.goal) {
          const percent = Math.round(100 * progress.ratio) + '%';
          const meter = element('progress', 've-agent-progress');
          meter.max = progress.goal;
          meter.value = progress.value;
          meter.setAttribute('aria-label', tr('Готовность с учётом объёма задач', 'Progress weighted by effort'));
          summary.append(meter, element('span', 've-agent-percent', percent));
        }
        const rows = element('div', 've-agent-rows');
        rows.append(...children.map(note => row(note, false)));
        list.append(summary, rows);
        fragment.append(list);
      }
    }
    panel.hidden = !fragment.childNodes.length;
    panel.replaceChildren(fragment);
    if (focused) Array.from(panel.querySelectorAll('[data-focus-key]')).find(node => node.dataset.focusKey === focused)?.focus({preventScroll:true});
  }
  refresh(notes);
  return {element:panel, refresh};
}
