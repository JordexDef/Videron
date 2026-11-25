import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import path from 'node:path';

const {values}=parseArgs({options:{'windows-shell':{type:'boolean'}}});
if (values['windows-shell'] && process.platform!=='win32') throw Error('--windows-shell requires a Windows desktop session.');
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=path.join(root,'output','qa');
await mkdir(output,{recursive:true});
const dir=await mkdtemp(path.join(output,'run-'));
const ui=path.join(dir,'interface.json'),native=path.join(dir,'native.json'),html=path.join(dir,'Videron-QA.html');
function run(module,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL(module,import.meta.url)),...args],{cwd:root,stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>resolve(code??1));
  });
}
// Run serially to avoid browser timeouts caused solely by native build/test load.
const uiStatus=await run('./run-audit.mjs',['--report',ui]);
const nativeStatus=await run('./native-audit.mjs',['--report',native]);
const reports=[ui,native];
let desktopStatus=0;
if (process.platform==='win32') {
  const desktop=path.join(dir,'desktop.json');
  const shell=values['windows-shell']?['--system-clipboard','--explorer']:[];
  desktopStatus=await run('./windows-credentials.mjs',[desktop,...shell]);
  reports.push(desktop);
  const sync=path.join(dir,'desktop-sync.json');
  const syncStatus=await run('./windows-sync.mjs',[sync]);
  desktopStatus=desktopStatus||syncStatus;
  reports.push(sync);
}
const reportStatus=await run('./render-audit.mjs',['--out',html,...reports]);
if (!reportStatus) {
  await copyFile(html,path.join(output,'Videron-QA.html'));
  console.log(html);
}
process.exitCode=uiStatus||nativeStatus||desktopStatus||reportStatus;
