import { Graph } from './graph.js';
import { initTheme } from './theme.js';
import { createMapCameraMemory } from './map-camera-memory.js';
import { playNoteTransition, cancelNoteTransition } from './note-transition.js';
import { mountMapReading, readingFragments } from './map-reading.js';
import { mountMapRoutes } from './map-routes.js';
import { mountStageControls } from './stage-controls.js';
import { openStageRemoval } from './stage-removal.js';
import { resolveMapMetrics, openMetricPicker, drawAreaMetric, drawNoteMetric } from './map-metrics.js';
import { areaPath, createArea, moveArea, descendantAreaIds, placeAreaNotes, releaseGridNotes, moveAreaGrid } from './areas.js';
import { suggestGrid, slotAt } from './map-slots.js';
import { DEFAULT_GRID_SPACING, MAX_GRID_SPACING, MIN_GRID_SPACING, fullGridIds, gridRowSpacing, gridSpacing, inSlot, isPinned } from './area-grid.js';
import { rememberMapAction, lastMapAction, resizeGridWithHistory, reorderStageWithHistory, insertStageWithHistory, deleteStageWithHistory, deleteAreaWithHistory, undoMapAction } from './map-history.js';
import { areaPicker } from './area-picker.js';
import { mountAreaDrag } from './area-drag.js';
import { mountSidebarTree, sidebarRows } from './sidebar-tree.js';
import { openExtensions, dismissExtensions } from './extensions.js';
import { openAppearance } from './appearance.js';
import { paintIcons, icon, drawAtlas } from './art.js';
import { newLibrary, readLibrary, serializeLibrary, blankWorkspace, isFolderSpace, demoWorkspace, translateDemoSamples, createNote, colors, validSpaceName } from './data.js';
import { CatalogRecords } from './catalog-records.js';
import { spaceTitle, localFallback, folderEntry, readSpaceFolder, createSpaceFolder, saveSpaceFolder } from './workspace-storage.js';
import { createWorkspaceActivity } from './workspace-activity.js';
import { openCreateSpace, openSpaceManager } from './workspace-ui.js';
import { compareIncoming, commitIncoming, commitPreparedMerge, preservesOpenNote } from './workspace-reconcile.js';
import { openWorkspaceConflicts, dismissWorkspaceConflicts } from './workspace-conflicts.js';
import { openWorkspaceServer, dismissWorkspaceServer } from './workspace-server-ui.js';
import { rememberServerAddress } from './server-address.js';
import { createEditorSaveStatus, mountWorkspaceStatus } from './workspace-status.js';
import { bindStaticTranslations, getLanguage, getLanguages, setLanguage, setLanguagePacks, tr } from './i18n.js';
import { isMacPlatform, primaryCommand, shortcutLabel, shortcutAria } from './shortcuts.js';
import { deleteNotes } from './note-deletion.js';
import { isProtectedNote, protectedNoteTitle, openNoteSession } from './note-vault.js';
import { openVaultSettings, openVaultPassword, showVaultUnlock, interruptVaultDialogs } from './vault-ui.js';
import { createIdleLock, normalizeIdleMinutes } from './idle-lock.js';
import { showLockScreen } from './lock-screen.js';

const $ = id => document.getElementById(id);
const element = (tag, className, text) => {
  const el=document.createElement(tag);
  if(className)el.className=className;
  if(text!==undefined)el.textContent=text;
  return el;
};
const iconTemplates=new Map();
function iconEl(name){
  if(!iconTemplates.has(name)){
    const template=element('i');template.innerHTML=icon(name);iconTemplates.set(name,template);
  }
  return iconTemplates.get(name).cloneNode(true);
}
function iconButton(name,label,action){
  const b=element('button','icon-button');
  b.append(iconEl(name));b.title=label;b.setAttribute('aria-label',label);b.onclick=action;return b;
}
function button(text,action,style='secondary'){
  const b=element('button','button '+style,text);b.onclick=action;return b;
}
const noteTitle=n=>isProtectedNote(n)?protectedNoteTitle():n.title.trim()||tr('Без названия','Untitled');
let library=newLibrary(), page='map', currentArea=null, selected=null, editor=null, tool='select';
let graph, areaDrag, native, ready=false, revision=0, saved=0, pending=null, timer, dirtySince=0, toastTimer, popover=null;
let reading,routes,mapMetrics,routeCamera,stageControls;
let noteSession=null, openingNote=null, projectProtected=false, policyWrite=null;
let idle=null, lockScreen=null, locking=null, lockDuringStartup=false;
const storageKey='videron.library.v1';
const mapCameraMemory=createMapCameraMemory();
let folderSession=null,spaceOperation=null,catalogSnapshot=null,startupNotice='';
// Only IDs for the idle timer and lock button. Folder keys stay in the native process.
const suspendedSpaceIds=new Set();
let catalogRecords=null,catalogRevision=null,pendingCatalogPatch=null;
let folderPoll=null,editorMerge=null,notePrivacyChange=null,reviewing=false,syncTimer,closingApp=false;
const emptyMap=blankWorkspace();
const workspace=()=>folderSession?.data ?? library.spaces[library.active] ?? emptyMap;
function byId(id){
  if(id==null)return;
  const notes=workspace().notes,index=graph?.nodes.get(id)?.index;
  return notes[index]?.id===id?notes[index]:notes.find(n=>n.id===id);
}
const areaById=id=>workspace().areas.find(a=>a.id===id);
const gridRecords=id=>({areas:[areaById(id)],notes:workspace().notes.filter(note=>note.areaId===id)});
const showingMap=()=>page==='map';
function syncMapVisibility(){
  graph?.setVisible(showingMap() && !document.hidden && !editor && !lockScreen);
}
function rememberMapView(){
  // A route temporarily borrows the camera. Resume the overview it started from.
  if(ready && graph && !lockScreen)mapCameraMemory.remember(routeCamera ?? graph.target ?? graph.camera);
}
function saveMapView(){
  rememberMapView();
  mapCameraMemory.flush();
}
function restoreMapView(){
  const camera=mapCameraMemory.open(library.active);
  if(camera){
    graph.restoreCamera({...camera,zoom:Math.max(graph.minZoom,camera.zoom)});
  }else{
    graph.fit({readable:true});
    // A first visit should open already framed, even when switching from a distant map.
    if(graph.target)graph.restoreCamera(graph.target);
  }
}
const collapsedAreas=new Set(), listSelection=new Set();
let lastListId=null;
const translateStatic=bindStaticTranslations(document);
const spaceActivity=createWorkspaceActivity();
spaceActivity.classList.add('workspace-transition');
$('shell').after(spaceActivity);

function notify(message,action){
  const toast=$('toast');
  toast.replaceChildren(element('span','toast-message',message));
  if(action){
    const undo=element('button','toast-action',action.label);
    undo.type='button';undo.title=shortcutLabel(action.label+' (Ctrl+Z)');
    undo.onclick=action.run;toast.append(undo);
  }
  const schedule=()=>{
    clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>{
      if(!action||!toast.matches(':hover,:focus-within'))toast.hidden=true;
    },action?12000:4200);
  };
  toast.onpointerleave=toast.onfocusout=action?schedule:null;
  toast.hidden=false;schedule();
}
let storageState='local';
const storageIndicator=mountWorkspaceStatus({
  onManage:()=>{if(ready&&!lockScreen)void serverSettings()},
  onRetry:()=>syncNow(folderSession).catch(error=>notify(storageErrorMessage(error))),
  onRetrySave:()=>flush().catch(reportWriteError)
});
function status(state=storageState){
  storageState=state;
  if(state==='failed')editor?.saveStatus.failed();
  const session=folderSession, connection=session?.connection;
  const error=session?.serverError;
  let connectionState='local';
  if(error)connectionState=String(error?.message||error).split('|')[0]==='VD_SERVER_OFFLINE'?'offline':'error';
  else if(connection?.address){
    if(!session.serverOnline)connectionState='connecting';
    else connectionState=session.exchanging?'syncing':'online';
  }else if(session && connection===undefined && native?.ServerConnection)connectionState='checking';
  storageIndicator.update({
    state:connectionState,storageState:state,folder:session?.folder,encrypted:session?.encrypted,
    address:connection?.address,transport:connection?.transport,lastSync:session?.lastSync||connection?.lastSync,
    error:error?storageErrorMessage(error):'',canManage:ready&&!!native?.ConnectSpaceServer,
    spaceName:spaceTitle(library.active,session?.link??workspace()),serverProjectDeleted:!!session?.serverProjectDeleted
  });
}
function storageErrorMessage(error){
  const message=String(error?.message||error),[code,...parts]=message.split('|');
  const messages={
    VD_SERVER_CODE:tr('Проверьте код подключения, выданный Videron Sync.','Check the pairing code from Videron Sync.'),
    VD_SERVER_ADDRESS:tr('Проверьте адрес сервера и порт.','Check the server address and port.'),
    VD_SERVER_CERT:tr('Не удалось подтвердить подлинность сервера. Проверьте адрес и сертификат.','Could not verify the server’s identity. Check its address and certificate.'),
    VD_SERVER_AUTH:tr('Сервер отклонил данные для входа. Проверьте пароль или код подключения.','The server rejected the credentials. Check the password or pairing code.'),
    VD_SERVER_TICKET:tr('Введите пароль и проверьте подключение ещё раз.','Enter the password and check the connection again.'),
    VD_SERVER_RATE:tr('Слишком много попыток. Подождите и попробуйте ещё раз.','Too many attempts. Wait a moment and try again.'),
    VD_SERVER_PROTOCOL:tr('По этому адресу не найден совместимый сервер Videron Sync.','Could not find a compatible Videron Sync server at this address.'),
    VD_SERVER_OFFLINE:tr('Сервер недоступен. Проверьте адрес и подключение.','Server unavailable. Check the address and connection.'),
    VD_SERVER_SPACE:tr('В папке и на сервере разные пространства. Выберите папку с рабочей копией этого пространства или пустую папку.','The folder and the server contain different spaces. Choose a working copy of this space or an empty folder.'),
    VD_SERVER_EMPTY:tr('Сервер пока пуст. Подключите пространство на первом компьютере.','The server is empty. Connect a space on the first computer.'),
    VD_SERVER_FOLDER:tr('В выбранной папке уже есть файлы. Выберите рабочую папку этого пространства или пустую папку для новой копии.','This folder already contains files. Choose this space’s working folder or an empty folder for a new copy.'),
    VD_PROJECT_NAME:tr('Введите название проекта длиной от 1 до 80 символов.','Enter a project name between 1 and 80 characters.'),
    VD_PROJECT_EXISTS:tr('На сервере уже есть проект с этим названием.','A project with this name already exists on the server.'),
    VD_PROJECT_MISSING:tr('Проект недоступен. Заново откройте список проектов.','This project is unavailable. Reopen the project list.'),
    VD_PROJECT_UNSUPPORTED:tr('Для именованных проектов требуется Videron Sync 0.46 или новее.','Named projects require Videron Sync 0.46 or later.'),
    VD_PROJECT_MANAGEMENT_UNSUPPORTED:tr('Для переименования и удаления проектов обновите Videron Sync до 0.47 или новее.','Renaming and deleting projects requires Videron Sync 0.47 or later.'),
    VD_PROJECT_CHANGED:tr('Проект изменился на другом устройстве. Проверьте его название и подтвердите действие ещё раз.','The project changed on another device. Check its name and confirm the action again.'),
    VD_PROJECT_DELETED:tr('Проект удалён с сервера. Локальные заметки и правки сохранены.','The project was deleted from the server. Your local notes and edits are preserved.'),
    VD_SERVER_RESPONSE:tr('Ошибка сервера.','Server error.'),
    VD_SYNC_PENDING:tr('Ожидаем остальные файлы синхронизации.','Waiting for the remaining sync files.'),
    VD_SPACE_IDENTITY:tr('В папке обнаружено другое пространство. Проверьте подключение.','A different space was found in this folder. Check the connection.'),
    VD_CONFIG:tr('Папка данных недоступна.','The data folder is unavailable.'),
    VD_READ:tr('Не удалось прочитать файл.','Could not read the file.'),
    VD_SPACE_EXISTS:tr('В папке уже есть пространство. Выберите другую папку или откройте существующую.','This folder already contains a space. Choose another folder or open the existing space.'),
    VD_SPACE_MISSING:tr('В этой папке нет файла Videron.space.','This folder has no Videron.space file.'),
    VD_ENCRYPTION_CHANGED:tr('Зашифрованный файл заменён открытым. Проверьте папку. Чтобы открыть именно этот файл, уберите старую ссылку и подключите папку снова.','An unencrypted file replaced the encrypted space. Check the folder. To use this file, remove the existing link and open the folder again.'),
    VD_FOLDER_INVALID:tr('Выберите существующую папку.','Choose an existing folder.'),
    VD_FOLDER_MISSING:tr('Папка не найдена. Проверьте путь и подключение к диску.','Folder not found. Check the path and drive connection.'),
    VD_FOLDER_ACCESS:tr('Нет доступа к папке.','Cannot access this folder.'),
    VD_FOLDER_OPEN:tr('Не удалось открыть папку.','Could not open the folder.'),
    VD_CORRUPT:tr('Повреждён файл хранилища.','The workspace file is damaged.'),
    VD_NOT_LOADED:tr('Сначала откройте хранилище.','Open the workspace first.'),
    VD_INVALID:tr('Некорректный документ Videron.','Invalid Videron document.'),
    VD_WRITE:tr('Не удалось записать файл.','Could not write the file.'),
    VD_UNAVAILABLE:tr('Для разблокировки откройте заметку в настольном приложении.','Open the note in the desktop app to unlock it.'),
    VD_VERSION:tr('Для открытия файла требуется более новая версия Videron.','This file requires a newer version of Videron.'),
    VD_LOCKED:tr('Проект или заметка заблокированы.','The project or note is locked.'),
    VD_CHANGED:tr('Файл проекта изменился на диске. Изменения не записаны.','The project file changed on disk. Your changes have not been written.')
  };
  return Object.hasOwn(messages,code)?[messages[code],...parts].join(' '):message;
}
function dirty(scope){
  if(!ready)return;
  if(scope?.settings)catalogRecords?.markSettings(scope.settings);
  else if(!scope?.catalogOnly){
    const id=scope?.spaceId??library.active;
    if(folderSession && id===library.active)folderSession.records?.mark(scope);
    else catalogRecords?.markSpace(id,scope);
  }
  revision++;clearTimeout(timer);
  const now=performance.now();dirtySince ||= now;
  timer=setTimeout(()=>flush().catch(reportWriteError),Math.min(320,Math.max(0,1400-(now-dirtySince))));
}
function reportWriteError(error){
  if(storageState!=='failed')status('failed');
  notify(tr('Не удалось сохранить изменения. ','Could not save your changes. ')+storageErrorMessage(error));
}
function acknowledgeCatalog(snapshot,catalog){
  if(catalogRecords){
    catalogRecords=new CatalogRecords(JSON.parse(snapshot),catalog);
    catalogRecords.markAll();
    catalogRevision=null;
    pendingCatalogPatch=null;
  }else catalogSnapshot=snapshot;
}
async function writeCatalog(catalog){
  if(catalogRecords){
    for(;;){
      const retry=!!pendingCatalogPatch;
      const draft=pendingCatalogPatch??catalogRecords.prepare(catalog);
      if(!draft.patch){draft.commit();return}
      if(catalogRevision===null)catalogRevision=await native.CatalogRevision();
      if(!catalogRevision){
        const snapshot=serializeLibrary(catalog);
        await native.Save(snapshot);
        acknowledgeCatalog(snapshot,catalog);
        return;
      }
      // Replay precisely the unacknowledged patch before including any newer edits.
      pendingCatalogPatch=draft;
      catalogRevision=await native.SaveCatalogPatch(catalogRevision,JSON.stringify(draft.patch));
      draft.commit();pendingCatalogPatch=null;
      if(!retry)return;
    }
  }
  const json=serializeLibrary(catalog);
  if(json===catalogSnapshot)return;
  if(native)await native.Save(json);else localStorage.setItem(storageKey,json);
  catalogSnapshot=json;
}
function flush(){
  editor?.flush?.();
  clearTimeout(timer);
  if(editorMerge)return editorMerge.then(flush,flush);
  if(policyWrite)return policyWrite.then(flush);
  if(pending)return pending;
  if(saved===revision)return Promise.resolve();
  dirtySince=0;
  pending=(async()=>{
    while(saved<revision){
      const latest=revision;
      editor?.saveStatus.writing();
      await noteSession?.flush();
      if(await saveSpaceFolder(native,folderSession))branchSaved(folderSession);
      await writeCatalog(library);
      saved=latest;
    }
    editor?.saveStatus.saved();status('local');
  })().catch(error=>{status('failed');throw error}).finally(()=>{pending=null});
  return pending;
}

