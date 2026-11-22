import { areaTreeRows } from './areas.js';

// Folders precede the notes in their branch. Reuse the area's traversal so
// imported orphans and cycles get the same parentage as the rest of the UI.
export function sidebarRows(areas, notes, collapsed, describeNote) {
  const folders=areaTreeRows(areas), known=new Set(areas.map(area=>area.id));
  const members=new Map(), rows=[], ancestors=[];
  for(const note of notes){
    const id=known.has(note.areaId)?note.areaId:null;
    if(!members.has(id))members.set(id,[]);
    members.get(id).push(note);
  }
  function addNotes(parentId,depth){
    for(const note of members.get(parentId) || []){
      rows.push({kind:'note',id:note.id,depth,parentId,...describeNote(note)});
    }
  }
  function finishTo(depth){
    while(ancestors.length>depth){
      const parent=ancestors.pop();
      addNotes(parent.id,parent.depth+1);
    }
  }
  for(let i=0;i<folders.length;i++){
    const {area,depth,pathLabel}=folders[i];
    finishTo(depth);
    const branch=folders[i+1]?.depth>depth || members.has(area.id);
    const expanded=branch && !collapsed.has(area.id);
    rows.push({kind:'area',id:area.id,depth,parentId:ancestors.at(-1)?.id??null,title:area.name,
      path:pathLabel,color:area.color,icon:area.grid?.stages?'track':area.grid?'slots':'folder',
      gridSize:area.grid?area.grid.cols+' × '+area.grid.rows:'',branch,expanded});
    if(branch && !expanded){
      while(folders[i+1]?.depth>depth)i++;
    }else ancestors.push({id:area.id,depth});
  }
  finishTo(0);addNotes(null,0);
  return rows;
}

const rowHeight=32, overscan=7;

export function mountSidebarTree(host,createRow,onToggle) {
  const nav=host.closest('nav');
  let rows=[], first=-1,last=-1, tabIndex=0;
  const mounted=new Map(), siblingCounts=new Map();
  host.style.setProperty('--tree-row-height',rowHeight+'px');
  host.setAttribute('role','tree');

  function itemAt(i){return mounted.get(i)?.querySelector('[role=treeitem]')}
  function updateTabStop(i){
    itemAt(tabIndex)?.setAttribute('tabindex','-1');
    tabIndex=i;
    itemAt(i)?.setAttribute('tabindex','0');
  }
  function paint(force=false){
    let start=0,end=rows.length;
    if(rows.length>64){
      const offset=nav.getBoundingClientRect().top-host.getBoundingClientRect().top;
      start=Math.min(rows.length,Math.max(0,Math.floor(offset/rowHeight)-overscan));
      end=Math.max(start,Math.min(rows.length,Math.ceil((offset+nav.clientHeight)/rowHeight)+overscan));
    }
    if(!force && start===first && end===last)return;
    first=start;last=end;
    const active=document.activeElement?.closest('.sidebar-tree-row');
    const focused=active && host.contains(active)?Number(active.dataset.index):-1;
    for(const [i,node] of mounted){
      if(i!==focused && (i<start || i>=end)){node.remove();mounted.delete(i)}
    }
    if(focused<0 && (tabIndex<start || tabIndex>=end))tabIndex=start;
    let before=focused>=end?mounted.get(focused):null;
    for(let i=end-1;i>=start;i--){
      let node=mounted.get(i);
      if(!node){
        node=createRow(rows[i]);node.classList.add('sidebar-tree-row');node.dataset.index=i;
        node.setAttribute('role','none');
        node.style.top=i*rowHeight+'px';node.style.setProperty('--depth',Math.min(rows[i].depth,7));
        const item=node.querySelector('[role=treeitem]');
        item.setAttribute('aria-level',String(rows[i].depth+1));
        item.setAttribute('aria-posinset',String(rows[i].position));
        item.setAttribute('aria-setsize',String(siblingCounts.get(rows[i].parentId)));
        item.tabIndex=i===tabIndex?0:-1;
        host.insertBefore(node,before);mounted.set(i,node);
      }else itemAt(i).tabIndex=i===tabIndex?0:-1;
      before=node;
    }
  }
  function focusIndex(index,scroll=true){
    if(!rows[index] || !host.getClientRects().length || getComputedStyle(nav).visibility==='hidden')return false;
    if(scroll){
      const y=host.getBoundingClientRect().top-nav.getBoundingClientRect().top+index*rowHeight;
      if(y<0)nav.scrollTop+=y;
      else if(y+rowHeight>nav.clientHeight)nav.scrollTop+=y+rowHeight-nav.clientHeight;
    }
    paint(true);updateTabStop(index);
    const item=itemAt(index);item?.focus({preventScroll:true});return !!item;
  }
  function clear(){
    rows=[];mounted.clear();siblingCounts.clear();host.replaceChildren();host.style.height='0px';first=last=-1;tabIndex=0;
  }
  nav.addEventListener('scroll',()=>paint(),{passive:true});
  new ResizeObserver(()=>paint()).observe(nav);
  host.addEventListener('focusin',event=>{
    const row=event.target.closest('.sidebar-tree-row');
    if(row)updateTabStop(Number(row.dataset.index));
  });
  host.addEventListener('keydown',event=>{
    if(!event.target.matches('[role=treeitem]') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)return;
    const index=Number(event.target.closest('.sidebar-tree-row').dataset.index),row=rows[index];
    if(!row)return;
    switch(event.key){
      case 'ArrowDown': focusIndex(Math.min(rows.length-1,index+1));break;
      case 'ArrowUp': focusIndex(Math.max(0,index-1));break;
      case 'Home': focusIndex(0);break;
      case 'End': focusIndex(rows.length-1);break;
      case 'ArrowRight':
        if(row.branch && !row.expanded)onToggle(row);
        else if(row.expanded)focusIndex(index+1);
        break;
      case 'ArrowLeft':
        if(row.expanded)onToggle(row);
        else if(row.parentId!==null)focusIndex(rows.findIndex(x=>x.kind==='area' && x.id===row.parentId));
        break;
      default:return;
    }
    event.preventDefault();event.stopPropagation();
  });
  return {clear,update(next,label){
    const focus=host.contains(document.activeElement),previous=rows[tabIndex];
    clear();rows=next;host.setAttribute('aria-label',label);
    // Screen readers cannot infer sibling positions from the mounted window.
    for(const row of rows){
      row.position=(siblingCounts.get(row.parentId)||0)+1;
      siblingCounts.set(row.parentId,row.position);
    }
    host.style.height=rows.length*rowHeight+'px';
    if(previous)tabIndex=Math.max(0,rows.findIndex(row=>row.kind===previous.kind && row.id===previous.id));
    paint(true);
    if(focus)focusIndex(tabIndex);
  },focusNote(id){return focusIndex(rows.findIndex(row=>row.kind==='note' && row.id===id))}};
}
