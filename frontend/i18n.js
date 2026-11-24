import {shortcutLabel, shortcutAria} from './shortcuts.js';

const preferenceKey = 'videron.interface-language.v1';
const builtIns = new Map([['ru','Русский'], ['en','English']]);
let packs = new Map();
let preferred = 'ru';
try {
  preferred = canonicalLocale(localStorage.getItem(preferenceKey)) || 'ru';
} catch {
  // Storage can be unavailable in a restricted webview. The interface still works.
}

// Imported dictionaries are inside the library, which may still be locked.
let language = builtIns.has(preferred) ? preferred : 'en';
export const getLanguage = () => language;
export function getLanguages() {
  return [
    ...Array.from(builtIns, ([code,name]) => ({code,name})),
    ...Array.from(packs.values(), pack => ({code:pack.locale, name:pack.name})),
  ];
}

const placeholder = /\{([a-zA-Z_][a-zA-Z_0-9]*)\}/g;

export function translateFor(locale, russian, english, params) {
  const text = locale === 'ru' ? russian : packs.get(locale)?.messages[english] ?? english;
  if (!params) return text;
  return text.replace(placeholder, (token,key) => Object.hasOwn(params,key) ? String(params[key]) : token);
}

export const tr = (russian, english, params) => translateFor(language, russian, english, params);

function canonicalLocale(value) {
  if (typeof value !== 'string' || !value || value.length > 128) return null;
  try { return Intl.getCanonicalLocales(value)[0]; } catch { return null; }
}

const packFields = new Set(['apiVersion','type','id','name','description','locale','messages']);
const messageLimit = 8192;

function isRecord(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function placeholderNames(value) {
  return [...new Set(Array.from(value.matchAll(placeholder), match => match[1]))].sort().join(',');
}

export function parseLanguagePack(value) {
  if (!isRecord(value) || value.apiVersion !== 1 || value.type !== 'language')
    throw Error(tr('Нужен языковой пакет с apiVersion 1.', 'Use a language pack with apiVersion 1.'));
  if (Object.keys(value).some(key => !packFields.has(key)))
    throw Error(tr('В языковом пакете есть неподдерживаемые поля.', 'The language pack contains unsupported fields.'));
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(value.id))
    throw Error(tr('Некорректный идентификатор расширения.', 'Invalid extension ID.'));
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.includes('\0') || value.name.length > 128 ||
      (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2048)))
    throw Error(tr('Проверьте название и описание языкового пакета.', 'Check the language pack name and description.'));
  const locale = canonicalLocale(value.locale);
  if (!locale) throw Error(tr('Укажите код языка, например de или pt-BR.', 'Enter a language tag such as de or pt-BR.'));
  if (builtIns.has(locale)) throw Error(tr('Этот язык уже встроен в приложение.', 'This language is already built in.'));
  if (!isRecord(value.messages))
    throw Error(tr('В поле messages нужен словарь переводов.', 'Supply a translation dictionary in the messages field.'));
  const keys = Object.keys(value.messages);
  if (!keys.length || keys.length > messageLimit)
    throw Error(tr('Словарь должен содержать от 1 до 8192 строк.', 'The dictionary must contain between 1 and 8192 entries.'));
  const messages = Object.create(null);
  let size = 0;
  for (const key of keys) {
    const translated = value.messages[key];
    if (!key.trim() || key.includes('\0') || key.length > 4096 || typeof translated !== 'string' ||
        !translated.trim() || translated.includes('\0') || translated.length > 16384)
      throw Error(tr('У каждой строки должен быть английский ключ и непустой текст перевода.', 'Each entry needs an English key and a nonempty text translation.'));
    size += key.length + translated.length;
    if (size > 2 * 1024 * 1024)
      throw Error(tr('Словарь переводов слишком большой.', 'The translation dictionary is too large.'));
    if (placeholderNames(key) !== placeholderNames(translated))
      throw Error(tr('Сохраните имена переменных в переводе строки «{key}».', 'Keep the placeholder names in the translation of “{key}”.', {key}));
    messages[key] = translated;
  }
  return {apiVersion:1, type:'language', id:value.id, name:value.name.trim(), description:value.description || '', locale, messages};
}

export function setLanguagePacks(plugins) {
  const next = new Map();
  for (const entry of plugins || []) {
    if (entry?.type !== 'language') continue;
    const pack = parseLanguagePack(entry);
    if (next.has(pack.locale))
      throw Error(tr('Языковой пакет для этого языка уже установлен.', 'A pack for this language is already installed.'));
    next.set(pack.locale, pack);
  }
  packs = next;
  if (builtIns.has(preferred) || packs.has(preferred)) language = preferred;
  else setLanguage('en');
}

export function setLanguage(value) {
  const locale = canonicalLocale(value);
  if (!builtIns.has(locale) && !packs.has(locale)) return false;
  language = preferred = locale;
  try {
    localStorage.setItem(preferenceKey, locale);
    return true;
  } catch {
    return false;
  }
}

// Only explicitly marked interface elements participate. Notes and plugin content
// can contain the same words as the interface and must keep their original text.
export function bindStaticTranslations(root) {
  const entries = [];
  for (const kbd of root.querySelectorAll('kbd')) kbd.textContent = shortcutLabel(kbd.textContent);
  for (const el of root.querySelectorAll('[aria-keyshortcuts]')) {
    el.setAttribute('aria-keyshortcuts', shortcutAria(el.getAttribute('aria-keyshortcuts')));
  }
  for (const [marker, attribute] of [['data-en', null], ['data-en-title', 'title'], ['data-en-aria', 'aria-label']]) {
    for (const el of root.querySelectorAll('[' + marker + ']')) {
      const russian = attribute ? el.getAttribute(attribute) : el.textContent;
      const english = el.getAttribute(marker);
      entries.push(() => {
        const value = tr(russian, english);
        if (attribute) el.setAttribute(attribute, shortcutLabel(value));
        else el.textContent = value;
      });
    }
  }
  return () => {
    document.documentElement.lang = language;
    entries.forEach(update => update());
  };
}
