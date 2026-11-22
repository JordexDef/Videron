import test from 'node:test'
import assert from 'node:assert/strict'
import {newLibrary, readLibrary, serializeLibrary} from '../frontend/data.js'
import {CatalogRecords} from '../frontend/catalog-records.js'
import {WorkspaceRecords} from '../frontend/workspace-records.js'

const note=id=>({id,title:id,body:[],plain:'',tags:[],links:[]})
const library=()=>({...newLibrary(),spaces:{personal:{notes:[note('a'),note('b')],areas:[]}}})
const draftValue=tx=>JSON.parse(JSON.stringify(tx.patch))

test('editing one title neither reads nor transfers another note or plugin',()=>{
  const live=library(), [a,b]=live.spaces.personal.notes;
  live.plugins=[{html:'large plugin'}];
  const tracker=new CatalogRecords(live,live);
  Object.defineProperty(b,'body',{enumerable:true,get(){throw Error('unrelated record read')}});
  Object.defineProperty(live.plugins[0],'html',{enumerable:true,get(){throw Error('unrelated setting read')}});
  a.title='new';
  tracker.markSpace('personal',{notes:[a]});
  const tx=tracker.prepare(live);
  assert.deepEqual(draftValue(tx),{spaces:{personal:{notes:{edit:[{id:a.id,set:{title:a.title}}]}}}});
  tx.commit();
  assert.equal(tracker.prepare(live).patch,null);
  live.view.labels=false;
  tracker.markSettings(['view']);
  assert.deepEqual(draftValue(tracker.prepare(live)),{set:{view:live.view}});
});

test('one title edit in 5,000 one-KiB notes transfers only the changed field',t=>{
  const live=newLibrary(), text='x'.repeat(1024);
  live.spaces.personal.notes=Array.from({length:5000},(_,i)=>({
    ...note('n'+i),title:'Example '+i,bodyVersion:1,body:[{type:'paragraph',runs:[{text}]}],plain:text,
    pinned:true,opens:0,x:i%100*130,y:Math.floor(i/100)*130,areaId:null,weight:1024,modified:1,created:1
  }));
  const tracker=new CatalogRecords(live,live), edited=live.spaces.personal.notes[1245];
  edited.title+='!';
  tracker.markSpace('personal',{notes:[edited]});
  const tx=tracker.prepare(live);
  const full=Buffer.byteLength(serializeLibrary(live)), changed=Buffer.byteLength(JSON.stringify(tx.patch));
  assert.deepEqual(tx.patch.spaces.personal.notes.edit.map(n=>n.id),[edited.id]);
  assert.ok(full>11_000_000 && changed<130,`full=${full} changed=${changed}`);
  t.diagnostic(`UTF-8 JSON bytes: full library ${full}, one-note patch ${changed}`);
});

test('a million-line data note sends only the edited text and uses the acknowledged baseline',t=>{
  const original='item,1\n'.repeat(1_000_000);
  const row={...note('csv'),type:'data',dataText:original};
  const space={notes:[row],areas:[]}, records=new WorkspaceRecords(space);
  row.title='Renamed';records.mark({notes:[row]});
  let tx=records.prepare(space);
  assert.deepEqual(draftValue(tx),{notes:{edit:[{id:'csv',set:{title:'Renamed'}}]}});
  tx.commit();
  const start=3_500_000;
  row.dataText=original.slice(0,start)+'😀'+original.slice(start+1);
  records.mark({notes:[row]});
  const pending=records.prepare(space);
  row.dataText=row.dataText.replace('😀','😇');
  records.mark({notes:[row]});
  const size=Buffer.byteLength(JSON.stringify(pending.patch));
  assert.ok(size<130);
  assert.deepEqual(pending.patch.notes.edit[0].textSplice,{start,remove:1,insert:'😀'});
  pending.commit();
  tx=records.prepare(space);
  assert.deepEqual(tx.patch.notes.edit[0].textSplice,{start,remove:2,insert:'😇'});
  tx.commit();
  row.dataText='\ud800'+row.dataText;records.mark({notes:[row]});
  assert.equal(records.prepare(space).patch.notes.edit[0].set.dataText,row.dataText);
  t.diagnostic(`UTF-8 JSON bytes: source ${Buffer.byteLength(original)}, one edit ${size}`);
});

