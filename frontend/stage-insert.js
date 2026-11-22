import { icon } from './art.js';
import { tr } from './i18n.js';
import { stageHandleAt } from './map-slots.js';

const targetSize=24;

// The target starts below the heading band, so even a truncated caption and its
// drag handle keep their full hit area. Only mount boundaries visible on screen.
export function visibleStageBoundaries(header,width,height){
  const {cols}=header.grid.grid;
  if(cols>=100 || header.b<0 || header.b+targetSize>height)return [];
  const first=Math.max(0,Math.ceil((targetSize/2-header.l)/header.pitch));
  const last=Math.min(cols,Math.floor((width-targetSize/2-header.l)/header.pitch));
  const result=[];
  for(let index=first;index<=last;index++){
    result.push({index,x:Math.round(header.l+index*header.pitch),y:Math.round(header.b)});
  }
  return result;
}

export function mountStageInsert(canvas,layer,onInsert){
  const buttons=new Map(),events=new AbortController(),stage=canvas.parentElement;
  const options={signal:events.signal};
  let currentGraph,hovered,draft;

  function setHover(button){
    if(hovered===button)return;
    hovered?.classList.remove('is-hot');button?.classList.add('is-hot');
    hovered=button;
  }
  function dismiss(refocus=false){
    if(!draft)return;
    const {form,button}=draft;
    draft=null;form.remove();button.setAttribute('aria-expanded','false');
    if(refocus)canvas.focus({preventScroll:true});
  }
  function positionForm(){
    if(!draft)return;
    const {form,button}=draft,{width,height}=currentGraph;
    const {x,y}=button.boundary,below=y+targetSize+3;
    const w=Math.min(236,width-8),h=form.offsetHeight;
    form.style.width=w+'px';
    form.style.left=Math.max(4,Math.min(width-w-4,x-w/2))+'px';
    form.style.top=Math.max(4,below+h<=height-4?below:y-h-4)+'px';
  }
  function open(button){
    if(draft?.button===button){dismiss(true);return}
    dismiss();
    const {id,index,stages}=button.boundary;
    const form=document.createElement('form'),input=document.createElement('input'),confirm=document.createElement('button');
    const name=tr('Название нового этапа','New stage name');
    form.className='stage-insert-form';
    form.setAttribute('role','dialog');form.setAttribute('aria-label',tr('Вставить этап','Insert stage'));
    input.type='text';input.maxLength=80;input.placeholder=name;input.setAttribute('aria-label',name);
    confirm.type='submit';confirm.disabled=true;confirm.innerHTML=icon('check');
    confirm.title=tr('Вставить этап','Insert stage');confirm.setAttribute('aria-label',confirm.title);
    input.oninput=()=>{input.setCustomValidity('');confirm.disabled=!input.value.trim()};
    form.onsubmit=e=>{
      e.preventDefault();
      const value=input.value.trim();
      if(!value || draft?.button!==button || !button.isConnected || button.boundary.stages!==stages)return;
      if(onInsert(id,index,value)){dismiss(true);canvas.focus({preventScroll:true})}
      else{input.setCustomValidity(tr('Не удалось вставить этап в это место.','Could not insert a stage here.'));input.reportValidity()}
    };
    form.onkeydown=e=>{if(e.key==='Escape' && !e.isComposing){e.preventDefault();e.stopPropagation();dismiss(true)}};
    form.onfocusout=e=>{if(e.relatedTarget && !form.contains(e.relatedTarget) && e.relatedTarget!==button)dismiss()};
    form.append(input,confirm);layer.append(form);
    draft={form,button,stages};button.setAttribute('aria-expanded','true');
    positionForm();input.focus({preventScroll:true});
  }
  function add(){
    const button=document.createElement('button');
    button.className='stage-insert';button.type='button';button.innerHTML=icon('plus');
    button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
    button.onclick=()=>open(button);
    button.oncontextmenu=e=>e.preventDefault();
    layer.append(button);return button;
  }
  function sync(graph){
    currentGraph=graph;
    const visible=new Set();
    if(!layer.hidden && !['edit','play'].includes(stage.dataset.routeMode))for(const header of graph.stageHeaders){
      const {id,grid,name}=header.grid;
      for(const {index,x,y} of visibleStageBoundaries(header,graph.width,graph.height)){
        const key=id+'/'+index;
        let button=buttons.get(key);
        if(!button){button=add();buttons.set(key,button);button.dataset.stageId=id;button.dataset.insertIndex=String(index)}
        visible.add(key);
        if(draft?.button===button && grid.stages!==draft.stages)dismiss(true);
        button.boundary={id,index,x,y,stages:grid.stages};
        const label=tr('Вставить этап на позицию '+(index+1)+' · '+name,'Insert stage at position '+(index+1)+' · '+name);
        if(button.title!==label){button.title=label;button.setAttribute('aria-label',label)}
        const transform='translate('+(x-targetSize/2)+'px,'+y+'px)';
        if(button.style.transform!==transform)button.style.transform=transform;
      }
    }
    for(const [key,button] of buttons){
      if(visible.has(key))continue;
      if(draft?.button===button)dismiss(true);
      if(hovered===button)setHover(null);
      if(button===document.activeElement)canvas.focus({preventScroll:true});
      button.remove();buttons.delete(key);
    }
    positionForm();
  }
  function pointer(e){
    if(!currentGraph || draft || e.buttons || e.pointerType==='touch')return;
    const control=e.target.closest?.('.stage-insert');
    if(control){setHover(control);return}
    if(e.target!==canvas){setHover(null);return}
    const p=currentGraph.local(e);
    let candidate=null,nearest=Infinity,depth=-Infinity;
    for(const header of currentGraph.stageHeaders){
      if(p.y<header.t-3 || p.y>header.b+targetSize || header.grid.depth<depth)continue;
      const index=Math.round((p.x-header.l)/header.pitch);
      const button=buttons.get(header.grid.id+'/'+index);
      const grip=stageHandleAt(header,p);
      if(!button || (grip!==null && currentGraph.hoverGridArea===header.grid && currentGraph.hoverStage===grip))continue;
      const d=Math.abs(p.x-button.boundary.x);
      if(d<=targetSize/2 && (header.grid.depth>depth || d<nearest)){
        nearest=d;depth=header.grid.depth;candidate=button;
      }
    }
    setHover(candidate);
  }
  stage.addEventListener('pointermove',pointer,options);
  stage.addEventListener('pointerleave',()=>setHover(null),options);
  document.addEventListener('pointerdown',e=>{
    if(draft && !draft.form.contains(e.target) && !draft.button.contains(e.target))dismiss();
  },{...options,capture:true});
  function reset(){dismiss();setHover(null)}
  return {sync,reset,destroy(){events.abort();reset();for(const button of buttons.values())button.remove();buttons.clear()}};
}
