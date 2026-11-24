import {icon} from './art.js';
import {tr} from './i18n.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, click) {
  const node = el('button', 'button secondary', text);
  node.type = 'button';
  node.onclick = click;
  return node;
}

export function agentClientError(error) {
  const code = String(error?.message || error);
  if (code.includes('VD_AGENT_CLIENT_NAME')) return tr('Введите имя агента длиной от 1 до 64 символов.', 'Enter an agent name between 1 and 64 characters.');
  if (code.includes('VD_AGENT_CLIENT_DUPLICATE')) return tr('Агент с таким именем уже добавлен.', 'An agent with this name already exists.');
  if (code.includes('VD_AGENT_CLIENT_LIMIT')) return tr('Можно добавить до 64 агентов. Сначала забудьте одного из сохранённых агентов.', 'You can save up to 64 agents. Forget a saved agent first.');
  if (code.includes('VD_AGENT_CLIENT_UNKNOWN')) return tr('Агент больше не сохранён на этом компьютере.', 'This agent is no longer saved on this computer.');
  if (code.includes('VD_AGENT_CLIENT_STORE')) return tr('Не удалось открыть или сохранить настройки агентов на этом компьютере.', 'Could not open or save the agent settings on this computer.');
  if (code.includes('VD_LOCKED')) return tr('Сначала разблокируйте Videron.', 'Unlock Videron first.');
  return tr('Не удалось выполнить действие с агентом. Попробуйте ещё раз.', 'Could not complete the agent action. Try again.');
}

