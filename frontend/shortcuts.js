export function isMacPlatform() {
  const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '';
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function primaryCommand(event) {
  if (event.altKey) return false;
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function historyDirection(event) {
  if (!primaryCommand(event)) return null;
  if (event.code === 'KeyZ') return event.shiftKey ? 'redo' : 'undo';
  if (event.code === 'KeyY' && !event.shiftKey) return 'redo';
  return null;
}

// Visible hints use the keycap symbol. aria-keyshortcuts uses the DOM key name.
export function shortcutLabel(text) {
  return isMacPlatform() ? text.replace(/\bCtrl\b/g, '⌘') : text;
}

export function shortcutAria(chords) {
  return chords.replace(/\b(?:Ctrl|Control)\b/g, isMacPlatform() ? 'Meta' : 'Control');
}
