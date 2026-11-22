import {icon} from './art.js';
import {getLanguage,tr} from './i18n.js';
import {folderLabel} from './folder-links.js';
import {openVaultPassword} from './vault-ui.js';

function element(tag,className,text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}
function button(text,className,action){
  const b=element('button',className,text);
  b.type='button';b.onclick=action;
  return b;
}
function glyph(name){
  const span=element('span','space-glyph');
  span.setAttribute('aria-hidden','true');span.innerHTML=icon(name);
  return span;
}
function iconButton(symbol,label,action){
  const b=button('','icon-button',action);
  b.title=label;b.setAttribute('aria-label',label);b.append(glyph(symbol));
  return b;
}
function checkLabel(label){
  const row=element('label','space-choice'),input=element('input');
  input.type='checkbox';row.append(input,document.createTextNode(label));
  return {row,input};
}

// Keep a pending filesystem operation and its feedback in the same dialog.
export function spaceDialog(dialog,title,onError){
  const {box,close}=dialog(title),shade=box.parentElement;
  box.classList.add('space-dialog');
  const error=element('div','vault-error');error.setAttribute('role','alert');
  let busy=false;
  function guard(e){
    if(busy && (e.type==='pointerdown' || e.key==='Escape')){
      e.preventDefault();e.stopPropagation();
    }
  }
  shade.addEventListener('pointerdown',guard,true);shade.addEventListener('keydown',guard,true);
  async function run(action){
    if(busy)return;
    const focus=document.activeElement;
    busy=true;box.inert=true;box.setAttribute('aria-busy','true');error.textContent='';
    try{await action()}catch(e){error.textContent=onError(e)}
    finally{
      busy=false;box.inert=false;box.removeAttribute('aria-busy');
      if(box.isConnected && document.activeElement===document.body && box.contains(focus))
        focus.focus({preventScroll:true});
    }
  }
  return {box,close,error,run};
}

export function openCreateSpace({dialog,native,projectProtected,onCreate,onError,sourceName}){
  const moving=sourceName!==undefined;
  const title=moving?tr('Перенести пространство в папку','Move space to a folder'):tr('Новое пространство','New space');
  const {box,close,error,run}=spaceDialog(dialog,title,onError);
  const form=element('form'),field=element('label','field',tr('Название','Name')),name=element('input');
  name.required=true;name.maxLength=80;name.value=sourceName??'';name.autocomplete='off';
  field.append(name);form.append(field);
  const protect=checkLabel(tr('Зашифровать файл паролем','Encrypt the file with a password'));
  protect.input.checked=!!projectProtected;
  let folder='';
  const save=element('button','button primary');save.type='submit';
  function update(){
    protect.row.hidden=!folder;
    save.textContent=moving?tr('Перенести','Move'):tr('Создать','Create');
    save.disabled=!name.value.trim() || (moving && !folder);
  }
  name.oninput=update;
  if(native?.PickFolder){
    const location=element('div','space-location'),caption=element('div','space-label',tr('Папка хранения','Storage folder'));
    const controls=element('div','space-location-controls'),hint=element('p','space-hint');
    const path=element('span');
    const choose=button('','button secondary space-choose',()=>run(async()=>{
      const selected=await native.PickFolder(getLanguage());
      if(!selected || !box.isConnected)return;
      folder=selected;
      if(!name.value.trim())name.value=folderLabel(folder).slice(0,80);
      updateLocation();update();
    }));
    choose.append(glyph('folder'),path);
    const clear=iconButton('x',tr('Хранить в библиотеке Videron','Store in the Videron library'),()=>{
      folder='';updateLocation();update();choose.focus();
    });
    function updateLocation(){
      path.textContent=folder || tr('Выбрать папку…','Choose a folder…');choose.title=path.textContent;
      clear.hidden=moving||!folder;
      hint.textContent=folder?tr('Карта и заметки сохранятся в файле Videron.space.','The map and notes will be saved in Videron.space.'):
        moving?tr('Выберите папку для карты и заметок.','Choose a folder for the map and notes.'):
        tr('По умолчанию пространство хранится в библиотеке Videron.','By default, the space is stored in your Videron library.');
    }
    updateLocation();
    controls.append(choose,clear);location.append(caption,controls,hint);form.append(location,protect.row);
  }
  const actions=element('div','dialog-actions');
  actions.append(button(tr('Отмена','Cancel'),'button secondary',close),save);
  form.append(error,actions);box.append(form);update();name.focus();if(moving)name.select();
  form.onsubmit=e=>{
    e.preventDefault();
    const title=name.value.trim();
    if(!title || title.length>80 || (moving&&!folder))return;
    void run(async()=>{
      if(folder && protect.input.checked){
        // Filesystem errors belong beside the folder selector, where they can be corrected.
        let failure;
        const completed=await openVaultPassword({mode:'set',scope:'space',onSubmit:async({password})=>{
          try{await onCreate({name:title,folder,password})}catch(e){failure=e}
        }});
        if(failure)throw failure;
        if(!completed)return;
      }else await onCreate({name:title,folder,password:''});
      close();
    });
  };
}

