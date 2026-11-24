import { tr } from './i18n.js';
import { icon } from './art.js';
import { appearanceOf, iconChoices, iconSvg, lockSticker, shapeNames, shapeSvg } from './icons/node-art.js';

const forms = [
  ['Круг', 'Circle'],
  ['Квадрат', 'Square'],
  ['Ромб', 'Diamond'],
  ['Треугольник', 'Triangle'],
  ['Пятиугольник', 'Pentagon'],
  ['Шестиугольник', 'Hexagon']
];
const colors = [
  ['#babdc3', 'Серебро', 'Silver'],
  ['#a9c6ed', 'Голубой', 'Blue'],
  ['#b5abde', 'Сиреневый', 'Lilac'],
  ['#dc9ab5', 'Розовый', 'Rose'],
  ['#da998f', 'Коралловый', 'Coral'],
  ['#dcbd91', 'Песочный', 'Sand'],
  ['#98bbc5', 'Ледяной', 'Ice']
];

function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(name, cls, action) {
  const control = element('button', cls);
  control.type = 'button';
  control.title = name;
  control.setAttribute('aria-label', name);
  control.onclick = action;
  return control;
}

function section(title) {
  const group = element('fieldset', 'ap-section');
  group.append(element('legend', '', title));
  return group;
}