test('an acknowledged immutable snapshot preserves edits made while saving and failed prepares do not advance the baseline',()=>{
  const live=library(), space=live.spaces.personal, a=space.notes[0];
  const records=new WorkspaceRecords(space);
  a.title='first';records.mark({notes:[a]});
  const saving=records.prepare(space);
  a.title='second';records.mark({notes:[a]});
  assert.equal(saving.patch.notes.edit[0].set.title,'first');
  saving.commit();
  const failed=records.prepare(space);
  assert.equal(failed.patch.notes.edit[0].set.title,'second');
  const retry=records.prepare(space);
  assert.deepEqual(retry.patch,failed.patch);
  retry.commit();
  assert.equal(records.prepare(space).patch,null);
});

test('extension text on an area remains an ordinary field',()=>{
  const area={id:'legacy',dataText:'x'.repeat(8192)};
  const space={notes:[],areas:[area]}, records=new WorkspaceRecords(space);
  area.dataText+='y';records.mark({areas:[area]});
  assert.deepEqual(draftValue(records.prepare(space)),{areas:{edit:[{id:'legacy',set:{dataText:area.dataText}}]}});
});

test('structural changes preserve record order, folder link privacy and legacy format versions',()=>{
  const live=library(), tracker=new CatalogRecords(live,live), space=live.spaces.personal;
  const [a,b]=space.notes;
  a.sealed='ciphertext';a.title='';tracker.markSpace('personal',{notes:[a]});
  let tx=tracker.prepare(live);assert.equal(tx.patch.set.version,2);tx.commit();
  space.notes=[b,note('c')];
  space.notes.reverse();tracker.markSpace('personal');
  tx=tracker.prepare(live);
  assert.deepEqual(draftValue(tx),{set:{version:1},spaces:{personal:{notes:{put:[space.notes[0]],remove:['a'],order:['c','b']}}}});
  tx.commit();
  const link={folder:'/test',name:'Work',encrypted:true};
  const next={...live,active:'w',spaces:{...live.spaces,w:{...link,notes:[note('never on disk')]}}};
  tx=tracker.prepare(next);
  assert.deepEqual(draftValue(tx),{set:{active:'w',version:3},spaces:{w:{replace:link}}});tx.commit();
  tx=tracker.prepare(live);assert.deepEqual(draftValue(tx),{set:{active:'personal',version:1},spaces:{w:{remove:true}}});
});

test('the initial comparison picks up legacy defaults and privacy normalization on load',()=>{
  const disk=library(), a=disk.spaces.personal.notes[0];
  a.title='';a.sealed='ciphertext';disk.version=2;
  disk.spaces.personal.routes=[{id:'route',stops:[{noteId:a.id,fragment:'private fragment'}]}];
  delete disk.view;delete disk.plugins;
  const live=readLibrary(JSON.stringify(disk)), tracker=new CatalogRecords(disk,live);
  tracker.markAll();
  const tx=tracker.prepare(live);
  assert.deepEqual(draftValue(tx),{set:{plugins:[],view:live.view},spaces:{personal:{set:{routes:live.spaces.personal.routes}}}});
  assert.equal(tx.patch.spaces.personal.set.routes[0].stops[0].fragment,null);
  tx.commit();assert.equal(tracker.prepare(live).patch,null);
  assert.equal(JSON.parse(serializeLibrary(live)).version,2);
});

test('adding a workspace preserves edits made before the new entry is acknowledged',()=>{
  const live=library(), tracker=new CatalogRecords(live,live);
  const added=note('new-note');
  live.spaces.work={name:'Work',notes:[added],areas:[]};
  const installing=tracker.prepare(live);
  added.title='edited during save';tracker.markSpace('work',{notes:[added]});
  installing.commit();
  assert.deepEqual(draftValue(tracker.prepare(live)),{spaces:{work:{notes:{edit:[{id:added.id,set:{title:added.title}}]}}}});
});

test('merge acknowledgements advance the disk baseline without swallowing later editor input',()=>{
  const live=library().spaces.personal,[a,b]=live.notes;
  const records=new WorkspaceRecords(live);
  a.title='typing';records.mark({notes:[a]});
  const incoming={...b,title:'remote'};
  records.acceptMerge({lists:{notes:{upsert:[incoming]},routes:{upsert:[{id:'r'}]}}});
  Object.assign(b,incoming);live.routes=[{id:'r'}];
  records.mark();
  const tx=records.prepare(live);
  assert.deepEqual(draftValue(tx),{notes:{edit:[{id:a.id,set:{title:a.title}}]}});
});