async function saveOpenEditor(){
  const current=editor;
  if(!current)return;
  try{
    // Finish the active draft only for an explicit save. Background autosave
    // must leave the formula, shape or paragraph the user is typing intact.
    if(await current.commitDraft?.()===false || editor!==current || lockScreen)return;
    await flush();
  }catch(error){reportWriteError(error)}
}

function hasOpenProtectedContent(){
  return projectProtected || folderSession?.encrypted || noteSession?.protected;
}
function syncIdle(){
  idle?.configure(library.autoLockMinutes,ready && !lockScreen && (hasOpenProtectedContent() || suspendedSpaceIds.size>0 || reviewing));
}
async function setIdleMinutes(minutes){
  const previous=normalizeIdleMinutes(library.autoLockMinutes);
  library.autoLockMinutes=normalizeIdleMinutes(minutes);dirty({settings:['autoLockMinutes']});
  try{await flush();syncIdle()}
  catch(error){library.autoLockMinutes=previous;dirty({settings:['autoLockMinutes']});throw error}
}

// Keep the editor and keys available behind the opaque cover until the last
// encrypted write succeeds. The retry uses the same note even after its editor closed.
function requestLock(){
  if(!native)return;
  storageIndicator.close();
  clearSpacePassphrases(document);
  dismissWorkspaceConflicts();dismissWorkspaceServer();
  if(!ready){
    if(!lockScreen){lockDuringStartup=true;void interruptVaultDialogs()}
    return;
  }
  if(lockScreen)return locking;
  if(!hasOpenProtectedContent() && !suspendedSpaceIds.size && !openingNote && !spaceOperation && !policyWrite && !document.querySelector('.vault-dialog'))return;
  saveMapView();
  spaceActivity.setMessage('');
  cancelNoteTransition();
  searchLifetime?.abort();
  dismissExtensions();cancelTransfers();closeMenu();routes?.reset();reading?.hide();mapMetrics=null;lockScreen=showLockScreen();sidebarTree?.clear();syncMapVisibility();syncIdle();
  let target=null, retryTimer;
  function retry(){
    clearTimeout(retryTimer);
    if(!locking)locking=finish().finally(()=>{locking=null});
    return locking;
  }
  async function finish(){
    try{
      await native.ForgetSuspendedFolderKeys?.();
      await interruptVaultDialogs();
      if(folderPoll)await folderPoll.catch(()=>{});
      if(spaceOperation)await spaceOperation.catch(()=>{});
      suspendedSpaceIds.clear();
      if(openingNote)await openingNote;
      // Failed password changes leave the previous protection policy in place.
      if(policyWrite)await policyWrite.catch(()=>{});
      if(target===null){
        if(!hasOpenProtectedContent()){
          lockScreen.close();lockScreen=null;renderAreas(workspace().areas);syncMapVisibility();syncIdle();return true;
        }
        target=noteSession?.note.id||'';
      }
      if(editor){if(!await editor.prepareClose())throw new Error('VD_WRITE')}
      else if(noteSession){
        if(!await noteSession.beforeClose())throw new Error('VD_WRITE');
        noteSession=null;
      }
      graph.flushPositions();await flush();
      await native.LockSession(target);
      ready=false;$('shell').hidden=true;
      location.reload();
      return true;
    }catch{
      lockScreen.failed(retry);
      retryTimer=setTimeout(retry,10000);
      return false;
    }
  }
  return retry();
}

