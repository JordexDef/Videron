import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,webkit} from 'playwright-core';
import {serveFrontend} from './serve-frontend.mjs';

const {values:args}=parseArgs({options:{
  area:{type:'string'}, engine:{type:'string'}, case:{type:'string'}, report:{type:'string'},frontend:{type:'string'}
}});
const areas=['map','editor','board','workspace','search'];
const engines={chromium,webkit};
if (args.area && !areas.includes(args.area)) throw Error('Unknown area: '+args.area);
if (args.engine && !Object.hasOwn(engines,args.engine)) throw Error('Unknown engine: '+args.engine);
const repo=fileURLToPath(new URL('../../',import.meta.url));
const ids=new Set();
const runs=[];
const catalog=[];
for (const area of args.area?[args.area]:areas) {
  const {actions,scenarios}=JSON.parse(await readFile(new URL('./catalog/'+area+'.json',import.meta.url),'utf8'));
  const {cases}=await import('./audit/'+area+'.mjs');
  const actionIds=new Set(actions.map(a=>a.id));
  assert.equal(actionIds.size,actions.length,'Duplicate action IDs in '+area);
  for (const a of actions) {
    assert.ok(a.id.startsWith(area+'.') && a.label && a.entry && a.source,a.id);
    await access(path.resolve(repo,a.source.replace(/:\d+$/,'')));
  }
  for (const s of scenarios) {
    assert.ok(s.id.startsWith(area+'.') && !ids.has(s.id) && s.steps?.length && s.expected && ['high','medium','low'].includes(s.risk),s.id);
    assert.ok(s.actions?.length && s.actions.every(id=>actionIds.has(id)),s.id+' uses unknown actions');
    ids.add(s.id);
  }
  for (const key of Object.keys(cases)) assert.ok(scenarios.some(s=>s.id===key),'Missing expectation for '+key);
  catalog.push({area,actions,scenarios});
  for (const s of scenarios) if (!args.case || s.id===args.case) runs.push({area,id:s.id,run:cases[s.id],requires:s.requires});
}
if (!runs.length) throw Error('No matching scenario');

const sample={id:'sample',title:'Sample note',body:[{type:'paragraph',runs:[{text:'Sample text'}]}],plain:'Sample text',x:0,y:0,tags:[],links:[],pinned:true};
async function session(browser,origin) {
  const context=await browser.newContext({viewport:{width:1280,height:820},reducedMotion:'reduce',colorScheme:'light'});
  const errors=[];
  try {
    const page=await context.newPage();
    page.setDefaultTimeout(6500);
    page.on('pageerror',e=>errors.push(e.message));
    async function seed(space) {
      // Leave the old client before writing the fixture: its pagehide flush is real.
      await page.goto(origin+'/__qa_seed');
      await page.evaluate(data=>{
        localStorage.clear();
        localStorage.setItem('videron.library.v1',JSON.stringify({version:1,active:'personal',spaces:{personal:data},plugins:[],view:{manualLayout:true}}));
        localStorage.setItem('videron.interface-language.v1','en');
        localStorage.setItem('videron.map-camera.v1.personal',JSON.stringify({x:0,y:0,zoom:1}));
      },space);
      await page.goto(origin);
      await page.waitForFunction(()=>document.querySelector('#space-name')?.textContent.trim());
    }
    await seed({notes:[sample],areas:[]});
    const mac=await page.evaluate(()=>/Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform||navigator.platform));
    async function openNote(id) {
      const selector=await page.evaluate(id=>'.tree-note-link[data-note-id="'+CSS.escape(id)+'"]',id);
      await page.locator(selector).click();
      await page.locator('.vd-editor:not(.ve-embedded-editor)').first().waitFor();
    }
    return {context,page,primary:mac?'Meta':'Control',mac,origin,seed,openNote,errors};
  } catch(error) { await context.close();throw error; }
}

const started=new Date().toISOString(),host=await serveFrontend(args.frontend?path.resolve(args.frontend):undefined);
const results=[];
async function runEngine(name, engine) {
  const browser=await engine.launch();
  try {
    for (const {id,area,run,requires} of runs) {
      const result={id,area,engine:name};
      if (!run) { results.push({...result,status:'not-run',reason:requires??'No automated browser scenario'});continue; }
      let s;
      try {
        s=await session(browser,host.origin);
        await run(s);
        assert.deepEqual(s.errors,[],'Uncaught error in Videron');
        result.status='pass';
      } catch(error) {
        result.status='fail';result.reason=error.stack||String(error);
      } finally { await s?.context.close(); }
      results.push(result);
      console.log(name,result.status,id,result.reason??'');
    }
  } finally { await browser.close(); }
}
try {
  const targets=args.engine?[[args.engine,engines[args.engine]]]:Object.entries(engines);
  const finished=await Promise.allSettled(targets.map(([name,engine])=>runEngine(name,engine)));
  for (const [i,outcome] of finished.entries()) {
    if (outcome.status!=='rejected') continue;
    process.exitCode=1;
    const engine=targets[i][0],reason=String(outcome.reason);
    console.error(engine,reason);
    for (const {id,area} of runs) if (!results.some(r=>r.id===id && r.engine===engine)) {
      results.push({id,area,engine,status:'not-run',reason});
    }
  }
} finally { await host.close(); }
if (args.report) {
  const target=path.resolve(args.report);
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,JSON.stringify({started,catalog,results},null,2)+'\n');
}
console.log('Passed',results.filter(r=>r.status==='pass').length,'Failed',results.filter(r=>r.status==='fail').length,'Not run',results.filter(r=>r.status==='not-run').length);
if (results.some(r=>r.status==='fail')) process.exitCode=1;