function searchText(value) {
  return value.toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function openAppearance({ note, areaColor, onChange }) {
  let value = appearanceOf(note);
  const secured = Object.hasOwn(note,'sealed');
  let pack = value.icon?.split('/')[0] || 'all';
  const inherited = areaColor || note.color || '#b3b3b3';
  const source = document.activeElement;
  const dialog = element('dialog', 'ap-dialog');
  const heading = element('h2', '', tr('Внешний вид заметки', 'Note appearance'));
  dialog.setAttribute('aria-label', heading.textContent);
  const header = element('header', 'ap-head');
  const close = button(tr('Закрыть', 'Close'), 'ap-close', () => dialog.close());
  close.textContent = '×';
  header.append(heading, close);

  const preview = element('div', 'ap-preview'),
    emblem = element('div', 'ap-emblem');
  preview.append(emblem, element('strong', '', note.title?.trim() || tr('Без названия', 'Untitled')));
  const controls = [];

  function addChoice(group, key, choice, name, cls, contents) {
    const item = button(name, cls, () => apply({ [key]: choice }));
    item.append(contents);
    group.append(item);
    controls.push({ item, key, choice });
    return item;
  }

  const formGroup = section(tr('Форма', 'Shape')),
    formRow = element('div', 'ap-form-row');
  shapeNames.forEach((shape, i) => {
    addChoice(formRow, 'shape', shape, tr(...forms[i]), 'ap-shape', shapeSvg(shape));
  });
  formGroup.append(formRow);

  const colorGroup = section(tr('Цвет', 'Color')),
    colorRow = element('div', 'ap-color-row');
  const auto = tr('Авто', 'Auto');
  const autoButton = addChoice(colorRow, 'color', null, auto, 'ap-auto', document.createTextNode(auto));
  autoButton.title = tr('Использовать цвет области', 'Use the area color');
  for (const [hex, ru, en] of colors) {
    const swatch = addChoice(colorRow, 'color', hex, tr(ru, en), 'ap-color', element('span'));
    swatch.style.setProperty('--ap-swatch', hex);
  }
  const custom = element('label', 'ap-custom-color');
  const picker = element('input');
  picker.type = 'color';
  custom.title = tr('Свой цвет', 'Custom color');
  picker.setAttribute('aria-label', custom.title);
  const customMark = element('span', '', '+');
  customMark.setAttribute('aria-hidden', 'true');
  custom.append(customMark, picker);
  colorRow.append(custom);
  picker.oninput = () => apply({ color: picker.value });
  colorGroup.append(colorRow);

  const iconsGroup = section(tr('Значок', 'Icon'));
  const searchBox = element('label', 'ap-icon-search');
  const magnifier = element('span');
  magnifier.innerHTML = icon('search');
  const search = element('input');
  search.type = 'search';
  search.placeholder = tr('Найти значок', 'Find an icon');
  search.setAttribute('aria-label', search.placeholder);
  search.autocomplete = 'off';
  search.spellcheck = false;
  searchBox.append(magnifier, search);
  const packs = element('div', 'ap-pack-row'),
    packSwitch = element('div', 'ap-packs');
  addChoice(
    packs,
    'icon',
    null,
    tr('Без значка', 'No icon'),
    'ap-none',
    document.createTextNode(tr('Без значка', 'No icon'))
  );
  packs.prepend(packSwitch);
  const results = element('div', 'ap-icon-results'), grid = element('div', 'ap-icons');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', tr('Значки', 'Icons'));
  const empty = element('p', 'ap-icon-empty', tr('Значки не найдены', 'No matching icons'));
  empty.setAttribute('role', 'status');
  results.append(grid, empty);
  let terms = [], tabStop = null;
  const catalog = [...iconChoices.values()].map(item => ({
    item, text: searchText([item.ru, item.en, item.id].join(' '))
  }));
  const tabs = [];
  for (const [id, name] of [
    ['all', tr('Все', 'All')],
    ['lucide', 'Lucide'],
    ['phosphor', 'Phosphor']
  ]) {
    const tab = button(name, 'ap-pack', () => {
      pack = id;
      renderIcons();
    });
    tab.textContent = name;
    packSwitch.append(tab);
    tabs.push({ tab, id });
  }
  function setTabStop(choice) {
    if (tabStop) tabStop.tabIndex = -1;
    tabStop = choice;
    if (choice) choice.tabIndex = 0;
  }
  function revealSelected() {
    const selected = grid.querySelector('[aria-pressed="true"]');
    if (selected && (selected.offsetTop < grid.scrollTop ||
        selected.offsetTop + selected.offsetHeight > grid.scrollTop + grid.clientHeight)) {
      grid.scrollTop = selected.offsetTop - (grid.clientHeight - selected.offsetHeight) / 2;
    }
  }
  function renderIcons() {
    const fragment = document.createDocumentFragment();
    for (const { item, text } of catalog) {
      if (pack !== 'all' && !item.id.startsWith(pack + '/')) continue;
      if (!terms.every(term => text.includes(term))) continue;
      const label = tr(item.ru, item.en);
      const choice = button(label, 'ap-icon', () => apply({ icon: item.id }));
      choice.dataset.icon = item.id;
      choice.tabIndex = -1;
      choice.setAttribute('aria-pressed', String(value.icon === item.id));
      const family = item.outline ? 'Lucide' : 'Phosphor';
      choice.title = label + ' · ' + family;
      if (pack === 'all') choice.setAttribute('aria-label', choice.title);
      choice.append(iconSvg(item.id));
      fragment.append(choice);
    }
    grid.replaceChildren(fragment);
    grid.scrollTop = 0;
    empty.hidden = Boolean(grid.childElementCount);
    setTabStop(grid.querySelector('[aria-pressed="true"]') || grid.firstElementChild);
    for (const { tab, id } of tabs) tab.setAttribute('aria-pressed', String(pack === id));
    if (!terms.length) revealSelected();
  }
  grid.addEventListener('focusin', event => setTabStop(event.target));
  grid.addEventListener('keydown', event => {
    const choice = event.target.closest('.ap-icon');
    if (!choice) return;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const index = Array.prototype.indexOf.call(grid.children, choice);
    const destinations = {
      ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - columns,
      ArrowDown: index + columns, Home: 0, End: grid.childElementCount - 1
    };
    if (!Object.hasOwn(destinations, event.key)) return;
    event.preventDefault();
    grid.children[Math.max(0, Math.min(grid.childElementCount - 1, destinations[event.key]))].focus();
  });
  search.oninput = () => {
    const text = searchText(search.value);
    if (text && !terms.length) pack = 'all';
    terms = text ? text.split(' ') : [];
    renderIcons();
  };
  search.onkeydown = event => {
    if (event.key === 'ArrowDown' && tabStop) {
      event.preventDefault(); tabStop.focus();
    }
    if (event.key === 'Escape' && search.value) {
      event.preventDefault(); event.stopPropagation();
      search.value = ''; search.oninput();
    }
  };
  iconsGroup.append(searchBox, packs, results);

  function update() {
    for (const { item, key, choice } of controls)
      item.setAttribute('aria-pressed', String(value[key] === choice));
    for (const choice of grid.children)
      choice.setAttribute('aria-pressed', String(value.icon === choice.dataset.icon));
    const shade = value.color || inherited;
    picker.value = /^#[0-9a-f]{6}$/i.test(shade) ? shade : '#b3b3b3';
    custom.classList.toggle('chosen', Boolean(value.color && !colors.some(([c]) => c === value.color)));
    custom.style.setProperty('--ap-custom', picker.value);
    emblem.style.setProperty('--ap-tone', picker.value);
    const outline = shapeSvg(value.shape);
    outline.classList.add('ap-preview-outline');
    emblem.replaceChildren(outline);
    if (value.icon || secured) {
      const sticker = iconSvg(value.icon || lockSticker);
      sticker.classList.add('ap-preview-icon');
      emblem.append(sticker);
    }
    if (secured && value.icon && value.icon !== lockSticker) {
      const lock = iconSvg(lockSticker);
      lock.classList.add('ap-preview-lock');
      emblem.append(lock);
    }
  }
  function apply(patch) {
    value = { ...value, ...patch };
    update();
    onChange?.({ ...value });
  }

  const footer = element('footer', 'ap-actions');
  const reset = button(tr('Сбросить вид', 'Reset appearance'), 'button secondary', () => {
    pack = 'all';
    search.value = '';
    terms = [];
    apply({ shape: 'circle', icon: null, color: null });
    renderIcons();
  });
  reset.textContent = reset.title;
  const done = button(tr('Готово', 'Done'), 'button primary', () => dialog.close());
  done.textContent = done.title;
  footer.append(reset, done);
  const body = element('div', 'ap-body');
  body.append(preview, formGroup, colorGroup, iconsGroup);
  dialog.append(header, body, footer);
  renderIcons();
  update();
  document.body.append(dialog);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  });
  dialog.addEventListener(
    'close',
    () => {
      dialog.remove();
      if (source?.isConnected) source.focus({ preventScroll: true });
    },
    { once: true }
  );
  dialog.showModal();
  revealSelected();
  search.focus({ preventScroll:true });
  return () => {
    if (dialog.open) dialog.close();
  };
}
