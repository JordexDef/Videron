import { validSpaceName } from './data.js'
import { folderLabel } from './folder-links.js'
import { getLanguage, tr } from './i18n.js'
import { spaceEncryptionFields } from './workspace-ui.js'
import { icon } from './art.js'

const newProject = 'new-project', chooseProject = 'choose-project', browse = 'browse', custom = 'custom'
const projectTitle = project => project.name || tr('Основной проект','Main project')
const validName = name => validSpaceName(name.trim()) && !/[\u0000-\u001f\u007f-\u009f]/u.test(name)
const sameFolder = (a,b) => a === b || (/^(?:[a-z]:|\\\\)/i.test(a) && a.toLowerCase() === b.toLowerCase())

export function mountServerProjectPicker(host,params) {
  const {native,catalog,spaceName,connection,projectProtected,run,close,
    onPrepareFolder,onJoin,onConnect,onFindCopies,onNewProject,onMoveFolder,onSync,onTicketError,
    onRenameServerProject,onDeleteServerProject} = params
  let selected=params.verified, customFolder='', copies=[], touched=false, search=0
  let folder=params.folder, location='', created=null
  const projects=[...catalog.projects]
  const currentId=()=>selected.projectId || ''
  host.replaceChildren()
  function field(label,tag,parent=host) {
    const row=document.createElement('label'),input=document.createElement(tag)
    input.setAttribute('aria-label',label)
    row.className='field';row.append(document.createTextNode(label),input);parent.append(row)
    return {row,input}
  }
  const project=field(tr('Проект на сервере','Server project'),'select')
  const mounted=()=>host.isConnected && host.contains(project.input)
  const links=document.createElement('div'), panel=document.createElement('div'), settings=document.createElement('div')
  links.className='server-project-links';panel.className='server-project-change';panel.hidden=true
  panel.setAttribute('role','group')
  host.append(links,panel,settings)
  const path=field(tr('Рабочая папка на этом компьютере','Working folder on this computer'),'select',settings)
  const content=field(tr('Что сохранить в выбранной папке','Contents of the selected folder'),'select',settings)
  const name=field(tr('Название нового проекта','New project name'),'input',settings)
  name.input.maxLength=80;name.input.autocomplete='off'
  const encryption=spaceEncryptionFields(projectProtected)
  const hint=document.createElement('p')
  hint.className='space-hint server-project-hint';hint.setAttribute('aria-live','polite')
  const actions=document.createElement('div'),apply=document.createElement('button')
  apply.type='button';apply.className='button primary'
  actions.className='dialog-actions';actions.append(apply)
  settings.append(encryption.row,hint,actions)

  function action(label,style,click,symbol) {
    const button=document.createElement('button')
    button.type='button';button.className=style;button.onclick=click
    if(symbol)button.innerHTML=icon(symbol)
    button.append(document.createTextNode(label))
    return button
  }
  const rename=action(tr('Переименовать','Rename'),'server-project-link',()=>editProject('rename'), 'edit')
  const remove=action(tr('Удалить с сервера…','Delete from server…'),'server-project-link',()=>editProject('delete'), 'trash')
  links.append(rename,remove)
  if(connection && !catalog.canManage && onRenameServerProject && onDeleteServerProject){
    const info=document.createElement('p')
    info.className='space-hint'
    info.textContent=tr('Для переименования и удаления проектов обновите Videron Sync на сервере.',
      'Update Videron Sync on the server to rename or delete projects.')
    host.insertBefore(info,settings)
  }
  function showSettings(focus) {
    panel.hidden=true;panel.replaceChildren();project.input.disabled=false;update()
    if(focus)focus.focus()
  }
  function editProject(mode) {
    const target=projects.find(p=>p.id===project.input.value)
    if(!target || !catalog.canManage || !panel.hidden)return
    const title=projectTitle(target),isRename=mode==='rename'
    const trigger=isRename?rename:remove
    panel.hidden=false;settings.hidden=true;links.hidden=true;project.input.disabled=true;apply.disabled=true
    encryption.setAvailable(false)
    const summary=document.createElement('strong'),detail=document.createElement('p')
    summary.className='space-confirm-name'
    summary.textContent=isRename?tr('Переименовать «'+title+'»','Rename “'+title+'”'):
      tr('Удалить «'+title+'» с сервера?','Delete “'+title+'” from the server?')
    panel.setAttribute('aria-label',summary.textContent)
    detail.className='space-hint';detail.id='server-project-change-details'
    panel.setAttribute('aria-describedby',detail.id)
    detail.textContent=isRename?tr('Новое имя появится в списке проектов на всех устройствах.','The new name will appear in the project list on every device.'):
      tr('С сервера будут удалены заметки и история проекта. Синхронизация прекратится на всех устройствах. Скачанные рабочие копии останутся в своих папках.',
         'The server will delete this project’s notes and history. Sync will stop on every device. Downloaded working copies will stay in their folders.')
    panel.append(summary,detail)
    const input=isRename?field(tr('Новое название на сервере','New server project name'),'input',panel).input:null
    const buttons=document.createElement('div');buttons.className='server-change-buttons'
    const cancel=action(tr('Отмена','Cancel'),'button secondary',()=>showSettings(trigger))
    const confirm=action(isRename?tr('Сохранить название','Save name'):tr('Удалить для всех','Delete for everyone'),
      isRename?'button primary':'button server-delete-confirm',()=>run(async()=>{
        try{
          if(isRename){
            const result=await onRenameServerProject(selected.ticket,target.id,input.value.trim(),target.name)
            if(!mounted())return
            selected=result;target.name=result.projectName
            populateProjects(currentId());showSettings()
            requestAnimationFrame(()=>{if(mounted())rename.focus()})
          }else{
            await onDeleteServerProject(selected.ticket,target.id,target.name)
            if(mounted())close()
          }
        }catch(error){
          // A renamed or deleted project requires a fresh choice before the next destructive action.
          if(['VD_PROJECT_CHANGED','VD_PROJECT_DELETED','VD_PROJECT_MISSING'].includes(String(error?.message||error).split('|')[0])){
            showSettings()
            await reloadProjects()
          }
          ticketFailure(error)
        }
      },isRename?tr('Сохраняем название…','Saving the name…'):tr('Удаляем проект с сервера…','Deleting the server project…')))
    confirm.setAttribute('aria-describedby',detail.id)
    buttons.append(cancel,confirm);panel.append(buttons)
    if(input){
      input.value=title;input.autocomplete='off'
      input.oninput=()=>{confirm.disabled=!validName(input.value)||input.value.trim()===title}
      input.oninput();input.focus();input.select()
    }else cancel.focus()
    panel.onkeydown=e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel.click()}
      else if(e.key==='Enter' && !e.isComposing){
        e.stopPropagation()
        if(input && e.target===input){e.preventDefault();confirm.click()}
      }
    }
  }

  function isCurrent(){return !!connection && currentId()===(connection.projectId||'')}
  function isNew(){return project.input.value===newProject || (!content.row.hidden && content.input.value==='empty') || !!created}
  function isCustom(){return location===custom && !!customFolder}
  function chosenFolder(){return isCustom()?customFolder:copies.find(copy=>copy.folder===location)?.folder||''}
  function populateProjects(value) {
    project.input.replaceChildren(...projects.map(item=>new Option(projectTitle(item),item.id)))
    if(value===chooseProject){
      const prompt=new Option(tr('Выберите проект…','Choose a project…'),chooseProject)
      prompt.disabled=true;project.input.add(prompt,0)
    }
    if(catalog.supported)project.input.add(new Option(tr('＋ Новый проект…','＋ New project…'),newProject))
    project.input.value=value
    project.row.hidden=!catalog.supported
  }
  function populateLocations() {
    const useCurrent=project.input.value!==newProject && (isCurrent() || (!connection && !selected.hasSpace && folder))
    const defaultLabel=useCurrent && folder ? tr('Текущая папка','Current folder')+' · '+folderLabel(folder)
      : tr('По умолчанию','Default folder')
    path.input.replaceChildren(new Option(defaultLabel,''))
    for(const copy of copies){
      if((useCurrent && folder && sameFolder(copy.folder,folder)) || (isCustom() && sameFolder(copy.folder,customFolder)))continue
      const item=new Option((copy.name||folderLabel(copy.folder))+' · '+copy.folder,copy.folder)
      item.title=copy.folder;path.input.add(item)
    }
    if(customFolder)path.input.add(new Option(customFolder,custom))
    if(native.PickFolder)path.input.add(new Option(tr('Выбрать папку…','Choose folder…'),browse))
    path.input.value=location
    if(path.input.selectedIndex<0){location='';path.input.value=''}
    path.input.title=chosenFolder() || (useCurrent && folder) || defaultLabel
  }
  function update() {
    const value=project.input.value
    links.hidden=!panel.hidden || !catalog.canManage || !onRenameServerProject || !onDeleteServerProject ||
      value===newProject || value===chooseProject || !!created
    settings.hidden=!panel.hidden || value===chooseProject
    const same=isCurrent(),has=selected.hasSpace
    const keepText=same || (!has && (folder || onPrepareFolder) && !connection)
      ? tr('Перенести содержимое текущего пространства','Move the current workspace here')
      : tr('Открыть рабочую копию проекта с сервера','Open a copy of the server project')
    content.input.options[0].textContent=keepText
    content.row.hidden=!isCustom() || !catalog.supported || project.input.value===newProject || !!created
    const fresh=isNew()
    name.row.hidden=!fresh
    name.input.readOnly=!!created
    encryption.setAvailable(!settings.hidden && (fresh || (!has && !same && (!!connection || !folder))))
    let label
    if(fresh)label=tr('Создать проект','Create project')
    else if(same)label=isCustom()?tr('Перенести в эту папку','Move to this folder'):chosenFolder()?tr('Открыть копию','Open working copy'):tr('Синхронизировать','Sync now')
    else if(has)label=tr('Открыть проект','Open project')
    else label=connection || (!folder && !onPrepareFolder)?tr('Создать рабочую копию','Create working copy'):tr('Подключить это пространство','Connect this space')
    apply.textContent=label
    apply.disabled=settings.hidden || fresh && !validName(name.input.value)
    if(fresh)hint.textContent=tr('На сервере появится новый пустой проект.','A new empty project will be created on the server.')
    else if(same && isCustom())hint.textContent=tr('Заметки и подключение переедут вместе с рабочей копией.','The working copy will move with its notes and server connection.')
    else if(!has && !connection && (folder || onPrepareFolder))hint.textContent=tr('Заметки из «'+spaceName+'» будут отправлены в этот проект.','Notes from “'+spaceName+'” will be uploaded to this project.')
    else if(has && !same && !chosenFolder())hint.textContent=tr('Videron найдёт рабочую копию или создаст её в папке приложения.','Videron will find a working copy or create one in the app’s storage folder.')
    else hint.textContent=''
    hint.hidden=!hint.textContent
  }
  function resetLocation() {
    encryption.clear()
    customFolder='';location='';copies=[];touched=false;created=null;content.input.value='keep';name.input.value=''
    populateLocations();update()
  }
  async function findCopies() {
    const attempt=++search
    if(!onFindCopies || !selected.hasSpace || project.input.value===newProject)return
    let found
    try {found=await onFindCopies(selected.ticket)} catch {return}
    if(attempt!==search || !mounted())return
    copies=found
    if(!touched && !isCurrent() && copies.length)location=copies[0].folder
    populateLocations();update()
  }
  function ticketFailure(error){
    const reason=String(error?.message||error).split('|')[0]
    if(mounted() && ['VD_SERVER_TICKET','VD_SERVER_AUTH','VD_SERVER_CERT','VD_SERVER_CODE'].includes(reason))onTicketError()
    throw error
  }
  function populateAvailable() {
    const available=!selected.projectDeleted && projects.some(p=>p.id===currentId())
    populateProjects(available?currentId():projects.length?chooseProject:newProject)
    resetLocation()
    if(available)void findCopies()
  }
  async function reloadProjects() {
    const fresh=await native.ListServerProjects(selected.ticket)
    if(!mounted())return
    projects.splice(0,projects.length,...fresh.projects)
    catalog.supported=fresh.supported;catalog.canManage=fresh.canManage
    const entry=projects.find(p=>p.id===currentId())
    if(entry)selected=await native.SelectServerProject(selected.ticket,entry.id)
    if(!mounted())return
    populateAvailable()
  }
  project.input.onchange=()=>{
    const id=project.input.value
    encryption.clear()
    if(id===newProject){++search;resetLocation();name.input.focus();return}
    run(async()=>{
      try {selected=await native.SelectServerProject(selected.ticket,id)}
      catch(error){
        project.input.value=created?newProject:currentId()
        if(['VD_PROJECT_DELETED','VD_PROJECT_MISSING'].includes(String(error?.message||error).split('|')[0]))await reloadProjects()
        ticketFailure(error)
      }
      if(!mounted())return
      const entry=projects.find(p=>p.id===id)
      if(entry){entry.name=selected.projectName||'';populateProjects(id)}
      resetLocation();void findCopies()
    },tr('Получаем сведения о проекте…','Loading project details…'))
  }
  path.input.onchange=()=>{
    if(path.input.value!==browse){
      if(location!==path.input.value)encryption.clear()
      location=path.input.value;touched=true;populateLocations();update();return
    }
    path.input.value=location
    run(async()=>{
      const dir=await native.PickFolder(getLanguage())
      if(!dir || !mounted())return
      if(!sameFolder(chosenFolder(),dir))encryption.clear()
      touched=true
      if(folder && sameFolder(folder,dir) && isCurrent()){location='';customFolder=''}
      else if(copies.some(copy=>sameFolder(copy.folder,dir)))location=copies.find(copy=>sameFolder(copy.folder,dir)).folder
      else {location=custom;customFolder=dir}
      populateLocations();update()
    },tr('Выберите папку в открывшемся окне…','Choose a folder in the system dialog…'))
  }
  content.input.add(new Option('','keep'))
  content.input.add(new Option(tr('Начать новый пустой проект','Start a new empty project'),'empty'))
  content.input.onchange=()=>{encryption.clear();update();if(!name.row.hidden)name.input.focus()}
  name.input.oninput=update
  async function applySelection(report){
    const fresh=isNew(),dest=chosenFolder()
    try {
      let result
      if(fresh){
        const title=name.input.value.trim()
        report(tr('Создаём проект…','Creating the project…'))
        if(!created){
          if(dest && native.InspectSpaceFolder && (await native.InspectSpaceFolder(dest)).exists)
            throw new Error('VD_SPACE_EXISTS')
          if(!mounted())return
          selected=await native.CreateServerProject(selected.ticket,title)
          if(!mounted())return
          created=selected
          projects.push({id:currentId(),name:title})
          populateProjects(currentId());update()
        }
        report(tr('Готовим рабочую копию…','Preparing the working copy…'))
        result=await onNewProject(selected.ticket,title,dest,encryption.password)
      }else if(isCurrent() && isCustom()){
        report(tr('Переносим рабочую копию…','Moving the working copy…'))
        result=await onMoveFolder(dest)
      }else if(isCurrent() && !dest){
        report(tr('Синхронизируем проект…','Syncing the project…'))
        result=await onSync()
      }else if(selected.hasSpace){
        report(tr('Открываем проект…','Opening the project…'))
        result=await onJoin(selected.ticket,dest,!!dest && !isCustom(),report)
      }else if(connection || (!folder && !onPrepareFolder)){
        report(tr('Создаём рабочую копию…','Creating the working copy…'))
        result=await onNewProject(selected.ticket,selected.projectName||tr('Основной проект','Main project'),dest,encryption.password)
      }else{
        if(!folder){
          report(tr('Готовим рабочую копию…','Preparing the working copy…'))
          folder=await onPrepareFolder(dest,encryption.password,selected.ticket)
          if(!folder || !mounted())return
          update()
        }else if(isCustom() && !sameFolder(folder,dest)){
          report(tr('Переносим рабочую копию…','Moving the working copy…'))
          if(await onMoveFolder(dest)===false || !mounted())return
          folder=dest
        }
        report(tr('Подключаем пространство…','Connecting the space…'))
        result=await onConnect(selected.ticket)
      }
      if(!mounted())return
      if(result?.savedFolder){
        copies=[{folder:result.savedFolder},...copies.filter(copy=>!sameFolder(copy.folder,result.savedFolder))]
        location=result.savedFolder;customFolder='';touched=true
        populateLocations();update()
        hint.hidden=false;hint.textContent=tr('Копия сохранена. Чтобы открыть её, введите пароль пространства.','Your copy has been saved. Enter the space password to open it.')
      }else if(result!==false)close()
    }catch(error){ticketFailure(error)}
  }
  apply.onclick=()=>{if(encryption.validate())return run(applySelection)}
  populateAvailable()
  return {apply,actions,clear:encryption.clear,focus:()=> (project.row.hidden?path.input:project.input).focus()}
}
