import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';

const {values,positionals}=parseArgs({options:{out:{type:'string'},findings:{type:'string'}},allowPositionals:true});
if (!values.out || !positionals.length) throw Error('Pass --out report.html and the result JSON file(s).');
const catalogs=new Map(),observations=new Map(),dates=[];
for (const file of positionals) {
  const report=JSON.parse(await readFile(file,'utf8'));
  dates.push(report.started);
  for (const section of report.catalog) {
    if (catalogs.has(section.area)) assert.deepEqual(catalogs.get(section.area),section,'Reports use different catalogs');
    catalogs.set(section.area,section);
  }
  for (const result of report.results) {
    const key=JSON.stringify([result.id,result.engine]);
    assert.ok(!observations.has(key),'Overlapping report: '+key);
    observations.set(key,result);
  }
}
const findings=values.findings?JSON.parse(await readFile(values.findings,'utf8')):[];
const results=[...observations.values()];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sectionNames={map:'Карта',board:'Холст и таблицы',editor:'Редакторы',workspace:'Пространства и настройки',search:'Поиск по библиотеке',native:'Синхронизация и защита'};
const engineNames={'go-integration':'Go · интеграция',webview2:'Windows · WebView2',chromium:'Chromium',webkit:'WebKit',
  'os-clipboard':'Буфер обмена ОС','native-picker':'Системный выбор папки и файловый менеджер'};
