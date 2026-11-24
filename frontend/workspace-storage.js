import { checkWorkspace, isFolderSpace, spaceNames, validSpaceName } from './data.js';
import { WorkspaceRecords } from './workspace-records.js';

export function spaceTitle(id,space){
  return space?.name || spaceNames[id];
}

export function localFallback(catalog){
  const key=Object.keys(catalog.spaces).find(id=>!isFolderSpace(catalog.spaces[id]));
  return {...catalog,version:3,active:key??''};
}

// Opening a temporary local space may follow a cancelled unlock or an unavailable drive.
// Keep the last chosen folder in the catalog while still saving edits to the visible space.
export function catalogWithStartupFolder(catalog,folderId){
  return folderId && isFolderSpace(catalog.spaces[folderId]) && catalog.active!==folderId
    ? {...catalog,active:folderId} : catalog;
}

export function folderEntry(spaces,path){
  // Native inspection resolves aliases. Case is also insignificant for a drive or UNC path.
  const key=p=>/^[a-z]:[\\/]|^\\\\/i.test(p)?p.toLowerCase():p;
  return Object.entries(spaces).find(([,s])=>isFolderSpace(s) && key(s.folder)===key(path));
}

async function session(bridge,folder,encrypted,data,raw,opening){
  const result={folder,encrypted,data,link:{folder,encrypted,name:data.name}};
  if(bridge.SaveFolderPatch && bridge.FolderPatchRevision){
    // Track the disk representation before validation repairs legacy grid slots or routes.
    result.records=new WorkspaceRecords(data);
    if(opening){
      checkWorkspace(data);
      result.records.mark();
      const repairs=result.records.prepare(data);
      if(!repairs.patch)repairs.commit();
    }
    result.head=await bridge.FolderPatchRevision(folder);
  }else{
    if(opening)checkWorkspace(data);
    result.raw=opening?JSON.stringify(data):raw;
  }
  return result;
}

export async function readSpaceFolder(bridge,info,prompt,knownLink){
  if(!info.exists)throw new Error('VD_SPACE_MISSING');
  if(knownLink?.encrypted && !info.encrypted)throw new Error('VD_ENCRYPTION_CHANGED');
  async function opened(raw){
    try{
      const data=JSON.parse(raw);
      if(isFolderSpace(data) || !validSpaceName(data?.name))throw new Error('VD_INVALID');
      const result=await session(bridge,info.folder,info.encrypted,data,raw,true);
      if(bridge.ServerConnection && knownLink?.name)result.link.name=knownLink.name;
      return result;
    }catch(error){await bridge.CloseFolderSpace(info.folder);throw error}
  }
  if(!info.encrypted)return opened(await bridge.OpenFolderSpace(info.folder,''));
  if(info.canResume && bridge.ResumeFolderSpace){
    let raw;
    try{raw=await bridge.ResumeFolderSpace(info.folder)}
    catch(error){
      // A lock or a new encryption key can invalidate the previous inspection.
      const code=String(error?.message||error).split('|')[0];
      if(code!=='VD_LOCKED' && code!=='VD_PASSWORD')throw error;
    }
    if(raw!==undefined)return opened(raw);
  }
  let result;
  const ok=await prompt({mode:'unlock',scope:'space',onSubmit:async({password})=>{
    result=await opened(await bridge.OpenFolderSpace(info.folder,password));
  }});
  if(!ok){
    if(result)await bridge.CloseFolderSpace(info.folder);
    return null;
  }
  return result;
}

export async function createSpaceFolder(bridge,info,data,password){
  if(info.exists)throw new Error('VD_SPACE_EXISTS');
  const raw=JSON.stringify(data);
  await bridge.CreateFolderSpace(info.folder,raw,password);
  return session(bridge,info.folder,!!password,data,raw,false);
}

export async function saveSpaceFolder(bridge,session){
  if(!session)return;
  if(session.records){
    let wrote=false;
    // Retry an unacknowledged request before submitting edits made during the write.
    for(;;){
      const tx=session.pendingPatch??session.records.prepare(session.data);
      if(!tx.patch){tx.commit();return wrote}
      session.pendingPatch=tx;
      session.head=await bridge.SaveFolderPatch(session.folder,session.head,JSON.stringify(tx.patch));
      tx.commit();session.pendingPatch=null;wrote=true;
    }
  }
  const raw=JSON.stringify(session.data);
  if(raw===session.raw)return;
  if(bridge.SaveFolderBranch)await bridge.SaveFolderBranch(session.folder,raw);
  else await bridge.SaveFolderSpace(session.folder,raw);
  session.raw=raw;
  return true;
}
