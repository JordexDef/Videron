import { normalizeAreaTree } from './areas.js';

// Compare JSON values, including documents serialized by writers with a different key order.
function equal(a,b){
  if(a===b)return true;
  if(!a || !b || typeof a!=='object' || typeof b!=='object' || Array.isArray(a)!==Array.isArray(b))return false;
  if(Array.isArray(a)){
    if(a.length!==b.length)return false;
    for(let i=0;i<a.length;i++)if(!equal(a[i],b[i]))return false;
    return true;
  }
  const keys=Object.keys(a);
  return keys.length===Object.keys(b).length && keys.every(key=>Object.hasOwn(b,key) && equal(a[key],b[key]));
}
export {equal as sameWorkspaceValue};

const diverged=Symbol('diverged');
function threeWay(base,local,remote){
  if(equal(local,remote) || equal(remote,base))return local;
  if(equal(local,base))return remote;
  return diverged;
}
function value(object,key){return object && Object.hasOwn(object,key)?object[key]:undefined}
function keysOf(base,...others){
  const originals=Object.keys(base??{}),known=new Set(originals);
  const additions=new Set(others.flatMap(o=>Object.keys(o??{})).filter(key=>!known.has(key)));
  return [...originals,...[...additions].sort()];
}
function mergeFields(base,local,remote){
  const fields=[];
  for(const key of keysOf(base,local,remote)){
    const result=threeWay(value(base,key),value(local,key),value(remote,key));
    if(result===diverged)return diverged;
    if(result!==undefined)fields.push([key,result]);
  }
  return Object.fromEntries(fields);
}

const locationKeys=new Set(['areaId','slot','pinned','mapGroupId']);
const transientKeys=new Set(['x','y','opens','modified']);
const mapKeys=new Set([...locationKeys,...transientKeys,'links']);
const publicNoteFields=['appearance','mapLabel'];
const protectedMapKeys=new Set([...mapKeys,...publicNoteFields]);
function contentOf(note,keys){return note && Object.fromEntries(Object.entries(note).filter(([key])=>!keys.has(key)))}
function fieldsOf(note,keys){return note && Object.fromEntries(Object.entries(note).filter(([key])=>keys.has(key)))}
function withoutDrift(note){
  return Object.fromEntries(Object.entries(note).filter(([key])=>!transientKeys.has(key) || ((note.pinned || note.mapGroupId) && (key==='x' || key==='y'))));
}
function coordinates(note){
  if(!note)return undefined;
  return Object.fromEntries(['x','y'].filter(key=>Object.hasOwn(note,key)).map(key=>[key,note[key]]));
}
function linkUnion(base,local,remote){
  const oneSide=threeWay(base,local,remote);
  if(oneSide!==diverged)return oneSide;
  const before=new Set(base),left=new Set(local),right=new Set(remote);
  const retained=[...before].filter(id=>left.has(id) && right.has(id));
  const additions=new Set([...left,...right].filter(id=>!before.has(id)));
  return [...retained,...[...additions].sort()];
}
function mergeNote(base,local,remote){
  // Text, rendering caches, boards and the encrypted envelope travel as a unit.
  const sealedOnAllSides=base?.sealed && local.sealed && remote.sealed;
  const keys=sealedOnAllSides?protectedMapKeys:mapKeys;
  const content=threeWay(contentOf(base,keys),contentOf(local,keys),contentOf(remote,keys));
  const leftLocation=fieldsOf(local,locationKeys), rightLocation=fieldsOf(remote,locationKeys);
  const location=threeWay(fieldsOf(base,locationKeys),leftLocation,rightLocation);
  if(content===diverged || location===diverged)return diverged;
  const left=coordinates(local),right=coordinates(remote);
  let point=threeWay(coordinates(base),left,right);
  // Coordinates captured by grouping win over ordinary free-map drift on a peer.
  if(location.mapGroupId && local.mapGroupId!==remote.mapGroupId)
    point=location.mapGroupId===local.mapGroupId?left:right;
  if(point===diverged){
    if((location.pinned || location.mapGroupId) && location.slot==null)return diverged;
    // Prefer the position accompanying a placement change; free physics drifts
    // independently on both computers. Break ties consistently in either direction.
    if(!equal(leftLocation,rightLocation))
      point=equal(location,leftLocation)?left:right;
    else point=(left.x??0)>(right.x??0) || (left.x===right.x && (left.y??0)>(right.y??0))?left:right;
  }
  const note={...content,...location,...point,links:linkUnion(base?.links,local.links,remote.links)};
  if(sealedOnAllSides){
    for(const key of publicNoteFields){
      const field=threeWay(base[key],local[key],remote[key]);
      if(field===diverged)return diverged;
      if(field!==undefined)note[key]=field;
    }
  }
  for(const key of ['opens','modified']){
    const values=[local[key],remote[key]].filter(Number.isFinite);
    if(values.length)note[key]=Math.max(...values);
  }
  return note;
}
function keyed(list){
  if(list===undefined)return true;
  if(!Array.isArray(list))return false;
  const ids=new Set();
  for(const entry of list){
    if(typeof entry?.id!=='string' || ids.has(entry.id))return false;
    ids.add(entry.id);
  }
  return true;
}

