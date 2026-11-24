let systemColors;

export function isLightTheme(){
  return globalThis.document?.documentElement?.dataset?.theme==='light';
}

export function getThemeMode(){
  return document.documentElement.dataset.themeMode || 'system';
}

function applyPalette(){
  const root = document.documentElement;
  const mode = getThemeMode();
  const theme = mode === 'system' ? (systemColors.matches ? 'dark' : 'light') : mode;
  const changed = root.dataset.theme !== theme;
  root.dataset.theme = theme;
  const channel = theme === 'light' ? 250 : 23;
  window.runtime?.WindowSetBackgroundColour?.(channel, channel, channel, 255);
  if (changed) window.dispatchEvent(new CustomEvent('videron:themechange', {detail:theme}));
}

function applyMode(){
  // In system mode the native title bar follows the OS even between WebView paints.
  const runtime = window.runtime;
  const mode = getThemeMode();
  if (mode === 'system') runtime?.WindowSetSystemDefaultTheme?.();
  else if (mode === 'light') runtime?.WindowSetLightTheme?.();
  else runtime?.WindowSetDarkTheme?.();
  applyPalette();
}

export function initTheme(){
  if (!systemColors) {
    systemColors = window.matchMedia('(prefers-color-scheme: dark)');
    systemColors.addEventListener('change', () => {
      if (getThemeMode() === 'system') applyPalette();
    });
  }
  applyMode();
}

export function setTheme(mode){
  if (!['system', 'light', 'dark'].includes(mode)) return;
  document.documentElement.dataset.themeMode = mode;
  try { localStorage.setItem('videron.theme.v1', mode); } catch {}
  initTheme();
}