export function openSpaceManager({dialog,entries,active,native,onLink,onDelete,onOpenFolder,onError}){
  const title=tr('Пространства на этом компьютере','Spaces on this computer'),{box,close,error,run}=spaceDialog(dialog,title,onError);
  const list=element('div','space-list'),confirm=element('section','space-confirm');
  box.append(list,confirm,error);confirm.hidden=true;
  for(const entry of entries){
    const {id,name,folder,encrypted}=entry;
    const row=element('div','space-row'),info=element('div','space-info'),heading=element('div','space-heading');
    const label=element('strong','',name);label.title=name;heading.append(label);
    if(active===id){
      const current=glyph('check');current.title=tr('Текущее пространство','Current space');
      heading.append(current,element('span','space-sr',current.title));
    }
    if(encrypted){
      const lock=glyph('lock');lock.title=tr('Зашифровано','Encrypted');heading.append(lock,element('span','space-sr',lock.title));
    }
    const detail=element('span','space-detail',folder||tr('Библиотека Videron','Videron library'));detail.title=detail.textContent;
    info.append(heading,detail);row.append(info);
    if(folder && native){
      row.append(iconButton('folder',tr('Открыть папку','Open folder')+' · '+name,()=>run(()=>onOpenFolder(folder))));
    }else if(!folder && native && active===id){
      row.append(button(tr('В папку…','Move to folder…'),'button secondary space-link',()=>{close();onLink()}));
    }
    const remove=folder
      ? button(tr('Убрать из списка','Remove from list'),'button secondary space-link',()=>ask(entry,remove))
      : iconButton('trash',tr('Удалить из локальной библиотеки','Delete from local library')+' · '+name,()=>ask(entry,remove));
    if(folder)remove.setAttribute('aria-label',tr('Убрать из списка на этом компьютере','Remove from the list on this computer')+' · '+name);
    row.append(remove);list.append(row);
  }
  function ask({id,name,folder,noteCount},opener){
    list.hidden=true;confirm.hidden=false;confirm.replaceChildren();error.textContent='';
    const heading=box.querySelector('h2'),question=folder?tr('Убрать из списка на этом компьютере?','Remove from the list on this computer?'):
      tr('Удалить из локальной библиотеки?','Delete from the local library?');
    heading.textContent=question;box.setAttribute('aria-label',question);
    const nameLabel=element('strong','space-confirm-name',name);confirm.append(nameLabel);
    const hint=element('p','space-hint');
    const file=checkLabel(tr('Также удалить рабочую копию из этой папки','Also delete the working copy from this folder'));
    const canDeleteFile=!!folder && id===active;
    const actions=element('div','dialog-actions');
    const cancel=button(tr('Отмена','Cancel'),'button secondary',()=>{
      heading.textContent=title;box.setAttribute('aria-label',title);
      list.hidden=false;confirm.hidden=true;error.textContent='';opener.focus();
    });
    const submit=button('','button primary',()=>run(async()=>{
      await onDelete(id,canDeleteFile && file.input.checked);close();
    }));
    function update(){
      const destroyingFile=canDeleteFile && file.input.checked;
      if(folder){
        hint.textContent=destroyingFile?tr('Из указанной папки будут удалены заметки и история, включая неотправленные правки. Проект на сервере Videron сохранится.',
          'The notes and history in this folder will be deleted, including unsent edits. The project on the Videron server will be preserved.'):
          tr('Заметки останутся в папке. Её можно открыть снова. Если пространство подключено к серверу, другие устройства сохранят к нему доступ.',
            'Your notes will stay in the folder. You can open it again. If this space is synced, other devices will keep access to the server project.');
      }else{
        hint.textContent=tr('Карта и заметки будут удалены из библиотеки.','The map and notes will be deleted from the library.')+
          (Number.isInteger(noteCount)?' '+tr('Заметок','Notes')+' · '+noteCount:'');
      }
      submit.textContent=folder && !destroyingFile?tr('Убрать из списка','Remove from list'):
        destroyingFile?tr('Удалить рабочую копию','Delete working copy'):tr('Удалить из библиотеки','Delete from library');
    }
    file.input.onchange=update;update();confirm.append(hint);
    if(folder){const path=element('p','space-file-path',folder);confirm.append(path)}
    if(canDeleteFile)confirm.append(file.row);
    actions.append(cancel,submit);confirm.append(actions);cancel.focus();
  }
}
