import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{report:{type:'string'}}});
const root=fileURLToPath(new URL('../../',import.meta.url));
const {actions,scenarios}=JSON.parse(await readFile(new URL('./catalog/native.json',import.meta.url),'utf8'));
const ids=new Set(actions.map(a=>a.id));
for (const action of actions) await access(path.resolve(root,action.source));
for (const s of scenarios) {
  assert.ok(s.steps.length && s.expected && s.actions.every(a=>ids.has(a)),s.id);
  assert.match(s.test,/^Test[A-Za-z0-9]+$/);
  assert.ok((await readFile(path.resolve(root,s.source),'utf8')).includes('func '+s.test+'('),s.test);
}
const packages=[...new Set(scenarios.map(s=>{
  const dir=path.posix.dirname(s.source);
  return dir==='.'?'.':'./'+dir;
}))];
const started=new Date().toISOString();
const tests=new Map(scenarios.map(s=>[s.test,{area:'native',engine:'go-integration',id:s.id,status:'not-run'}]));
const logs=new Map();
const opts={cwd:root,maxBuffer:16*1024*1024};
let stdout,problem;
try {
  ({stdout}=await promisify(execFile)('go',['test','-json','-count=1','-run','^('+[...tests.keys()].join('|')+')$',...packages],opts));
} catch (e) { stdout=e.stdout||'';problem=e.message.split('\n')[0];process.exitCode=1; }
for (const line of stdout.trim().split(/\r?\n/)) {
  if (!line) continue;
  const event=JSON.parse(line), r=tests.get(event.Test);
  if (!r) continue;
  if (event.Action==='output') logs.set(event.Test,(logs.get(event.Test)||'')+event.Output);
  if (['pass','fail','skip'].includes(event.Action)) {
    r.status=event.Action==='skip'?'not-run':event.Action;
    if (r.status!=='pass') r.reason=logs.get(event.Test);
  }
}
const results=[...tests.values()];
for (const r of results) if (r.status==='not-run' && !r.reason) r.reason=problem||'The named Go test produced no result.';
for (const r of results) console.log(r.status,r.id,r.reason??'');
if (values.report) {
  const out=path.resolve(values.report);await mkdir(path.dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify({started,catalog:[{area:'native',actions,scenarios}],results},null,2)+'\n');
}
if (results.some(r=>r.status!=='pass')) process.exitCode=1;
