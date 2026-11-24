import assert from 'node:assert/strict';
import test from 'node:test';
import {getThemeMode, initTheme, isLightTheme, setTheme} from '../frontend/theme.js';

test('system colours update the open document without replacing the saved mode or overriding a fixed palette', () => {
  const media = Object.assign(new EventTarget(), {matches:false});
  const windowEvents = new EventTarget();
  const palettes = [], captions = [], writes = [];
  function changeSystem(dark) {
    media.matches = dark;
    media.dispatchEvent(new Event('change'));
  }
  windowEvents.addEventListener('videron:themechange', event => palettes.push(event.detail));
  globalThis.document = {documentElement:{dataset:{theme:'light', themeMode:'system'}}};
  globalThis.window = Object.assign(windowEvents, {
    matchMedia:() => media,
    runtime:{
      WindowSetSystemDefaultTheme:() => captions.push('system'),
      WindowSetLightTheme:() => captions.push('light'),
      WindowSetDarkTheme:() => captions.push('dark')
    }
  });
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {configurable:true,
    value:{setItem:(key, value) => writes.push([key,value])}});
  try {
    initTheme();
    changeSystem(true);
    assert.equal(getThemeMode(), 'system');
    assert.equal(isLightTheme(), false);
    assert.deepEqual(writes, []);

    setTheme('dark');  // Same current colour, different behaviour on the next OS change.
    changeSystem(false);
    assert.equal(isLightTheme(), false);
    setTheme('system');
    assert.equal(isLightTheme(), true);
    setTheme('light');
    changeSystem(true);
    assert.equal(isLightTheme(), true);
    setTheme('system');
    assert.equal(isLightTheme(), false);
    changeSystem(false);
    assert.deepEqual(palettes, ['dark','light','dark','light']);
    assert.deepEqual(captions, ['system','dark','system','light','system']);
    assert.deepEqual(writes, ['dark','system','light','system'].map(mode => ['videron.theme.v1',mode]));
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
  }
});