const riskNames={high:'Высокий',medium:'Средний',low:'Низкий'};
const stateNames={pass:'Пройден',fail:'Ошибка',partial:'Частично',pending:'Без прогона'};
const sections=[...catalogs.values()];
const actions=sections.flatMap(c=>c.actions);
const scenarios=sections.flatMap(c=>c.scenarios);
const scenarioIds=new Set(scenarios.map(s=>s.id));
for (const r of results) assert.ok(scenarioIds.has(r.id),'Unknown result '+r.id);
for (const f of findings) assert.ok(scenarioIds.has(f.id),'Unknown finding '+f.id);
const state=new Map(),used=new Map();
for (const s of scenarios) {
  const observations=results.filter(r=>r.id===s.id);
  const expected=s.runtimes??(s.id.startsWith('native.')?['go-integration']:['chromium','webkit']);
  const all=expected.every(e=>observations.some(r=>r.engine===e && r.status==='pass'));
  const level=observations.some(r=>r.status==='fail')?'fail':all?'pass':observations.some(r=>r.status==='pass'||r.status==='partial')?'partial':'pending';
  state.set(s.id,level);
  for (const id of s.actions) { if (!used.has(id)) used.set(id,[]);used.get(id).push(s.id); }
}
const option=(v,title)=>'<option value="'+esc(v)+'">'+esc(title)+'</option>';
const anchor=id=>'<a href="#'+esc(id)+'">'+esc(id)+'</a>';
function scenarioRow(s,area) {
  const status=state.get(s.id);
  const entries=results.filter(r=>r.id===s.id);
  for (const engine of s.runtimes??[]) if (!entries.some(r=>r.engine===engine)) entries.push({engine,status:'not-run'});
  const evidence=entries.map(r=>{
    const reason=r.reason && r.status!=='pass'?' · '+esc(r.reason.split('\n')[0]):'';
    return '<li>'+esc(engineNames[r.engine]??r.engine)+' — '+esc(({pass:'пройден',fail:'ошибка','not-run':'без прогона',partial:'частично'})[r.status]??r.status)+reason+(r.note?' · '+esc(r.note):'')+'</li>';
  }).join('')||'<li>Для этой цепочки в выбранных файлах нет результатов.</li>';
  return '<details class="row" id="'+esc(s.id)+'" data-kind="scenarios" data-area="'+esc(area)+'" data-status="'+status+'"><summary><code>'+esc(s.id)+'</code> <span class="status '+status+'">'+stateNames[status]+'</span><span class="sub">'+esc(s.steps[0])+'</span></summary><div class="detail"><ol>'+s.steps.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ol><b>Ожидаемый результат</b><p>'+esc(s.expected)+'</p><b>Результат прогона</b><ul>'+evidence+'</ul><p>Риск · '+riskNames[s.risk]+'</p><p>Действия · '+s.actions.map(anchor).join(' · ')+'</p></div></details>';
}
function actionRow(a,area) {
  const ids=used.get(a.id)??[];
  return '<details class="row" id="'+esc(a.id)+'" data-kind="actions" data-area="'+esc(area)+'"><summary><code>'+esc(a.id)+'</code> '+esc(a.label)+'</summary><div class="detail"><p>'+esc(a.entry)+'</p><p><code>'+esc(a.source)+'</code></p><p>'+(ids.length?ids.map(anchor).join(' · '):'Действие внесено в каталог. Отдельная цепочка пока не назначена.')+'</p></div></details>';
}
const count=status=>[...state.values()].filter(x=>x===status).length;
const covered=new Set(scenarios.filter(s=>state.get(s.id)==='pass').flatMap(s=>s.actions)).size;
const title='Проверка интерфейса Videron';
const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}*{box-sizing:border-box}body{max-width:1100px;margin:36px auto;padding:0 20px 64px}h1{font-size:clamp(1.7rem,4vw,2.6rem);margin-bottom:.3em}h2{font-size:1.2rem}a{color:LinkText}small,.sub{opacity:.76}.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:20px 0}input,select{font:inherit;color:inherit;background:Canvas;border:1px solid GrayText;border-radius:5px;padding:.4em .6em}.row{border-top:1px solid color-mix(in srgb,CanvasText 20%,Canvas);padding:9px 0}.row summary{cursor:pointer}.detail{padding:0 1em}.detail p{margin:.4em 0 1em}code{font-size:.9em}.sub{display:block;margin-left:1.4em}.status{float:right;padding:0 .5em;border:1px solid GrayText;border-radius:5px;font-size:.82em}.fail{font-weight:700}.finding{margin:.8em 0}li{margin:.25em 0}[hidden]{display:none!important}@media(max-width:550px){.status{float:none}.filters>*{max-width:100%}} </style>
<main><h1>${title}</h1><small>Начало прогона · ${esc(dates.sort()[0])}</small><p>${actions.length} действий в каталоге · ${scenarios.length} цепочек. Пройдено полностью · ${count('pass')}. Частично · ${count('partial')}. С ошибкой · ${count('fail')}. Без прогона · ${count('pending')}.</p>
<p>В полностью пройденных цепочках заявлено ${covered} из ${actions.length} действий каталога. Проверки интерфейса используют временные библиотеки. Для синхронизации и защиты указаны отдельные интеграционные тесты Go. Названия элементов даны по английскому интерфейсу приложения.</p>
${findings.length?'<section><h2>Воспроизведённые ошибки</h2>'+findings.map(f=>'<div class="finding"><b>'+esc(f.title)+'</b><br>'+esc(f.detail)+' '+anchor(f.id)+'</div>').join('')+'</section>':''}
<div class="filters"><select id="kind" aria-label="Что показать"><option value="scenarios">Цепочки</option><option value="actions">Действия</option></select><select id="area" aria-label="Раздел"><option value="">Все разделы</option>${sections.map(c=>option(c.area,sectionNames[c.area]??c.area)).join('')}</select><select id="status" aria-label="Результат"><option value="">Все результаты</option>${Object.entries(stateNames).map(([k,v])=>option(k,v)).join('')}</select><input type="search" id="query" aria-label="Поиск" placeholder="Найти действие или цепочку"></div>
<output id="shown" aria-live="polite"></output>${sections.map(c=>c.scenarios.map(s=>scenarioRow(s,c.area)).join('')+c.actions.map(a=>actionRow(a,c.area)).join('')).join('')}</main>
<script>
const by=id=>document.getElementById(id);
const rows=[...document.querySelectorAll('.row')];
const terms=rows.map(row=>row.textContent.toLowerCase());
function apply() {
  const kind=by('kind').value, area=by('area').value, status=by('status').value;
  const query=by('query').value.trim().toLowerCase();
  let visible=0;
  by('status').hidden=kind==='actions';
  rows.forEach((row,index)=>{
    const sameArea=!area || row.dataset.area===area;
    const sameStatus=kind==='actions' || !status || row.dataset.status===status;
    row.hidden=!(row.dataset.kind===kind && sameArea && sameStatus && terms[index].includes(query));
    if (!row.hidden) visible++;
  });
  by('shown').textContent='Показано · '+visible;
}
function jump() {
  const row=by(location.hash.slice(1));
  if (!row?.classList.contains('row')) return;
  by('kind').value=row.dataset.kind;
  by('area').value=by('status').value=by('query').value='';
  apply();
  row.open=true;
  row.scrollIntoView();
}
document.querySelector('.filters').addEventListener('input',apply);
addEventListener('hashchange',jump);
apply();
jump();
</script></html>`;
await mkdir(path.dirname(path.resolve(values.out)),{recursive:true});
await writeFile(values.out,html);
console.log(actions.length+' actions, '+scenarios.length+' scenarios',Object.fromEntries(Object.keys(stateNames).map(s=>[s,count(s)])));
