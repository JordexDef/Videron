// Two desktop clients, two private profiles and a real loopback Videron Sync server.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {buildDesktop,launchDesktop} from './windows-desktop.mjs';

if(process.platform!=='win32')throw Error('Windows and WebView2 are required.');
const repo=fileURLToPath(new URL('../../',import.meta.url));
const temp=await realpath(os.tmpdir()), dir=await mkdtemp(path.join(temp,'videron-sync-audit-'));
const started=new Date().toISOString(),report=process.argv[2];
const result={id:'workspace.live-sync-undo',area:'workspace',engine:'webview2',status:'fail'};
const conflict={id:'workspace.live-conflict-undo',area:'workspace',engine:'webview2',status:'not-run'};
const paragraphHistory={id:'workspace.live-peer-paragraph-undo',area:'workspace',engine:'webview2',status:'not-run'};
const clients=[],errors=[],password=randomUUID();
let server,resumeServer;
const button=(p,name)=>p.getByRole('button',{name,exact:true});
const field=p=>p.locator('.ve-content .ve-text').first();
const note=(id,title,text)=>({id,title,plain:text,body:[{type:'paragraph',runs:[{text}]}],x:id==='draft'?0:240,y:0,links:[],tags:[],pinned:true});

async function startServer(){
  const reservation=net.createServer();
  reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const exe=path.join(dir,'Sync.exe'),store=path.join(dir,'server'),address='127.0.0.1:'+port;
  execFileSync('go',['build','-o',exe,'./cmd/videron-sync'],{cwd:repo,windowsHide:true});
  execFileSync(exe,['-set-password','-data',store],{input:password+'\n',stdio:['pipe','ignore','pipe'],windowsHide:true});
  resumeServer=async()=>{
    server=spawn(exe,['-listen',address,'-data',store],{windowsHide:true,stdio:'ignore'});
    for(let i=0;i<100;i++){
      assert.equal(server.exitCode,null,'Loopback server exited during startup');
      const socket=net.connect(port,'127.0.0.1');
      try{await once(socket,'connect');return}
      catch{await delay(50)}finally{socket.destroy()}
    }
    throw Error('Loopback server did not start');
  };
  await resumeServer();return address;
}
async function stopServer(){
  if(!server || server.exitCode!==null || server.signalCode!==null)return;
  const exit=once(server,'exit');server.kill();await exit;
}

