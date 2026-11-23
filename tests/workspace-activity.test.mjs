import test from 'node:test'
import assert from 'node:assert/strict'
import {spaceDialog} from '../frontend/workspace-ui.js'

test('a delayed workspace operation announces its stage and can be retried after an error', async t => {
  function element() {
    return {
      isConnected:true, inert:false, children:[], dataset:{}, classList:{add(){}},
      setAttribute(name,value){this[name]=value},
      append(node){this.children=this.children.filter(child=>child!==node);this.children.push(node)},
      contains(node){return this.children.includes(node)},
      getClientRects(){return [{}]},
      focus(){document.activeElement=this},
    }
  }
  const previousDocument=globalThis.document
  globalThis.document={createElement:element,body:element()}
  t.after(()=>{
    if(previousDocument)globalThis.document=previousDocument
    else delete globalThis.document
  })
  const box=element(), trigger=element(), alreadyLocked=element()
  box.parentElement=new EventTarget()
  alreadyLocked.inert=true
  box.append(trigger);box.append(alreadyLocked)
  trigger.focus()
  const {error,run}=spaceDialog(()=>({box,close(){}}),'Server',error=>error.message)
  const activity=box.children.find(child=>child.role==='status')
  assert.equal(activity.hidden,true)

  let attempts=0,report,reject
  const wait=update=>{
    attempts++;report=update
    return new Promise((_,fail)=>{reject=fail})
  }
  const first=run(wait,'Checking the working copy')
  assert.equal(activity.hidden,false)
  assert.equal(activity.textContent,'Checking the working copy')
  assert.equal(trigger.inert,true)
  assert.equal(activity.inert,false)
  report('Downloading project')
  assert.equal(activity.textContent,'Downloading project')
  await run(wait,'Duplicate request')
  assert.equal(attempts,1)
  assert.equal(activity.textContent,'Downloading project')
  reject(new Error('Offline'))
  await first
  assert.equal(error.textContent,'Offline')
  assert.equal(trigger.inert,false)
  assert.equal(alreadyLocked.inert,true)
  assert.equal(activity.hidden,true)
  assert.equal(document.activeElement,trigger)

  const stale=report, passwordInput=element()
  await run(async update=>{
    stale('Late update')
    assert.equal(activity.textContent,'Retrying')
    assert.equal(error.textContent,'')
    update('Opening project')
    // The user can focus a password prompt while the parent operation is pending.
    passwordInput.focus()
  },'Retrying')
  assert.equal(activity.hidden,true)
  assert.equal(document.activeElement,passwordInput)
})
