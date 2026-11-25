import assert from 'node:assert/strict';

// A scripted desktop peer makes it possible to type while a prepared merge
// is still unacknowledged. The UI's save queue, patches, undo and merge
// application are real. This fixture models only the rows these scenarios use.
export async function scriptedPeer(page,draftFields={}) {
  const folder='/qa/shared';
  const note=(id,title,text)=>({id,title,plain:text,bodyVersion:1,
    body:[{type:'paragraph',runs:[{text}]}],tags:[],links:[],pinned:true,x:id==='draft'?0:240,y:0});
  const shared={name:'Shared',areas:[],notes:[note('draft','Draft','Base'),note('peer','Neighbour','Peer base')]};
  Object.assign(shared.notes[0],draftFields);
  let library={version:3,active:'shared',spaces:{
    shared:{name:'Shared',folder,encrypted:false},
    other:{name:'Other',notes:[note('draft','Draft in Other','Other project')],areas:[]}
  },view:{manualLayout:true}};
  let version=1,incoming=null,hold=null;
  async function gate(method){
    if(hold?.method!==method)return;
    const pending=hold;
    hold=null;
    pending.started.resolve();
    await pending.gate.promise;
  }
  const byId=id=>shared.notes.find(n=>n.id===id);
  const bridge={
    Load:()=>JSON.stringify(library), Save:raw=>{library=JSON.parse(raw)},
    IsProjectProtected:()=>false, TakeResumeNote:()=>'',
    InspectSpaceFolder:()=>({folder,exists:true,encrypted:false}),
    OpenFolderSpace:()=>JSON.stringify(shared), CloseFolderSpace:()=>{}, ServerConnection:()=>null,
    FolderPatchRevision:()=>String(version),
    SaveFolderPatch:(_,head,raw)=>{
      if(head!==String(version))throw Error('VD_CHANGED');
      const patch=JSON.parse(raw);
      for(const [key,value] of Object.entries(patch)){
        if(key==='set'){Object.assign(shared,value);continue}
        assert.equal(key,'notes','unexpected fixture collection');
        assert.deepEqual(Object.keys(value),['edit']);
        for(const change of value.edit){
          Object.assign(byId(change.id),change.set);
          for(const field of change.unset||[])delete byId(change.id)[field];
        }
      }
      return String(++version);
    },
    // The frontend uses PollFolderSpace to detect sync support and selects the
    // prepared bridge when both commit and prepare methods are available.
    PollFolderSpace:()=>{throw Error('Expected the prepared merge path')},
    PrepareFolderMerge:async(_,force,knownToken)=>{
      if(!incoming)return {token:''};
      const {id,remote,base}=incoming,local=byId(id);
      const token=String(version)+':peer';
      if(token===knownToken)return {token};
      const conflicts=local.plain===base?[]:[{kind:'note',key:'note:'+id,id,local,remote}];
      const reply=structuredClone({token,prepared:true,conflicts,changedNotes:conflicts.length?[]:[id]});
      await gate('prepare');
      return reply;
    },
    CommitFolderMergeChoices:async(_,token,choices)=>{
      if(!incoming || token!==String(version)+':peer')throw Error('VD_CHANGED');
      const {id,remote,base}=incoming;
      if(byId(id).plain!==base)assert.ok(['local','remote'].includes(choices['note:'+id]),'missing conflict choice');
      const usePeer=choices['note:'+id]!=='local';
      if(usePeer)Object.assign(byId(id),remote);
      incoming=null;
      const reply=structuredClone({head:String(++version),lists:usePeer?{notes:{upsert:[byId(id)]}}:{}});
      await gate('commit');
      return reply;
    }
  };
  await page.exposeFunction('qaWorkspaceCall',(name,args)=>bridge[name](...args));
  await page.addInitScript(names=>{
    window.go={main:{App:Object.fromEntries(names.map(n=>[n,(...args)=>window.qaWorkspaceCall(n,args)]))}};
  },Object.keys(bridge));
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#space-name')?.textContent==='Shared');
  async function publishFields(id,base,fields){
    incoming={id,base,remote:{...structuredClone(byId(id)),...fields}};
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  }
  return {
    text:id=>byId(id).plain,
    record:id=>structuredClone(byId(id)),
    publishFields,
    publish:(id,base,text)=>publishFields(id,base,{plain:text,body:[{type:'paragraph',runs:[{text}]}]}),
    hold(method){
      const latch=Promise.withResolvers(),started=Promise.withResolvers();
      hold={method,gate:latch,started};
      return {async wait(){
        let timeout;
        try{await Promise.race([started.promise,new Promise((_,reject)=>{
          timeout=setTimeout(()=>reject(Error('No '+method+' call arrived')),6000);
        })])}finally{clearTimeout(timeout)}
      },release:latch.resolve};
    }
  };
}