export function agentClientSettings(view, native, session, standalone = false) {
  const section = el('section', standalone ? 'agent-clients' : 'agent-clients vault-settings-section');
  if (!standalone) section.append(el('h3', '', tr('Внешние агенты', 'External agents')));
  const hint = el('p', 'vault-hint', tr('Добавьте настройки MCP в локальный клиент один раз. Доступ к каждой заметке вы выдаёте отдельно.', 'Add the MCP configuration to your local client once. You choose which notes to share.'));
  const list = el('ul', 'agent-client-list');
  const add = button(tr('Добавить агента…', 'Add agent…'), () => {
    form.hidden = false;
    add.hidden = true;
    feedback('');
    name.focus();
  });

  const form = el('form', 'agent-client-form');
  form.hidden = true;
  const label = el('label', 'vault-field', tr('Имя агента', 'Agent name'));
  const name = el('input', '');
  name.required = true;
  name.autocomplete = 'off';
  name.placeholder = tr('Например, Claude Desktop', 'For example, Claude Desktop');
  label.append(name);
  const submit = el('button', 'button primary', tr('Добавить и скопировать настройки', 'Add and copy configuration'));
  submit.type = 'submit';
  const cancel = button(tr('Отмена', 'Cancel'), () => {
    collapseForm();
    feedback('');
    add.focus();
  });
  const formActions = el('div', 'vault-settings-actions');
  formActions.append(submit, cancel);
  form.append(label, formActions);
  const result = el('p', 'agent-client-result');
  result.setAttribute('role', 'status');
  const errorLine = el('div', 'vault-error');
  errorLine.setAttribute('role', 'alert');
  section.append(hint, list, add, form, result, errorLine);

  let clients = [], confirming = null;

  function feedback(status, error = '') {
    result.textContent = status;
    errorLine.textContent = error;
  }

  function collapseForm() {
    name.value = '';
    form.hidden = true;
    add.hidden = false;
  }

  async function copyConfig(client) {
    if (view.node.inert) return;
    try {
      if (!client.config?.mcpServers?.videron) throw Error('Missing MCP configuration');
      const text = JSON.stringify(client.config, null, 2);
      if (window.runtime?.ClipboardSetText) {
        if (await window.runtime.ClipboardSetText(text) === false) throw Error('Clipboard unavailable');
      } else {
        await navigator.clipboard.writeText(text);
      }
      feedback(tr('Настройки скопированы. Вставьте их в настройки MCP клиента «{name}».', 'Configuration copied. Paste it into the MCP settings for “{name}”.', {name:client.name}));
    } catch {
      feedback('', tr('Не удалось скопировать настройки. Нажмите кнопку копирования рядом с именем агента, чтобы повторить.', 'Could not copy the configuration. Use the copy button beside the agent’s name to try again.'));
    }
  }

  async function run(action) {
    if (section.inert) return;
    const active = document.activeElement;
    feedback('');
    section.inert = true;
    view.setBusy(true);
    try {
      await action();
    } catch (error) {
      feedback('', agentClientError(error));
    } finally {
      section.inert = false;
      if (view.settled(!errorLine.textContent)) {
        const target = active?.getClientRects().length ? active : form.hidden ? add : name;
        target.focus();
      }
    }
  }

  function render() {
    list.replaceChildren();
    for (const client of clients) {
      const item = el('li', 'agent-client-item');
      const clientName = el('strong', 'agent-client-name', client.name);
      const copyLabel = tr('Скопировать настройки MCP', 'Copy MCP configuration');
      const copy = button('', () => run(async () => {
        const details = JSON.parse(await native.AgentClientConfig(client.id));
        await copyConfig(details);
      }));
      copy.className = 'icon-button';
      copy.setAttribute('aria-label', copyLabel);
      copy.title = copyLabel;
      copy.innerHTML = icon('copy');
      const forget = button(tr('Забыть', 'Forget'), () => {
        confirming = client.id;
        feedback('');
        render();
        list.querySelector('.agent-forget-cancel').focus();
      });
      forget.classList.add('agent-forget');
      item.append(clientName, copy, forget);
      if (confirming === client.id) {
        copy.hidden = true;
        forget.hidden = true;
        const confirmation = el('div', 'agent-forget-confirm');
        confirmation.append(el('p', 'vault-hint', tr('Сохранённые настройки MCP этого агента перестанут работать, а его доступ к заметке завершится.', 'This agent’s saved MCP configuration will stop working and its access to the shared note will end.')));
        const controls = el('div', 'vault-settings-actions');
        const back = button(tr('Отмена', 'Cancel'), () => {
          confirming = null;
          render();
          list.children[clients.indexOf(client)]?.querySelector('.agent-forget')?.focus();
        });
        back.classList.add('agent-forget-cancel');
        const confirm = button(tr('Забыть агента', 'Forget agent'), () => run(async () => {
          await native.ForgetAgentClient(client.id);
          if (session?.current?.clientId === client.id) await session.stop();
          confirming = null;
          clients = clients.filter(c => c.id !== client.id);
          render();
          feedback(tr('Агент «{name}» удалён.', 'Removed “{name}”.', {name:client.name}));
        }));
        controls.append(back, confirm);
        confirmation.append(controls);
        item.append(confirmation);
      }
      list.append(item);
    }
  }

  form.onsubmit = event => {
    event.preventDefault();
    const value = name.value.trim();
    if (!value || Array.from(value).length > 64) {
      feedback('', agentClientError('VD_AGENT_CLIENT_NAME'));
      name.focus();
      return;
    }
    void run(async () => {
      const client = JSON.parse(await native.RegisterAgentClient(value));
      if (view.node.inert) return;
      clients.push({id:client.id, name:client.name});
      collapseForm();
      render();
      await copyConfig(client);
    });
  };

  // Load the names before enabling changes, so a slow response cannot overwrite a new pairing.
  const retry = button(tr('Повторить', 'Retry'), load);
  retry.hidden = true;
  section.append(retry);
  async function load() {
    feedback('');
    add.hidden = true;
    retry.hidden = true;
    try {
      clients = JSON.parse(await native.ListAgentClients());
      render();
      add.hidden = false;
      if (standalone && document.activeElement === view.node) add.focus();
    } catch (error) {
      feedback('', agentClientError(error));
      retry.hidden = false;
    }
  }
  void load();
  return section;
}
