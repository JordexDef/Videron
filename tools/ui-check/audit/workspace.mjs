import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {syncCases} from './workspace-sync.mjs';

const pack={apiVersion:1,type:'language',id:'qa.audit-locale',locale:'fr',name:'Audit French',messages:{Settings:'Audit réglages'}};
const name='Audit space';
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const dialog=page=>page.getByRole('dialog').last();
const note=page=>page.locator('.tree-note-link[data-note-id="sample"]');
const workspaceMenu=page=>page.locator('#workspace-switch').click();
async function spaceAction(page,name) {
  await workspaceMenu(page);await page.getByRole('menuitem',{name,exact:true}).click();
}
async function create(page) {
  await spaceAction(page,'Create space…');
  const input=dialog(page).getByRole('textbox');
  await input.fill('  '+name+'  '); await input.press('Enter');
  await page.waitForFunction(n=>document.querySelector('#space-name').textContent===n,name);
}
async function switchTo(page,name) {
  await workspaceMenu(page);await page.getByRole('menuitemradio',{name,exact:true}).click();
  await page.waitForFunction(n=>document.querySelector('#space-name').textContent===n,name);
}
async function remove(page) {
  await spaceAction(page,'Spaces on this computer…');
  await button(page,'Delete from local library · '+name).click();
}
async function importFile(page, contents,action='Install from JSON') {
  const chosen=page.waitForEvent('filechooser');
  await button(page,action).click();
  await (await chosen).setFiles({name:'pack.json',mimeType:'application/json',buffer:Buffer.from(typeof contents==='string'?contents:JSON.stringify(contents))});
}
const row=page=>page.locator('.extension').filter({has:page.getByRole('heading',{name:pack.name})});
async function install(page) {
  await page.locator('#extensions').click();await importFile(page,pack);
  await row(page).waitFor();
}
async function applyLanguage(page) {
  await row(page).getByRole('button',{name:'Use language'}).click();
  await page.waitForFunction(()=>document.documentElement.lang==='fr');
}
async function palette(page,value) {
  await page.waitForFunction(v=>document.documentElement.dataset.theme===v,value);
}
async function chooseTheme(page,value) {
  const field=page.locator('.theme-option').filter({has:page.locator('input[value="'+value+'"]')});
  await field.click(); assert.ok(await field.locator('input').isChecked());
}