/**
 * Merge snapshots of a single space. A missing version in a conflict is null.
 * Never commit data with outstanding conflicts. Re-run with key -> local/remote
 * choices against the same three snapshots. The result owns its JSON objects.
 */
export function mergeWorkspace(base,local,remote,choices={}){
  const conflicts=[];
  function choose(kind,id,b,l,r){
    const key=kind+':'+id,choice=choices instanceof Map?choices.get(key):value(choices,key);
    if(choice==='remote')return r;
    if(choice!=='local')conflicts.push({key,kind,id,base:b??null,local:l??null,remote:r??null});
    return l;
  }
  function collection(kind,b=[],l=[],r=[]){
    const versions=[b,l,r].map(list=>new Map(list.map(entry=>[entry.id,entry])));
    const [oldIds,leftIds,rightIds]=versions.map(side=>[...side.keys()]);
    const order=threeWay(oldIds,leftIds,rightIds);
    const added=new Set([...leftIds,...rightIds].filter(id=>!versions[0].has(id)));
    // Two peers can merge the same pair simultaneously. Independent new notes
    // must acquire the same order (and grid collision repair) on both peers.
    const ids=new Set([...(order===diverged?oldIds:order),...oldIds,...[...added].sort()]),results=[];
    for(const id of ids){
      const [before,left,right]=versions.map(side=>side.get(id));
      let item=threeWay(before,left,right);
      if(item===diverged && left && right){
        if(kind==='note')item=mergeNote(before,left,right);
        else if(before && !(kind==='ink' && (left.mapGroupId || right.mapGroupId) &&
          threeWay(coordinates(before),coordinates(left),coordinates(right))===diverged))item=mergeFields(before,left,right);
      }else if(item===diverged && kind==='note' && before && equal(withoutDrift(before),withoutDrift(left??right))){
        item=undefined; // Opening an otherwise unchanged note does not veto a deletion.
      }
      if(item===diverged)item=choose(kind,id,before,left,right);
      if(item!==undefined)results.push(item);
    }
    return results;
  }
  const kinds={notes:'note',areas:'area',routes:'route',mapInk:'ink'},properties=[];
  for(const key of keysOf(base,local,remote)){
    const args=[base,local,remote].map(side=>value(side,key));
    let result=threeWay(...args);
    if(result===diverged){
      if(Object.hasOwn(kinds,key) && args.every(keyed))result=collection(kinds[key],...args);
      else result=choose('setting',key,...args);
    }
    if(result!==undefined)properties.push([key,result]);
  }
  const data=structuredClone(Object.fromEntries(properties));
  reconcileLinks(data,base,local,remote);
  normalizeAreaTree(data);
  return {data,conflicts:structuredClone(conflicts)};
}

function reconcileLinks(data,base,local,remote){
  const spaces=[base,local,remote];
  if(spaces.every(space=>space.notes.length===data.notes.length &&
      space.notes.every((note,index)=>note.id===data.notes[index].id)))return;
  const retained=new Set(data.notes.map(note=>note.id)),removed=new Set();
  const [before,left,right]=spaces.map(space=>{
    const notes=new Map();
    for(const note of space.notes){
      notes.set(note.id,note);
      if(!retained.has(note.id))removed.add(note.id);
    }
    return notes;
  });
  // A retained target missing on one side may have had its incoming links
  // cleared there by deleteNotes. Only the surviving side can restore them.
  const survivingSide=new Map();
  for(const id of before.keys()){
    if(!retained.has(id))continue;
    if(!left.has(id))survivingSide.set(id,right);
    else if(!right.has(id))survivingSide.set(id,left);
  }
  if(!removed.size && !survivingSide.size)return;
  for(const note of data.notes){
    if(removed.size)note.links=note.links.filter(id=>!removed.has(id));
    if(!survivingSide.size)continue;
    let existing;
    const sideLinks=new Map();
    for(const id of before.get(note.id)?.links??[]){
      const side=survivingSide.get(id);
      if(!side)continue;
      existing??=new Set(note.links);
      if(existing.has(id))continue;
      if(!sideLinks.has(side))sideLinks.set(side,new Set(side.get(note.id)?.links));
      if(sideLinks.get(side).has(id)){note.links.push(id);existing.add(id)}
    }
  }
}
