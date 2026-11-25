import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

function shell(args,onReady) {
  return new Promise((resolve,reject)=>{
    const helper=fileURLToPath(new URL('./windows-folder.ps1',import.meta.url));
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',helper,...args],{windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:45000});
    let output='',errors='',ready=false;
    child.stdout.on('data',chunk=>{
      output+=chunk.toString();
      if (!ready && /^READY\r?$/m.test(output)) { ready=true; onReady?.(); }
    });
    child.stderr.on('data',chunk=>{errors+=chunk.toString()});
    child.once('error',reject);
    child.once('close',code=>code===0?resolve(output):reject(new Error(errors.trim()||'Windows Shell check timed out')));
  });
}

export async function checkFolder({page,pid,dir}) {
  const folder=path.join(dir,'Project folder Ω '+randomUUID());
  const marker=randomUUID()+'.txt',title='Folder link '+randomUUID();
  await mkdir(folder);
  await writeFile(path.join(folder,marker),'Videron UI audit');
  const button=name=>page.getByRole('button',{name,exact:true});
  await button('New note').click();
  await page.locator('.ve-title').fill(title);
  const paragraph=page.locator('.ve-content .ve-text').first();
  const label='Project folder',prefix='Before ',sentence=prefix+label+' after';
  await paragraph.fill(sentence);
  await paragraph.press('Home');
  for (const _ of prefix) await page.keyboard.press('ArrowRight');
  for (const _ of label) await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await page.evaluate(()=>getSelection().toString()),label);
  await Promise.all([
    shell(['-Mode','choose','-Folder',folder,'-OwnerPid',String(pid)]),
    button('Link to folder').click()
  ]);
  const link=paragraph.locator('a[data-folder-path]');
  await link.waitFor();
  assert.equal(await link.textContent(),label);
  await paragraph.focus();
  await page.keyboard.press('Control+s');
  await button('Back to map').click();
  await page.getByRole('treeitem',{name:title,exact:true}).click();
  await link.waitFor();
  assert.equal(await paragraph.innerText(),sentence);
  assert.equal(await link.textContent(),label);
  assert.equal(path.normalize(await link.getAttribute('data-folder-path')),folder);
  let ready;
  const watching=new Promise(resolve=>{ready=resolve});
  const observation=shell(['-Mode','observe','-Folder',folder,'-Sentinel',marker],ready);
  await Promise.race([watching,observation.then(()=>{throw Error('Explorer observer exited before it was ready')})]);
  const [output]=await Promise.all([observation,link.click()]);
  assert.match(output,/CLOSED|REUSED/);
  console.log('Explorer showed the exact folder and marker. '+(output.includes('CLOSED')?'Test window closed.':'A pre-existing shell window was reused.'));
}
