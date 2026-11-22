import { getLanguage, tr } from './i18n.js';
import { normalizeAreaTree } from './areas.js';

export function blankWorkspace(){return {notes:[],areas:[]}}
export const defaultMapView = Object.freeze({labels:true, links:true, grid:true, reading:true, manualLayout:false});
export function newLibrary(){
  return {version:1, active:'personal', spaces:{personal:blankWorkspace()}, plugins:[], view:{...defaultMapView}};
}
export function serializeLibrary(library){
  const entries=Object.entries(library.spaces);
  const hasCatalog=library.version===3 || !library.spaces.personal || library.demoHidden ||
    entries.some(([id,space])=>isFolderSpace(space) || !Object.hasOwn(spaceNames,id));
  if(hasCatalog){
    const spaces=Object.fromEntries(entries.map(([id,space])=>[id,isFolderSpace(space)
      ? {name:space.name,folder:space.folder,encrypted:space.encrypted} : space]));
    return JSON.stringify({...library,version:3,spaces});
  }
  const protectedNotes=entries.some(([,space])=>space.notes.some(note=>Object.hasOwn(note,'sealed')));
  return JSON.stringify({...library,version:protectedNotes?2:1});
}
export const isFolderSpace=space=>!!space && Object.hasOwn(space,'folder');
export const validSpaceName=name=>typeof name==='string' && !!name.trim() && [...name].length<=80;
export const spaceNames = {
  get personal() { return tr('Личное', 'Personal'); },
  get demo() { return tr('Пример карты', 'Demo map'); }
};
export const colors=['#b9bdc2','#a7b9cf','#c5aa86','#b5a4c8','#cb9890','#8197b2','#b8b09b'];
const validBoard=board=>[1,2].includes(board?.version)&&Array.isArray(board.elements);
export function checkNote(note){
  if(typeof note?.id!=='string'||typeof note.title!=='string'||!Array.isArray(note.body)||!Array.isArray(note.links)||!Array.isArray(note.tags))
    throw new Error(tr('Некорректная запись заметки.', 'The workspace contains an invalid note.'));
  if(Object.hasOwn(note,'sealed')&&(typeof note.sealed!=='string'||!note.sealed||note.title||note.plain||note.body.length||note.tags.length||note.board||Object.hasOwn(note,'dataText')||Object.hasOwn(note,'dataLanguage')||Object.hasOwn(note,'dataHasHeader')))
    throw new Error(tr('Повреждена запись зашифрованной заметки.','The encrypted note record is damaged.'));
  if(note.type==='data' && (typeof note.dataText!=='string' || (note.dataLanguage!==undefined && typeof note.dataLanguage!=='string') || (note.dataHasHeader!==undefined && typeof note.dataHasHeader!=='boolean')))
    throw new Error(tr('Повреждено содержимое заметки с данными.','This data note contains invalid content.'));
  if((note.type==='canvas'&&!validBoard(note.board))||note.body.some(block=>block?.type==='drawing'&&block.board&&!validBoard(block.board)))
    throw new Error(tr('Версия рисунка в этой заметке не поддерживается.','This note uses an unsupported drawing format.'));
}
export function readLibrary(raw){
  if(!raw)return newLibrary();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(tr('Файл хранилища содержит некорректный JSON.', 'The workspace file contains invalid JSON.')); }
  if (!data || typeof data !== 'object') throw new Error(tr('Структура хранилища повреждена.', 'The library structure is invalid.'));
  if(data.plugins!==undefined&&(!Array.isArray(data.plugins)||data.plugins.some(p=>!p||p.apiVersion!==1||typeof p.id!=='string'||typeof p.name!=='string'||typeof p.html!=='string')))
    throw new Error(tr('Повреждён список расширений.', 'The extensions list is damaged.'));
  if(![1,2,3].includes(data.version) || !data.spaces || Array.isArray(data.spaces) ||
      typeof data.spaces!=='object' || typeof data.active!=='string' ||
      (!(data.version===3 && data.active==='') && !Object.hasOwn(data.spaces,data.active)) ||
      (data.version!==3 && (!data.spaces.personal || !Object.hasOwn(spaceNames,data.active))))
    throw new Error(tr('Формат хранилища не поддерживается этой версией Videron.', 'This version of Videron cannot read this workspace format.'));
  for(const [id,space] of Object.entries(data.spaces)){
    if(['__proto__','constructor','prototype'].includes(id) || !id)throw new Error('VD_INVALID');
    if(isFolderSpace(space)){
      if(data.version!==3 || !validSpaceName(space.name) || typeof space.folder!=='string' || !space.folder.trim() ||
         typeof space.encrypted!=='boolean' || Object.keys(space).some(k=>!['name','folder','encrypted'].includes(k)))
        throw new Error('VD_INVALID');
    }else{
      if(space && data.version<3 && !Object.hasOwn(spaceNames,id) && space.name===undefined)space.name=id.slice(0,80);
      if((!Object.hasOwn(spaceNames,id) || space?.name!==undefined) && !validSpaceName(space?.name))throw new Error('VD_INVALID');
      checkWorkspace(space);
    }
  }
  return {...newLibrary(),...data,view:{...defaultMapView,...data.view}};
}
export function checkWorkspace(space){
  if(!Array.isArray(space?.notes)||!Array.isArray(space.areas))throw new Error(tr('Структура пространства повреждена.', 'The workspace structure is invalid.'));
  const ids=new Set(), sealedIds=new Set();
  for(const note of space.notes){
    checkNote(note);
    if(ids.has(note.id))throw new Error(tr('Некорректная запись заметки.', 'The workspace contains an invalid note.'));
    ids.add(note.id);
    if(Object.hasOwn(note,'sealed'))sealedIds.add(note.id);
  }
  // A concurrent peer can add a passage to a route while its note is being
  // encrypted elsewhere. Keep the stop but discard its content fingerprint.
  if(sealedIds.size && Array.isArray(space.routes)){
    for(const route of space.routes){
      if(!Array.isArray(route?.stops))continue;
      for(const stop of route.stops)if(stop?.fragment && sealedIds.has(stop.noteId))stop.fragment=null;
    }
  }
  if(space.areas.some(a=>typeof a?.id!=='string'||!a.id||typeof a.name!=='string'||!/^#[0-9a-f]{6}$/i.test(a.color)) ||
     new Set(space.areas.map(a=>a.id)).size!==space.areas.length)
    throw new Error(tr('Некорректная запись области.', 'The workspace contains an invalid area.'));
  normalizeAreaTree(space);
  return space;
}
export function createNote(x,y,areaId=null,type='text'){
  const note={id:crypto.randomUUID(),title:'',bodyVersion:1,body:[],plain:'',tags:[],links:[],x,y,pinned:false,areaId,opens:0,weight:0,created:Date.now(),modified:Date.now()};
  if(type==='canvas')Object.assign(note,{type,board:{version:1,elements:[]}});
  if(type==='data')Object.assign(note,{type,dataText:'',dataLanguage:'text'});
  return note;
}
export function demoWorkspace() {
  const sample=createDemo(getLanguage());
  const styles={
    'demo-0-0':{shape:'hexagon',icon:'lucide/orbit'},
    'demo-1-0':{shape:'square',icon:'lucide/notebook-pen'},
    'demo-2-0':{shape:'pentagon',icon:'phosphor/leaf'}
  };
  for(const note of sample.notes)if(styles[note.id])note.appearance=styles[note.id];
  return sample;
}

function createDemo(language, legacy = false) {
  const english = language === 'en';
  const local = (ru, en) => english ? en : ru;
  const areas=[
    {id:'visual',name:local('Визуальный язык', 'Visual language'),color:colors[0]},
    {id:'research',name:local('Исследования', 'Research'),color:colors[1]},
    {id:'ideas',name:local('Лаборатория идей', 'Idea lab'),color:colors[2]}];
  const groups=[
    {x:-245,y:-50, notes:english ? [
      ['Atlas of shapes', 'A circle keeps its silhouette at any scale. A thin outline gives the neighboring shapes room to breathe.', '#shape #composition'],
      ['Soft light', 'Try two layers of light. The narrow one defines the edge, and the wider one barely changes the background.', '#light #shape'],
      ['Rhythm and pause', 'Leave enough space between groups for the eye to move from one outline to the next.', '#composition'],
      ['Palette', 'Silver for the main shapes, smoky blue for observations and warm ochre for experiments.', '#color #light'],
      ['Outline', 'Compare line weights as you zoom in.', '#shape'],
      ['Scale', 'Which details should appear as you zoom? First the silhouette, then the title, then the connections.', '#composition'],
      ['Leaf silhouettes', 'Make a series of simple prints and look for repeated edges.', '#shape'],
      ['Halftone', 'Two neighboring shades.', '#color'],
      ['Negative space', 'Look at the spaces between the shapes first.', '#composition'],
      ['Grid', 'A spacing of 24.', '#composition'],
      ['Glow', 'A soft edge.', '#light']
    ] : [
      ['Атлас форм','Собираю формы, которые хорошо различимы издалека. Круг сохраняет силуэт при любом масштабе, а тонкая обводка оставляет место для соседей.','#форма #композиция'],
      ['Мягкий свет','Попробовать два слоя света. Узкий слой подчёркивает границу, а широкий едва меняет фон.','#свет #форма'],
      ['Ритм и пауза','Оставить между группами достаточно воздуха, чтобы взгляд мог перейти от одного контура к другому.','#композиция'],
      ['Палитра',(legacy ? 'Шалфейный' : 'Серебряный')+' для основных форм, дымчато-синий для наблюдений и тёплая охра для экспериментов.','#цвет #свет'],
      ['Контур','Сравнить толщину линий при приближении.','#форма'],
      ['Масштаб','Какие детали должны появляться при увеличении? Сначала силуэт, затем название, затем связи.','#композиция'],
      ['Силуэты листьев','Сделать серию простых отпечатков и найти в них повторяющиеся рёбра.','#форма'],
      ['Полутон','Два близких оттенка.','#цвет'],
      ['Негативное пространство','Сначала посмотреть на пустоты между пятнами.','#композиция'],
      ['Сетка','Шаг 24.','#композиция'],
      ['Свечение','Нужен мягкий край.','#свет']
    ]},
    {x:225,y:-80,notes:english ? [
      ['Field journal', 'Three landmarks stayed with me after a walk. Their positions relative to one another are easier to recall than an exact address. Does that hold for notes?', '#memory #observation'],
      ['Spatial memory', 'Return to the map in a week and try finding an idea by its neighboring circles.', '#memory'],
      ['Interview', 'Ask someone to point out the notebook on their desk. Write down the words they use to describe its location.', '#observation'],
      ['Card sorting', 'Lay out the cards without labeling the groups. See which ideas end up together.', '#memory'],
      ['Points of attraction', 'A word can connect two notes. So can a personal association. Keep both possibilities open.', '#observation'],
      ['Routes', 'Draw the way home from memory.', '#memory'],
      ['Landmark', 'The tower by the river.', '#observation']
    ] : [
      ['Полевой дневник','На прогулке запомнились три ориентира. Их положение относительно друг друга вспоминается легче точного адреса. Проверить, повторяется ли это для заметок.','#память #наблюдение'],
      ['Пространственная память','Вернуться к карте через неделю и попробовать найти идею по соседним кругам.','#память'],
      ['Интервью','Попросить человека показать, где на столе лежит нужный блокнот. Записать слова, которыми он объясняет свой выбор.','#наблюдение'],
      ['Метод карточек','Разложить карточки без подписей групп. Посмотреть, какие понятия окажутся рядом.','#память'],
      ['Точки притяжения','Иногда две записи соединяет общее слово, иногда — личная ассоциация. Оставить оба способа.','#наблюдение'],
      ['Маршруты','Нарисовать путь домой по памяти.','#память'],
      ['Ориентир','Башня у реки.','#наблюдение']
    ]},
    {x:47,y:137,notes:english ? [
      ['Note garden', 'Imagine the notes as a garden. The notes you revisit gradually brighten. Zoom out a little to discover unfamiliar connections.', '#prototype #garden'],
      ['Living typography', 'Try placing labels around a dense group of circles.', '#prototype'],
      ['Night constellations', 'Make a drawing with three clusters of dots and a few lines.', '#garden'],
      ['Gesture sketch', 'Drag one circle and watch its neighbors follow.', '#prototype'],
      ['Seeds', 'An idea for later.', '#garden']
    ] : [
      ['Сад заметок','Представить записи как сад. То, к чему часто возвращаешься, постепенно светлеет. Незнакомые связи можно увидеть, если немного отдалить карту.','#прототип #сад'],
      ['Живая типографика','Проверить, как размещать подписи вокруг плотной группы кругов.','#прототип'],
      ['Ночные созвездия','Собрать рисунок из трёх групп точек и нескольких линий между ними.','#сад'],
      ['Набросок жеста','Потянуть один круг и посмотреть, как постепенно подтянутся его соседи.','#прототип'],
      ['Семена','Идея на потом.','#сад']
    ]}
  ];
  const notes=[];
  groups.forEach((group,g)=>group.notes.forEach(([title,text,tags],i)=>{
    const angle=i*2.39996+g, length=i?53+Math.sqrt(i)*14:0;
    const note=createNote(group.x+Math.cos(angle)*length,group.y+Math.sin(angle)*length,areas[g].id);
    Object.assign(note,{id:'demo-'+g+'-'+i,title,plain:text+'\n'+tags,body:[{type:'paragraph',runs:[{text}]},{type:'paragraph',runs:[{text:tags}]}],
      tags:tags.split(' ').map(t=>t.slice(1)),opens:i===0?17:Math.max(1,8-i),pinned:i===0,weight:text.length});
    notes.push(note);
  }));
  const atlas=notes[0];
  const sketch={type:'drawing',width:850,height:250,strokes:[
    {tool:'ellipse',points:[[102,26],[307,224]],color:'#93969a',width:2},
    {tool:'ellipse',points:[[162,71],[247,155]],color:'#d5d7da',width:3},
    {tool:'ellipse',points:[[223,143],[265,185]],color:'#d5d7da',width:2},
    {tool:'ellipse',points:[[133,135],[179,181]],color:'#b3b6ba',width:2},
    {tool:'ellipse',points:[[432,49],[578,195]],color:'#9eafc7',width:2},
    {tool:'ellipse',points:[[475,91],[535,151]],color:'#b7cce3',width:3},
    {tool:'ellipse',points:[[517,136],[545,164]],color:'#9eafc7',width:2},
    {tool:'ellipse',points:[[677,114],[732,169]],color:'#ccb08d',width:3},
    {tool:'pen',points:[[248,109],[291,100],[331,99],[371,104],[416,115],[474,120]],color:'#777a7f',width:2},
    {tool:'pen',points:[[536,120],[594,116],[632,121],[676,138]],color:'#777a7f',width:2}
  ]};
  if (legacy) {
    const oldSketchColors = {'#93969a':'#81936d', '#d5d7da':'#c9dfa1', '#b3b6ba':'#a6b88b', '#777a7f':'#718062'};
    for (const stroke of sketch.strokes) stroke.color = oldSketchColors[stroke.color] || stroke.color;
  }
  atlas.body.splice(1,0,{type:'subheading',runs:[{text:local('Три масштаба', 'Three scales')}]},sketch,
    {type:'paragraph',runs:[{text:local('Издалека видны области. ', 'From a distance, the areas stand out. '),bold:true},{text:local('Вблизи отдельные круги собираются в цепочки. Если два круга касаются, пустое пространство вокруг пары остаётся общим.', 'Up close, the individual circles form chains. When two circles touch, the space around them frames the pair.')}]},
    {type:'quote',runs:[{text:local('Попробовать нарисовать одно и то же созвездие по памяти на следующий день.', 'Tomorrow, try drawing the same constellation from memory.'),italic:true}]});
  atlas.plain=atlas.body.map(b=>b.runs?.map(r=>r.text).join('')||'').join('\n');
  atlas.weight=atlas.plain.length+150+sketch.strokes.length*8;
  const diary=notes.find(n=>n.id==='demo-1-0');
  diary.links=[atlas.id];
  const loose=(english ? [
    [-65,-124,'In the margins','Open space on the map makes groups easier to find.'],
    [-26,-108,'A note for tomorrow','Look at the map in the morning.'],
    [-349,106,'Horizon line','Check which landmarks you can recognize from a distance.'],
    [357,72,'An open question','Which idea will appear next?']
  ] : [
    [-65,-124,'На полях','Свободное место на карте помогает находить группы.'],
    [-26,-108,'Заметка на завтра','Посмотреть на карту утром.'],
    [-349,106,'Линия горизонта','Проверить, какие ориентиры различимы издалека.'],
    [357,72,'Вопрос без ответа','Какая идея появится следующей?']
  ]).map(([x,y,title,plain],i)=>({...createNote(x,y),id:'demo-loose-'+i,title,plain,weight:plain.length,body:[{type:'paragraph',runs:[{text:plain}]}]}));
  loose[0].links.push(loose[1].id);notes.push(...loose);
  return {areas,notes};
}

let referenceSamples;

function matchesDocument(note, sample) {
  return note.title === sample.title && note.plain === sample.plain &&
    note.bodyVersion === sample.bodyVersion && sameValue(note.tags, sample.tags) &&
    sameValue(note.body, sample.body);
}

function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

// In v0.1 the last four sample notes received UUIDs. Both the original
// sequence and the entire document must match before translating those notes.
export function translateDemoSamples(workspace) {
  if (!workspace?.notes?.length) return false;
  referenceSamples ??= { ru: createDemo('ru'), en: createDemo('en'), legacy: createDemo('ru', true) };
  const target = referenceSamples[getLanguage()];
  const references = Object.values(referenceSamples);
  const indexById = new Map(target.notes.map((note, i) => [note.id, i]));
  const firstLoose = indexById.get('demo-loose-0');
  if (!workspace.notes.some(note => indexById.has(note.id))) return false;
  const originalOrder = target.notes.slice(0, firstLoose).every((sample, i) => workspace.notes[i]?.id === sample.id);
  let changed = false;
  for (const [slot, note] of workspace.notes.entries()) {
    let index = indexById.get(note.id);
    if (index === undefined && originalOrder && slot >= firstLoose && slot < target.notes.length &&
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(note.id)) index = slot;
    if (index === undefined) continue;
    const desired = target.notes[index];
    if (matchesDocument(note, desired) || !references.some(source => matchesDocument(note, source.notes[index]))) continue;
    note.title = desired.title;
    note.plain = desired.plain;
    note.body = structuredClone(desired.body);
    note.tags = [...desired.tags];
    note.weight = desired.weight;
    changed = true;
  }
  for (const [i, desired] of target.areas.entries()) {
    const area = workspace.areas.find(item => item.id === desired.id);
    if (!area || !references.some(source => area.name === source.areas[i].name)) continue;
    if (area.name !== desired.name) {
      area.name = desired.name;
      changed = true;
    }
    if (area.id === 'visual' && area.color.toLowerCase() === '#b4cc8e') {
      area.color = desired.color;
      changed = true;
    }
  }
  return changed;
}