const paragraphs=page=>page.locator('.ve-content .ve-text');
const back=page=>page.getByRole('button',{name:'Back to map',exact:true}).click();
async function switchTo(page,name){
  await page.locator('#workspace-switch').click();
  await page.getByRole('menuitemradio',{name,exact:true}).click();
  await page.waitForFunction(n=>document.querySelector('#space-name').textContent===n,name);
}
async function append(page,text){
  await paragraphs(page).last().press('End');
  await page.keyboard.insertText(text);
}
async function saved(peer,id,value){
  const end=Date.now()+6000;
  while(peer.text(id)!==value && Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(peer.text(id),value,'Expected the local save to record the text');
}
async function openSavedDraft(ctx,peer){
  const {page,openNote,primary}=ctx;
  await openNote('draft');
  await append(page,' local');
  await page.keyboard.press(primary+'+s');
  await saved(peer,'draft','Base local');
}
async function assertUndo(ctx,text){
  const {page,primary}=ctx;
  await paragraphs(page).first().click();
  await page.keyboard.press(primary+'+z');
  assert.equal((await paragraphs(page).allTextContents()).join('\n'),text);
}

export const syncCases={
  async 'workspace.identical-text-isolated-history'(ctx){
    const {page,primary,openNote}=ctx;
    await scriptedPeer(page);
    const replace=async(id)=>{
      await openNote(id);await paragraphs(page).first().fill('Same final text');await back(page);
    };
    await replace('draft');await replace('peer');
    await switchTo(page,'Other');await replace('draft');
    await switchTo(page,'Shared');await openNote('draft');await assertUndo(ctx,'Base');await back(page);
    await openNote('peer');await assertUndo(ctx,'Peer base');await back(page);
    await switchTo(page,'Other');await openNote('draft');await assertUndo(ctx,'Other project');await back(page);
    await switchTo(page,'Shared');await openNote('draft');
    await paragraphs(page).first().press(primary+'+Shift+z');
    assert.equal(await paragraphs(page).first().innerText(),'Same final text');
  },
  async 'workspace.switch-with-response-pending'(ctx){
    const {page,openNote}=ctx,peer=await scriptedPeer(page);
    await openSavedDraft(ctx,peer);
    const pending=peer.hold('prepare');
    await peer.publish('peer','Peer base','Peer text during switch');
    try{
      await pending.wait();
      await back(page);
      await page.locator('#workspace-switch').click();
      await page.getByRole('menuitemradio',{name:'Other',exact:true}).click();
      // changeSpace has taken ownership of the switch and is waiting for the poll.
      await page.waitForFunction(()=>document.querySelector('#shell').inert);
      assert.equal(await page.locator('#space-name').innerText(),'Shared');
    }finally{pending.release()}
    await page.waitForFunction(()=>document.querySelector('#space-name').textContent==='Other');
    await openNote('draft');
    await assertUndo(ctx,'Other project');
    await back(page);
    await switchTo(page,'Shared');
    await saved(peer,'peer','Peer text during switch');
    await openNote('peer');
    await assertUndo(ctx,'Peer text during switch');
    await back(page);
    await openNote('draft');
    await assertUndo(ctx,'Base');
    await back(page);await openNote('draft');
    await paragraphs(page).first().press(ctx.primary+'+Shift+z');
    assert.equal(await paragraphs(page).first().innerText(),'Base local');
  },
  async 'workspace.typing-during-merge'(ctx){
    const {page,primary,openNote}=ctx,peer=await scriptedPeer(page);
    await openSavedDraft(ctx,peer);
    const pending=peer.hold('commit');
    await peer.publish('peer','Peer base','From another computer');
    try{
      await pending.wait();
      await paragraphs(page).first().press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.insertText('In flight');
      await page.keyboard.press(primary+'+z');
      assert.deepEqual((await paragraphs(page).allTextContents()).map(t=>t.trim()),['Base local','']);
      await page.keyboard.press(primary+'+Shift+z');
      assert.deepEqual(await paragraphs(page).allTextContents(),['Base local','In flight']);
    }finally{pending.release()}
    await saved(peer,'peer','From another computer');
    await back(page);
    await switchTo(page,'Other');
    await openNote('draft');
    await assertUndo(ctx,'Other project');
    await back(page);
    await switchTo(page,'Shared');
    await openNote('draft');
    await assertUndo(ctx,'Base local\n');
    await page.keyboard.press(primary+'+Shift+z');
    assert.deepEqual(await paragraphs(page).allTextContents(),['Base local','In flight']);
    assert.equal(peer.text('draft'),'Base local\nIn flight');
    await back(page);
    await openNote('peer');
    await assertUndo(ctx,'From another computer');
  },
  async 'workspace.defer-conflict-switch'(ctx){
    const {page,primary,openNote}=ctx,peer=await scriptedPeer(page);
    const remote='Base local final — chosen on B';
    await openSavedDraft(ctx,peer);
    await peer.publish('draft','Base',remote);
    await page.waitForFunction(()=>document.querySelector('#sync-review')?.textContent==='Compare versions');
    assert.equal(await page.locator('.workspace-conflicts').count(),0);
    await page.keyboard.press(primary+'+z');
    assert.equal(await paragraphs(page).first().innerText(),'Base');
    await page.keyboard.press(primary+'+Shift+z');
    await append(page,' final');
    await back(page);
    const conflict=page.getByRole('dialog',{name:'Which version should be kept?'});
    async function verifyVersions(){
      await conflict.waitFor();
      assert.match(await conflict.getByRole('region',{name:'This computer'}).innerText(),/Base local final/);
      assert((await conflict.getByRole('region',{name:'From the shared space'}).innerText()).includes(remote));
    }
    await verifyVersions();
    await conflict.getByRole('button',{name:'Later'}).click();
    await switchTo(page,'Other');
    await openNote('draft');
    await assertUndo(ctx,'Other project');
    await back(page);
    await switchTo(page,'Shared');
    await verifyVersions();
    await conflict.locator('input[value=remote]').check();
    await conflict.getByRole('button',{name:'Apply choices'}).click();
    await openNote('draft');
    await assertUndo(ctx,remote);
    await page.keyboard.press(primary+'+Shift+z');
    assert.equal(await paragraphs(page).first().innerText(),remote);
    assert.equal(peer.text('draft'),remote);
  },
  async 'workspace.recheck-late-preview'(ctx){
    const {page,primary,openNote}=ctx,peer=await scriptedPeer(page);
    await openSavedDraft(ctx,peer);
    const pending=peer.hold('prepare');
    await peer.publish('draft','Base','Peer version');
    let second;
    try{
      await pending.wait();
      await append(page,' after request');
      await page.keyboard.press(primary+'+s');
      await saved(peer,'draft','Base local after request');
      second=peer.hold('prepare');
      pending.release();
      // The replacement proposal can itself go stale. Close the editor with
      // the second ack still paused so this time it will be shown on the map.
      await second.wait();
      await append(page,' and again');
      await page.keyboard.press(primary+'+s');
      await saved(peer,'draft','Base local after request and again');
      await back(page);
      await page.locator('.ve-title').waitFor({state:'hidden'});
    }finally{pending.release();second?.release()}
    const conflict=page.getByRole('dialog',{name:'Which version should be kept?'});
    await conflict.waitFor();
    assert.match(await conflict.getByRole('region',{name:'This computer'}).innerText(),/Base local after request and again/);
    await conflict.locator('input[value=local]').check();
    await conflict.getByRole('button',{name:'Apply choices'}).click();
    await switchTo(page,'Other');
    await switchTo(page,'Shared');
    await openNote('draft');
    const full='Base local after request and again';
    assert.equal(await paragraphs(page).first().innerText(),full);
    await paragraphs(page).first().press(primary+'+z');
    const undone=await paragraphs(page).first().innerText();
    assert(undone.startsWith('Base') && full.startsWith(undone) && undone!==full);
    await page.keyboard.press(primary+'+Shift+z');
    assert.equal(await paragraphs(page).first().innerText(),full);
  },
  async 'workspace.undo-after-peer-paragraph'(ctx){
    const {page,primary,openNote}=ctx,peer=await scriptedPeer(page);
    await openSavedDraft(ctx,peer);
    await back(page);await switchTo(page,'Other');
    const base='Base local',remote='Paragraph from B';
    const blocks=(...lines)=>lines.map(text=>({type:'paragraph',runs:[{text}]}));
    await peer.publishFields('draft',base,{plain:base+'\n'+remote,body:blocks(base,remote)});
    await switchTo(page,'Shared');await saved(peer,'draft',base+'\n'+remote);
    await openNote('draft');await assertUndo(ctx,'Base\n'+remote);
    await back(page);await openNote('draft');
    await paragraphs(page).first().press(primary+'+Shift+z');
    assert.deepEqual(await paragraphs(page).allTextContents(),[base,remote]);
    await back(page);await switchTo(page,'Other');
    const replacement='Peer replaced the entire first line';
    await peer.publishFields('draft',base+'\n'+remote,{plain:replacement+'\n'+remote,body:blocks(replacement,remote)});
    await switchTo(page,'Shared');await saved(peer,'draft',replacement+'\n'+remote);
    await openNote('draft');await assertUndo(ctx,replacement+'\n'+remote);
    await page.keyboard.press(primary+'+Shift+z');
    assert.deepEqual(await paragraphs(page).allTextContents(),[replacement,remote]);
    await back(page);await page.reload();await openNote('draft');
    await assertUndo(ctx,replacement+'\n'+remote);
  },
  async 'workspace.undo-after-peer-data-row'(ctx){
    const {page,primary,openNote}=ctx;
    const initial='key,value\na,1\nb,2';
    const peer=await scriptedPeer(page,{type:'data',body:[],plain:initial,dataText:initial,dataLanguage:'csv'});
    const read=async()=>(await page.locator('.cm-line').allTextContents()).join('\n');
    const cm=page.locator('.cm-content');
    const title=page.getByRole('textbox',{name:'Note title',exact:true});
    const end=primary==='Meta'?'Meta+ArrowRight':'End';
    await openNote('draft');await page.locator('.cm-line').nth(1).click();await page.keyboard.press(end);
    await page.keyboard.insertText('0');
    const local='key,value\na,10\nb,2',combined='key,value\na,10\nb,20';
    assert.equal(await read(),local);
    await title.fill('Local data heading');
    await back(page);await switchTo(page,'Other');
    assert.equal(peer.record('draft').title,'Local data heading');
    await peer.publishFields('draft',local,{dataText:combined,plain:combined});
    await switchTo(page,'Shared');await saved(peer,'draft',combined);await openNote('draft');
    assert.equal(await title.inputValue(),'Local data heading');
    await title.press(primary+'+z');
    assert.equal(await title.inputValue(),'Draft');
    assert.equal(await read(),combined);
    await cm.press(primary+'+z');
    assert.equal(await read(),'key,value\na,1\nb,20');
    await back(page);await openNote('draft');await cm.press(primary+'+Shift+z');
    assert.equal(await read(),combined);
    await cm.press(primary+'+Shift+z');
    assert.equal(await title.inputValue(),'Local data heading');
    await back(page);await switchTo(page,'Other');
    const replaced='key,value\na,77\nb,20';
    await peer.publishFields('draft',combined,{dataText:replaced,plain:replaced});
    await switchTo(page,'Shared');await saved(peer,'draft',replaced);await openNote('draft');
    await cm.press(primary+'+z');
    assert.equal(await title.inputValue(),'Draft');
    for(const chord of [primary+'+z',primary+'+Shift+z']){
      await cm.press(chord);
      assert.equal(await read(),replaced);
    }
  },
  async 'workspace.undo-after-peer-shape'(ctx){
    const {page,primary,openNote}=ctx;
    const shape=(id,x)=>({id,x,y:0,w:70,h:55,type:'rect',fill:'#888888'});
    const peer=await scriptedPeer(page,{type:'canvas',body:[],plain:'',board:{version:1,elements:[shape('a',0),shape('b',160)]}});
    const item=id=>page.locator('.vb-object[data-id="'+id+'"]');
    const x=id=>item(id).evaluate(el=>parseFloat(el.style.left));
    const stage=page.locator('.vb-stage');
    async function remoteMove(id,value){
      const {board,plain}=peer.record('draft');
      const elements=board.elements.map(el=>el.id===id?{...el,x:value}:el);
      await peer.publishFields('draft',plain,{board:{...board,elements}});
      await switchTo(page,'Shared');
      const deadline=Date.now()+6000;
      while(peer.record('draft').board.elements.find(el=>el.id===id).x!==value && Date.now()<deadline)
        await new Promise(resolve=>setTimeout(resolve,25));
      await openNote('draft');assert.equal(await x(id),value);
    }
    await openNote('draft');await item('a').click();await page.keyboard.press('ArrowRight');
    const moved=await x('a');assert(moved>0);
    await back(page);await switchTo(page,'Other');
    await remoteMove('b',220);
    await stage.press(primary+'+z');assert.equal(await x('a'),0);assert.equal(await x('b'),220);
    await back(page);await openNote('draft');await stage.press(primary+'+Shift+z');
    assert.equal(await x('a'),moved);assert.equal(await x('b'),220);
    await back(page);await switchTo(page,'Other');
    await remoteMove('a',95);
    for(const chord of [primary+'+z',primary+'+Shift+z']){
      await stage.press(chord);
      assert.equal(await x('a'),95);assert.equal(await x('b'),220);
    }
  }
};
