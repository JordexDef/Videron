import test from 'node:test';
import assert from 'node:assert/strict';
import {historyDirection, primaryCommand, shortcutAria, shortcutLabel} from '../frontend/shortcuts.js';

test('hints, assistive technology and shortcut dispatch agree on the platform modifier', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
  for (const [platform, modifier, other] of [
    ['Win32', 'ctrlKey', 'metaKey'], ['Linux x86_64', 'ctrlKey', 'metaKey'], ['MacIntel', 'metaKey', 'ctrlKey']
  ]) {
    Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{platform}});
    const mac = modifier === 'metaKey';
    assert.equal(shortcutLabel('Ctrl+S'), mac ? '⌘+S' : 'Ctrl+S');
    assert.equal(shortcutAria('Ctrl+S Control+Shift+F'), mac ? 'Meta+S Meta+Shift+F' : 'Control+S Control+Shift+F');
    const chord = {code:'KeyZ', key:'я', [modifier]:true};
    assert.equal(historyDirection(chord), 'undo');
    assert.equal(historyDirection({...chord, shiftKey:true}), 'redo');
    assert.equal(historyDirection({...chord, code:'KeyY'}), 'redo');
    assert.equal(historyDirection({...chord, code:'KeyY', shiftKey:true}), null);
    assert.ok(!primaryCommand({[other]:true}));
    assert.ok(!primaryCommand({...chord, altKey:true}));
    assert.ok(!primaryCommand({...chord, [other]:true}));
  }
});
