import { stageRemovalOptions } from './areas.js';
import { tr } from './i18n.js';

function element(tag, className, text) {
  const el=document.createElement(tag);
  if(className)el.className=className;
  if(text!==undefined)el.textContent=text;
  return el;
}

export function openStageRemoval({space,area,index,anchor,onRemove,onClose}) {
  const grid=area.grid, names=grid.stages.slice();
  const {count,options,reason}=stageRemovalOptions(space,area.id,index);
  const last=reason==='last-stage', name=names[index];
  const title=last?tr('Последний этап','Final stage'):
    tr('Удалить этап «'+name+'»?','Delete stage “'+name+'”?');
  const box=element('form','dialog stage-removal');
  box.setAttribute('role','dialog');box.setAttribute('aria-label',title);
  box.anchor=anchor instanceof Element?anchor:null;
  const opener=box.anchor || document.getElementById('graph');
  function close(){
    if(box.isConnected){
      if(onClose)onClose();
      else{box.dispose();box.remove()}
    }
    if(opener?.isConnected)opener.focus({preventScroll:true});
  }
  box.append(element('h2','',title));
  const select=element('select'), hint=element('p','stage-removal-hint');
  hint.setAttribute('role','status');
  const actions=element('div','dialog-actions');
  const cancel=element('button','button secondary',last?tr('Закрыть','Close'):tr('Отмена','Cancel'));
  cancel.type='button';cancel.onclick=close;
  const submit=element('button','button primary',tr('Удалить этап','Delete stage'));submit.type='submit';
  let initialFocus=cancel;
  if(last){
    box.append(element('p','',tr('В дорожке должен остаться хотя бы один этап. Добавьте другой кнопкой «+» у заголовка.',
      'A track needs at least one stage. Use the + beside the heading to add another.')));
    actions.append(cancel);
  }else{
    if(count && !reason){
      const field=element('label','field',tr('Куда перенести заметки','Move notes to')+' ('+count+')');
      for(const {destination,available} of options){
        const label=destination===null?tr('На карту, вне дорожки','Onto the map, outside this track'):
          (destination+1)+' · '+names[destination];
        const option=element('option','',label+(available?'':tr(' · нет мест',' · no space')));
        option.value=destination===null?'map':String(destination);option.disabled=!available;select.append(option);
      }
      const nearest=options.filter(o=>o.available && o.destination!==null)
        .sort((a,b)=>Math.abs(a.destination-index)-Math.abs(b.destination-index) || b.destination-a.destination)[0];
      select.value=nearest?String(nearest.destination):'map';
      function showDestination(){
        const choice=options[select.selectedIndex];
        if(choice?.destination===null)hint.textContent=tr('Заметки останутся рядом с дорожкой.','The notes will stay beside the track.');
        else if(choice?.rows>grid.rows)hint.textContent=tr('Мест на этапе станет '+choice.rows+' вместо '+grid.rows+'.',
          'Seats per stage will increase from '+grid.rows+' to '+choice.rows+'.');
        else hint.textContent='';
      }
      select.onchange=showDestination;showDestination();
      field.append(select);box.append(field);initialFocus=select;
    }
    if(reason)hint.textContent=tr('Дорожка изменилась. Откройте меню этапа снова.','The track has changed. Open the stage menu again.');
    submit.disabled=!!reason;actions.append(cancel,submit);
  }
  box.append(hint,actions);
  box.onsubmit=e=>{
    e.preventDefault();
    if(last || reason)return;
    const destination=count ? (select.value==='map'?null:Number(select.value)) : undefined;
    if(!space.areas.includes(area) || JSON.stringify(area.grid?.stages)!==JSON.stringify(names) ||
       !onRemove(destination)){
      hint.textContent=tr('Дорожка изменилась. Откройте меню этапа снова.','The track has changed. Open the stage menu again.');
      submit.disabled=true;return;
    }
    close();
  };
  box.onkeydown=e=>{if(e.key==='Escape' && !e.isComposing){e.preventDefault();e.stopPropagation();close()}};
  function place(){
    const rect=box.anchor?box.anchor.getBoundingClientRect():anchor;
    const gap=8,w=box.offsetWidth,h=box.offsetHeight,x=rect.left??rect.x,y=rect.bottom??rect.y;
    const top=y+gap+h<=innerHeight?y+gap:(rect.top??y)-gap-h;
    box.style.left=Math.max(gap,Math.min(x,innerWidth-w-gap))+'px';
    box.style.top=Math.max(gap,Math.min(top,innerHeight-h-gap))+'px';
  }
  const observer=new ResizeObserver(place);
  box.dispose=()=>{observer.disconnect();window.removeEventListener('resize',place)};
  document.body.append(box);observer.observe(box);window.addEventListener('resize',place);
  place();initialFocus.focus({preventScroll:true});
  return box;
}
