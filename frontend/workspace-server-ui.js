import { icon } from './art.js'
import { getLanguage, tr } from './i18n.js'
import { folderLabel } from './folder-links.js'
import { spaceDialog } from './workspace-ui.js'
import { openVaultPassword } from './vault-ui.js'
import { lastServerAddress, rememberServerAddress } from './server-address.js'
import { mountServerProjectPicker } from './server-project-picker.js'

let dismissCurrent = null
export function dismissWorkspaceServer() { dismissCurrent?.() }

function node(tag, kind, text) {
  const el=document.createElement(tag)
  if(kind)el.className=kind
  if(text!==undefined)el.textContent=text
  return el
}
function action(label, primary, handler) {
  const b=node('button','button '+(primary?'primary':'secondary'),label)
  b.type='button';b.onclick=handler
  return b
}
function field(label, type) {
  const row=node('label','field',label), input=node('input')
  input.type=type;input.autocomplete='off';input.spellcheck=false
  row.append(input)
  return {row,input}
}

export function openWorkspaceServer(options){
  const {dialog,native,folder:initialFolder,spaceName,projectProtected,connection,onPrepareFolder,onFindCopies,onConnect,onJoin,onDisconnect,onSync,onError}=options
  let folder=initialFolder
  dismissWorkspaceServer()
  const {box,error,run,close}=spaceDialog(dialog,tr('Свой сервер','Your server'),onError)
  box.classList.add('space-server-dialog')

  let clearCredentials=()=>{}
  function dismiss(){clearCredentials();close()}
  dismissCurrent=dismiss
  // The dialog shell also supports closing via X, the backdrop and Escape.
  const observer=new MutationObserver(()=>{
    if(box.isConnected)return
    observer.disconnect();clearCredentials()
    if(dismissCurrent===dismiss)dismissCurrent=null
  })
  observer.observe(box.parentElement.parentElement,{childList:true})

  function perform(callback,button,progress){return run(async()=>{
    const label=button?.textContent
    if(button)button.textContent=progress
    try{
      const result=await callback()
      if(result!==false && box.isConnected)dismiss()
    }finally{
      if(button && button.textContent===progress)button.textContent=label
    }
  })}
  if(connection){
    rememberServerAddress(connection.address)
    const address=node('p','server-address',connection.address)
    const projectName=node('p','space-hint',connection.projectName||tr('Основной проект','Main project'))
    const hint=node('p','space-hint',tr('Отключение остановит синхронизацию этой рабочей копии. Файлы в папке и проект на сервере сохранятся.',
      'Disconnecting stops sync for this working copy. The files in its folder and the project on the server will remain available.'))
    const actions=node('div','dialog-actions')
    const projects=node('div','server-projects')
    const manage=action(tr('Проекты и папка…','Projects and folder…'),false,()=>run(async()=>{
      const profile=await native.ConnectedServerTicket(folder)
      if(!box.isConnected){discard(profile.ticket);return}
      clearCredentials=()=>discard(profile.ticket)
      const catalog=await native.ListServerProjects(profile.ticket).catch(error=>{clearCredentials();throw error})
      if(!box.isConnected)return
      const reset=()=>{
        clearCredentials();clearCredentials=()=>{}
        actions.hidden=false;hint.hidden=false;projectName.hidden=false;projects.replaceChildren();manage.focus()
      }
      projectName.textContent=profile.projectName||tr('Основной проект','Main project')
      const rename=options.onRenameServerProject && (async(...args)=>{
        const result=await options.onRenameServerProject(...args)
        if((result.projectId||'')===(connection.projectId||''))projectName.textContent=result.projectName
        return result
      })
      const picker=mountServerProjectPicker(projects,{...options,verified:profile,catalog,run,close:dismiss,onTicketError:reset,
        onRenameServerProject:rename})
      const back=action(tr('Назад','Back'),false,reset)
      picker.actions.prepend(back)
      actions.hidden=true;hint.hidden=true;projectName.hidden=true;picker.focus()
    }))
    if(native.ConnectedServerTicket && native.ListServerProjects && options.onNewProject)actions.append(manage)
    actions.append(action(tr('Отключить на этом компьютере','Disconnect on this computer'),false,()=>perform(onDisconnect)),
      action(tr('Синхронизировать','Sync now'),true,()=>perform(onSync)))
    box.append(address,projectName)
    box.append(hint,projects,error,actions);actions.lastElementChild.focus()
    return
  }

  const form=node('form'), credentials=node('div'), legacy=node('div')
  form.autocomplete='off'
  const address=field(tr('Адрес сервера','Server address'),'text')
  address.input.placeholder='sync.example.net';address.input.inputMode='url';address.input.autocapitalize='none'
  address.input.value=lastServerAddress()
  const password=field(tr('Пароль сервера','Server password'),'password')
  credentials.append(address.row,password.row)
  const code=field(tr('Код подключения','Pairing code'),'password')
  legacy.append(code.row)

  let pairing=!native?.VerifySyncServer, verified=null, generation=0, checking=false, differentSpace=false, picker=null
  const canChooseProject=!!native?.ListServerProjects && !!options.onNewProject
  function discard(ticket){
    if(ticket && native?.DiscardSyncServerTicket)native.DiscardSyncServerTicket(ticket).catch(()=>{})
  }
  function invalidate(){
    generation++;checking=false;differentSpace=false
    discard(verified?.ticket);verified=null
    copies.replaceChildren();projectHost.replaceChildren();picker=null
    error.textContent=''
  }
  clearCredentials=()=>{
    invalidate()
    password.input.value='';code.input.value=''
  }

  const summary=node('div','server-summary'), status=node('div','server-verified')
  status.setAttribute('role','status')
  const mark=node('span','space-glyph');mark.setAttribute('aria-hidden','true');mark.innerHTML=icon('check')
  const checkedAddress=node('p','server-address')
  const edit=action(tr('Изменить','Edit'),false,()=>{
    clearCredentials();update();address.input.focus()
  })
  summary.append(status,edit,checkedAddress)

  const hint=node('p','space-hint'),copies=node('div','server-copies')
  const projectHost=node('div','server-projects')
  const location=node('label','field',tr('Рабочая папка','Working folder')),locationInput=node('select')
  locationInput.setAttribute('aria-label',tr('Рабочая папка','Working folder'))
  locationInput.add(new Option(tr('По умолчанию','Default folder'),''))
  if(native.PickFolder)locationInput.add(new Option(tr('Выбрать папку…','Choose folder…'),'browse'))
  let customFolder='',chosenLocation=''
  locationInput.onchange=()=>{
    if(locationInput.value!=='browse'){chosenLocation=locationInput.value;update();return}
    locationInput.value=chosenLocation
    run(async()=>{
      const dir=await native.PickFolder(getLanguage())
      if(!dir || !box.isConnected)return
      customFolder=dir
      locationInput.querySelector('option[value="custom"]')?.remove()
      locationInput.add(new Option(dir,'custom'),locationInput.options[1]);locationInput.value=chosenLocation='custom';update()
    })
  }
  location.append(locationInput)
  const defaultFolderAvailable=!!options.onNewProject
  async function destination(){
    return defaultFolderAvailable?locationInput.value==='custom'?customFolder:'':(await native.PickFolder(getLanguage())||null)
  }
  const protect=node('label','space-choice'),encrypt=node('input')
  encrypt.type='checkbox';encrypt.checked=!!projectProtected
  protect.append(encrypt,document.createTextNode(tr('Зашифровать файл пространства паролем','Encrypt the space file with a password')))
  const actions=node('div','dialog-actions')
  const changeMode=action('',false,()=>{
    clearCredentials();pairing=!pairing;update()
    focusFirstField()
  })
  changeMode.className='server-method'
  const check=action('',true,verify)
  const join=action('',false,()=>perform(async()=>{
    const dir=await destination()
    if(dir===null || !box.isConnected)return false
    const result=await useCredential(credential=>onJoin(credential,dir,false))
    if(result?.savedFolder && box.isConnected){
      addCopy({folder:result.savedFolder})
      update()
      hint.textContent=tr('Копия сохранена. Чтобы открыть её, введите пароль пространства.',
        'Your copy has been saved. Enter the space password to open it.')
      return false
    }
    return result
  },join,tr('Открываем…','Opening…')))
  const connect=action(tr('Подключить это пространство','Connect this space'),true,()=>perform(async()=>{
    if(!folder){
      const dir=await destination()
      if(dir===null || !box.isConnected)return false
      let password=''
      if(encrypt.checked){
        const accepted=await openVaultPassword({mode:'set',scope:'space',onSubmit:values=>{password=values.password}})
        if(!accepted || !box.isConnected)return false
      }
      folder=await useCredential(credential=>onPrepareFolder(dir,password,credential))
      if(!folder || !box.isConnected)return false
      update()
    }else if(defaultFolderAvailable && locationInput.value==='custom' && customFolder!==folder){
      if(await useCredential(onConnect)===false || !box.isConnected)return false
      if(await options.onMoveFolder(customFolder)===false || !box.isConnected)return false
      folder=customFolder;return true
    }
    return useCredential(onConnect)
  },connect,tr('Подключаем…','Connecting…')))
  function addCopy({folder,name=folderLabel(folder)}){
    if([...copies.children].some(row=>row.dataset.folder===folder))return
    const row=node('div','server-copy')
    row.dataset.folder=folder
    const open=action(tr('Открыть «'+name+'»','Open “'+name+'”'),true,()=>perform(
      ()=>useCredential(credential=>onJoin(credential,folder,true)),open,tr('Открываем…','Opening…')))
    open.title=folder
    const path=node('span','space-detail',folder)
    path.title=folder;path.id='server-copy-folder-'+copies.childElementCount
    open.setAttribute('aria-describedby',path.id)
    row.append(open,path);copies.append(row)
  }
  function defaultAction(){return picker?.apply || copies.querySelector('button') || (!connect.hidden?connect:!join.hidden?join:edit)}
  function focusFirstField(){
    const first=pairing?code.input:address.input.value?password.input:address.input
    first.focus()
  }

  async function findCopies(ticket,attempt){
    let matches
    // An unavailable library folder must not hold up opening a manually chosen folder.
    try{matches=await onFindCopies(ticket)}catch{return}
    if(!matches.length || attempt!==generation || !box.isConnected || !verified?.hasSpace)return
    const focusCopy=!box.inert && document.activeElement===join
    for(const copy of matches)addCopy(copy)
    update()
    if(focusCopy)defaultAction().focus()
  }

  async function useCredential(callback){
    const credential=pairing?code.input.value.trim():verified?.ticket
    if(!credential)return false
    try{return await callback(credential)}
    catch(e){
      const reason=String(e?.message||e).split('|')[0]
      if(['VD_SERVER_TICKET','VD_SERVER_AUTH','VD_SERVER_CERT','VD_SERVER_CODE'].includes(reason)){
        clearCredentials();update()
      }else if(reason==='VD_SERVER_SPACE' || reason==='VD_SERVER_EMPTY'){
        differentSpace=reason==='VD_SERVER_SPACE'
        if(verified)verified.hasSpace=differentSpace
        if(!differentSpace)copies.replaceChildren()
        update()
      }
      throw e
    }
  }

  async function verify(){
    if(checking || pairing || verified || !address.input.value.trim() || !password.input.value)return
    const attempt=++generation
    if(document.activeElement===check)password.input.focus({preventScroll:true})
    checking=true;error.textContent='';update()
    let result
    try{
      result=await native.VerifySyncServer(address.input.value.trim(),password.input.value)
      if(attempt!==generation || !box.isConnected){discard(result?.ticket);return}
      if(!result?.ticket || !result.address)throw new Error('VD_SERVER_RESPONSE')
      rememberServerAddress(result.address)
      const catalog=canChooseProject?await native.ListServerProjects(result.ticket):null
      if(attempt!==generation || !box.isConnected){discard(result.ticket);return}
      password.input.value='';verified=result
      status.replaceChildren(mark,document.createTextNode(tr('Доступ к серверу подтверждён','Server access verified')))
      checkedAddress.textContent=result.address
      if(catalog)picker=mountServerProjectPicker(projectHost,{...options,verified:result,catalog,run,close:dismiss,
        onTicketError:()=>{clearCredentials();update();password.input.focus()}})
      update()
      if(picker)picker.focus()
      else{defaultAction().focus();if(result.hasSpace && onFindCopies)void findCopies(result.ticket,attempt)}
    }catch(e){
      discard(result?.ticket)
      if(attempt===generation && box.isConnected)error.textContent=onError(e)
    }finally{
      if(attempt===generation && box.isConnected){checking=false;update()}
    }
  }

  function update(){
    const ready=!!verified || pairing
    credentials.hidden=pairing || !!verified;legacy.hidden=!pairing;summary.hidden=!verified
    hint.hidden=!ready
    changeMode.hidden=!native?.VerifySyncServer || !!verified
    changeMode.textContent=pairing?tr('Ввести адрес и пароль','Use address and password'):tr('Использовать код подключения','Use a pairing code')
    check.hidden=ready
    check.disabled=checking || !address.input.value.trim() || !password.input.value
    check.textContent=checking?tr('Проверяем…','Checking…'):tr('Проверить подключение','Check connection')
    const knownCopies=copies.childElementCount
    const canConnect=!differentSpace && verified?.hasSpace!==true && (!!folder || !!onPrepareFolder)
    connect.hidden=!ready || !canConnect;join.hidden=!ready || verified?.hasSpace===false
    const hasCredential=!!verified || !!code.input.value.trim()
    connect.disabled=!hasCredential || (!folder && !native?.PickFolder && !defaultFolderAvailable)
    connect.textContent=folder && defaultFolderAvailable && locationInput.value==='custom' && customFolder!==folder
      ?tr('Подключить и перенести','Connect and move'):tr('Подключить это пространство','Connect this space')
    join.disabled=!hasCredential || (!native?.PickFolder && !defaultFolderAvailable)
    join.textContent=defaultFolderAvailable?tr('Открыть с сервера','Open from server'):
      knownCopies?tr('Выбрать другую папку…','Choose another folder…'):tr('Открыть с сервера…','Open from server…')
    join.className='button '+(canConnect || knownCopies?'secondary':'primary')
    copies.hidden=!knownCopies
    protect.hidden=connect.hidden || !!folder
    if(!canConnect && verified?.hasSpace===false){
      hint.textContent=tr('Сервер пуст. Создайте или откройте пространство в Videron, затем подключите его здесь.',
        'The server is empty. Create or open a space in Videron, then connect it here.')
    }else if(knownCopies){
      hint.textContent=knownCopies===1?tr('Рабочая копия на этом компьютере','Working copy on this computer'):
        tr('Рабочие копии на этом компьютере','Working copies on this computer')
    }else if(!canConnect){
      hint.textContent=defaultFolderAvailable?tr('Откройте проект в папке по умолчанию или укажите свою рабочую папку.',
        'Open the project in the default folder or choose your own working folder.'):
        tr('Выберите папку с рабочей копией этого пространства или пустую папку для новой копии.',
          'Choose the folder containing your working copy of this space, or an empty folder for a new copy.')
    }else if(!folder){
      hint.textContent=tr('При подключении «'+spaceName+'» его карта и заметки будут отправлены на сервер.',
        'Connecting “'+spaceName+'” will upload its map and notes to the server.')
    }else{
      hint.textContent=onPrepareFolder?
        tr('Пространство сохранено в папке. Нажмите «Подключить это пространство», чтобы начать синхронизацию.',
           'Your space is saved in its folder. Choose “Connect this space” to start syncing.'):
        tr('Подключите «'+spaceName+'», чтобы синхронизировать карту и заметки с сервером.',
           'Connect “'+spaceName+'” to sync its map and notes with the server.')
    }
    if(!verified){status.replaceChildren();checkedAddress.textContent=''}
    location.hidden=!ready || !!picker || !defaultFolderAvailable
    if(picker){hint.hidden=true;protect.hidden=true;actions.hidden=true;copies.hidden=true}
    else actions.hidden=false
  }
  for(const input of [address.input,password.input,code.input])input.oninput=()=>{invalidate();update()}
  actions.append(changeMode,check,join,connect)
  form.append(credentials,legacy,summary,projectHost,hint,copies,location,protect,error,actions);box.append(form)
  // Inputs may share a form even when their alternate sign-in method is hidden.
  form.onsubmit=e=>{e.preventDefault();(pairing || verified?defaultAction():check).click()}
  form.onkeydown=e=>{
    if(e.target.tagName==='INPUT' && e.key==='Enter' && !e.isComposing){
      e.preventDefault();(pairing || verified?defaultAction():check).click()
    }
  }
  update();focusFirstField()
}
