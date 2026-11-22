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
  if(merged.prepared)return !(merged.changedNotes||[]).includes(id);
  const open=session.data.notes.find(n=>n.id===id);
  return !!open && sameWorkspaceValue(open,merged.data.notes.find(n=>n.id===id));
}

// Keep the arrays captured by an open editor. Unchanged records retain their
// identity, including any text typed after Go prepared the merge.
function applyList(rows,changes){
  const changed=new Map((changes.upsert||[]).map(row=>[row.id,row]));
  if(changes.order){
    const byId=new Map(rows.map(row=>[row.id,row]));
    for(const [id,row] of changed)byId.set(id,row);
    rows.length=0;
    for(const id of changes.order)rows.push(byId.get(id));
    return;
  }
  const removed=new Set(changes.remove||[]);
  let count=0;
  for(const row of rows){
    if(removed.has(row.id))continue;
    rows[count++]=changed.get(row.id)??row;
    changed.delete(row.id);
  }
  rows.length=count;
  for(const row of changed.values())rows.push(row);
}

export async function commitPreparedMerge(bridge,session,proposal,choices={}){
  const commit=()=>bridge.CommitFolderMergeChoices(session.folder,proposal.token,choices);
  let delta;
  try{delta=await commit()}
  catch(error){
    if(String(error?.message||error).startsWith('VD_'))throw error;
    // A transport failure can arrive after Go durably accepted the choices.
    delta=await commit();
  }
  for(const key of delta.unset||[])delete session.data[key];
  for(const [key,value] of Object.entries(delta.set||{})){
    Object.defineProperty(session.data,key,{value,enumerable:true,writable:true,configurable:true});
  }
  for(const [key,changes] of Object.entries(delta.lists||{})){
    if(!Object.hasOwn(session.data,key))session.data[key]=[];
    applyList(session.data[key],changes);
  }
  session.records.acceptMerge(delta);
  session.head=delta.head;
  session.link.name=session.connection?.projectName||session.data.name;
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
