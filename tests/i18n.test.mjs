import assert from 'node:assert/strict';
import test from 'node:test';
import {parseLanguagePack} from '../frontend/i18n.js';

const preferenceKey = 'videron.interface-language.v1';
const pack = {apiVersion:1,type:'language',id:'example.portuguese',locale:'pt-br',name:'Português',messages:{
  Task:'Tarefa',
  'Move {note} to {area}':'Em {area}, mover {note}',
}};

async function session(t, saved) {
  const storage = new Map(saved === undefined ? [] : [[preferenceKey,saved]]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {configurable:true, value:{
    getItem:key => storage.get(key) ?? null, setItem:(key,value) => storage.set(key,value),
  }});
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  const i18n = await import('../frontend/i18n.js?test=' + encodeURIComponent(t.name));
  return {i18n,storage};
}

test('the saved language activates after unlock and removal persists an English fallback', async t => {
  const {i18n,storage} = await session(t, 'pt-BR');
  assert.equal(i18n.getLanguage(), 'en');
  assert.equal(storage.get(preferenceKey), 'pt-BR');
  const view = {apiVersion:1,id:'example.view',name:'My view',html:'<p>Test</p>'};
  i18n.setLanguagePacks([view,pack]);
  assert.equal(i18n.getLanguage(), 'pt-BR');
  assert.deepEqual(i18n.getLanguages().map(entry=>[entry.code,entry.name]),
    [['ru','Русский'],['en','English'],['pt-BR','Português']]);
  assert.equal(i18n.tr('Задача','Task'), 'Tarefa');
  assert.equal(i18n.tr('Карта','Map'), 'Map');
  assert.equal(i18n.translateFor('en','Задача','Task'), 'Task');
  assert.equal(i18n.translateFor('ru','Задача','Task'), 'Задача');
  i18n.setLanguagePacks([view]);
  assert.equal(i18n.getLanguage(), 'en');
  assert.equal(storage.get(preferenceKey), 'en');
  assert.equal(i18n.setLanguage('pt-BR'), false);
  i18n.setLanguagePacks([pack]);
  assert.equal(i18n.getLanguage(), 'en');
});

test('importing leaves the original preference in place and placeholders preserve user input verbatim', async t => {
  const {i18n,storage} = await session(t);
  i18n.setLanguagePacks([pack]);
  assert.equal(i18n.getLanguage(), 'ru');
  assert.equal(i18n.setLanguage('pt-br'), true);
  assert.equal(storage.get(preferenceKey), 'pt-BR');
  assert.equal(i18n.tr('Переместить {note} в {area}', 'Move {note} to {area}',
    {note:'{area} & $&',area:'Projetos'}), 'Em Projetos, mover {area} & $&');
  assert.equal(i18n.tr('Удалить {id}?', 'Delete {id}?',{id:12}), 'Delete 12?');
  assert.throws(()=>i18n.setLanguagePacks([pack,{...pack,locale:'pt-BR',id:'other'}]));
  assert.equal(i18n.tr('Задача','Task'), 'Tarefa');
  assert.equal(i18n.setLanguage('ru'), true);
  assert.equal(i18n.tr('Переместить {note} в {area}', 'Move {note} to {area}',{note:'1',area:'2'}), 'Переместить 1 в 2');
});

test('language packs accept data-only manifests and standalone string dictionaries', () => {
  for (const overrides of [
    {locale:'en'}, {locale:'RU'}, {locale:'not_a_locale'}, {id:'bad id'}, {type:'view'}, {apiVersion:2},
    {name:'   '}, {description:[]}, {html:'<p>preview</p>'}, {script:'optional'}, {permissions:[]},
    {messages:{}}, {messages:[]}, {messages:{Task:{text:'Tarefa'}}}, {messages:{Task:''}},
    {messages:{'Move {note} to {area}':'Mover {note}'}}, {messages:{Task:'Tarefa {name}'}},
    {messages:{Task:'x'.repeat(16385)}}, {messages:{'Select folder':'Folder\0dialog'}},
  ]) assert.throws(()=>parseLanguagePack({...pack,...overrides}));
  const input = JSON.parse('{"__proto__":"proto text","constructor":"constructor text","Task":"Tarefa"}');
  const valid = parseLanguagePack({...pack,messages:input});
  assert.equal(valid.locale, 'pt-BR');
  assert.deepEqual(Object.keys(valid.messages), ['__proto__','constructor','Task']);
  assert.equal(Object.getPrototypeOf(valid.messages), null);
  input.Task = 'Updated externally';
  assert.equal(valid.messages.Task, 'Tarefa');
});
