import { tr } from './i18n.js';
import { icon } from './art.js';
import { isPinned } from './area-grid.js';
import { appearanceOf, badgeRadius, contentRadius, edgeRadius, geometryFor, iconChoices, iconSvg,
  lockSticker, maxNoteRadius, minNoteRadius, shapeNames, shapeSvg, sideBadgeX, sideBadgeY } from './icons/node-art.js';

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

export function openAppearance({ note, areaColor, onChange, concealed = false }) {
  let value = appearanceOf(note);
  const secured = Object.hasOwn(note,'sealed');
  let pack = value.icon?.split('/')[0] || 'all';
  const inherited = areaColor || note.color || '#b3b3b3';
  const source = document.activeElement;
  const dialog = element('dialog', 'ap-dialog');
  dialog.dataset.noteId = note.id;
  const heading = element('h2', '', tr('Внешний вид заметки', 'Note appearance'));
  dialog.setAttribute('aria-label', heading.textContent);
  const header = element('header', 'ap-head');
  const close = button(tr('Закрыть', 'Close'), 'ap-close', () => dialog.close());
  close.textContent = '×';
  header.append(heading, close);

  const preview = element('div', 'ap-preview'),
    emblem = element('div', 'ap-emblem');
  preview.append(emblem);
  if (concealed) {
    const label = element('span','note-title-spoiler');
    label.setAttribute('role','img');
    label.setAttribute('aria-label',tr('Зашифрованная заметка', 'Encrypted note'));
    preview.append(label);
  } else {
    preview.append(element('strong', '', note.title?.trim() || tr('Без названия', 'Untitled')));
  }
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

  const sizing = element('div', 'ap-sizing');
  function sizeChoice(label, options) {
    const field = element('label', 'ap-sizing-field');
    const select = element('select');
    for (const [key, name] of options) {
      const option = element('option', '', name);
      option.value = key;
      select.append(option);
    }
    field.append(element('span', '', label), select);
    sizing.append(field);
    return select;
  }
  const sizeMode = sizeChoice(tr('Размер фигуры', 'Shape size'), [
    ['auto', tr('По содержимому', 'By content')], ['fixed', tr('Вручную', 'Manual')]
  ]);
  const badgeMode = sizeChoice(tr('Боковые значки', 'Edge badges'), [
    ['small', tr('Мелкие', 'Small')], ['normal', tr('Обычные', 'Regular')],
    ['large', tr('Крупные', 'Large')], ['hidden', tr('Скрыть', 'Hide')]
  ]);
  const diameterRow = element('label', 'ap-diameter');
  const diameter = element('input');
  diameter.type = 'range';
  diameter.min = minNoteRadius * 2;
  diameter.max = maxNoteRadius * 2;
  diameter.step = 2;
  const diameterLabel = tr('Диаметр при масштабе 100%', 'Diameter at 100% zoom');
  diameter.setAttribute('aria-label',diameterLabel);
  const diameterReadout = element('output');
  diameterRow.append(element('span', '', diameterLabel), diameter, diameterReadout);
  sizing.append(diameterRow);
  const autoRadius = contentRadius(note);
  sizeMode.onchange = () => apply({radius:sizeMode.value === 'fixed' ? Math.round(autoRadius) : undefined});
  badgeMode.onchange = () => apply({badgeSize:badgeMode.value});
  diameter.oninput = () => {
    diameterReadout.value = diameter.value;
    updatePreview(Number(diameter.value) / 2);
  };
  diameter.onchange = () => apply({radius:Number(diameter.value) / 2});

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
  const iconFilters = element('div', 'ap-icon-filters');
  const target = element('select', 'ap-icon-target');
  target.title = tr('Положение значка', 'Icon position');
  target.setAttribute('aria-label', target.title);
  for (const [field, label] of [
    ['icon', tr('В центре', 'Center')], ['leftIcon', tr('Слева', 'Left')], ['rightIcon', tr('Справа', 'Right')]
  ]) {
    const option = element('option', '', label);
    option.value = field;
    target.append(option);
  }
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
  iconFilters.append(target, searchBox);
  const packs = element('div', 'ap-pack-row'),
    packSwitch = element('div', 'ap-packs');
  const clearIcon = button('', 'ap-none', () => apply({[target.value]:null}));
  packs.append(packSwitch, clearIcon);
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
      const choice = button(label, 'ap-icon', () => apply({ [target.value]: item.id }));
      choice.dataset.icon = item.id;
      choice.tabIndex = -1;
      choice.setAttribute('aria-pressed', String(value[target.value] === item.id));
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
  target.onchange = () => {
    search.value = '';
    terms = [];
    pack = value[target.value]?.split('/')[0] || 'all';
    renderIcons();
    updateClearIcon();
  };
  iconsGroup.append(iconFilters, packs, results);

  function updateClearIcon() {
    const label = target.value === 'icon' ? tr('Без значка', 'No icon') : tr('Авто', 'Auto');
    clearIcon.textContent = label;
    clearIcon.title = target.value === 'icon' ? label : tr('Оставить только служебные значки', 'Show status badges only');
    clearIcon.setAttribute('aria-label',label);
    clearIcon.setAttribute('aria-pressed', String(!value[target.value]));
  }
  function update() {
    updateClearIcon();
    for (const { item, key, choice } of controls)
      item.setAttribute('aria-pressed', String(value[key] === choice));
    for (const choice of grid.children)
      choice.setAttribute('aria-pressed', String(value[target.value] === choice.dataset.icon));
    const shade = value.color || inherited;
    picker.value = /^#[0-9a-f]{6}$/i.test(shade) ? shade : '#b3b3b3';
    custom.classList.toggle('chosen', Boolean(value.color && !colors.some(([c]) => c === value.color)));
    custom.style.setProperty('--ap-custom', picker.value);
    sizeMode.value = value.radius === undefined ? 'auto' : 'fixed';
    badgeMode.value = value.badgeSize || 'normal';
    diameterRow.hidden = value.radius === undefined;
    diameter.value = (value.radius ?? Math.round(autoRadius)) * 2;
    diameterReadout.value = diameter.value;
    updatePreview(value.radius ?? autoRadius);
  }
  function updatePreview(radius) {
    const outlineSize = 34 + (radius - minNoteRadius) * 0.8;
    const previewRadius = outlineSize / 2.3;
    const geometry = geometryFor(value.shape);
    const model = {geometry, r:previewRadius};
    const outline = shapeSvg(value.shape);
    outline.classList.add('ap-preview-outline');
    emblem.replaceChildren(outline);
    emblem.style.setProperty('--ap-tone', picker.value);
    emblem.style.setProperty('--ap-outline-size', outlineSize + 'px');
    const iconSize = Math.min(1.05, (geometry?.apothem || 1) * 1.68) * previewRadius;
    emblem.style.setProperty('--ap-icon-size', iconSize + 'px');
    if (value.icon || secured) {
      const sticker = iconSvg(value.icon || lockSticker);
      sticker.classList.add('ap-preview-icon');
      emblem.append(sticker);
    }
    function addBadge(glyph, dx, dy, sticker) {
      const badge = element('span', 'ap-preview-badge ap-preview-' + glyph);
      if (sticker) badge.append(iconSvg(sticker));
      else badge.innerHTML = icon(glyph);
      const edge = edgeRadius(model, dx, dy);
      badge.style.left = 'calc(50% + ' + edge * dx + 'px)';
      badge.style.top = 'calc(50% + ' + edge * dy + 'px)';
      emblem.append(badge);
    }
    const badge = badgeRadius(radius,value.badgeSize,geometry,!!(value.leftIcon || value.rightIcon));
    emblem.style.setProperty('--ap-badge-size', (badge * 2 * previewRadius / radius) + 'px');
    const pinned = isPinned(note);
    if (pinned && !value.icon && !secured) {
      const pin = element('span','ap-center-pin');
      pin.innerHTML = icon('pin');
      emblem.append(pin);
    }
    if (badge) {
      if (value.leftIcon) addBadge('left',-sideBadgeX,sideBadgeY,value.leftIcon);
      if (value.rightIcon) addBadge('right',sideBadgeX,sideBadgeY,value.rightIcon);
      if (secured && value.icon && value.icon !== lockSticker) addBadge('lock',-Math.SQRT1_2,-Math.SQRT1_2,lockSticker);
      if (pinned && (value.icon || secured)) addBadge('pin',Math.SQRT1_2,-Math.SQRT1_2);
      if (note.agentTask?.status === 'done') addBadge('check',value.leftIcon ? 0 : -Math.SQRT1_2,value.leftIcon ? 1 : Math.SQRT1_2);
    }
  }
  function apply(patch) {
    value = appearanceOf({appearance:{...value, ...patch}});
    update();
    onChange?.({ ...value });
  }

  const footer = element('footer', 'ap-actions');
  const reset = button(tr('Сбросить вид', 'Reset appearance'), 'button secondary', () => {
    pack = 'all';
    target.value = 'icon';
    search.value = '';
    terms = [];
    apply({ shape:'circle', icon:null, color:null, radius:undefined, badgeSize:undefined, leftIcon:undefined, rightIcon:undefined });
    renderIcons();
  });
  reset.textContent = reset.title;
  const done = button(tr('Готово', 'Done'), 'button primary', () => dialog.close());
  done.textContent = done.title;
  footer.append(reset, done);
  const body = element('div', 'ap-body');
  body.append(preview, formGroup, sizing, colorGroup, iconsGroup);
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