export const cases={
  ...syncCases,
  async 'workspace.demo-extension-return'({page,openNote}) {
    const initial=await page.locator('#space-name').innerText();
    await switchTo(page,'Demo map');
    const demo=page.locator('.tree-note-link[data-note-id]').first();
    await demo.waitFor();
    const demoId=await demo.getAttribute('data-note-id');
    assert.notEqual(demoId,'sample');
    assert.equal(await note(page).count(),0);
    await page.locator('#extensions').click();
    await button(page,'Open').click();
    await page.frameLocator('iframe').getByRole('button',{name:/#/}).first().waitFor();
    await button(page,'← All extensions').click();
    await page.getByRole('heading',{name:'Tag spectrum',exact:true}).waitFor();
    assert.equal(await page.locator('iframe').count(),0);
    await button(page,'Close').click();
    assert.equal(await page.locator('#space-name').innerText(),'Demo map');
    await switchTo(page,initial);
    assert.equal(await page.locator('.tree-note-link').count(),1);
    await openNote('sample');
    assert.equal(await page.locator('.ve-text').first().innerText(),'Sample text');
  },
  async 'workspace.follow-system'({page}) {
    await page.locator('#settings').click();
    assert.ok(await page.locator('input[value=system]').isChecked());
    await page.emulateMedia({colorScheme:'dark'});await palette(page,'dark');
    await chooseTheme(page,'dark');await page.emulateMedia({colorScheme:'light'});
    await page.keyboard.press('Escape');await page.reload();await palette(page,'dark');
    await page.locator('#settings').click();assert.ok(await page.locator('input[value=dark]').isChecked());
    await chooseTheme(page,'light');await palette(page,'light');
    await chooseTheme(page,'system');await page.emulateMedia({colorScheme:'dark'});await palette(page,'dark');
  },
  async 'workspace.language-reload'({page}) {
    await page.locator('#language-select').selectOption('ru');
    await page.locator('#graph').focus();await page.keyboard.press('F1');
    await page.getByRole('heading',{name:'Управление картой'}).waitFor();
    await page.keyboard.press('Escape');await page.reload();
    assert.equal(await page.locator('#language-select').inputValue(),'ru');
    await page.locator('#language-select').selectOption('en');await page.locator('#help').click();
    await page.getByRole('heading',{name:'Map controls'}).waitFor();assert.match(await note(page).textContent(),/Sample note/);
  },
  async 'workspace.local-status'({page}) {
    const toggle=page.locator('#workspace-status-toggle'), panel=page.locator('#workspace-status-details');
    await toggle.click(); await panel.waitFor();assert.match(await panel.innerText(),/Local library|Local storage/i);
    assert.doesNotMatch(await panel.innerText(),/Server address/);await page.keyboard.press('Escape');
    assert.ok(await panel.isHidden());assert.ok(await toggle.evaluate(n=>document.activeElement===n));
    await toggle.click();await page.locator('#settings').click();await page.locator('.vault-panel').waitFor();assert.ok(await panel.isHidden());
  },
  async 'workspace.create-cancel'({page}) {
    await spaceAction(page,'Create space…');const input=dialog(page).getByRole('textbox');
    await input.fill('   ');assert.ok(await button(page,'Create').isDisabled());
    await input.fill(name);assert.ok(await button(page,'Create').isEnabled());await button(page,'Cancel').click();
    await workspaceMenu(page);assert.equal(await page.getByRole('menuitemradio',{name,exact:true}).count(),0);assert.ok(await note(page).isVisible());
  },
  async 'workspace.space-roundtrip'({page}) {
    const initial=await page.locator('#space-name').innerText();await create(page);
    assert.equal(await page.locator('.tree-note-link[data-note-id]').count(),0);await switchTo(page,initial);assert.ok(await note(page).isVisible());
    await switchTo(page,name);await page.reload();await page.waitForFunction(n=>document.querySelector('#space-name').innerText===n,name);
    assert.equal(await page.locator('.tree-note-link[data-note-id]').count(),0);
  },
  async 'workspace.remove-cancel'({page}) {
    const initial=await page.locator('#space-name').innerText();await create(page);await switchTo(page,initial);
    await remove(page);await button(page,'Cancel').click();
    assert.ok(await button(page,'Delete from local library · '+name).isVisible());await page.keyboard.press('Escape');
    assert.ok(await note(page).isVisible());await switchTo(page,name);
  },
  async 'workspace.remove-local'({page,openNote}) {
    const initial=await page.locator('#space-name').innerText();await create(page);await remove(page);await button(page,'Delete from library').click();
    await page.waitForFunction(n=>document.querySelector('#space-name').innerText===n,initial);await page.reload();await note(page).waitFor();
    await workspaceMenu(page);assert.equal(await page.getByRole('menuitemradio',{name,exact:true}).count(),0);
    await page.keyboard.press('Escape');await openNote('sample');assert.equal(await page.locator('.ve-text').first().innerText(),'Sample text');
  },
  async 'workspace.tag-roundtrip'({page,seed}) {
    await seed({areas:[],notes:['First','Second'].map((title,i)=>({id:'tag'+i,title,x:i*200,y:0,tags:['audit'],links:[],plain:'#audit',body:[{type:'paragraph',runs:[{text:'#audit'}]}]}))});
    await page.locator('#extensions').click();await button(page,'Open').click();
    const frame=page.frameLocator('iframe'),tag=frame.getByRole('button',{name:/#audit/});
    await tag.click();await frame.getByRole('button',{name:'First',exact:true}).waitFor();await frame.getByRole('button',{name:'Second',exact:true}).waitFor();
    await frame.getByRole('button',{name:/All tags/}).click();await tag.click();await frame.getByRole('button',{name:'Second',exact:true}).click();
    await page.locator('.ve-title').waitFor();assert.equal(await page.locator('.ve-title').inputValue(),'Second');assert.equal(await page.locator('iframe').count(),0);
  },
  async 'workspace.bad-import-retry'({page}) {
    await page.locator('#extensions').click();await importFile(page,'{');
    await page.getByText(/does not contain valid JSON/).waitFor();assert.equal(await row(page).count(),0);
    await importFile(page,pack);await applyLanguage(page);await page.keyboard.press('Escape');await page.reload();
    await page.waitForFunction(()=>document.documentElement.lang==='fr');assert.match(await page.locator('#settings').innerText(),/Audit réglages/);
  },
  async 'workspace.update-identity'({page}) {
    await install(page);await importFile(page,{...pack,id:'qa.different'},'Update…');
    await page.getByText(/same ID and language code/).waitFor();
    await importFile(page,{...pack,messages:{Settings:'Audit updated'}},'Update…');
    await page.getByText('Language pack updated',{exact:true}).waitFor();
    assert.equal(await row(page).count(),1);await applyLanguage(page);assert.match(await page.locator('#settings').innerText(),/Audit updated/);
  },
  async 'workspace.remove-active-language'({page}) {
    await install(page);await applyLanguage(page);
    // Applying a language can remount the manager with translated controls.
    if (!await row(page).isVisible()) await page.locator('#extensions').click();
    await row(page).getByRole('button',{name:/Remove/}).click();
    await page.waitForFunction(()=>document.documentElement.lang!=='fr');await page.reload();await note(page).waitFor();
    const locales=page.locator('#language-select');
    assert.ok(['en','ru'].includes(await locales.inputValue()));assert.equal(await locales.locator('option[value=fr]').count(),0);
  },
  async 'workspace.download-template'({page}) {
    await page.locator('#extensions').click();const downloaded=page.waitForEvent('download');
    await button(page,'Save language template…').click();const file=await downloaded;
    assert.equal(file.suggestedFilename(),'Videron.language.json');
    const manifest=JSON.parse(await readFile(await file.path(),'utf8'));assert.equal(manifest.type,'language');assert.ok(Object.keys(manifest.messages).length>0);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#language-select').inputValue(),'en'); assert.equal(await page.locator('#language-select option').count(),2);
  }
};
