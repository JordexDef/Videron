const preferenceKey = 'videron.interface-language.v1';
let language = 'ru';
try {
  if (localStorage.getItem(preferenceKey) === 'en') language = 'en';
} catch {
  // Storage can be unavailable in a restricted webview. The interface still works.
}

export const getLanguage = () => language;
export const tr = (russian, english) => language === 'en' ? english : russian;

export function setLanguage(value) {
  if (value !== 'ru' && value !== 'en') return false;
  language = value;
  try {
    localStorage.setItem(preferenceKey, value);
    return true;
  } catch {
    return false;
  }
}

// Only explicitly marked interface elements participate. Notes and plugin content
// can contain the same words as the interface and must keep their original text.
export function bindStaticTranslations(root) {
  const entries = [];
  for (const [marker, attribute] of [['data-en', null], ['data-en-title', 'title'], ['data-en-aria', 'aria-label']]) {
    for (const el of root.querySelectorAll('[' + marker + ']')) {
      const russian = attribute ? el.getAttribute(attribute) : el.textContent;
      const english = el.getAttribute(marker);
      entries.push(() => {
        const value = tr(russian, english);
        if (attribute) el.setAttribute(attribute, value);
        else el.textContent = value;
      });
    }
  }
  return () => {
    document.documentElement.lang = language;
    entries.forEach(update => update());
  };
}
