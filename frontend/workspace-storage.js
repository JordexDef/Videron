import { checkWorkspace, isFolderSpace, spaceNames, validSpaceName } from './data.js';

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

function session(folder,encrypted,data,raw){
  return {folder,encrypted,data,raw,link:{folder,encrypted,name:data.name}};
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
      checkWorkspace(data);
      result=session(info.folder,info.encrypted,data,JSON.stringify(data));
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
  return session(info.folder,!!password,data,raw);
}

export async function saveSpaceFolder(bridge,session){
  if(!session)return;
  const raw=JSON.stringify(session.data);
  if(raw===session.raw)return;
  if(bridge.SaveFolderBranch)await bridge.SaveFolderBranch(session.folder,raw);
  else await bridge.SaveFolderSpace(session.folder,raw);
  session.raw=raw;
  return true;
}
