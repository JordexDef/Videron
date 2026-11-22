import test from 'node:test'
import assert from 'node:assert/strict'
import { newLibrary, readLibrary, serializeLibrary } from '../frontend/data.js'
import { folderEntry, localFallback, readSpaceFolder, saveSpaceFolder } from '../frontend/workspace-storage.js'

const link={name:'Studio',folder:'D:/Cloud/Studio',encrypted:true}
const data={name:'Studio',notes:[],areas:[],routes:[]}

test('folder autosave retries the identical request before sending edits made since a lost reply',async()=>{
  const record={id:'note',title:'original',tags:[],links:[],body:[]};
  const calls=[];
  const bridge={OpenFolderSpace:async()=>JSON.stringify({...data,notes:[record]}),FolderPatchRevision:async()=>'first',
    async SaveFolderPatch(_folder,head,raw){
      calls.push([head,raw]);
      if(calls.length===1)throw new Error('lost reply');
      return calls.length===2?'second':'third';
    }};
  const session=await readSpaceFolder(bridge,{...link,encrypted:false,exists:true});
  assert.equal(await saveSpaceFolder(bridge,session),false);
  const live=session.data.notes[0];
  live.title='first edit';session.records.mark({notes:[live]});
  await assert.rejects(saveSpaceFolder(bridge,session),/lost reply/);
  live.title='second edit';session.records.mark({notes:[live]});
  assert.equal(await saveSpaceFolder(bridge,session),true);
  assert.deepEqual(calls[0],calls[1]);
  assert.equal(calls[2][0],'second');assert.equal(JSON.parse(calls[2][1]).notes.put[0].title,'second edit');
  assert.equal(session.head,'third');
});

test('catalog writes only the folder link and supports a library with no open space',()=>{
  const library={...newLibrary(),active:'s',spaces:{s:{...data,...link,privateText:'must stay off disk'}}}
  const catalog=readLibrary(serializeLibrary(library))
  assert.equal(catalog.version,3)
  assert.deepEqual(catalog.spaces.s,link)
  assert.equal(folderEntry(catalog.spaces,'d:/cloud/studio')[0],'s')
  assert.deepEqual(localFallback(catalog),{...catalog,active:''})
  const empty=readLibrary(serializeLibrary(localFallback({...catalog,spaces:{}})))
  assert.equal(empty.active,'')
  assert.deepEqual(empty.spaces,{})
  assert.throws(()=>readLibrary(JSON.stringify({...catalog,active:'missing'})))
  assert.throws(()=>readLibrary(JSON.stringify({...catalog,spaces:{s:{...link,notes:[]}}})))
})

test('save retries retain the last revision and folder payloads never flow into the catalog',async()=>{
  const info={...link,exists:true},saved=[]
  const bridge={OpenFolderSpace:async()=>JSON.stringify(data),async SaveFolderSpace(folder,raw){
    assert.equal(folder,link.folder)
    saved.push(raw)
    if(saved.length===1)throw Error('VD_WRITE')
  }}
  const session=await readSpaceFolder(bridge,info,async options=>{await options.onSubmit({password:'test passphrase'});return true},link)
  await saveSpaceFolder(bridge,session)
  assert.equal(saved.length,0)
  session.data.routes.push({id:'new route'})
  await assert.rejects(saveSpaceFolder(bridge,session),/VD_WRITE/)
  await saveSpaceFolder(bridge,session)
  assert.equal(saved[1],saved[0])
  await saveSpaceFolder(bridge,session)
  assert.equal(saved.length,2)
  assert.deepEqual(session.link,link)
})

test('a missing or downgraded encrypted folder is not silently reopened',async()=>{
  await assert.rejects(readSpaceFolder({}, {exists:false},null,link),/VD_SPACE_MISSING/)
  await assert.rejects(readSpaceFolder({}, {exists:true,encrypted:false},null,link),/VD_ENCRYPTION_CHANGED/)
})
