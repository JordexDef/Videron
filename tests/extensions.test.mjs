import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkspace } from '../frontend/extensions.js';
import { readExtensionManifests, tagSpectrumId } from '../frontend/extension-manifest.js';
import { demoWorkspace, newLibrary, readLibrary, serializeLibrary, translateDemoSamples } from '../frontend/data.js';
import { getLanguage, setLanguage, setLanguagePacks } from '../frontend/i18n.js';

test('extensions can identify a data note without reading its document', () => {
  const note = {id:'raw',type:'data',title:'Log',dataLanguage:'json',
    get dataText(){throw new Error('Extension projection read the full data document')}};
  const [projected] = projectWorkspace({areas:[],notes:[note]}).notes;
  assert.equal(projected.type,'data');
  assert.ok(!Object.hasOwn(projected,'dataText'));
});

test('extensions receive only public note metadata and links to unprotected notes', () => {
  const original = {
    id:'one', title:'First', type:'canvas', appearance:{shape:'square', color:'#ABCDEF'},
    areaId:'shelf', tags:['#One', 'one', ''], links:['sealed-id', 'two', 'two'],
    x:11, y:22, weight:5, opens:3, pinned:true,
    get body() { throw new Error('Extension projection read a note body'); },
    plain:'private body'
  };
  const space = {
    areas:[{id:'shelf', name:'Shelf', color:'#888888', other:'private area data'}],
    notes:[original, {id:'sealed-id', sealed:'private envelope'}, {id:'two', title:'Second'}]
  };
  const data = projectWorkspace(space);
  assert.equal(data.type, 'videron:data');
  assert.equal(data.apiVersion, 1);
  assert.deepEqual(data.notes.map(n => n.id), ['one','two']);
  assert.deepEqual(data.notes[0], {
    id:'one', title:'First', type:'canvas', appearance:{shape:'square', icon:null, color:'#abcdef'},
    areaId:'shelf', tags:['one'], links:['two'], x:11, y:22, weight:5, opens:3, pinned:true
  });
  assert.deepEqual(data.areas, [{id:'shelf', name:'Shelf', color:'#888888', parentId:null}]);
  assert.deepEqual(original.links, ['sealed-id', 'two', 'two']);
  assert.doesNotMatch(JSON.stringify(data), /private|sealed-id/);
});

const view = {apiVersion:1,id:'custom.stats',name:'Statistics',html:'<p>Notes</p>'};
const pack = {apiVersion:1,type:'language',id:'example.pt',name:'Português',locale:'pt-br',messages:{'New note':'Nova nota'}};

test('views and language packs share the installer and have separate catalog records', () => {
  const [installedView, installedPack] = readExtensionManifests([view,pack]);
  assert.equal(installedView.html,view.html);
  assert.equal(installedPack.locale,'pt-BR');
  assert.equal(Object.hasOwn(installedPack,'html'),false);
  const lib = {...newLibrary(),plugins:[installedView],languagePacks:[installedPack]};
  const raw = serializeLibrary(lib);
  assert.deepEqual(readLibrary(raw).languagePacks,[installedPack]);
  assert.deepEqual(readLibrary(raw).plugins,[installedView]);
  assert.equal(readLibrary(serializeLibrary({...newLibrary(),plugins:[view]})).languagePacks,undefined);
  assert.throws(()=>readLibrary(JSON.stringify({...lib,languagePacks:[view]})));
  assert.throws(()=>readLibrary(JSON.stringify({...lib,languagePacks:[{...pack,html:'<p>unrelated view</p>'}]})));
  assert.throws(()=>readLibrary(JSON.stringify({...lib,plugins:[{...pack,html:'<p>unrelated view</p>'}]})));
  assert.throws(()=>readLibrary(JSON.stringify({...lib,languagePacks:[{...pack,id:view.id}]})));
});

test('installation rejects duplicate IDs, canonical locale tags and built-in language overrides', () => {
  assert.throws(()=>readExtensionManifests([{...pack,id:tagSpectrumId}]));
  assert.throws(()=>readExtensionManifests([{...view,id:pack.id.toUpperCase()}],[pack]));
  assert.throws(()=>readExtensionManifests([pack,{...pack,id:'other',locale:'pt-BR'}]));
  for (const locale of ['RU','en']) assert.throws(()=>readExtensionManifests([{...pack,locale}]));
});

test('a third interface language reaches views and uses the English sample map', () => {
  const previous = getLanguage();
  try {
    setLanguage('ru');
    const demo = demoWorkspace();
    demo.notes[1].title = 'Моя запись';
    setLanguagePacks([pack]);
    setLanguage('pt-BR');
    assert.equal(projectWorkspace({areas:[],notes:[]}).language,'pt-BR');
    assert.equal(demoWorkspace().notes[0].title,'Atlas of shapes');
    assert.equal(translateDemoSamples(demo),true);
    assert.equal(demo.notes[0].title,'Atlas of shapes');
    assert.equal(demo.notes[1].title,'Моя запись');
    assert.equal(translateDemoSamples(demo),false);
  } finally {
    setLanguage(previous);
    setLanguagePacks([]);
  }
});