async function client(exe,name){
  const root=path.join(dir,name),folder=path.join(root,'working');
  const config=path.join(root,'roaming','Videron');
  await mkdir(config,{recursive:true});await mkdir(folder);
  const catalog={version:3,active:'personal',spaces:{
    personal:{areas:[],notes:[note('draft','Private control','Only in Personal')]},
    shared:{name:'Shared QA',folder,encrypted:false}
  },plugins:[],view:{manualLayout:true}};
  await writeFile(path.join(config,'workspace.json'),JSON.stringify(catalog));
  const instance=await launchDesktop(exe,root,errors);
  clients.push(instance);
  await instance.page.locator('#language-select').selectOption('en');
  await instance.page.getByRole('treeitem',{name:'Private control',exact:true}).waitFor();
  return {...instance,root,folder};
}
async function toggleProject(page,shared){
  await page.locator('#workspace-switch').click();
  const menu=page.getByRole('menuitemradio');
  const target=shared?menu.filter({hasNotText:/Personal|Demo map/}):page.getByRole('menuitemradio',{name:'Personal',exact:true});
  await target.click();
  await page.locator('.tree-note-link[data-note-id="draft"]').filter({hasText:shared?'Draft':'Private control'}).waitFor();
}
async function open(page,title){
  await page.getByRole('treeitem',{name:title,exact:true}).click();
  await field(page).waitFor();
}
async function back(page){
  await button(page,'Back to map').click();
  await field(page).waitFor({state:'hidden'});
}
async function expectText(page,text){
  await page.waitForFunction(wanted=>document.querySelector('.ve-content .ve-text')?.innerText===wanted,text,{timeout:10000});
}
async function findOnPeer(page,word,expected='Notes found · 1'){
  await page.locator('#search').click();
  const query=page.getByPlaceholder('Title, text, or #tag');
  await query.fill(word);
  await page.getByText(expected,{exact:true}).waitFor({timeout:40000});
  await query.press('Escape');
}
async function join({page,folder},address){
  await page.evaluate(async({folder,address,password})=>{
    const api=window.go.main.App;
    const {ticket}=await api.VerifySyncServer(address,password);
    await api.JoinSpaceServer(ticket,folder);
  },{folder,address,password});
}
const suffix=' — written on A',remoteName='Neighbour edited on B';
async function exercise(){
  const exe=await buildDesktop(dir),address=await startServer();
  const a=await client(exe,'A'),b=await client(exe,'B');
  const log=note('log','Shared log','Alpha\nBeta');
  log.body=['Alpha','Beta'].map(text=>({type:'paragraph',runs:[{text}]}));log.y=240;
  const space={name:'Shared QA',areas:[],notes:[note('draft','Draft','Starting line'),note('other','Neighbour','Original neighbour'),log]};
  await a.page.evaluate(async({folder,address,password,space})=>{
    const api=window.go.main.App;
    await api.CreateFolderSpace(folder,JSON.stringify(space),'');
    const {ticket}=await api.VerifySyncServer(address,password);
    await api.ConnectSpaceServer(folder,ticket);
    await api.CloseFolderSpace(folder);
  },{folder:a.folder,address,password,space});
  await join(b,address);
  await toggleProject(a.page,true);await toggleProject(b.page,true);
  await open(a.page,'Draft');await open(b.page,'Neighbour');
  await field(a.page).press('End');await a.page.keyboard.insertText(suffix);
  await expectText(a.page,'Starting line'+suffix);
  await b.page.locator('.ve-title').fill(remoteName);
  await back(b.page);
  // The sidebar remains mounted behind the editor. Wait for the real server watch
  // and merge to update it, without injecting a sync event or closing the draft.
  await a.page.waitForFunction(name=>document.querySelector('.tree-note-link[data-note-id="other"]')?.textContent.includes(name),remoteName,{timeout:40000});
  assert.equal(await a.page.locator('dialog[open]').count(),0);
  await field(a.page).press('Control+z');await expectText(a.page,'Starting line');
  await field(a.page).press('Control+Shift+z');await expectText(a.page,'Starting line'+suffix);
  await back(a.page);
  await toggleProject(a.page,false);await open(a.page,'Private control');
  await field(a.page).press('Control+z');await expectText(a.page,'Only in Personal');await back(a.page);
  await toggleProject(a.page,true);await open(a.page,'Draft');
  await field(a.page).press('Control+z');await expectText(a.page,'Starting line');
  await back(a.page);await open(a.page,'Draft');
  await field(a.page).press('Control+Shift+z');await expectText(a.page,'Starting line'+suffix);
  await back(a.page);
  await findOnPeer(b.page,'written on A');
  await open(b.page,'Draft');await expectText(b.page,'Starting line'+suffix);
  await back(b.page);
  // Joining starts with the published base. Wait for the GUI to apply subsequent heads.
  const cold=await client(exe,'clean-download');
  await join(cold,address);await toggleProject(cold.page,true);
  await cold.page.getByRole('treeitem',{name:remoteName,exact:true}).waitFor({timeout:40000});
  await findOnPeer(cold.page,'written on A');
  await open(cold.page,'Draft');await expectText(cold.page,'Starting line'+suffix);
  await cold.stop();
  await a.stop();
  const restarted=await launchDesktop(exe,a.root,errors);clients.push(restarted);
  await restarted.page.getByRole('treeitem',{name:remoteName,exact:true}).waitFor();
  await open(restarted.page,'Draft');
  await field(restarted.page).press('Control+z');
  await expectText(restarted.page,'Starting line'+suffix);
  assert.deepEqual(errors,[]);
  return {a:restarted.page,b:b.page};
}
async function exerciseConflict({a,b}){
  const base='Starting line'+suffix,local=' | offline A',remote=' | offline B',last=' | before closing';
  await stopServer();
  await open(b,'Draft');
  await field(a).press('End');await a.keyboard.insertText(local);
  await field(b).press('End');await b.keyboard.insertText(remote);
  await back(b);
  await expectText(a,base+local);
  await resumeServer();
  await a.waitForFunction(()=>{const b=document.querySelector('#sync-review');return b&&!b.hidden&&b.textContent==='Compare versions'},null,{timeout:65000});
  await field(a).press('Control+z');await expectText(a,base);
  await field(a).press('Control+Shift+z');await expectText(a,base+local);
  await field(a).press('End');await a.keyboard.insertText(last);await back(a);
  const dialog=a.locator('dialog[open]').filter({has:a.getByRole('region',{name:'This computer'})});
  async function checkVersions(){
    await dialog.waitFor({timeout:40000});
    assert((await dialog.getByRole('region',{name:'This computer'}).innerText()).includes(base+local+last));
    assert((await dialog.getByRole('region',{name:'From the shared space'}).innerText()).includes(base+remote));
  }
  await checkVersions();await button(dialog,'Later').click();
  await toggleProject(a,false);await toggleProject(a,true);
  await checkVersions();
  await dialog.locator('input[value=local]').check();await button(dialog,'Apply choices').click();
  await dialog.waitFor({state:'hidden'});
  await open(a,'Draft');
  await field(a).press('Control+z');await expectText(a,base+local);
  await field(a).press('Control+Shift+z');await expectText(a,base+local+last);
  await back(a);
  // B can already be reviewing the competing version. An accepted descendant
  // supersedes that dialog; B must retain the decision without a second choice.
  await b.locator('dialog[open]').waitFor({state:'hidden',timeout:45000});
  await findOnPeer(b,'before closing');
  await open(b,'Draft');await expectText(b,base+local+last);
  assert.deepEqual(errors,[]);
}
async function exercisePeerParagraph({a,b}){
  const rows=p=>p.locator('.ve-content .ve-text');
  const first='Alpha — edit by A',second='Beta — edit by B',overlap='First line replaced by B';
  await back(b);
  await open(a,'Shared log');await rows(a).first().press('End');await a.keyboard.insertText(' — edit by A');
  await back(a);await toggleProject(a,false);
  await findOnPeer(b,'edit by A');
  await open(b,'Shared log');await rows(b).nth(1).press('End');await b.keyboard.insertText(' — edit by B');
  await back(b);await toggleProject(a,true);await findOnPeer(a,'edit by B');
  await open(a,'Shared log');
  assert.deepEqual(await rows(a).allTextContents(),[first,second]);
  await rows(a).first().press('Control+z');
  assert.deepEqual(await rows(a).allTextContents(),['Alpha',second]);
  await back(a);
  await findOnPeer(b,'edit by A','No matches');
  await open(b,'Shared log');assert.deepEqual(await rows(b).allTextContents(),['Alpha',second]);await back(b);
  await open(a,'Shared log');await rows(a).first().press('Control+Shift+z');
  assert.deepEqual(await rows(a).allTextContents(),[first,second]);await back(a);await toggleProject(a,false);
  await findOnPeer(b,'edit by A');
  await open(b,'Shared log');await rows(b).first().fill(overlap);await back(b);
  await toggleProject(a,true);await findOnPeer(a,overlap);await open(a,'Shared log');
  for(const command of ['Control+z','Control+Shift+z']){
    await rows(a).first().press(command);
    assert.deepEqual(await rows(a).allTextContents(),[overlap,second]);
  }
  await back(a);await open(b,'Shared log');assert.deepEqual(await rows(b).allTextContents(),[overlap,second]);
  assert.deepEqual(errors,[]);
}
let running=result;
try{
  const peers=await exercise();
  result.status='pass';
  result.note='Two Windows desktop clients synchronized through a loopback HTTPS server. Undo survived a project switch and redo survived reopening. A fresh process started with empty history and the saved text. A clean download received both edits.';
  running=conflict;conflict.status='fail';
  await exerciseConflict(peers);
  conflict.status='pass';
  conflict.note='The clients edited the same paragraph offline. Both versions survived deferral and a project switch. Open-editor undo/redo affected local input. The peer received the chosen version including the final words typed before closing.';
  running=paragraphHistory;paragraphHistory.status='fail';
  await exercisePeerParagraph(peers);
  paragraphHistory.status='pass';
  paragraphHistory.note='B changed another paragraph in the same note while A was in another project. Undo on A removed its earlier edit while preserving B’s paragraph, and the result reached B. A later replacement of A’s text by B survived both undo and redo.';
}catch(e){running.reason=String(e.stack||e).replaceAll(dir,'[private test profile]').replaceAll(password,'[test password]');process.exitCode=1}
finally{
  for(const app of clients.reverse())await app.stop();
  await stopServer();
  const resolved=await realpath(dir);
  assert.equal(path.dirname(resolved),temp);assert(path.basename(resolved).startsWith('videron-sync-audit-'));
  await rm(resolved,{recursive:true,force:true,maxRetries:25,retryDelay:400});
}
if(report){
  await mkdir(path.dirname(path.resolve(report)),{recursive:true});
  await writeFile(report,JSON.stringify({started,catalog:[],results:[result,conflict,paragraphHistory]},null,2)+'\n');
}
for(const row of [result,conflict,paragraphHistory])console.log(row.status,row.id,row.reason??row.note??'');
