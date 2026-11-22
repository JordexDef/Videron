import {getLanguage, tr} from './i18n.js';
import {applyFormulaCompletion, canSkipFormulaClosing, catalogTarget, formulaCompletions, formulaSignature, functionCatalog} from './formula-completion.js';

export function attachFormulaSuggestions(field, table, id, browseButton) {
  const doc = field.ownerDocument;
  const popup = doc.createElement('div');
  popup.className = 'vt-completions';
  popup.id = id + '-functions';
  const topLayer = typeof popup.showPopover === 'function';
  if (topLayer) popup.setAttribute('popover', 'manual');
  let match = null, active = 0, rendered = '', dismissed = '', composing = false;
  let observing, resize, transform, catalog;

  function place() {
    if (!topLayer || !popup.isConnected) return;
    const anchor = catalog ? browseButton : field, a = anchor.getBoundingClientRect();
    const width = doc.documentElement.clientWidth, height = doc.documentElement.clientHeight;
    popup.style.visibility = getComputedStyle(anchor).visibility === 'hidden' ||
      a.bottom <= 0 || a.top >= height || a.right <= 0 || a.left >= width ? 'hidden' : '';
    const gap = 5, above = a.top - gap, below = height - a.bottom - gap;
    const flip = popup.scrollHeight + 2 > below && above > below;
    popup.style.maxHeight = Math.max(0, Math.min(240, (flip ? above : below) - gap)) + 'px';
    const bounds = popup.getBoundingClientRect();
    popup.style.left = Math.max(gap, Math.min(a.left, width - bounds.width - gap)) + 'px';
    popup.style.top = Math.max(gap, flip ? a.top - gap - bounds.height : a.bottom + gap) + 'px';
  }
  function show() {
    if (!popup.isConnected) {
      (topLayer ? table : field.parentElement).append(popup);
      if (topLayer) {
        popup.showPopover();
        observing = new AbortController();
        window.addEventListener('scroll', place, {capture:true, signal:observing.signal});
        window.addEventListener('resize', place, {signal:observing.signal});
        resize = new ResizeObserver(place);
        resize.observe(field);
        resize.observe(browseButton);
        const world = field.closest('.vb-world');
        if (world) {
          transform = new MutationObserver(place);
          transform.observe(world, {attributes:true, attributeFilter:['style']});
          const footer = field.closest('.vt-footer');
          if (footer) transform.observe(footer, {attributes:true, attributeFilter:['style']});
        }
      }
    }
    place();
  }
  function hide() {
    observing?.abort(); resize?.disconnect(); transform?.disconnect();
    popup.remove();
    match = null; rendered = '';
    catalog = null;
    browseButton.setAttribute('aria-expanded', 'false');
    browseButton.removeAttribute('aria-controls');
    field.removeAttribute('aria-activedescendant');
    field.removeAttribute('aria-controls');
    field.removeAttribute('aria-describedby');
    if (field.hasAttribute('role')) field.setAttribute('aria-expanded', 'false');
  }
  function highlight(index) {
    active = index;
    for (const [i, row] of Array.from(popup.children).entries()) {
      row.setAttribute('aria-selected', String(i === active));
    }
    const row = popup.children[active];
    field.setAttribute('aria-activedescendant', row.id);
    if (row.offsetTop < popup.scrollTop) popup.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > popup.scrollTop + popup.clientHeight)
      popup.scrollTop = row.offsetTop + row.offsetHeight - popup.clientHeight;
  }
  function positionKey() {
    return field.selectionStart + '/' + field.selectionEnd + '/' + field.value;
  }
  function refresh() {
    const raw = field.value, caret = field.selectionStart;
    if (catalog && catalog.position !== positionKey()) {
      catalog = null;
      browseButton.setAttribute('aria-expanded','false');
      browseButton.removeAttribute('aria-controls');
    }
    if (!raw.startsWith('=') && !catalog) {
      hide();
      for (const name of ['role','aria-autocomplete','aria-expanded']) field.removeAttribute(name);
      return;
    }
    field.setAttribute('role','combobox');
    field.setAttribute('aria-autocomplete','list');
    if (composing || doc.activeElement !== field || (!catalog && field.selectionEnd !== caret) || dismissed === positionKey()) {
      hide(); return;
    }
    dismissed = '';
    const lang = getLanguage();
    match = catalog || formulaCompletions(raw, caret, lang);
    const hint = !match && formulaSignature(raw, caret, lang);
    if (!match && !hint) { hide(); return; }
    const key = match ? 'options:' + match.items.map(item => item.signature).join('|') : 'hint:' + hint.signature;
    if (rendered !== key) {
      rendered = key;
      popup.replaceChildren();
      popup.classList.toggle('vt-signature', !!hint);
      if (hint) {
        popup.setAttribute('role','tooltip');
        popup.removeAttribute('aria-label');
        popup.textContent = hint.signature;
        field.removeAttribute('aria-activedescendant');
        field.removeAttribute('aria-controls');
        field.setAttribute('aria-describedby', popup.id);
      } else {
        popup.setAttribute('role','listbox');
        popup.setAttribute('aria-label',tr('Функции формул', 'Formula functions'));
        field.removeAttribute('aria-describedby');
        field.setAttribute('aria-controls', popup.id);
        active = 0;
        for (const [i, item] of match.items.entries()) {
          const option = doc.createElement('div'), signature = doc.createElement('code'), description = doc.createElement('small');
          option.id = popup.id + '-' + item.name;
          option.dataset.index = i;
          option.setAttribute('role','option');
          signature.textContent = item.signature;
          description.textContent = item.description;
          option.append(signature, description);
          popup.append(option);
        }
      }
    }
    field.setAttribute('aria-expanded', String(!!match));
    show();
    if (match) highlight(active);
  }
  function choose(index) {
    if (!match || !match.items[index]) return;
    const {start, end} = match, before = field.value;
    const result = applyFormulaCompletion(before, match, match.items[index]);
    hide();
    if (result.value !== before) {
      const replacement = result.value.slice(start, result.value.length - (before.length - end));
      field.setSelectionRange(start, end);
      // Keep the completion in the input's native undo stack alongside typed text.
      if (!doc.execCommand('insertText', false, replacement)) {
        field.value = result.value;
        field.dispatchEvent(new Event('input', {bubbles:true}));
      }
    }
    field.setSelectionRange(result.caret, result.caret);
    refresh();
  }
  function keydown(e) {
    if (!popup.isConnected || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    if (e.key === 'Escape') { dismissed = positionKey(); hide(); }
    else if (!match) return false;
    else if (catalog && (e.key === 'Home' || e.key === 'End')) highlight(e.key === 'Home' ? 0 : match.items.length - 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = match.items.length;
      highlight((active + n + (e.key === 'ArrowDown' ? 1 : -1)) % n);
    } else if (e.key === 'Tab' || e.key === 'Enter') choose(active);
    else return false;
    e.preventDefault();
    return true;
  }
  popup.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
  popup.addEventListener('click', e => {
    e.stopPropagation();
    const option = e.target.closest('[role="option"]');
    if (option) choose(Number(option.dataset.index));
  });
  popup.addEventListener('wheel', e => e.stopPropagation(), {passive:true});
  field.addEventListener('beforeinput', e => {
    const caret = field.selectionStart;
    if (e.isComposing || !e.cancelable || e.inputType !== 'insertText' || e.data !== ')' ||
        field.selectionEnd !== caret || !canSkipFormulaClosing(field.value, caret)) return;
    e.preventDefault();
    field.setSelectionRange(caret + 1, caret + 1);
    refresh();
  });
  field.addEventListener('compositionstart', () => { composing = true; hide(); });
  field.addEventListener('compositionend', () => { composing = false; refresh(); });
  field.addEventListener('selectionchange', refresh);
  field.addEventListener('pointerup', refresh);
  field.addEventListener('keyup', e => {
    if (['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) refresh();
  });
  function browse(wholeCell) {
    if (catalog) { dismissed = positionKey(); hide(); return; }
    field.focus({preventScroll:true});
    dismissed = '';
    catalog = {
      ...catalogTarget(field.value, field.selectionStart, field.selectionEnd, wholeCell),
      items:functionCatalog(field.value, getLanguage()), position:positionKey()
    };
    browseButton.setAttribute('aria-expanded','true');
    browseButton.setAttribute('aria-controls',popup.id);
    refresh();
  }
  return {keydown, refresh, browse, destroy:hide};
}
