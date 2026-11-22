import { checkWorkspace, isFolderSpace, spaceNames, validSpaceName } from './data.js';
import { WorkspaceRecords } from './workspace-records.js';

export function spaceTitle(id,space){
  return space?.name || spaceNames[id];
}

export function localFallback(catalog){
  const key=Object.keys(catalog.spaces).find(id=>!isFolderSpace(catalog.spaces[id]));
  return {...catalog,version:3,active:key??''};
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
  let result;
  async function read(password){
    const raw=await bridge.OpenFolderSpace(info.folder,password);
    try{
      const data=JSON.parse(raw);
      if(isFolderSpace(data) || !validSpaceName(data?.name))throw new Error('VD_INVALID');
      result=await session(bridge,info.folder,info.encrypted,data,raw,true);
      if(bridge.ServerConnection && knownLink?.name)result.link.name=knownLink.name;
    }catch(error){await bridge.CloseFolderSpace(info.folder);throw error}
  }
  if(info.encrypted){
    const ok=await prompt({mode:'unlock',scope:'space',onSubmit:({password})=>read(password)});
    if(!ok){
      if(result)await bridge.CloseFolderSpace(info.folder);
      return null;
    }
  }else await read('');
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