function applyProjectProtection(write,enabled){
  if(policyWrite)return policyWrite;
  editor?.flush?.();
  graph.flushPositions();
  clearTimeout(timer);
  policyWrite=(async()=>{
    if(pending)await pending;
    const latest=revision;
    if(await saveSpaceFolder(native,folderSession))branchSaved(folderSession);
    const snapshot=serializeLibrary(library);
    await write(snapshot);acknowledgeCatalog(snapshot,library);
    saved=latest;projectProtected=enabled;status('local');syncIdle();
  })().finally(()=>{
    policyWrite=null;
    if(saved<revision)timer=setTimeout(()=>flush().catch(reportWriteError),320);
  });
  return policyWrite;
}
function settings(){
  closeMenu();
  openVaultSettings({
    available:!!native,protected:projectProtected,canLock:!!folderSession?.encrypted || suspendedSpaceIds.size>0,
    idleMinutes:normalizeIdleMinutes(library.autoLockMinutes),onIdleMinutesChange:setIdleMinutes,
    onEnable:password=>applyProjectProtection(payload=>native.ProtectProject(payload,password),true),
    onChange:(current,password)=>applyProjectProtection(payload=>native.ChangeProjectPassword(payload,current,password),true),
    onDisable:current=>applyProjectProtection(payload=>native.RemoveProjectPassword(payload,current),false),
    onLock:requestLock
  });
}
function closeMenu(){
  const menu=popover;popover=null;
  menu?.dispose?.();menu?.remove();
}
document.addEventListener('pointerdown',event=>{
  if(popover&&!popover.contains(event.target)&&!popover.anchor?.contains(event.target))closeMenu();
});
function menu(anchor, items, {scrollChoices=false}={}){
  if(popover&&popover.anchor===anchor){closeMenu();return}
  closeMenu();
  const box=element('div',scrollChoices?'menu workspace-menu':'menu');box.setAttribute('role','menu');box.anchor=anchor instanceof Element?anchor:null;
  const origin=box.anchor || document.elementFromPoint(anchor.x,anchor.y)?.closest('button,input,[tabindex]') || document.activeElement;
  function dismiss(){closeMenu();if(origin?.isConnected)origin.focus({preventScroll:true})}
  let group=box;
  if(scrollChoices){
    group=element('div','workspace-menu-list');group.setAttribute('role','group');box.append(group);
  }
  for(const item of items){
    if(!item){group=box;box.append(element('hr'));continue}
    const b=element('button'),label=element('span','menu-label',item.name);
    b.setAttribute('role',typeof item.checked==='boolean'?(scrollChoices?'menuitemradio':'menuitemcheckbox'):'menuitem');
    if(typeof item.checked==='boolean')b.setAttribute('aria-checked',String(item.checked));
    b.append(iconEl(item.icon),label);
    b.title=item.title||item.name;
    if(item.checked){const c=iconEl('check');c.className='check';b.append(c)}
    b.onclick=()=>{dismiss();item.run()};group.append(b);
  }
  document.body.append(box);popover=box;
  box.onkeydown=e=>{
    const buttons=[...box.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();buttons[(index+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();
    }else if(e.key==='Home'||e.key==='End'){e.preventDefault();buttons.at(e.key==='Home'?0:-1)?.focus()}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();dismiss()}
    else if(e.key==='Tab')dismiss();
  };
  function place(){
    const rect=box.anchor?box.anchor.getBoundingClientRect():{left:anchor.x,bottom:anchor.y};
    box.style.left=Math.max(5,Math.min(rect.left,innerWidth-box.offsetWidth-6))+'px';
    box.style.top=Math.max(5,Math.min(rect.bottom+5,innerHeight-box.offsetHeight-6))+'px';
  }
  box.anchor?.setAttribute('aria-expanded','true');
  box.dispose=()=>{window.removeEventListener('resize',place);box.anchor?.setAttribute('aria-expanded','false')};
  window.addEventListener('resize',place);place();
  const first=(scrollChoices && box.querySelector('[aria-checked=true]')) || box.querySelector('button');
  first?.focus({preventScroll:true});if(scrollChoices)first?.scrollIntoView({block:'nearest'});
}
function clearSpacePassphrases(root){
  for(const input of root.querySelectorAll('.space-passphrase input[type="password"]')){
    input.value='';input.setCustomValidity('');
  }
}
function dialog(title, dismissible=true){
  closeMenu();
  const focus=document.activeElement;
  const shade=element('div','shade'),box=element('div','dialog'),heading=element('div','dialog-title');
  box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label',title);
  function close(){clearSpacePassphrases(box);shade.remove();focus?.focus?.({preventScroll:true})}
  heading.append(element('h2','',title));if(dismissible)heading.append(iconButton('x',tr('Закрыть','Close'),close));
  box.append(heading);shade.append(box);document.body.append(shade);
  shade.addEventListener('pointerdown',e=>{if(e.target===shade&&dismissible)close()});
  shade.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(dismissible)close();return}
    if(e.key!=='Tab')return;
    const list=[...box.querySelectorAll('button:enabled,input:enabled,select:enabled')].filter(control=>control.getClientRects().length);
    const i=list.indexOf(document.activeElement);
    if((e.shiftKey&&i===0)||(!e.shiftKey&&i===list.length-1)){
      e.preventDefault();list[e.shiftKey?list.length-1:0]?.focus();
    }
  });
  box.querySelector('button')?.focus();return {box,close};
}
function gridSettingsPanel(anchor,staged){
  closeMenu();
  const title=staged?tr('Настроить дорожку','Stage track settings'):tr('Настроить сетку','Grid settings');
  const box=element('section','dialog stage-settings'),heading=element('div','dialog-title');
  box.setAttribute('role','dialog');box.setAttribute('aria-label',title);
  box.anchor=anchor instanceof Element?anchor:null;
  const focusTarget=box.anchor||$('graph');
  let at=box.anchor?.getBoundingClientRect()||anchor;
  const close=()=>{
    if(popover!==box)return;
    closeMenu();
    (focusTarget.getClientRects().length?focusTarget:$('graph')).focus({preventScroll:true});
  };
  heading.append(element('h2','',title),iconButton('x',tr('Закрыть','Close'),close));box.append(heading);
  box.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close()}};
  function place(){
    if(box.anchor?.getClientRects().length)at=box.anchor.getBoundingClientRect();
    const gap=8,w=box.offsetWidth,h=box.offsetHeight,right=(at.right??at.x)+gap,left=(at.left??at.x)-gap-w;
    const x=right+w<=innerWidth-gap?right:left>=gap?left:Math.max(gap,Math.min(innerWidth-gap-w,at.x));
    const y=Math.max(gap,Math.min(innerHeight-gap-h,at.y));
    box.style.left=Math.round(x)+'px';box.style.top=Math.round(y)+'px';
  }
  const observer=new ResizeObserver(place);
  box.dispose=()=>{observer.disconnect();window.removeEventListener('resize',place);box.anchor?.setAttribute('aria-expanded','false')};
  box.anchor?.setAttribute('aria-expanded','true');
  box.followMap=place;
  document.body.append(box);popover=box;observer.observe(box);window.addEventListener('resize',place);
  return {box,close};
}
function gridSpacingField(grid,columns,rows){
  const field=element('fieldset','grid-spacing-field');
  const label=element('legend','',tr('Шаг сетки','Grid spacing'));
  field.append(label);
  function axis(caption,accessibleName,value){
    const controls=element('div','grid-spacing-inputs'),slider=element('input'),number=element('input');
    slider.type='range';number.type='number';number.required=true;
    slider.setAttribute('aria-label',accessibleName);number.setAttribute('aria-label',accessibleName);
    for(const control of [slider,number]){
      control.min=String(MIN_GRID_SPACING);control.max=String(MAX_GRID_SPACING);control.step='1';control.value=String(value);
    }
    slider.oninput=()=>{number.value=slider.value;update()};
    number.oninput=()=>{if(number.validity.valid)slider.value=number.value;update()};
    controls.append(element('span','',caption),slider,number);field.append(controls);
    return {slider,number};
  }
  const horizontal=axis(tr('По горизонтали','Horizontal'),tr('Шаг по горизонтали','Horizontal spacing'),grid?gridSpacing(grid):DEFAULT_GRID_SPACING);
  const vertical=axis(tr('По вертикали','Vertical'),tr('Шаг по вертикали','Vertical spacing'),grid?gridRowSpacing(grid):DEFAULT_GRID_SPACING);
  const preview=element('div','grid-spacing-preview'),sample=element('span','grid-spacing-sample');
  const dots=element('span','grid-spacing-dots'),size=element('span','grid-spacing-size');
  sample.setAttribute('aria-hidden','true');sample.append(dots);
  function update(){
    const c=columns.valueAsNumber,r=rows.valueAsNumber;
    if([horizontal.number,vertical.number,columns,rows].some(n=>!n.validity.valid)){size.textContent='';dots.hidden=true;return}
    dots.hidden=false;
    const {spacing,rowSpacing}=value();
    const spanX=(c-1)*spacing,spanY=(r-1)*rowSpacing;
    const scale=Math.min(.13,105/Math.max(1,spanX),43/Math.max(1,spanY));
    const width=spanX*scale,height=spanY*scale;
    // On a dense grid show a representative set of rows/columns, including both edges.
    const intervalsX=Math.max(1,Math.min(c-1,Math.floor(width/3.5)));
    const intervalsY=Math.max(1,Math.min(r-1,Math.floor(height/3.5)));
    dots.style.backgroundSize=(c===1?4:Math.max(3.1,width/intervalsX))+'px '+(r===1?4:Math.max(3.1,height/intervalsY))+'px';
    dots.style.width=(width+3)+'px';dots.style.height=(height+3)+'px';
    size.textContent=tr('Размер на карте','Map size')+' · '+(c*spacing)+' × '+(r*rowSpacing);
  }
  function value(){return {spacing:horizontal.number.valueAsNumber,rowSpacing:vertical.number.valueAsNumber}}
  columns.addEventListener('input',update);rows.addEventListener('input',update);
  preview.append(sample,size);field.append(preview);update();
  return {field,value,slider:horizontal.slider};
}
function areaDialog(area=null,{parentId=null,point=null,startAsGrid=false,startAsTrack=false,focusSpacing=false,anchor=null,stageIndex=null}={}){
  const parent=areaById(parentId);
  const d=anchor && area?.grid?gridSettingsPanel(anchor,!!area.grid.stages):
    dialog(area?tr('Изменить область','Edit area'):parent?tr('Подобласть в «{name}»','New area in “{name}”',{name:parent.name}):tr('Новая область','New area'));
  const form=element('form'),field=element('label','field',tr('Название','Name')),input=element('input');
  input.required=true;input.maxLength=80;input.value=area?.name||'';input.placeholder=tr('Например, Исследования','For example, Research');field.append(input);
  const palette=element('div','palette');let color=area?.color||colors[workspace().areas.length%colors.length];
  for(const [i,value] of colors.entries()){
    const b=element('button','swatch');b.type='button';b.style.setProperty('--dot',value);
    b.setAttribute('aria-label',[tr('Серебристый','Silver'),tr('Синий','Blue'),tr('Охра','Ochre'),tr('Сиреневый','Lilac'),tr('Коралловый','Coral'),tr('Стальной синий','Steel blue'),tr('Песочный','Sand')][i]);
    function update(){b.classList.toggle('chosen',color===value);b.setAttribute('aria-pressed',String(color===value))}
    b.onclick=()=>{color=value;palette.dispatchEvent(new Event('change'))};palette.addEventListener('change',update);update();palette.append(b);
  }
  let areaType=area?(area.grid?.stages?'track':area.grid?'grid':'free'):(startAsTrack?'track':startAsGrid?'grid':'free');
  const types=element('div','area-type-options');
  types.setAttribute('role','group');types.setAttribute('aria-label',tr('Тип области','Area type'));
  const dimensions=element('div','area-grid-dimensions');
  function dimension(label,value){
    const field=element('label','field',label),number=element('input');
    number.type='number';number.min='1';number.max='100';number.step='1';number.required=true;number.value=String(value);
    number.oninput=()=>message.textContent='';
    field.append(number);dimensions.append(field);return number;
  }
  const columns=dimension(tr('Столбцы','Columns'),area?.grid?.cols||6);
  const rows=dimension(tr('Строки','Rows'),area?.grid?.rows||4);
  const spacing=gridSpacingField(area?.grid,columns,rows);
  const message=element('p','area-form-status');message.setAttribute('role','status');
  const stageField=element('fieldset','stage-names'),stageInputs=element('div','stage-inputs');
  stageField.append(element('legend','',tr('Этапы слева направо','Stages from left to right')),stageInputs);
  const stageNames=area?.grid?.stages?.slice()??[tr('Идеи','Ideas'),tr('В работе','In progress'),tr('Готово','Done')];
  let gridCols=columns.value,trackCols=String(stageNames.length);
  function updateStages(){
    const count=columns.valueAsNumber;
    if(areaType!=='track'||!columns.validity.valid)return;
    const fields=[...stageInputs.children];
    for(const field of fields.slice(count))field.remove();
    for(let i=fields.length;i<count;i++){
      const field=element('label'),number=element('span','',String(i+1)),name=element('input');
      name.required=true;name.maxLength=80;name.value=stageNames[i]??tr('Этап ','Stage ')+(i+1);
      name.setAttribute('aria-label',tr('Название этапа ','Stage name ')+(i+1));
      name.oninput=()=>{stageNames[i]=name.value;message.textContent=''};
      field.append(number,name);stageInputs.append(field);
    }
  }
  columns.addEventListener('input',updateStages);
  function setType(type){
    if(areaType==='track')trackCols=columns.value;
    else if(areaType==='grid')gridCols=columns.value;
    areaType=type;
    const grid=type!=='free',track=type==='track';
    if(track)columns.value=trackCols;else columns.value=gridCols;
    dimensions.hidden=!grid;
    rows.disabled=columns.disabled=!grid;
    spacing.field.hidden=spacing.field.disabled=!grid;
    columns.parentNode.firstChild.textContent=track?tr('Число этапов','Stage count'):tr('Столбцы','Columns');
    rows.parentNode.firstChild.textContent=track?tr('Мест на этапе','Seats per stage'):tr('Строки','Rows');
    stageField.hidden=stageField.disabled=!track;
    columns.dispatchEvent(new Event('input'));
    for(const b of types.children)b.setAttribute('aria-pressed',String(b.dataset.type===type));
  }
  if(!area){
    for(const [type,label,symbol] of [['free',tr('Свободная область','Freeform area'),'circle'],['grid',tr('Сетка','Grid'),'slots'],['track',tr('Дорожка этапов','Stage track'),'track']]){
      const b=button(label,()=>setType(type));b.type='button';b.dataset.type=type;b.prepend(iconEl(symbol));types.append(b);
    }
  }
  if(areaType==='track')columns.value=trackCols;
  setType(areaType);
  const actions=element('div','dialog-actions'),cancel=button(tr('Отмена','Cancel'),d.close);cancel.type='button';
  if(area?.grid){
    const remove=button(areaDeleteLabel(area),()=>{d.close();deleteFolder(area)},'area-delete');
    remove.type='button';actions.append(remove);
  }
  const submit=element('button','button primary',area?tr('Сохранить','Save'):tr('Создать область','Create area'));submit.type='submit';actions.append(cancel,submit);
  form.append(field);if(!area)form.append(types);
  form.append(dimensions,stageField,spacing.field,element('div','nav-label',tr('Цвет','Color')),palette,message,actions);d.box.append(form);
  form.onsubmit=e=>{
    e.preventDefault();if(!input.value.trim()){input.focus();return}
    const space=workspace(),r=rows.valueAsNumber,c=columns.valueAsNumber,pitch=spacing.value();
    const stages=areaType==='track'?[...stageInputs.querySelectorAll('input')].map(i=>i.value.trim()):undefined;
    if(stages?.includes('')){message.textContent=tr('Укажите название для каждого этапа.','Give each stage a name.');return}
    const appearance=area?.grid && (input.value.trim()!==area.name || color!==area.color)?{name:input.value.trim(),color}:undefined;
    const resized=area?.grid && (r!==area.grid.rows || c!==area.grid.cols || pitch.spacing!==gridSpacing(area.grid) || pitch.rowSpacing!==gridRowSpacing(area.grid) || JSON.stringify(stages)!==JSON.stringify(area.grid.stages) || !!appearance);
    if(resized && !resizeGridWithHistory(space,area.id,r,c,pitch,stages,appearance)){
      message.textContent=stages?tr('Сначала перенесите заметки с удаляемого этапа или оставьте больше мест на этапе.','Move notes out of removed stages or keep more seats per stage.'):tr('В сетке недостаточно мест для её заметок. Увеличьте число строк или столбцов.','The notes need more slots. Increase the number of rows or columns.');return;
    }
    let result=area;
    if(area)Object.assign(area,{name:input.value.trim(),color});
    else {
      const origin=point||graph.worldCenter();
      const grid=areaType!=='free'?(point?{rows:r,cols:c,x:point.x,y:point.y,...pitch}:suggestGrid(r,c,origin,space,pitch)):undefined;
      if(stages)grid.stages=stages;
      result=createArea(space,{name:input.value.trim(),color,parentId,grid});
      if(!result)return;
      if(!grid)result.anchor=graph.suggestAreaAnchor(origin,parentId);
      expandTo(parentId);
    }
    dirty(resized?gridRecords(result.id):{areas:[result]});d.close();render();
    if(!area&&showingMap())graph.focusArea(result.id);
    if(resized)notify(stages?tr('Дорожка обновлена','Stage track updated'):tr('Настройки сетки сохранены','Grid settings saved'),undoButton());
  };
  const first=Number.isInteger(stageIndex)?stageInputs.children[stageIndex]?.querySelector('input'):null;
  if(focusSpacing)spacing.slider.focus();else{(first||input).focus({preventScroll:true});(first||input).select()}
}
function expandTo(id){
  let changed=false;
  for(const a of areaPath(workspace().areas,id))if(collapsedAreas.delete(a.id))changed=true;
  return changed;
}
function cancelTransfers(){
  graph?.cancelDrag();
  areaDrag?.clear();
  stageControls?.reset();
}
function placeNotes(ids,id,created=false,slot=null,positions=[]){
  if(!ready||editor||openingNote||lockScreen)return false;
  const area=areaById(id);
  if(id!==null&&!area)return false;
  const space=workspace(), change=placeAreaNotes(space,ids,id,slot,positions);
  if(!change.ok){
    if(change.reason==='full')notify(area?.grid?.stages?tr('На этапе недостаточно мест для всех выбранных заметок.','This stage needs more free seats for the selected notes.'):tr('В сетке недостаточно свободных мест для выделения.','The grid needs more free slots for this selection.'));
    return false;
  }
  const count=change.after.length;
  if(!count && !created)return true;
  if(count)rememberMapAction(space,{kind:'placement',before:change.before,after:change.after});
  dirty({notes:change.after.map(p=>byId(p.id)),areas:created?[area]:[]});expandTo(id);
  if(!positions.length){graph.select(null);selected=null}
  listSelection.clear();lastListId=null;
  if(!created && showingMap())renderMapPlacement(change.after);
  else render();
  if(showingMap())$('graph').focus({preventScroll:true});
  if(area?.grid && ids.length===1 && count===2)notify(tr('Заметки поменялись местами','Notes swapped places'),undoButton());
  else if(count && area?.grid?.stages && Number.isInteger(slot))notify(area.name+' → '+area.grid.stages[slot%area.grid.cols]+' · '+count,undoButton());
  else if(count)notify(area
    ?tr('В области «{name}» · {count}','Moved to “{name}” · {count}',{name:area.name,count})
    :tr('Перемещено на верхний уровень · {count}','Moved to the top level · {count}',{count}),undoButton());
  return true;
}
function placeArea(id,parentId){
  const previous=areaById(id)?.parentId??null;
  if(!ready||editor||openingNote||lockScreen||!moveArea(workspace(),id,parentId))return;
  rememberMapAction(workspace(),{kind:'folder',id,parentId:previous});
  expandTo(parentId);dirty({areas:[areaById(id)]});render();
  notify(tr('Область перемещена','Area moved'),undoButton());
}
function pickForNotes(ids,anchor){
  if(!ready||editor||lockScreen)return;
  const space=workspace(), wanted=new Set(ids), records=space.notes.filter(note=>wanted.has(note.id));
  if(!records.length)return;
  if(popover?.anchor===anchor){closeMenu();return}
  closeMenu();
  const parents=new Set(records.map(note=>note.areaId||null));
  const common=parents.size===1?records[0].areaId||null:undefined;
  const parentId=common||null;
  const complete=(id,created=false)=>{
    closeMenu();
    if(space===workspace())placeNotes(wanted,id,created);
  };
  popover=areaPicker({anchor,title:tr('Поместить в область','Move notes to area'),areas:space.areas,
    full:fullGridIds(space,wanted),
    rootLabel:records.some(note=>note.areaId)?tr('Без области','No area'):null,currentId:common,
    createIn:parentId?areaPath(space.areas,parentId).map(a=>a.name).join(' / '):'',
    choose:id=>complete(id),create:name=>{
      const area=createArea(space,{name,parentId,color:colors[space.areas.length%colors.length]});
      if(area){
        const x=records.reduce((sum,n)=>sum+n.x,0)/records.length,y=records.reduce((sum,n)=>sum+n.y,0)/records.length;
        area.anchor={x,y};complete(area.id,true);
      }
    },close:closeMenu});
}
function pickParent(area,anchor){
  closeMenu();
  const space=workspace(), excluded=descendantAreaIds(space.areas,area.id);
  excluded.add(area.parentId||null);
  popover=areaPicker({anchor,title:tr('Переместить область','Move area'),areas:space.areas,
    rootLabel:tr('Верхний уровень','Top level'), allowed:id=>!excluded.has(id),
    choose:id=>{
      closeMenu();if(space===workspace())placeArea(area.id,id);
    },close:closeMenu});
}
function areaDeleteLabel(area){
  if(area.grid?.stages)return tr('Удалить дорожку','Delete stage track');
  return area.grid?tr('Удалить сетку','Delete grid'):tr('Удалить область…','Delete area…');
}
function deleteFolder(area){
  const space=workspace(), parent=areaById(area.parentId);
  function remove(){
    if(!ready || lockScreen || editor || openingNote || spaceOperation || reviewing ||
       space!==workspace() || areaById(area.id)!==area)return;
    cancelTransfers();graph.flushPositions();
    if(!deleteAreaWithHistory(space,area.id))return;
    collapsedAreas.delete(area.id);dirty();
    if(currentArea===area.id)navigate(parent?'area':'list',parent?.id||null);
    else render();
    if(showingMap())$('graph').focus({preventScroll:true});
    const message=area.grid?.stages?tr('Дорожка удалена','Stage track deleted'):
      area.grid?tr('Сетка удалена','Grid deleted'):tr('Область удалена','Area deleted');
    notify(message+tr('. Все заметки сохранены.','. All notes were kept.'),undoButton());
  }
  if(area.grid){remove();return}
  const d=dialog(tr('Удалить область «{name}»?','Delete area “{name}”?',{name:area.name}));
  const detail=parent?.grid
    ?tr('Заметки займут свободные места в «{name}». Остальные поднимутся выше по дереву. Вложенные области перейдут в «{name}».','Notes will take available slots in “{name}”. Any remaining notes move up the tree. Child areas will move into “{name}”.',{name:parent.name})
    :parent ?tr('Заметки и вложенные области останутся в «{name}».','Notes and child areas will move into “{name}”.',{name:parent.name})
    :tr('Заметки и вложенные области останутся на верхнем уровне пространства.','Notes and child areas will move to the top level of this workspace.');
  d.box.append(element('p','',detail));
  const actions=element('div','dialog-actions');
  actions.append(button(tr('Отмена','Cancel'),d.close),button(tr('Удалить область','Delete area'),()=>{d.close();remove()}));d.box.append(actions);
}
function areaActions(area,anchor){
  const items=[{icon:'map',name:tr('Показать на карте','Show on map'),run:()=>showArea(area.id)},
    {icon:'plus',name:tr('Создать вложенную область','Create child area'),run:()=>areaDialog(null,{parentId:area.id})},
    {icon:'edit',name:area.grid?.stages?tr('Настроить дорожку…','Stage track settings…'):tr('Изменить область','Edit area'),run:()=>areaDialog(area,{anchor})},metricAction(area,'area',anchor)];
  if(area.parentId || descendantAreaIds(workspace().areas,area.id).size<workspace().areas.length)
    items.push({icon:'folder',name:tr('Переместить область…','Move area…'),run:()=>pickParent(area,anchor)});
  items.push(null,{icon:'trash',name:areaDeleteLabel(area),run:()=>deleteFolder(area)});
  menu(anchor,items);
}
function showArea(id){
  navigate('map');graph.resize();graph.focusArea(id);$('graph').focus({preventScroll:true});
}
function showHelp(){
  const d=dialog(tr('Управление картой','Map controls')),rows=element('div','shortcuts');
  for(const [label,key] of [
    [tr('Создать заметку','Create a note'),'Ctrl N'],
    [tr('Создать заметку-холст','Create a canvas note'),'Ctrl Shift N'],
    [tr('Отменить перенос или удаление','Undo a move or deletion'),'Ctrl Z'],
    [tr('Поиск с карты','Search from the map'),'Ctrl K'],
    [tr('Поиск из любого редактора','Search from any editor'),'Ctrl Shift F'],
    [tr('Открыть выбранную заметку','Open the selected note'),tr('Enter или двойной щелчок','Enter or double-click')],
    [tr('Действия и внешний вид','Actions and appearance'),tr('Правый щелчок','Right-click')],
    [tr('Выбрать несколько заметок на карте','Select several notes on the map'),tr('Рамка или Ctrl / Shift + щелчок','Drag a box or Ctrl / Shift + click')],
    [tr('Выделить сетку или дорожку целиком','Select a whole grid or stage track'),tr('Обвести рамкой','Drag a box around it')],
    [tr('Выбрать все заметки','Select all notes'),'Ctrl A'],
    [tr('Удалить выбранные заметки, сетку или дорожку','Delete selected notes, grid or track'),isMacPlatform()?'⌫ / Delete':'Delete'],
    [tr('Переместить заметки в область','Move notes into an area'),tr('Потянуть в контур или на папку','Drag into its outline or sidebar folder')],
    [tr('Изменить порядок этапов','Reorder stages'),tr('Потянуть ручку у названия этапа','Drag the handle beside a stage name')],
    [tr('Вставить этап','Insert a stage'),tr('Плюс между заголовками','Plus between stage headings')],
    [tr('Удалить этап','Delete a stage'),tr('Правый щелчок по названию этапа','Right-click its heading')],
    [tr('Изменить шаг сетки','Change grid spacing'),tr('Потянуть правый нижний угол','Drag the bottom-right corner')],
    [tr('Выбор / перемещение','Select / pan'),'V / H'],
    [tr('Связать две заметки','Link two notes'),'L'],
    [tr('Масштаб','Zoom'),tr('+ / − или колесо','+ / − or wheel')],
    [tr('Масштаб 100% / уместить карту','Actual size / fit map'),'0 / F'],
    [tr('Скрыть или показать боковую панель','Toggle sidebar'),'Ctrl + \\']
  ]){
    const row=element('div');row.append(element('span','',label),element('kbd','',shortcutLabel(key)));rows.append(row);
  }
  d.box.append(element('p','',tr('Размер фигуры зависит от наполнения заметки. Частые открытия добавляют мягкое свечение. Закрепление удерживает заметку на выбранном месте.','A shape grows with its note. Opening a note more often gives it a soft glow. Pin it to keep it in place.')),rows);
}
function changeSpace(work,message){
  if(spaceOperation || !ready || lockScreen || editor || openingNote)return Promise.reject(new Error('VD_LOCKED'));
  $('shell').inert=true;
  cancelTransfers();graph.flushPositions();
  graph.remaining=0; // Keep the flushed positions stable during the folder picker or password prompt.
  if(message)spaceActivity.setMessage(message);
  spaceOperation=(async()=>{
    if(folderPoll)await folderPoll.catch(()=>{});
    await flush();
    await finishServerWrites();
    if(lockScreen)throw new Error('VD_LOCKED');
    return work();
  })().finally(()=>{
    if(message)spaceActivity.setMessage('');
    spaceOperation=null;$('shell').inert=!!editor;
  });
  return spaceOperation;
}
function showSpace(next,session){
  saveMapView();
  if(library.active && !Object.hasOwn(next.spaces,library.active))mapCameraMemory.forget(library.active);
  cancelNoteTransition();
  searchLifetime?.abort();
  dismissExtensions();
  dismissWorkspaceConflicts();
  storageIndicator.close();
  routes.reset();reading.hide();cancelTransfers();closeMenu();
  $('toast').hidden=true;$('toast').replaceChildren();$('list-stage').replaceChildren();
  graph.select(null);graph.setData([],[]);collapsedAreas.clear();listSelection.clear();lastListId=null;
  library=next;folderSession=session;
  suspendedSpaceIds.delete(next.active);
  page='map';currentArea=null;selected=null;chooseTool('select');status('local');render();
  graph.resize();restoreMapView();syncIdle();
  queueSync(80);syncBadge();
}
async function activateSpace(next,session=null){
  const previous=folderSession,previousId=library.active;
  try{await writeCatalog(next)}
  catch(error){
    if(session && session!==previous)await native.CloseFolderSpace(session.folder);
    throw error;
  }
  showSpace(next,session);
  if(previous && previous!==session){
    if(previous.encrypted && native.SuspendFolderSpace && !lockScreen && !closingApp){
      if(await native.SuspendFolderSpace(previous.folder))suspendedSpaceIds.add(previousId);
      syncIdle();
    }else await native.CloseFolderSpace(previous.folder);
  }
}
function promptForSpace(options){
  if(lockScreen || lockDuringStartup)return Promise.resolve(false);
  return openVaultPassword(options);
}
function switchSpace(id){
  if(id===library.active)return;
  changeSpace(async()=>{
    const entry=library.spaces[id];
    if(isFolderSpace(entry)){
      const info=await native.InspectSpaceFolder(entry.folder);
      const doc=await readSpaceFolder(native,info,promptForSpace,entry);
      if(doc)await activateSpace({...library,active:id,spaces:{...library.spaces,[id]:doc.link}},doc);
    }else if(entry)await activateSpace({...library,active:id});
    else if(id==='demo')await activateSpace({...library,active:id,demoHidden:false,spaces:{...library.spaces,demo:demoWorkspace()}});
  },tr('Переключаем пространство…','Switching spaces…')).catch(error=>notify(storageErrorMessage(error)));
}
async function createSpace({name,folder,password},sourceId){
  if(!validSpaceName(name))throw new Error('VD_INVALID');
  await changeSpace(async()=>{
    const migrating=sourceId!==undefined;
    if(migrating && (library.active!==sourceId || folderSession || !folder))throw new Error('VD_CHANGED');
    const id=migrating?sourceId:crypto.randomUUID();
    const data={...(migrating?workspace():blankWorkspace()),name:name.trim()};
    let doc=null;
    if(folder){
      const info=await native.InspectSpaceFolder(folder);
      if(folderEntry(library.spaces,info.folder))throw new Error('VD_SPACE_EXISTS');
      doc=await createSpaceFolder(native,info,data,password||'');
    }
    try{await activateSpace({...library,active:id,spaces:{...library.spaces,[id]:doc?.link??data}},doc)}
    catch(error){
      if(!doc)throw error;
      throw new Error(tr('Файл создан. Чтобы подключить его после восстановления записи библиотеки, выберите «Открыть из папки». ',
        'The file was created. Once the library is writable, use “Open from folder” to connect it. ')+storageErrorMessage(error));
    }
  });
}
async function attachSpace(){
  try{
    const path=await native.PickFolder(tr('Выберите папку','Choose a folder'));
    if(!path || lockScreen)return;
    await changeSpace(async()=>{
      const info=await native.InspectSpaceFolder(path),entry=folderEntry(library.spaces,info.folder);
      const id=entry?.[0]??crypto.randomUUID();
      if(id===library.active)return;
      const doc=await readSpaceFolder(native,info,promptForSpace,entry?.[1]);
      if(doc)await activateSpace({...library,active:id,spaces:{...library.spaces,[id]:doc.link}},doc);
    },tr('Открываем пространство из папки…','Opening space from folder…'));
  }catch(error){notify(storageErrorMessage(error))}
}
async function deleteSpace(id,deleteFile){
  await changeSpace(async()=>{
    if(!Object.hasOwn(library.spaces,id))throw new Error('VD_CHANGED');
    const current=id===library.active,previous=folderSession;
    if(deleteFile && (!current || !previous))throw new Error('VD_INVALID');
    const removed=library.spaces[id],spaces={...library.spaces};delete spaces[id];
    let next={...library,spaces};
    if(id==='demo')next.demoHidden=true;
    if(current)next=localFallback(next);
    await writeCatalog(next);
    if(deleteFile){
      try{await native.DeleteFolderSpace(previous.folder)}
      catch(error){
        // Keep the link registered if a cloud client replaced the file before confirmation.
        try{await writeCatalog(library)}
        catch{showSpace(next,null);await native.CloseFolderSpace(previous.folder)}
        throw error;
      }
    }
    if(current){
      showSpace(next,null);
      if(previous && !deleteFile)await native.CloseFolderSpace(previous.folder);
    }else{
      if(isFolderSpace(removed))await native?.CloseFolderSpace(removed.folder);
      suspendedSpaceIds.delete(id);mapCameraMemory.forget(id);library=next;render();syncIdle();
    }
  });
}
function newSpaceForm(link=false){
  const id=link?library.active:undefined;
  openCreateSpace({dialog,native,projectProtected,sourceName:link?spaceTitle(id,workspace()):undefined,
    onCreate:options=>createSpace(options,id),onError:storageErrorMessage});
}
function manageSpaces(){
  const entries=Object.entries(library.spaces).map(([id,space])=>({id,name:spaceTitle(id,space),folder:space.folder,
    encrypted:isFolderSpace(space)?space.encrypted:projectProtected,noteCount:space.notes?.length ?? (id===library.active?workspace().notes.length:undefined)}));
  openSpaceManager({dialog,entries,active:library.active,native,onLink:()=>newSpaceForm(true),onDelete:deleteSpace,
    onOpenFolder:folder=>native.OpenFolder(folder),onError:storageErrorMessage});
}
function syncBadge(){
  const b=$('sync-review'),incoming=folderSession?.incoming;
  b.hidden=!incoming || reviewing || !!lockScreen;
  b.textContent=incoming?.conflict?tr('Сравнить версии','Compare versions'):tr('Открыть изменения','Review updates');
}
function queueSync(delay=5000){
  clearTimeout(syncTimer);
  if(!native?.PollFolderSpace || !folderSession || closingApp || lockScreen)return;
  syncTimer=setTimeout(()=>{
    void exchangeServer(false).catch(()=>{});
    void checkIncoming().catch(()=>{});
    queueSync();
  },delay);
}
function blockedForMerge(){
  return editor || openingNote || spaceOperation || lockScreen || closingApp || policyWrite || graph?.drag ||
    routes?.isEditing() || popover || document.querySelector('.shade:not(.vs-shade),dialog[open],[role="dialog"]:not(.vs-panel):not([hidden])');
}
function branchSaved(session){
  if(!session)return;
  session.nextExchange=0;session.sendAgain=true;
  if(session.connection?.address && !lockScreen && !closingApp)void exchangeServer(true).catch(()=>{});
}
async function finishServerWrites(){
  const session=folderSession;
  if(!session?.connection?.address || session.serverError)return;
  try{
    if(session.serverPoll)await session.serverPoll;
    if(session.sendAgain)await exchangeServer(true,{finalWrite:true});
  }catch{/* The branch is saved in the folder for the next connection. */}
}
function clearServerStatus(session){
  session.serverEpoch=(session.serverEpoch||0)+1;
  Object.assign(session,{serverOnline:false,lastSync:0,serverError:null,exchanging:false,
    serverPoll:null,watching:false,cursor:'',sendAgain:false,nextExchange:0});
}
function setServerConnection(session,info){
  session.connection=info||null;
  const name=info?.projectName||session.data.name;
  if(info?.address)session.serverProjectDeleted=false;
  if(session.link.name===name)return;
  // The catalog can display a server-side rename without creating a content
  // revision in the (possibly encrypted) workspace on each device.
  session.link.name=name;
  if(session===folderSession && !lockScreen){
    $('space-name').textContent=$('crumb-space').textContent=name;
    dirty({catalogOnly:true});
  }
}
function serverProjectGone(session){
  const message=storageErrorMessage('VD_PROJECT_DELETED');
  clearServerStatus(session);
  setServerConnection(session,null);
  session.serverProjectDeleted=true;
  if(session===folderSession && !lockScreen){status();notify(message)}
}
function serverLinked(session,info){
  clearServerStatus(session);
  setServerConnection(session,info);
  if(info?.address){rememberServerAddress(info.address);session.lastSync=info.lastSync||Date.now();session.serverOnline=true}
  if(session===folderSession)status();
}
async function syncNow(session){
  if(!session || session!==folderSession || lockScreen || closingApp)return;
  await flush();
  if(session!==folderSession)return;
  await exchangeServer(true);
  if(session===folderSession){session.deferred=null;queueSync(100)}
}
async function watchServer(session,epoch){
  if(session.watching || !native?.WaitSpaceServerChange)return;
  const current=()=>session===folderSession && session.serverEpoch===epoch && session.connection?.address && !lockScreen && !closingApp;
  session.watching=true;
  try{
    while(current()){
      const since=session.cursor||'';
      const cursor=await native.WaitSpaceServerChange(session.folder,since);
      if(!current() || !cursor)return;
      if(cursor!==since){await exchangeServer(true);void checkIncoming().catch(()=>{})}
    }
  }catch(error){
    if(current()){
      if(String(error?.message||error)==='VD_PROJECT_DELETED')serverProjectGone(session);
      else {session.serverError=error;session.nextExchange=Date.now()+2500;status();queueSync(2600)}
    }
  }finally{if(session.serverEpoch===epoch)session.watching=false}
}
async function exchangeServer(force,{finalWrite=false}={}){
  const session=folderSession;
  if(session?.serverPoll)return session.serverPoll;
  if(!session || lockScreen || (closingApp && !finalWrite) || (!force && (spaceOperation || Date.now()<(session.nextExchange||0))))return;
  const epoch=session.serverEpoch;
  const current=()=>session===folderSession && session.serverEpoch===epoch && !lockScreen;
  session.serverPoll=(async()=>{
    if(session.connection===undefined){
      const info=await native.ServerConnection(session.folder);
      if(!current())return;
      rememberServerAddress(info?.address);
      setServerConnection(session,info);session.serverError=null;status();
    }
    if(!session.connection?.address || !current())return;
    session.exchanging=true;status();
    do{
      session.sendAgain=false;
      const cursor=await native.SyncSpaceServer(session.folder);
      if(!current())return;
      if(!cursor){
        session.connection=undefined;clearServerStatus(session);status();return;
      }
      session.cursor=cursor;
      session.lastSync=Date.now();
      session.serverOnline=true;session.serverError=null;
      // Read the route the authenticated request actually used (including fallback).
      const info=await native.ServerConnection(session.folder).catch(()=>null);
      if(!current())return;
      if(info?.address){setServerConnection(session,info);session.lastSync=info.lastSync||session.lastSync}
    }while(session.sendAgain);
    session.nextExchange=Date.now()+60000;
    if(!closingApp){
      void watchServer(session,epoch);
      if(!spaceOperation)void checkIncoming().catch(()=>{});
    }
  })().catch(error=>{
    if(current() && String(error?.message||error)==='VD_PROJECT_DELETED'){serverProjectGone(session);return}
    if(current()){session.nextExchange=Date.now()+4000;session.serverError=error}
    throw error;
  }).finally(()=>{
    if(session.serverEpoch===epoch){
      session.serverPoll=null;session.exchanging=false;
      if(current())status();
    }
  });
  return session.serverPoll;
}
function checkFolderUpdate(session,knownToken='',force=false){
  if(session.records && native.PrepareFolderMerge && native.CommitFolderMergeChoices){
    return native.PrepareFolderMerge(session.folder,force,knownToken||'');
  }
  return !force && knownToken && native.CheckFolderSpace
    ? native.CheckFolderSpace(session.folder,knownToken)
    : native.PollFolderSpace(session.folder,force);
}
function previewFolderUpdate(session,update){
  return update.prepared?{...update,conflicts:update.conflicts||[]}:compareIncoming(session,update);
}
async function checkIncoming(){
  const session=folderSession,shown=session?.choiceToken;
  if(!shown)return pollFolder(false);
  if(session.rechecking || lockScreen || closingApp)return;
  session.rechecking=true;
  try{
    const fresh=await checkFolderUpdate(session,shown);
    if(session===folderSession && session.choiceToken===shown && fresh.token!==shown){
      session.superseded=shown;
      dismissWorkspaceConflicts();
      await folderPoll;
      if(session===folderSession)return pollFolder(true);
    }
  }finally{session.rechecking=false}
}
function pollFolder(force){
  const session=folderSession;
  if(folderPoll)return folderPoll;
  if(!session || !ready || lockScreen || closingApp || policyWrite || spaceOperation)return Promise.resolve();
  if(graph?.drag || graph?.pinch){session.pollAfterGesture=true;return Promise.resolve()}
  session.pollAfterGesture=false;
  folderPoll=(async()=>{
    let update=await checkFolderUpdate(session,force?'':session.incoming?.token||session.deferred,force);
    for(;;){
      if(session!==folderSession || lockScreen || closingApp)return;
      if(!update.token){session.incoming=null;return}
      if(!force && session.deferred===update.token)return;
      // The native read can finish after the user has started moving a note.
      if(graph?.drag || graph?.pinch){session.pollAfterGesture=true;return}
      if(!blockedForMerge()){
        // A search can follow conflict-free changes. Leave conflicts for after dismissal.
        const previous=session.incoming;
        if(!force && (activeSearch || openingSearch) && previous?.conflict &&
            previous.token===update.token && previous.revision===revision)return;
        break;
      }
      editor?.flush?.();
      const openId=editor && !openingNote && !pending && saved===revision && !policyWrite && !notePrivacyChange &&
        !spaceOperation && !lockScreen ? noteSession?.note.id : null;
      const previous=session.incoming;
      if(!force && previous?.token===update.token && previous.revision===revision &&
          (!openId || previous.conflict || previous.openId===openId))return;
      if(!update.remote && !update.prepared){
        update=await checkFolderUpdate(session);
        continue;
      }
      const merged=previewFolderUpdate(session,update);
      if(openId && preservesOpenNote(session,merged,openId)){
        graph.remaining=0;
        editorMerge=update.prepared?commitPreparedMerge(native,session,update):commitIncoming(native,session,update,merged,openId);
        try{await editorMerge}finally{editorMerge=null;$('shell').inert=!!editor}
        session.incoming=null;session.deferred=null;
        refreshOpenSearch();
        library.spaces[library.active]=session.link;dirty({catalogOnly:true});render();branchSaved(session);
      }else session.incoming={token:update.token,conflict:merged.conflicts.length>0,revision,openId};
      return;
    }
    cancelTransfers();graph.flushPositions();graph.remaining=0;
    reviewing=true;$('shell').inert=true;syncBadge();
    try{
      const previewHead=session.head;
      await flush();
      if(lockScreen || closingApp || spaceOperation)return;
      if(!update.prepared || previewHead!==session.head)update=await checkFolderUpdate(session,'',true);
      if(!update.token){session.incoming=null;return}
      let merged=previewFolderUpdate(session,update),choices;
      session.incoming={token:update.token,conflict:merged.conflicts.length>0,revision};
      if(merged.conflicts.length){
        if(activeSearch || openingSearch)return;
        syncIdle();
        session.choiceToken=update.token;
        try{
          choices=await openWorkspaceConflicts({spaceName:session.link.name,conflicts:merged.conflicts,
            previewSealed:(id,sealed,password)=>native.PreviewSealedNote(id,sealed,password)});
        }finally{session.choiceToken=null}
        if(!choices){session.deferred=session.superseded===update.token?null:update.token;session.superseded=null;return}
        if(!update.prepared)merged=compareIncoming(session,update,choices);
      }
      if(lockScreen || closingApp || spaceOperation || session!==folderSession)return;
      if(update.prepared)await commitPreparedMerge(native,session,update,choices);
      else await commitIncoming(native,session,update,merged);
      refreshOpenSearch();
      branchSaved(session);
      library.spaces[library.active]=session.link;
      session.incoming=null;session.deferred=null;session.nextExchange=0;session.syncError='';
      routes.reset();reading.hide();closeMenu();
      if(selected && !byId(selected))selected=null;
      if(currentArea && !areaById(currentArea)){page='map';currentArea=null}
      $('toast').hidden=true;render();dirty({catalogOnly:true});
      queueSync(250);
    }finally{reviewing=false;$('shell').inert=!!editor || !!activeSearch;syncIdle()}
  })().catch(error=>{
    if(lockScreen || closingApp || session!==folderSession)return;
    const code=String(error?.message||error).split('|')[0];
    if(code==='VD_CHANGED'){session.deferred=null;queueSync(350);return}
    if(code==='VD_SYNC_PENDING')return;
    if(session.syncError!==code || force)notify(storageErrorMessage(error));
    session.syncError=code;
  }).finally(()=>{folderPoll=null;syncBadge()});
  return folderPoll;
}
async function serverSettings(){
  let session=folderSession;
  let id=library.active, draft=null;
  const isCurrent=()=>!lockScreen && !closingApp && folderSession===session && library.active===id;
  function requireCurrent(){if(!isCurrent())throw new Error('VD_CHANGED')}
  async function linked(doc){
    try{
      const connection=await native.ServerConnection(doc.folder);
      if(doc===folderSession && !lockScreen)serverLinked(doc,connection);
    }catch(error){
      doc.connection=undefined;notify(storageErrorMessage(error));
    }
    queueSync(100);
  }
  async function copiesFor(ticket){
    requireCurrent();
    const folders=Object.values(library.spaces).filter(isFolderSpace).map(space=>space.folder);
    if(!folders.length || !native.MatchingServerFolders)return [];
    const matches=await native.MatchingServerFolders(ticket,folders);
    requireCurrent();
    return matches.map(folder=>({folder,name:folderEntry(library.spaces,folder)?.[1].name}));
  }
  async function connect(code){
    await changeSpace(async()=>{
      requireCurrent();
      if(!session)throw new Error('VD_CHANGED');
      await native.ConnectSpaceServer(session.folder,code);
      await linked(session);
    });
  }
  try{
    const info=session?await native.ServerConnection(session.folder):null;
    if(!isCurrent())return;
    const name=spaceTitle(id,session?.link??workspace());
    const managesActive=projectId=>!!session && !!info?.address && (info.projectId||'')===projectId;
    openWorkspaceServer({dialog,native,folder:session?.folder,spaceName:name,projectProtected,connection:info?.address?info:null,onError:storageErrorMessage,
      onRenameServerProject:(ticket,projectId,name,expectedName)=>changeSpace(async()=>{
        requireCurrent();
        const updated=await native.RenameServerProject(ticket,projectId,name,expectedName);
        if(managesActive(projectId) && isCurrent()){
          serverLinked(session,{...info,projectName:updated.projectName});
          queueSync(50);
        }
        return updated;
      }),
      onDeleteServerProject:(ticket,projectId,expectedName)=>changeSpace(async()=>{
        requireCurrent();
        await native.DeleteServerProject(ticket,projectId,expectedName);
        if(managesActive(projectId) && isCurrent()){
          // Let the client verify the tombstone against the saved identity
          // before discarding this folder's credentials.
          try{await exchangeServer(true)}catch{queueSync(100)}
        }
      }),
      onFindCopies:copiesFor,
      onPrepareFolder:!session && library.spaces[id]?async(folder,password,ticket)=>{
        requireCurrent();
        folder ||= await native.ManagedServerFolder(ticket);
        requireCurrent();
        await createSpace({name,folder,password},id);
        session=folderSession;
        return session.folder;
      }:null,
      onConnect:connect,
      onNewProject:async(ticket,projectName,path,password)=>{
        requireCurrent();
        if(!draft || draft.id!==id || draft.ticket!==ticket || draft.name!==projectName || draft.path!==path){
          const folder=path || await native.ManagedServerFolder(ticket);
          requireCurrent();
          await createSpace({name:projectName,folder,password});
          id=library.active;session=folderSession;
          draft={id,ticket,name:projectName,path};
        }
        await connect(ticket);
      },
      onMoveFolder:path=>changeSpace(async()=>{
        requireCurrent();
        if(!session)throw new Error('VD_CHANGED');
        const info=await native.InspectSpaceFolder(path),entry=folderEntry(library.spaces,info.folder);
        if(entry?.[0]===id)return session.folder;
        if(entry || info.exists)throw new Error('VD_SPACE_EXISTS');
        const link={...session.link,folder:info.folder};
        const next={...library,spaces:{...library.spaces,[id]:link}};
        const snapshot=serializeLibrary(next);
        const moved=await native.MoveFolderSpace(session.folder,link.folder,snapshot);
        acknowledgeCatalog(snapshot,next);
        clearServerStatus(session);
        session={folder:link.folder,link,encrypted:link.encrypted,raw:session.raw,data:session.data,records:session.records,head:session.head};
        showSpace(next,session);
        await linked(session);
        if(moved.keptSource)notify(tr('Перенос завершён. Часть файлов осталась в прежней папке.','Move complete. Some files remain in the previous folder.'));
        return link.folder;
      }),
      onJoin:(code,folder,existingOnly=false,report)=>changeSpace(async()=>{
        requireCurrent();
        report?.(tr('Ищем рабочую копию…','Looking for a working copy…'));
        if(!folder){
          const copies=await copiesFor(code);
          folder=copies[0]?.folder || await native.ManagedServerFolder(code);
          requireCurrent();
        }
        let info=await native.InspectSpaceFolder(folder);
        const entry=folderEntry(library.spaces,info.folder);
        let doc=entry?.[0]===id?session:null;
        if((existingOnly || doc || entry?.[1].encrypted) && !info.exists)throw new Error('VD_SPACE_MISSING');
        if(doc?.encrypted && !info.encrypted)throw new Error('VD_ENCRYPTION_CHANGED');
        try{
          requireCurrent();
          if(info.exists && !doc){
            report?.(tr('Открываем рабочую копию…','Opening the working copy…'));
            doc=await readSpaceFolder(native,info,promptForSpace,entry?.[1]);
            if(!doc)return false;
          }
          requireCurrent();
          report?.(info.exists ? tr('Синхронизируем рабочую копию…','Syncing the working copy…') :
            tr('Загружаем проект…','Downloading the project…'));
          await native.JoinSpaceServer(code,info.folder);
          requireCurrent();
          report?.(tr('Открываем пространство…','Opening the workspace…'));
          if(!doc){
            info=await native.InspectSpaceFolder(info.folder);
            requireCurrent();
            doc=await readSpaceFolder(native,info,promptForSpace,entry?.[1]);
            if(!doc)return {savedFolder:info.folder};
          }
          requireCurrent();
        }catch(error){
          if(doc && doc!==session)await native.CloseFolderSpace(doc.folder);
          throw error;
        }
        if(doc!==session){
          const key=entry?.[0]??crypto.randomUUID();
          await activateSpace({...library,active:key,spaces:{...library.spaces,[key]:doc.link}},doc);
        }
        await linked(doc);
      }),
      onSync:()=>syncNow(session),
      onDisconnect:()=>changeSpace(async()=>{
        if(!isCurrent())throw new Error('VD_CHANGED');
        await native.DisconnectSpaceServer(session.folder);setServerConnection(session,null);clearServerStatus(session);status();
      })
    });
  }catch(error){notify(storageErrorMessage(error))}
}
function spaceMenu(anchor){
  const ids=Object.keys(library.spaces);
  if(!library.demoHidden && !ids.includes('demo'))ids.push('demo');
  const items=ids.map(id=>{
    const space=library.spaces[id];
    return {name:spaceTitle(id,space),title:space?.folder,icon:isFolderSpace(space)?(space.encrypted?'lock':'folder'):id==='demo'?'space':'layers',
      checked:id===library.active,run:()=>switchSpace(id)};
  });
  items.push(null,{name:tr('Создать пространство…','Create space…'),icon:'plus',run:()=>newSpaceForm()});
  if(native)items.push({name:tr('Открыть из папки…','Open from folder…'),icon:'folder',run:attachSpace});
  if(native?.ConnectSpaceServer)items.push({name:tr('Свой сервер…','Your server…'),icon:'globe',run:serverSettings});
  items.push({name:tr('Пространства на этом компьютере…','Spaces on this computer…'),icon:'sliders',run:manageSpaces});
  menu(anchor,items,{scrollChoices:true});
}
function navigate(target,area=null){
  cancelNoteTransition();
  routes?.reset();reading?.hide();
  cancelTransfers();closeMenu();page=target;currentArea=area;selected=null;listSelection.clear();lastListId=null;
  if(area)expandTo(areaById(area)?.parentId);
  graph.select(null);chooseTool('select');render();
  $('shell').classList.remove('mobile-open');updateSidebarToggle();
}
function editFromMap(id,searchTarget=null){
  return edit(id,null,searchTarget,{fromMap:true});
}
function returnToMapNote(id,camera){
  graph.restoreCamera(camera);
  if(document.hidden)return;
  let destination=graph.noteViewportRect(id);
  // A linked note, a resized window or a synced move can put the note outside the old frame.
  if(!destination){
    const node=graph.nodes.get(id);
    if(!node)return;
    graph.restoreCamera({x:node.x,y:node.y,zoom:camera.zoom});
    destination=graph.noteViewportRect(id);
  }
  if(destination){
    graph.showReturnCue(id);
    playNoteTransition('close',destination);
  }
}
function edit(id,returnToResults=null,searchTarget=null,navigation={}){
  if(editorMerge)return editorMerge.then(()=>edit(id,returnToResults,searchTarget,navigation),()=>{});
  const record=byId(id);if(!record||editor||openingNote||lockScreen||!ready)return;
  cancelNoteTransition();
  const fromMap=navigation.fromMap && showingMap();
  const mapVisit=fromMap?{space:library.active,camera:graph.captureCamera()}:navigation.mapVisit;
  routes?.reset();reading?.hide();
  // A route can start flying back to its first view as it closes.
  if(fromMap)graph.restoreCamera(mapVisit.camera);
  cancelTransfers();closeMenu();
  openingNote=openRecord(record,returnToResults,searchTarget,mapVisit,fromMap).finally(()=>{openingNote=null});
  return openingNote;
}
async function openRecord(record,returnToResults,searchTarget,mapVisit,fromMap){
  const id=record.id;
  const fromTree=$('areas').contains(document.activeElement);
  const hiddenRouteFragments=new Map();
  let session,openEditor;
  try{
    if(lockScreen || closingApp)return;
    session=await openNoteSession({record,bridge:native,dirty:()=>dirty({notes:[record]}),persist:flush,hasPlainHistory:!!folderSession && !folderSession.encrypted,onPrivacyChange:()=>{
      // Fragment keys can include a fingerprint of the selected paragraph.
      // Strip them before the first encrypted write, including on save retry.
      if(isProtectedNote(record)){
        for(const route of Array.isArray(workspace().routes)?workspace().routes:[])for(const stop of Array.isArray(route?.stops)?route.stops:[]){
          if(stop?.noteId===id && stop.fragment){hiddenRouteFragments.set(stop,stop.fragment);stop.fragment=null}
        }
      }else{
        for(const [stop,key] of hiddenRouteFragments)stop.fragment=key;
        hiddenRouteFragments.clear();
      }
      refreshOpenSearch();
      dirty({meta:true});
      $('list-stage').replaceChildren();$('toast').hidden=true;render();syncIdle();
    },onError:reportWriteError});
  }catch(error){notify(storageErrorMessage(error));return}
  if(!session)return;
  noteSession=session;
  try{
    openEditor=session.note.type==='data'?(await import('./data-editor.js')).openDataEditor:(await import('./editor.js')).openEditor;
  }catch(error){
    if(await session.beforeClose())noteSession=null;
    notify(storageErrorMessage(error));return;
  }
  if(closingApp){if(await session.beforeClose())noteSession=null;return}
  if(lockScreen && (projectProtected||folderSession?.encrypted||session.protected))return;
  syncIdle();
  chooseTool('select');selected=id;graph.select(id);record.opens=(record.opens||0)+1;dirty({notes:[record]});
  const backLabels={map:tr('К карте','Back to map'),list:tr('К списку','Back to list'),pinned:tr('К закреплённым','Back to pinned'),area:tr('К области','Back to area')};
  const saveStatus=createEditorSaveStatus();
  const sameMap=()=>mapVisit && mapVisit.space===library.active && showingMap();
  const source=fromMap && sameMap() && !lockScreen?graph.noteViewportRect(id):null;
  editor=openEditor({note:session.note,notes:workspace().notes,areas:workspace().areas,saveIndicator:saveStatus.element,
    textAreaDefaults:{style:library.view?.textAreaStyle,save(style){
      library.view={...library.view,textAreaStyle:style};dirty({settings:['view']})
    }},
    backLabel:returnToResults?tr('К результатам','Back to results'):backLabels[page],
    onReturn:returnToResults,onSearch:()=>search(),
    onChange:patch=>{session.changed(patch);saveStatus.edited()},beforeClose:session.beforeClose,
    manageProtection:native?()=>{
      if(notePrivacyChange)return notePrivacyChange;
      // A concurrent merge may introduce new route stops. Finish applying
      // them before sealing the note and clearing its private passage references.
      notePrivacyChange=(async()=>{
        if(editorMerge)await editorMerge;
        if(noteSession!==session || lockScreen || closingApp)return false;
        return session.manageProtection();
      })().finally(()=>{notePrivacyChange=null});
      return notePrivacyChange;
    }:null,isProtected:()=>session.protected,
    onClose:reason=>{
      cancelNoteTransition();
      saveStatus.close();editor=null;noteSession=null;$('shell').inert=!!editorMerge;syncIdle();
      if(lockScreen)return;
      render();
      if(reason==='back' && showingMap() && !returnToResults && !closingApp){
        if(sameMap())returnToMapNote(id,mapVisit.camera);
        else if(!mapVisit)graph.focus(id);
      }
      if(document.activeElement===document.body && !(fromTree && sidebarTree?.focusNote(id))){
        const row=listNoteRow(id);
        (showingMap()?$('graph'):row||$('new-note')).focus({preventScroll:true});
      }
      flush().catch(reportWriteError);
      queueSync(100);
    },
    onOpenNote:target=>edit(target,returnToResults,null,{mapVisit})
  });
  editor.saveStatus=saveStatus;
  if(storageState==='failed')saveStatus.failed();
  editor.returnToResults=returnToResults;
  editor.mapVisit=mapVisit;
  syncMapVisibility();
  $('shell').inert=true;
  if(searchTarget)editor.revealSearchMatch(searchTarget);
  if(source && !lockScreen)playNoteTransition('open',source,editor.element);
}
function addNote(pos=graph.worldCenter(),type='text',seat=null){
  if(!ready || !library.active || editor || openingNote || spaceOperation || lockScreen)return;
  const space=workspace(),n=createNote(pos.x,pos.y,null,type);
  space.notes.push(n);
  const placement=(seat || page==='area')?placeAreaNotes(space,[n.id],seat?.areaId??currentArea,seat?.slot??null):null;
  if(placement && !placement.ok){
    space.notes.pop();notify(areaById(seat?.areaId??currentArea)?.grid?.stages?tr('Этап заполнен. Перенесите заметку дальше или добавьте мест на этапе.','This stage is full. Advance a note or add seats per stage.'):tr('Все места заняты. Увеличьте сетку или освободите ячейку.','All slots are occupied. Enlarge the grid or free a slot.'));return;
  }
  const changed=[n];
  for(const {id} of placement?.after??[])if(id!==n.id)changed.push(byId(id));
  selected=n.id;dirty({notes:changed});render();edit(n.id);
}
function noteTypeItems(pos,seat=null){
  return [
    {icon:'newTextNote', name:tr('Текстовая заметка','Text note'),run:()=>addNote(pos,'text',seat)},
    {icon:'newCanvas',name:tr('Заметка-холст','Canvas note'),run:()=>addNote(pos,'canvas',seat)},
    {icon:'newData',name:tr('Заметка с данными','Data note'),run:()=>addNote(pos,'data',seat)}
  ];
}
function chooseTool(next){
  if(next!=='select')routes?.reset();
  if(next==='link'&&workspace().notes.length<2){notify(tr('Для связи нужны две заметки.','Create at least two notes to link them.'));return}
  if(next==='link'&&!showingMap()){
    const source=selected;
    navigate('map');
    selected=source;
    graph.select(source);
    graph.fit();
  }
  tool=next;graph?.setTool(next==='hand'?'hand':'select');graph?.setLinkMode(next==='link',selected);
  $('map-stage').querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===next));
  renderLinkHint();
  renderSelection();
}
function renderLinkHint(){
  const bar=$('link-message'),hint=$('link-hint');
  bar.hidden=tool!=='link';
  let message='';
  if(!bar.hidden){
    const source=byId(graph.linkSource);
    message=source ? tr('Выберите заметку для связи с «{name}»','Select a note to link with “{name}”',{name:noteTitle(source)})
      : tr('Выберите первую заметку','Select the first note');
  }
  if(hint.textContent!==message)hint.textContent=hint.title=message;
}
function linkClick(id){
  const linkSource=graph.linkSource;
  if(!linkSource){selected=id;graph.select(id);chooseTool('link');return}
  if(linkSource===id)return;
  const a=byId(linkSource),b=byId(id);if(!a||!b)return;
  if(a.links.includes(id)||b.links.includes(a.id))notify(tr('Заметки уже связаны вручную.','These notes already have a manual link.'));
  else{a.links.push(id);a.modified=Date.now();dirty({notes:[a]});notify(tr('Связь добавлена','Link added'))}
  chooseTool('select');render();
}
function pinLabel(n){
  return inSlot(n)?tr('Извлечь из сетки','Take out of grid'):n.pinned?tr('Открепить','Unpin'):tr('Закрепить','Pin');
}
function pin(n){
  if(inSlot(n)){
    const path=areaPath(workspace().areas,n.areaId);
    const parent=path.slice(0,-1).reverse().find(area=>!area.grid);
    placeNotes([n.id],parent?.id??null);return;
  }
  n.pinned=!n.pinned;dirty({notes:[n]});render();
}
function appearance(n){
  openAppearance({note:n,areaColor:areaById(n.areaId)?.color,onChange:value=>{
    n.appearance=value;dirty({notes:[n]});render();
  }});
}
function undoButton(){
  return lastMapAction(workspace()) ? {label:tr('Отменить','Undo'),run:undoWorkspaceChange} : null;
}
function undoWorkspaceChange(){
  if(!ready||editor||openingNote||lockScreen)return;
  cancelTransfers();graph.flushPositions();
  const change=undoMapAction(workspace());
  if(!change){
    notify(tr('Прежнее место больше недоступно.','The previous location is no longer available.'),undoButton());return;
  }
  let ids=[];
  if(['stage-order','stage-insert','stage-delete'].includes(change.kind))ids=[...graph.selectedIds];
  else if(change.kind==='deletion')ids=change.ids??[change.id];
  else if(change.kind!=='area-delete' && Array.isArray(change.before))ids=change.before.map(p=>p.id);
  const gridId=change.kind==='area-delete' && change.area.grid && showingMap()?change.id:null;
  if(!showingMap() && change.kind==='deletion'){
    listSelection.clear();
    if(ids.length>1)for(const id of ids)listSelection.add(id);
    lastListId=ids[0];
  }
  selected=ids.length===1?ids[0]:null;chooseTool('select');graph.changeSelection(new Set(ids),gridId);dirty();
  if(showingMap() && (change.kind==='placement' || change.kind==='positions'))renderMapPlacement(change.before);
  else render();
  if(showingMap()){
    if(change.kind==='deletion' && ids.length===1)graph.focus(ids[0]);
    $('graph').focus({preventScroll:true});
  }else (listNoteRow(ids[0])||$('new-note')).focus({preventScroll:true});
  const msg=change.kind==='area-delete'?tr('Восстановлена «{name}»','Restored “{name}”',{name:change.area.name}):
    change.kind==='deletion'?(ids.length===1?tr('Заметка восстановлена','Note restored'):tr('Восстановлено заметок · ','Notes restored · ')+ids.length):
    change.kind==='stage-insert' && change.releasedCount?tr('Вставка отменена. Новые заметки на карте · {count}',
      'Insertion undone. New notes moved onto the map · {count}',{count:change.releasedCount}):
    change.kind==='stage-insert'?tr('Вставка этапа отменена','Stage insertion undone'):
    change.kind==='stage-delete'?tr('Этап и места заметок восстановлены','Stage and note positions restored'):
    change.kind==='stage-order'?tr('Прежний порядок этапов восстановлен','Previous stage order restored'):
    change.kind==='grid-size' && change.before.stages?tr('Настройки дорожки восстановлены','Previous track settings restored'):
    change.kind==='grid-size'?tr('Настройки сетки восстановлены','Grid settings restored'):tr('Перемещение отменено','Move undone');
  notify(msg,undoButton());
}
function removeNotes(ids){
  const space=workspace();
  const single=ids.length===1;
  const record=single?byId(ids[0]):null;
  if(!ids.length || (single && !record))return;
  const title=single?noteTitle(record):'';
  const d=dialog(single?tr('Удалить заметку?','Delete note?'):tr('Удалить выбранные заметки?','Delete selected notes?'));
  d.box.append(element('p','',single?tr('«{title}» и её связи будут удалены из этого пространства.','“{title}” and its links will be removed from this workspace.',{title}):
    tr('Выбрано заметок · ','Selected notes · ')+ids.length+shortcutLabel(tr('. Удаление можно отменить через Ctrl+Z.','. You can undo this with Ctrl+Z.'))));
  const actions=element('div','dialog-actions');actions.append(button(tr('Отмена','Cancel'),d.close),button(tr('Удалить','Delete'),()=>{
    d.close();
    if(space!==workspace() || !ready || lockScreen || spaceOperation || editor || reviewing)return;
    graph.flushPositions();
    const removed=deleteNotes(space,ids);
    if(!removed)return;
    rememberMapAction(space,{kind:'deletion',ids:removed.map(n=>n.id)});
    selected=null;graph.select(null);listSelection.clear();lastListId=null;chooseTool('select');dirty();render();
    (showingMap()?$('graph'):$('list-stage').querySelector('.note-row')||$('new-note')).focus({preventScroll:true});
    notify(single?tr('Удалена «{title}»','Deleted “{title}”',{title}):tr('Удалено заметок · ','Notes deleted · ')+ids.length,undoButton());
  }));d.box.append(actions);
}
function metricAction(target,kind,anchor){
  const space=workspace();
  return {icon:'metric',name:kind==='area'?tr('Прогресс из таблицы…','Progress from table…'):tr('График из таблицы…','Chart from table…'),run:()=>{
    closeMenu();
    popover=openMetricPicker({target,kind,space,anchor,onClose:closeMenu,onChange:binding=>{
      if(workspace()!==space || lockScreen || isProtectedNote(target))return;
      if(binding)target.mapMetric=binding;else delete target.mapMetric;
      dirty(kind==='area'?{areas:[target]}:{notes:[target]});render();
    }});
  }};
}
const stageMapActive=()=>ready && showingMap() && !editor && !openingNote && !lockScreen;
function insertMapStage(id,index,name){
  if(!stageMapActive())return false;
  if(!insertStageWithHistory(workspace(),id,index,name).ok)return false;
  dirty(gridRecords(id));render();
  notify(tr('Добавлен этап «{name}»','Added stage “{name}”',{name}),undoButton());
  return true;
}
function stageContext(id,index,anchor){
  if(!stageMapActive())return;
  const space=workspace(),area=areaById(id),stages=area?.grid?.stages;
  if(!stages || !Number.isInteger(index) || index<0 || index>=stages.length)return;
  const current=()=>stageMapActive() && workspace()===space && areaById(id)?.grid?.stages===stages;
  menu(anchor,[
    {icon:'edit',name:tr('Переименовать этап…','Rename stage…'),run:()=>{
      if(current())areaDialog(area,{anchor,stageIndex:index});
    }},
    {icon:'trash',name:tr('Удалить этап…','Delete stage…'),run:()=>{
      if(!current())return;
      popover=openStageRemoval({space,area,index,anchor,onClose:closeMenu,onRemove:destination=>{
        if(!current())return false;
        graph.flushPositions();
        const affected=gridRecords(id); // Includes notes released to the map by this deletion.
        if(!deleteStageWithHistory(space,id,index,destination).ok)return false;
        dirty(affected);render();
        notify(tr('Удалён этап «{name}»','Deleted stage “{name}”',{name:stages[index]}),undoButton());
        return true;
      }});
    }}
  ]);
}
function context(id,x,y,gridId=null,openNote=edit){
  const n=byId(id);
  const gridArea=areaById(gridId);
  const sizeAction=gridArea?.grid?.stages?{icon:'sliders',name:tr('Настроить дорожку…','Stage track settings…'),run:()=>areaDialog(gridArea,{anchor:{x,y}})}:
    gridArea?.grid?{icon:'slots',name:tr('Изменить размер сетки…','Resize grid…'),run:()=>areaDialog(gridArea,{focusSpacing:true,anchor:{x,y}})}:null;
  if(!n){
    const pos=graph.world(graph.local({clientX:x,clientY:y}));
    const slot=gridArea?.grid?slotAt(gridArea.grid,pos):null;
    menu({x,y},[...(gridArea?[...(sizeAction?[sizeAction]:[]),metricAction(gridArea,'area',{x,y}),
      {icon:'trash',name:areaDeleteLabel(gridArea),run:()=>deleteFolder(gridArea)},null]:[]),...noteTypeItems(pos,slot===null?null:{areaId:gridId,slot}),null,{icon:'folder',name:tr('Создать область здесь…','Create area here…'),run:()=>areaDialog(null,{point:pos})},
      {icon:'slots',name:tr('Создать сетку здесь…','Create grid here…'),run:()=>areaDialog(null,{point:pos,startAsGrid:true})},
      {icon:'track',name:tr('Создать дорожку этапов…','Create stage track…'),run:()=>areaDialog(null,{point:pos,startAsTrack:true})},
      null,{icon:'fit',name:tr('Уместить карту','Fit map'),run:()=>graph.fit()}]);return;
  }
  const group=showingMap()?graph.selectedIds:listSelection;
  if(group.size>1 && group.has(id)){
    const ids=[...group];
    menu({x,y},[{icon:'folder',name:tr('В область…','Move to area…'),run:()=>pickForNotes(ids,{x,y})},
      {icon:'trash',name:tr('Удалить выбранные заметки','Delete selected notes'),run:()=>removeNotes(ids)}]);return;
  }
  selected=id;graph.select(id);renderSelection();
  menu({x,y},[{icon:isProtectedNote(n)?'lock':'edit',name:tr('Открыть заметку','Open note'),run:()=>openNote(id)},
    ...(isProtectedNote(n)?[]:[{icon:'appearance',name:tr('Внешний вид','Appearance'),run:()=>appearance(n)},metricAction(n,'note',{x,y})]),{icon:inSlot(n)?'slots':'pin',name:pinLabel(n),run:()=>pin(n)},
    {icon:'link',name:tr('Связать с заметкой','Link to another note'),run:()=>chooseTool('link')},...(sizeAction?[sizeAction]:[]),null,{icon:'trash',name:tr('Удалить заметку','Delete note'),run:()=>removeNotes([id])}]);
}
function renderSelection(){
  const s=$('selection'),n=byId(selected);s.hidden=!n||tool==='link';
  if(n)s.replaceChildren(element('strong','',noteTitle(n)),iconButton(isProtectedNote(n)?'lock':'edit',tr('Открыть заметку','Open note'),()=>editFromMap(n.id)),
    ...(isProtectedNote(n)?[]:[iconButton('appearance',tr('Внешний вид','Appearance'),()=>appearance(n))]),iconButton(inSlot(n)?'slots':'pin',pinLabel(n),()=>pin(n)),iconButton('more',tr('Действия','More actions'),e=>{
      const r=e.currentTarget.getBoundingClientRect();context(n.id,r.left,r.top-175,null,editFromMap);
    }));
}
function listNoteRow(id){
  return id==null?null:$('list-stage').querySelector('.note-row[data-note-id="'+CSS.escape(id)+'"]');
}
function selectListNote(id,range,checkbox){
  if(range && lastListId!=null){
    const rows=[...$('list-stage').querySelectorAll('.note-row[data-note-id]')].map(row=>row.dataset.noteId);
    const start=rows.indexOf(lastListId),end=rows.indexOf(id);
    if(start>=0 && end>=0){
      for(const key of rows.slice(Math.min(start,end),Math.max(start,end)+1))listSelection.add(key);
      renderListSelection();return;
    }
  }
  if(listSelection.has(id))listSelection.delete(id);else listSelection.add(id);
  lastListId=id;
  renderListSelection(checkbox);
}
function renderListSelection(changedCheckbox){
  const list=$('list-stage'),bar=$('list-selection');
  bar.hidden=showingMap()||!listSelection.size;
  list.classList.toggle('selecting-notes',!bar.hidden);
  const checks=changedCheckbox?[changedCheckbox]:list.querySelectorAll(listSelection.size?'.note-check':'.is-selected .note-check');
  for(const check of checks){
    const selected=listSelection.has(check.value);
    if(check.checked!==selected)check.checked=selected;
    check.parentElement.classList.toggle('is-selected',selected);
  }
  if(bar.hidden){bar.replaceChildren();return}
  const move=button(tr('В область…','Move to area…'),e=>pickForNotes([...listSelection],e.currentTarget));
  move.prepend(iconEl('folder'));
  bar.replaceChildren(element('span','',tr('Выбрано · ','Selected · ')+listSelection.size),move,
    iconButton('trash',tr('Удалить выбранные заметки','Delete selected notes'),()=>removeNotes([...listSelection])),
    iconButton('x',tr('Снять выделение','Clear selection'),()=>{
      const row=listNoteRow(lastListId??listSelection.values().next().value);
      listSelection.clear();lastListId=null;renderListSelection();row?.focus();
    }));
}
function renderList(){
  const list=$('list-stage');list.replaceChildren();
  const {areas,notes}=workspace(), children=page==='area'?areas.filter(a=>a.parentId===currentArea):[];
  if(page==='area'){
    const ancestors=areaPath(areas,currentArea);
    if(ancestors.length>1){
      const path=element('nav','area-breadcrumbs');path.setAttribute('aria-label',tr('Путь области','Area path'));
      for(const ancestor of ancestors.slice(0,-1)){
        const back=button(ancestor.name,()=>navigate('area',ancestor.id),'plain');
        back.title=ancestor.name;path.append(back,iconEl('chevron'));
      }
      const here=element('strong','',ancestors.at(-1).name);here.title=here.textContent;
      path.append(here);list.append(path);
    }
    for(const child of children){
      const row=element('button','note-row child-area');row.dataset.areaId=child.id;row.title=child.name;
      const glyph=iconEl(child.grid?.stages?'track':child.grid?'slots':'folder');glyph.style.color=child.color;
      row.append(glyph,element('strong','',child.name),iconEl('chevron'));
      row.onclick=()=>navigate('area',child.id);
      row.oncontextmenu=e=>{e.preventDefault();areaActions(child,{x:e.clientX,y:e.clientY})};
      list.append(row);
    }
  }
  const grid=page==='area'&&areaById(currentArea)?.grid;
  const items=notes.filter(n=>page==='pinned'?isPinned(n):page==='area'?n.areaId===currentArea:true)
    .sort((a,b)=>grid?(grid.stages?(a.slot%grid.cols)-(b.slot%grid.cols):0)||a.slot-b.slot:(b.modified||0)-(a.modified||0));
  if(grid){
    const info=element('div','area-grid-info');
    info.append(iconEl('slots'),element('span','',grid.cols+' × '+grid.rows+' · '+tr('Занято ','Occupied ')+items.length+' / '+grid.cols*grid.rows),
      button(tr('Показать на карте','Show on map'),()=>showArea(currentArea)));
    list.prepend(info);
  }
  if(listSelection.size){
    const visible=new Set(items.map(item=>item.id));
    for(const id of listSelection)if(!visible.has(id))listSelection.delete(id);
  }
  if(!items.length && !children.length){
    const empty=element('div','list-empty');empty.append(iconEl(page==='pinned'?'pin':'list'),
      element('h2','',page==='pinned'?tr('Пока нет закреплённых заметок','No pinned notes yet'):tr('Здесь пока нет заметок','No notes here yet')),
      element('p','',page==='pinned'?tr('Закрепите заметку через меню круга или в редакторе.','Pin a note from its map menu or in the editor.'):tr('Создайте первую заметку в этой коллекции.','Create the first note in this collection.')));
    if(page!=='pinned')empty.append(button(tr('Создать заметку','Create a note'),()=>addNote(),'primary'));list.append(empty);
  }
  const areaIndex=new Map(areas.map(a=>[a.id,a]));
  const fragment=document.createDocumentFragment(),batchSize=32;
  let batch=fragment;
  for(const [index,n] of items.entries()){
    if(items.length>128 && index%batchSize===0){
      batch=element('div','note-list-batch');
      batch.style.setProperty('--batch-height',Math.min(batchSize,items.length-index)*68+'px');
      fragment.append(batch);
    }
    const entry=element('div','note-list-entry'),check=element('input','note-check');
    check.type='checkbox';check.value=n.id;check.setAttribute('aria-label',tr('Выбрать «{name}»','Select “{name}”',{name:noteTitle(n)}));
    check.onclick=e=>selectListNote(n.id,e.shiftKey,check);
    const row=element('button','note-row'),symbol=element('span','row-symbol'),summary=element('span','note-summary');
    row.dataset.noteId=n.id;
    const canvas=n.type==='canvas',data=n.type==='data',locked=isProtectedNote(n);
    symbol.title=locked?protectedNoteTitle():canvas?tr('Заметка-холст','Canvas note'):data?tr('Заметка с данными','Data note'):tr('Текстовая заметка','Text note');
    symbol.append(iconEl(locked?'lock':canvas?'board':data?'newData':inSlot(n)?'slots':n.pinned?'pin':'list'));
    const content=data?n.dataText:n.plain;
    const snippet=locked?tr('Открыть по паролю','Open with password'):
      typeof content==='string' && content?content:canvas?tr('Холст','Canvas'):tr('Пустая заметка','Empty note');
    const preview=snippet.length>320?snippet.slice(0,320).replace(/[\uD800-\uDBFF]$/u,'')+'…':snippet;
    summary.append(element('strong','',noteTitle(n)),element('small','',preview));row.append(symbol,summary);
    const area=areaIndex.get(n.areaId);
    if(area){
      const coords=area.grid&&Number.isInteger(n.slot)?(Math.floor(n.slot/area.grid.cols)+1)+', '+(n.slot%area.grid.cols+1):'';
      const stage=area.grid?.stages?.[n.slot%area.grid.cols];
      const label=area.name+(stage?' · '+stage:coords?' · '+coords:'');
      const pill=element('span','area-pill');
      pill.title=label+(coords?' ('+tr('Строка, столбец','Row, column')+' · '+coords+')':'');
      pill.append(areaMarker(area),element('span','area-pill-label',label));row.append(pill);
    }
    row.append(iconEl('chevron'));row.onclick=e=>{
      if(e.shiftKey||e.ctrlKey||e.metaKey||listSelection.size)selectListNote(n.id,e.shiftKey,check);
      else edit(n.id);
    };
    row.oncontextmenu=e=>{e.preventDefault();context(n.id,e.clientX,e.clientY)};
    entry.append(check,row);batch.append(entry);
  }
  list.append(fragment);
  renderListSelection();
}
function dot(color){const d=element('span','area-dot');d.style.setProperty('--dot',color);return d}
function areaMarker(area){
  if(!area.grid)return dot(area.color);
  const i=iconEl(area.grid.stages?'track':'slots');i.className='area-grid-mark';i.style.color=area.color;return i;
}
let sidebarTree, treeSpaceId;
function toggleTreeArea(item){
  if(item.expanded)collapsedAreas.add(item.id);else collapsedAreas.delete(item.id);
  renderAreas(workspace().areas);
}
function sidebarRow(item){
  const folder=item.kind==='area',active=folder && page==='area' && currentArea===item.id;
  const row=element('div',folder?'area-tree-row'+(active?' is-active':''):'tree-note-row');
  const open=element('button',folder?'nav-item area-tree-link':'nav-item tree-note-link');
  open.type='button';open.setAttribute('role','treeitem');
  const glyph=iconEl(item.icon);if(folder)glyph.style.color=item.color;
  open.append(glyph,element('span','',item.title));
  if(folder){
    row.dataset.areaId=item.id;
    if(item.branch){
      const toggle=iconButton(item.expanded?'chevronDown':'chevron',
        (item.expanded?tr('Свернуть ','Collapse '):tr('Развернуть ','Expand '))+item.title,()=>toggleTreeArea(item));
      toggle.classList.add('area-disclosure');toggle.tabIndex=-1;
      toggle.setAttribute('aria-expanded',String(item.expanded));open.setAttribute('aria-expanded',String(item.expanded));
      row.append(toggle);
    }else row.append(element('span','area-disclosure-space'));
    open.title=item.path+(item.gridSize?' · '+item.gridSize:'');
    if(active)open.setAttribute('aria-current','page');
    open.onclick=()=>navigate('area',item.id);
    const actions=anchor=>{const area=areaById(item.id);if(area)areaActions(area,anchor)};
    row.oncontextmenu=e=>{e.preventDefault();actions(e.clientX||e.clientY?{x:e.clientX,y:e.clientY}:open)};
    const more=iconButton('more',tr('Действия с областью «{name}»','Actions for area “{name}”',{name:item.title}),e=>actions(e.currentTarget));
    more.classList.add('area-more');more.tabIndex=-1;more.setAttribute('aria-haspopup','menu');
    row.append(open,more);
  }else if(item.kind==='note'){
    open.dataset.noteId=item.id;
    const kind=item.icon==='board'?tr('Заметка-холст','Canvas note'):item.icon==='newData'?tr('Заметка с данными','Data note'):tr('Текстовая заметка','Text note');
    open.title=item.icon==='lock'?item.title:item.title+' · '+kind;
    open.onclick=()=>edit(item.id);
    open.oncontextmenu=e=>{
      e.preventDefault();const box=open.getBoundingClientRect();
      context(item.id,e.clientX||box.left,e.clientY||box.bottom);
    };
    row.append(open);
  }else{
    open.classList.add('add-area-inline');open.onclick=()=>areaDialog();row.append(open);
  }
  if(folder || item.kind==='note')open.onkeydown=e=>{
    if(!isDeleteKey(e) || e.defaultPrevented || e.isComposing || e.keyCode===229 || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ||
        !ready || editor || openingNote || lockScreen || reviewing || spaceOperation || popover)return;
    e.preventDefault();e.stopPropagation();
    if(folder){
      const area=areaById(item.id);if(area)deleteFolder(area);
    }else removeNotes([item.id]);
  };
  return row;
}
function renderAreas(areas){
  sidebarTree??=mountSidebarTree($('areas'),sidebarRow,toggleTreeArea);
  if(lockScreen || !library.active){sidebarTree.clear();return}
  if(treeSpaceId!==library.active){
    sidebarTree.clear();treeSpaceId=library.active;$('areas').closest('nav').scrollTop=0;
  }
  const rows=sidebarRows(areas,workspace().notes,collapsedAreas,n=>({
    title:noteTitle(n),icon:isProtectedNote(n)?'lock':n.type==='canvas'?'board':n.type==='data'?'newData':'newTextNote'
  }));
  if(!rows.length)rows.push({kind:'add',depth:0,parentId:null,icon:'folder',title:tr('Создать область','Create area')});
  sidebarTree.update(rows,tr('Области и заметки','Areas and notes'));
}
const mapNote=n=>isProtectedNote(n)?{...n,title:protectedNoteTitle()}:n;
function renderMapPlacement(states){
  const {notes,areas}=workspace();
  graph.setData(notes.map(mapNote),areas,new Set(states.map(state=>state.id)));
  $('pin-count').textContent=notes.filter(isPinned).length;
  renderAreas(areas);
  renderSelection();
}
function render(){
  syncMapVisibility();
  const {notes,areas}=workspace(),map=showingMap(),area=areaById(currentArea);
  const views={map:tr('Карта заметок','Note map'),list:tr('Все заметки','All notes'),pinned:tr('Закреплённые','Pinned notes')};
  const title=views[page]||area?.name||tr('Область','Area');
  $('crumb-page').textContent=page==='map'?tr('Карта','Map'):title;
  const hasSpace=!!library.active;
  $('space-name').textContent=$('crumb-space').textContent=hasSpace?spaceTitle(library.active,folderSession?.link??workspace()):tr('Выберите пространство','Choose a space');
  $('shell').classList.toggle('no-space',!hasSpace);
  $('space-welcome').hidden=hasSpace;
  $('welcome-folder').hidden=!native;
  if(!hasSpace){
    const existing=Object.keys(library.spaces).length>0;
    $('welcome-create').replaceChildren(iconEl(existing?'layers':'plus'),document.createTextNode(existing?
      tr('Выбрать пространство','Choose a space'):tr('Создать пространство','Create space')));
  }
  for(const control of document.querySelectorAll('[data-page],#new-area,#search'))control.disabled=!hasSpace;
  $('all-count').textContent=notes.length;$('pin-count').textContent=notes.filter(isPinned).length;
  document.querySelectorAll('[data-page]').forEach(b=>{
    const active=b.dataset.page===page;
    b.classList.toggle('active',active);
    if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  });
  renderAreas(areas);
  $('map-stage').hidden=!map;$('list-stage').hidden=map;
  $('routes').hidden=!map;
  mapMetrics=map && !lockScreen?resolveMapMetrics(workspace()):null;
  graph.setView(library.view);graph.setData(notes.map(mapNote),areas);
  if(tool==='link')renderLinkHint();
  reading?.invalidate();routes?.refresh();
  if(selected || (!graph.selectedGridId && graph.selectedIds.size<2))graph.select(selected);
  $('empty').hidden=!map||notes.length>0||areas.length>0;$('try-demo').hidden=library.active==='demo'||!!library.demoHidden;
  $('view').hidden=!map&&page!=='area';
  $('view').replaceChildren(iconEl(map?'sliders':'folder'),document.createTextNode(map?tr('Вид','View'):tr('Область','Area')));
  if(!map)renderList();else $('list-selection').hidden=true;
  renderSelection();
}
let openingSearch=false,searchLifetime=null,activeSearch=null;
function refreshOpenSearch(){
  if(!activeSearch)return;
  const {dialog,onDismiss}=activeSearch,state=dialog.state();
  searchLifetime.abort(); // Drop the old rows and worker before displaying the merged workspace.
  if(state && !lockScreen && !closingApp)void search(state,onDismiss);
}
async function search(initialState={},onDismiss){
  if(!ready||lockScreen||closingApp||spaceOperation||openingSearch||document.querySelector('.vs-shade'))return;
  cancelTransfers();
  openingSearch=true;
  searchLifetime?.abort();
  const lifetime=new AbortController();
  searchLifetime=lifetime;
  const origin=editor,originId=selected;
  const returnToOrigin=origin?edit.bind(null,originId,origin.returnToResults,null,{mapVisit:origin.mapVisit}):onDismiss;
  closeMenu();
  try{
    const {openSearch}=await import('./search.js');
    if(reviewing)await folderPoll;
    if(editorMerge)await editorMerge.catch(()=>{});
    if(lockScreen||closingApp||spaceOperation||!ready||lifetime.signal.aborted)return;
    editor?.flush?.();
    const dialog=openSearch({notes:workspace().notes,areas:workspace().areas,initialState,signal:lifetime.signal,
      onClose:()=>{
        if(searchLifetime===lifetime)activeSearch=null;
        if(reviewing)$('shell').inert=true;
      },
      onDismiss:async()=>{
        if(reviewing)await folderPoll;
        if(!lifetime.signal.aborted && !lockScreen && !closingApp)onDismiss?.();
      },
      onOpen:async(id,state,target)=>{
        const original=byId(id);
        if(reviewing)await folderPoll;
        if(editorMerge)await editorMerge.catch(()=>{});
        const searchable=()=>{
          const note=byId(id);
          return !lifetime.signal.aborted && !lockScreen && !closingApp && note && !isProtectedNote(note);
        };
        if(!searchable())return;
        if(origin && id===originId){
          if(target && byId(id)===original)origin.revealSearchMatch(target);
          return;
        }
        if(origin && !await origin.prepareClose())return;
        if(!searchable())return;
        if(byId(id)!==original)target=null;
        edit(id,search.bind(null,state,returnToOrigin),target);
      }});
    if(dialog)activeSearch={dialog,onDismiss};
  }
  catch(error){notify(tr('Не удалось открыть поиск. ','Could not open search. ')+String(error))}
  finally{openingSearch=false}
}
const narrowSidebar=matchMedia('(max-width:680px)');
function updateSidebarToggle(){
  const open=narrowSidebar.matches?$('shell').classList.contains('mobile-open'):!$('shell').classList.contains('collapsed');
  const b=$('sidebar-toggle'),label=open?tr('Скрыть боковую панель','Hide sidebar'):tr('Показать боковую панель','Show sidebar');
  b.title=shortcutLabel(label+' (Ctrl+\\)');b.setAttribute('aria-keyshortcuts',shortcutAria('Ctrl+\\'));b.setAttribute('aria-label',label);b.setAttribute('aria-expanded',String(open));
  b.replaceChildren(iconEl(open?'panelClose':'panelOpen'));
}
function toggleSidebar(){
  $('shell').classList.toggle(narrowSidebar.matches?'mobile-open':'collapsed');updateSidebarToggle();
}
function isDeleteKey(event){
  return event.key==='Delete' || (event.key==='Backspace' && isMacPlatform());
}
function updateLanguageSelector(){
  const select=$('language-select');
  select.replaceChildren(...getLanguages().map(({code,name})=>{
    const option=new Option(name,code);
    option.lang=code;
    return option;
  }));
  select.value=getLanguage();
}
function loadLibraryLanguages(){
  setLanguagePacks(library.languagePacks ?? []);
  updateLanguageSelector();
  translateStatic();
}
function refreshLanguage(){
  stageControls?.reset();
  translateStatic();closeMenu();$('toast').hidden=true;
  $('language-select').value=getLanguage();
  if(translateDemoSamples(library.spaces.demo))dirty({spaceId:'demo',all:true});
  status();syncBadge();updateSidebarToggle();render();
}
function chooseLanguage(code){
  const persisted=setLanguage(code);
  refreshLanguage();
  if(!persisted)notify(tr('Выбор языка действует до закрытия окна.','Your language choice will last until this window closes.'));
}
function saveExtensions(items,changed){
  if(changed.type==='language'){
    const packs=items.filter(item=>item.type==='language');
    const previous=getLanguage();
    setLanguagePacks(packs);
    if(packs.length)library.languagePacks=packs;
    else delete library.languagePacks;
    dirty({settings:['languagePacks']});
    updateLanguageSelector();
    if(previous!==getLanguage() || changed.locale===getLanguage())refreshLanguage();
  }else{
    library.plugins=items.filter(item=>item.type!=='language');
    dirty({settings:['plugins']});
  }
}
function bindUI(){
  $('sync-review').onclick=async()=>{
    if(lockScreen || !folderSession || reviewing)return;
    if(editor && !await editor.prepareClose())return;
    folderSession.deferred=null;await pollFolder(true);
  };
  window.addEventListener('focus',()=>queueSync(150));
  window.addEventListener('online',()=>{if(folderSession)folderSession.nextExchange=0;queueSync(20)});
  window.addEventListener('offline',()=>{if(folderSession?.connection?.address){folderSession.nextExchange=0;queueSync(20)}});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)saveMapView();else queueSync(100);
    syncMapVisibility();
  });
  window.addEventListener('pagehide',saveMapView);
  const resumeFolderPoll=()=>{if(folderSession?.pollAfterGesture)queueSync(60)};
  for(const type of ['pointerup','pointercancel','lostpointercapture'])
    document.addEventListener(type,resumeFolderPoll,{capture:true});
  narrowSidebar.addEventListener('change',updateSidebarToggle);updateSidebarToggle();
  $('language-select').onchange=e=>chooseLanguage(e.target.value);
  $('workspace-switch').onclick=e=>spaceMenu(e.currentTarget);
  $('welcome-create').onclick=e=>Object.keys(library.spaces).length?spaceMenu(e.currentTarget):newSpaceForm();
  $('welcome-folder').onclick=attachSpace;
  document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>navigate(b.dataset.page));
  $('sidebar-toggle').onclick=toggleSidebar;
  $('new-area').onclick=()=>areaDialog();$('try-demo').onclick=()=>switchSpace('demo');
  $('new-note').onclick=$('first-note').onclick=()=>addNote();
  $('new-canvas').onclick=()=>addNote(graph.worldCenter(),'canvas');
  $('new-data').onclick=()=>addNote(graph.worldCenter(),'data');
  $('routes').onclick=e=>{closeMenu();if(tool!=='select')chooseTool('select');routes.open(e.currentTarget)};
  $('cancel-link').onclick=()=>chooseTool('select');
  $('plus').onclick=()=>graph.zoomBy(1.2);$('minus').onclick=()=>graph.zoomBy(1/1.2);
  $('actual-size').onclick=()=>graph.zoomBy(1/graph.zoom);$('fit').onclick=()=>graph.fit();
  $('map-stage').querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{chooseTool(tool==='link'&&b.dataset.tool==='link'?'select':b.dataset.tool);renderSelection()});
  $('view').onclick=e=>{
    if(page==='area'){areaActions(areaById(currentArea),e.currentTarget);return}
    menu(e.currentTarget,[
      ['manualLayout','pointer',tr('Свободная расстановка','Free layout'),tr('Расставлять заметки вручную и скрыть линии связей','Position notes by hand and hide link lines')],
      ['labels','text',tr('Названия заметок','Note titles')],
      ...(!graph.view.manualLayout ? [['links','link',tr('Линии связей','Link lines')]] : []),
      ['grid','grid',tr('Точечная сетка','Dot grid')],['reading','zoomIn',tr('Читать приближением','Read as you zoom')]
    ].map(([key,symbol,name,title])=>({
      name,title,icon:symbol,checked:graph.view[key],run:()=>{library.view[key]=!graph.view[key];graph.setView(library.view);dirty({settings:['view']})}
    })));
  };
  $('help').onclick=showHelp;$('search').onclick=()=>search();$('settings').onclick=settings;
  $('extensions').onclick=()=>openExtensions({workspace:workspace(),plugins:[...library.plugins,...(library.languagePacks??[])],
    onSavePlugins:saveExtensions,onSelectLanguage:chooseLanguage,onOpenNote:edit,notify});
  document.addEventListener('keydown',e=>{
    const find=e.code==='KeyF' && e.shiftKey, save=e.code==='KeyS' && !e.shiftKey && editor && !editor.element.inert;
    if(!(find||save)||!primaryCommand(e)||e.isComposing||e.keyCode===229||e.defaultPrevented)return;
    if(!ready||!library.active||spaceOperation||openingNote||lockScreen||reviewing)return;
    if(document.querySelector('.shade,dialog[open],[role="dialog"]:not(.vd-editor)'))return;
    e.preventDefault();e.stopPropagation();
    if(!e.repeat){if(save)void saveOpenEditor();else search()}
  },true);
  document.addEventListener('keydown',e=>{
    if(e.defaultPrevented||e.isComposing||e.keyCode===229||e.altKey)return;
    const command=primaryCommand(e);
    if((e.ctrlKey||e.metaKey) && !command)return;
    if(!ready||!library.active||spaceOperation||openingNote||openingSearch||reviewing||editor||lockScreen||popover||
        document.querySelector('.shade,[role="dialog"],dialog[open]'))return;
    if(e.target.isContentEditable || e.target.closest?.('input:not([type=checkbox]),textarea,select'))return;
    const mapFocused=showingMap() && (e.target===document.body || e.target.closest?.('.page'));
    if(mapFocused && routes.keydown(e))return;
    if(!command && !e.shiftKey && e.key==='Escape'){
      if(e.repeat)return;
      selected=null;graph.select(null);listSelection.clear();lastListId=null;chooseTool('select');renderSelection();renderListSelection();return;
    }
    if(command && !e.shiftKey && e.code==='KeyA'){
      if(e.target===$('graph') && showingMap()){
        e.preventDefault();
        if(!e.repeat && !graph.drag && !graph.pinch && !$('map-stage').dataset.routeMode){
          if(tool!=='select')chooseTool('select');
          graph.changeSelection(new Set(graph.nodes.keys()));
        }
      }else if(!showingMap() && $('list-stage').contains(e.target)){
        e.preventDefault();
        if(!e.repeat){
          for(const row of $('list-stage').querySelectorAll('[data-note-id]'))listSelection.add(row.dataset.noteId);
          renderListSelection();
        }
      }
      return;
    }
    if(command && !e.shiftKey && e.code==='KeyZ' && lastMapAction(workspace())){
      e.preventDefault();if(!e.repeat)undoWorkspaceChange();return;
    }
    if(command && !e.shiftKey && e.code==='KeyK'){e.preventDefault();if(!e.repeat)search();return}
    if(command && e.code==='KeyN'){e.preventDefault();if(!e.repeat)addNote(graph.worldCenter(),e.shiftKey?'canvas':'text');return}
    if(command && !e.shiftKey && e.code==='Backslash'){e.preventDefault();if(!e.repeat)toggleSidebar();return}
    if(command)return;
    if(e.key==='?' || (e.key==='F1' && !e.shiftKey)){e.preventDefault();if(!e.repeat)showHelp();return}
    if(isDeleteKey(e) && !e.shiftKey && !e.repeat){
      if(showingMap() && e.target===$('graph') && tool==='select' && !graph.drag && !graph.pinch && !$('map-stage').dataset.routeMode){
        const grid=areaById(graph.selectedGridId);
        if(grid?.grid){e.preventDefault();deleteFolder(grid)}
        else if(graph.selectedIds.size){e.preventDefault();removeNotes([...graph.selectedIds])}
      }else if(!showingMap() && ($('list-stage').contains(e.target) || $('list-selection').contains(e.target))){
        const row=e.target.closest('[data-note-id]');
        const ids=listSelection.size?[...listSelection]:row?[row.dataset.noteId]:[];
        if(ids.length){e.preventDefault();removeNotes(ids)}
      }
      return;
    }
    if(!mapFocused || graph.drag || graph.pinch)return;
    if(e.key==='+' || e.key==='=' || e.key==='-' || e.key==='0'){
      e.preventDefault();
      if(e.key==='0')graph.zoomBy(1/graph.zoom);
      else graph.zoomBy(e.key==='-'?1/1.2:1.2);
      return;
    }
    if(e.shiftKey || e.repeat)return;
    if(e.code==='KeyF'){e.preventDefault();graph.fit();return}
    const nextTool={KeyV:'select',KeyH:'hand',KeyL:'link'}[e.code];
    if(nextTool){e.preventDefault();chooseTool(nextTool);return}
    if(e.key==='Enter'&&e.target===$('graph')&&selected){e.preventDefault();editFromMap(selected)}
  });
}
async function loadDesktopLibrary(){
  // A WebView reload starts with a fresh idle timer and no remembered unlocks.
  await native.ForgetSuspendedFolderKeys?.();
  let resume='';
  let loaded;
  for(;;){
    if(lockDuringStartup){
      lockDuringStartup=false;
      if(await native.IsProjectProtected())await native.LockProject();
    }
    try{
      loaded=await native.Load();library=readLibrary(loaded);
      projectProtected=await native.IsProjectProtected();
    }catch(error){
      if(String(error?.message||error).split('|')[0]!=='VD_LOCKED')throw error;
      if(lockDuringStartup)continue;
      projectProtected=true;
      const opened=await showVaultUnlock({onUnlock:async password=>{
        loaded=await native.UnlockProject(password);library=readLibrary(loaded);
      }});
      if(!opened || lockDuringStartup){lockDuringStartup=true;continue}
    }
    resume=(await native.TakeResumeNote())||resume;
    if(lockDuringStartup)continue;
    if(native.SaveCatalogPatch && native.CatalogRevision){
      catalogRevision=await native.CatalogRevision();
      catalogRecords=new CatalogRecords(loaded?JSON.parse(loaded):library,library);
      catalogRecords.markAll(); // Persist migrations applied by readLibrary before accepting later record edits.
      loaded=null;
    }else catalogSnapshot=serializeLibrary(library);
    loadLibraryLanguages();
    const entry=library.spaces[library.active];
    if(isFolderSpace(entry)){
      let notice='';
      try{
        const info=await native.InspectSpaceFolder(entry.folder);
        folderSession=await readSpaceFolder(native,info,promptForSpace,entry);
      }catch(error){notice=storageErrorMessage(error)}
      if(lockDuringStartup){
        if(folderSession)await native.CloseFolderSpace(folderSession.folder);
        folderSession=null;continue;
      }
      if(folderSession)library.spaces[library.active]=folderSession.link;
      else{
        library=localFallback(library);resume='';startupNotice=notice;
      }
    }
    return resume;
  }
}
async function init(){
  initTheme();
  translateStatic();$('language-select').value=getLanguage();status();
  paintIcons();drawAtlas($('atlas'));
  window.addEventListener('videron:themechange',()=>{
    drawAtlas($('atlas'));graph?.repaint();reading?.invalidate();
  });
  native=window.go?.main?.App;
  if(!native&&(!/^https?:$/.test(location.protocol)||!['localhost','127.0.0.1','[::1]'].includes(location.hostname)))
    throw new Error(tr('Не удалось подключить локальное хранилище.','Could not connect to local storage.'));
  if(native&&window.runtime){
    idle=createIdleLock({onIdle:requestLock});
    async function consumeLock(){
      if(await native.ConsumeSessionLock())requestLock();
    }
    window.runtime.EventsOn('videron:session-lock',()=>{
      requestLock();void native.ConsumeSessionLock();
    });
    window.addEventListener('focus',consumeLock);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)void consumeLock()});
    await consumeLock();
    let closing=false;
    window.runtime.EventsOn('videron:close-requested',async()=>{
      if(closing)return;closing=true;
      try{
        saveMapView();
        closingApp=true;dismissWorkspaceConflicts();dismissWorkspaceServer();
        if(folderPoll)await folderPoll.catch(()=>{});
        if(spaceOperation){await interruptVaultDialogs();await spaceOperation.catch(()=>{})}
        if(openingNote){await interruptVaultDialogs();await openingNote}
        if(locking)await locking;
        if(ready&&lockScreen){closingApp=closing=false;return}
        if(policyWrite)await policyWrite;
        if(editor && !await editor.prepareClose()){closingApp=closing=false;queueSync();return}
        if(ready){cancelTransfers();graph.flushPositions();await flush()}
        if(ready)await finishServerWrites();
        await native.FinishClose();
      }catch(error){closingApp=closing=false;queueSync();reportWriteError(error)}
    });
    await native.EnableCloseGuard();
  }
  let resume='';
  if(native)resume=await loadDesktopLibrary();
  else{
    library=readLibrary(localStorage.getItem(storageKey));
    loadLibraryLanguages();
    catalogSnapshot=serializeLibrary(library);
    if(isFolderSpace(library.spaces[library.active])){
      library=localFallback(library);startupNotice=tr('Откройте папку пространства в настольном приложении.','Open the space folder in the desktop app.');
    }
  }
  const demoChanged=translateDemoSamples(library.spaces.demo);
  $('shell').hidden=false;
  areaDrag=mountAreaDrag({sidebar:$('sidebar'),tree:$('areas'),list:$('list-stage'),
    getWorkspace:workspace,getListSelection:()=>listSelection,onAssign:placeNotes,onMove:placeArea,
    onExpand:id=>{if(collapsedAreas.delete(id))renderAreas(workspace().areas)}
  });
  const stage=$('map-stage');
  reading=mountMapReading({stage,getNote:byId,getMetric:id=>mapMetrics?.notes.get(id),isActive:()=>ready && showingMap() && !lockScreen && !editor && !openingNote && !routes?.isEditing(),
    onChange:note=>dirty({notes:[note]}),onOpen:editFromMap});
  routes=mountMapRoutes({stage,getSpace:workspace,getFragments:readingFragments,onChange:()=>dirty({meta:true}),
    onVisit:(id,fragment)=>{
      const node=graph.nodes.get(id);if(!node)return;
      routeCamera??={...graph.camera};
      graph.fly(node.x,node.y,Math.min(2.25,Math.max(1.35,graph.zoom)));
      reading.present(graph,id,fragment);
    },onStop:()=>{
      reading.release();
      if(routeCamera){graph.fly(routeCamera.x,routeCamera.y,routeCamera.zoom);routeCamera=null}
    },onModeChange:()=>graph?.repaint()});
  const editMapGrid=(id,anchor,stageIndex=null)=>{
    const area=areaById(id);
    if(!area?.grid || !ready || editor || lockScreen)return;
    if(popover?.classList.contains('stage-settings') && popover.anchor===anchor){closeMenu();return}
    areaDialog(area,{anchor,stageIndex});
  };
  stageControls=mountStageControls({canvas:$('graph'),onEdit:editMapGrid,onInsert:insertMapStage});
  graph=new Graph($('graph'),{onSelect:id=>{selected=id;renderSelection()},onAreaAction:pickForNotes,onOpen:editFromMap,onLink:linkClick,
    onContext:(id,x,y,gridId)=>context(id,x,y,gridId,editFromMap),
    onEditStage:(id,col,anchor)=>editMapGrid(id,anchor,col),
    onStageContext:stageContext,
    onStageReorder:(id,from,to)=>{
      if(!ready || editor || openingNote || lockScreen || !showingMap())return false;
      if(!reorderStageWithHistory(workspace(),id,from,to))return false;
      const names=areaById(id).grid.stages;
      dirty(gridRecords(id));render();
      notify(tr('«{name}» · этап {index} из {total}','“{name}” · stage {index} of {total}',
        {name:names[to],index:to+1,total:names.length}),undoButton());
      return true;
    },
    onNewGridNote:(areaId,slot,point)=>addNote(point,'text',{areaId,slot}),
    recordingRoute:routes.isEditing,onRoutePick:routes.pick,onMapFrame:g=>{
      rememberMapView();
      reading.sync(g);if(showingMap()){stageControls.sync(g);popover?.followMap?.()}
    },onDrawRoute:routes.draw,
    onDrawAreaMetric:(ctx,group,view)=>{const metric=mapMetrics?.areas.get(group.id);if(metric)drawAreaMetric(ctx,group,metric,view)},
    onDrawNoteMetric:(ctx,id,point)=>{const metric=mapMetrics?.notes.get(id);if(metric)drawNoteMetric(ctx,metric,point)},
    onNoteDragMove:areaDrag.hoverNotes,onNoteDrop:areaDrag.dropNotes,onNoteDragEnd:areaDrag.clear,
    onMapDrop:(ids,id,slot,positions)=>placeNotes(ids,id,false,slot,positions),
    onReleaseSeats:positions=>{
      if(!ready || editor || openingNote || lockScreen)return;
      const space=workspace(),change=releaseGridNotes(space,positions,{movePinned:graph.view.manualLayout});
      if(!change.ok || !change.after.length)return;
      rememberMapAction(space,{kind:'placement',before:change.before,after:change.after});
      dirty({notes:change.after.map(p=>byId(p.id))});
      if(showingMap())renderMapPlacement(change.after);else render();
      notify(tr('Перенесено на карту','Moved onto the map'),undoButton());
    },
    onManualMove:before=>{
      if(!before.length)return;
      rememberMapAction(workspace(),{kind:'positions',before});
      if(before.length>1)notify(tr('Перемещено заметок · ','Notes moved · ')+before.length,undoButton());
      else if($('toast').querySelector('.toast-action'))$('toast').hidden=true;
    },
    onGridSpacing:(id,spacing)=>{
      const grid=areaById(id)?.grid;
      if(!grid||!resizeGridWithHistory(workspace(),id,grid.rows,grid.cols,spacing))return false;
      dirty(gridRecords(id));render();notify(grid.stages?tr('Шаг дорожки изменён','Stage spacing updated'):tr('Размер сетки изменён','Grid resized'),undoButton());return true;
    },
    onGridMove:(id,x,y)=>{
      const g=areaById(id)?.grid;
      if(!g)return false;
      const before={x:g.x,y:g.y};
      if(!moveAreaGrid(workspace(),id,x,y))return false;
      rememberMapAction(workspace(),{kind:'grid',id,before});dirty(gridRecords(id));render();
      notify(g.stages?tr('Дорожка перемещена','Stage track moved'):tr('Сетка перемещена','Grid moved'),undoButton());return true;
    },
    onMove:changes=>{
      const moved=[];
      for(const p of changes){
        const n=byId(p.id);
        if(n){n.x=p.x;n.y=p.y;moved.push(n)}
      }
      if(moved.length)dirty({notes:moved});
    },onZoom:scale=>$('actual-size').textContent=Math.round(scale*100)+'%'});
  ready=true;bindUI();render();status();syncIdle();
  queueSync(200);
  if(catalogRecords)dirty({catalogOnly:true});
  else if(demoChanged || catalogSnapshot!==serializeLibrary(library))dirty();
  if(startupNotice)notify(startupNotice);
  restoreMapView();
  if(resume && byId(resume))await edit(resume);
  if(!native)window.addEventListener('pagehide',()=>{editor?.flush?.();graph.flushPositions();if(saved!==revision)localStorage.setItem(storageKey,serializeLibrary(library))});
}
init().catch(error=>{
  ready=false;status('unavailable');
  const d=dialog(tr('Не удалось открыть пространство','Could not open the workspace'),false),retry=button(tr('Повторить открытие','Try again'),()=>location.reload());
  d.box.append(element('p','',storageErrorMessage(error)),retry);$('shell').inert=true;retry.focus();
});
