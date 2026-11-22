import { checkWorkspace, isFolderSpace, validSpaceName } from './data.js';
import { mergeWorkspace, sameWorkspaceValue } from './workspace-merge.js';

function documentFrom(raw){
  const doc=JSON.parse(raw);
  if(isFolderSpace(doc)||!validSpaceName(doc?.name))throw new Error('VD_INVALID');
  return checkWorkspace(doc);
}
export function compareIncoming(session,incoming,choices){
  const {base,remote}=incoming;
  return mergeWorkspace(documentFrom(base),session.data,documentFrom(remote),choices);
}
export function preservesOpenNote(session,merged,id){
  if(merged.conflicts.length)return false;
  const open=session.data.notes.find(n=>n.id===id);
  return !!open && sameWorkspaceValue(open,merged.data.notes.find(n=>n.id===id));
}
export async function commitIncoming(bridge,session,incoming,merged,openId){
  if(merged.conflicts.length)throw new Error('VD_UNRESOLVED');
  const data=checkWorkspace(merged.data),raw=JSON.stringify(data);
  await bridge.CommitFolderMerge(session.folder,incoming.token,raw);
  if(openId){
    // The editor holds the live record and both collections. Keep its caret, undo stack,
    // and any characters typed while the native write was in flight.
    const live=session.data,record=live.notes.find(n=>n.id===openId);
    const notes=live.notes,areas=live.areas;
    notes.length=0;for(const n of data.notes)notes.push(n.id===openId?record:n);
    areas.length=0;for(const a of data.areas)areas.push(a);
    for(const key of Object.keys(live))if(!Object.hasOwn(data,key))delete live[key];
    Object.assign(live,data,{notes,areas});
  }else session.data=data;
  session.raw=raw;session.link.name=session.connection?.projectName||data.name;
}
