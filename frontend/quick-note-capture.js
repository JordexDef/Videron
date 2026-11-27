import {icon} from './art.js';
import {tr} from './i18n.js';
import {isMacPlatform, primaryCommand, shortcutAria, shortcutLabel} from './shortcuts.js';

const gap = 9;
const microphone = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6"/></svg>';
let active = null;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function iconButton(label, graphic, type = 'button') {
  const button = node('button', 'icon-button');
  button.type = type;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = graphic;
  return button;
}

function systemDictationHint() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/Win/i.test(platform)) return tr('Нажмите Win + H и говорите.', 'Press Win + H and start speaking.');
  if (isMacPlatform()) return tr('Нажмите клавишу микрофона или сочетание клавиш диктовки macOS.',
    'Press the microphone key or your macOS dictation shortcut.');
  return '';
}

function anchorRect(anchor) {
  const value = typeof anchor === 'function' ? anchor() : anchor;
  if (!value) return null;
  if (typeof value.getBoundingClientRect === 'function') {
    return value.isConnected && value.getClientRects().length ? value.getBoundingClientRect() : null;
  }
  const left = value.left ?? value.x, top = value.top ?? value.y;
  const right = value.right ?? left, bottom = value.bottom ?? top;
  return [left, right, top, bottom].every(Number.isFinite) ? {left, right, top, bottom} : null;
}

export function dismissQuickNoteCapture() {
  active?.close(false);
}

export function updateQuickNoteCapturePosition() {
  active?.position();
}

export function openQuickNoteCapture({title, anchor, onSave, onClose, focusTarget, onError}) {
  dismissQuickNoteCapture();
  const events = new AbortController(), {signal} = events;
  const panel = node('form', 'quick-capture');
  const label = tr('Новая запись', 'New entry');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', label);

  const cancel = iconButton(tr('Закрыть', 'Close'), icon('x'));
  if (title) {
    const top = node('div', 'quick-capture-top');
    top.append(node('h2', 'quick-capture-title', title), cancel);
    panel.append(top);
  }
  const input = node('textarea', 'quick-capture-input');
  input.rows = 7;
  input.setAttribute('aria-label', label);
  input.placeholder = tr('Что нужно записать?', 'What do you want to capture?');
  panel.append(input);

  const actions = node('div', 'quick-capture-actions');
  const error = node('p', 'quick-capture-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const dictation = systemDictationHint();
  if (dictation) {
    const hint = node('p', 'quick-capture-dictation', dictation);
    hint.id = 'quick-capture-dictation';
    hint.hidden = true;
    hint.setAttribute('role', 'status');
    const mic = iconButton(tr('Системная диктовка', 'System dictation') + ' · ' + dictation, microphone);
    mic.setAttribute('aria-expanded', 'false');
    mic.setAttribute('aria-controls', hint.id);
    mic.addEventListener('click', () => {
      hint.hidden = !hint.hidden;
      mic.setAttribute('aria-expanded', String(!hint.hidden));
      input.focus({preventScroll:true});
    }, {signal});
    actions.append(mic);
    panel.append(hint);
  }
  panel.append(error, actions);

  const key = shortcutLabel('Ctrl+Enter');
  actions.append(node('kbd', 'quick-capture-shortcut', key));
  if (!title) actions.append(cancel);
  const save = iconButton(tr('Добавить запись', 'Add entry'), icon('check'), 'submit');
  save.classList.add('quick-capture-save');
  save.title += ' (' + key + ')';
  save.setAttribute('aria-keyshortcuts', shortcutAria('Control+Enter'));
  save.disabled = true;
  actions.append(save);

  let busy = false, closed = false, width, height, lastPosition = '';
  const size = new ResizeObserver(measure);
  active = {close, position};
  document.body.append(panel);
  size.observe(panel);
  measure();
  if (!closed) input.focus({preventScroll:true});

  function measure() {
    width = panel.offsetWidth;
    height = panel.offsetHeight;
    position();
  }
  function position() {
    if (closed) return;
    const rect = anchorRect(anchor);
    const outside = !rect || rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight;
    if (outside && !busy && !input.value.trim()) { close(false); return; }
    if (!rect) return;
    const min = gap;
    const right = rect.right + gap, left = rect.left - width - gap;
    const maxX = window.innerWidth - width - gap;
    const x = Math.max(min, Math.min(maxX, right > maxX && left >= min ? left : right));
    const startsAbove = rect.top - height - gap >= min;
    const y = Math.max(min, Math.min(window.innerHeight - height - gap,
      rect.bottom + height + gap <= window.innerHeight || !startsAbove ? rect.bottom + gap : rect.top - height - gap));
    const transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    if (transform !== lastPosition) {
      panel.style.transform = transform;
      lastPosition = transform;
    }
  }
  function close(restoreFocus = true) {
    if (closed) return;
    closed = true;
    if (active?.close === close) active = null;
    events.abort();
    size.disconnect();
    input.value = '';
    panel.remove();
    onClose?.();
    if (restoreFocus) (focusTarget || (typeof anchor?.focus === 'function' ? anchor : null))?.focus({preventScroll:true});
  }

  input.addEventListener('input', () => {
    error.hidden = true;
    save.disabled = busy || !input.value.trim();
  }, {signal});
  cancel.addEventListener('click', () => close(), {signal});
  document.addEventListener('pointerdown', event => {
    if (event.composedPath().includes(panel) || busy || input.value.trim()) return;
    close(false);
  }, {capture:true, signal});
  window.addEventListener('resize', measure, {signal});
  panel.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && primaryCommand(event) && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!save.disabled) panel.requestSubmit();
    }
  }, {signal});
  panel.addEventListener('submit', async event => {
    event.preventDefault();
    if (closed || busy || !input.value.trim()) return;
    busy = save.disabled = input.readOnly = true;
    panel.setAttribute('aria-busy', 'true');
    error.hidden = true;
    try {
      if (await onSave(input.value) !== false && !closed) close();
    } catch (reason) {
      if (!closed) {
        error.textContent = onError?.(reason) || tr('Не удалось добавить запись. Попробуйте ещё раз.',
          'Could not add the entry. Try again.');
        error.hidden = false;
      }
    } finally {
      if (!closed) {
        busy = input.readOnly = false;
        save.disabled = !input.value.trim();
        panel.removeAttribute('aria-busy');
        input.focus({preventScroll:true});
      }
    }
  }, {signal});
  return close;
}
