import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../frontend/graph.js';
import { drawSlotGrid } from '../frontend/map-slots.js';
import { deleteAreaWithHistory, undoMapAction } from '../frontend/map-history.js';

function setup({stages=['Idea','Review','Done'],zoom=1}={}){
  const width=800,height=600,calls={moves:[],sizes:[],edits:[],seats:[],opens:[]};
  const graph=Object.assign(Object.create(Graph.prototype),{
    width,height,camera:{x:0,y:0,zoom},tool:'select',
    canvas:{style:{},focus(){},getBoundingClientRect(){return {left:20,top:30,width,height}},
      setPointerCapture(){},hasPointerCapture(){return false}},
    nodes:new Map(),contacts:new Map(),selectedIds:new Set(),heating:new Set(),repaint(){},
    callbacks:{
      onGridMove:(...args)=>calls.moves.push(args),onGridSpacing:(...args)=>calls.sizes.push(args),
      onOpen:id=>calls.opens.push(id),onEditStage:(...args)=>calls.edits.push(args),
      onNewGridNote:(...args)=>calls.seats.push(args)
    }
  });
  const grid={x:-96,y:0,rows:2,cols:3,spacing:96,stages};
  graph.setData([{id:'n',areaId:'g',slot:0}],[{id:'g',name:'Track',grid}]);
  const group=graph.groups[0],ctx={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},
    rect(){},fill(){},arc(){},fillText(){},measureText(text){return {width:text.length*7}}};
  const label=drawSlotGrid(ctx,group,{ox:width/2,oy:height/2,zoom,width,height});
  if(label?.stageHeader)graph.stageHeaders.push(label.stageHeader);
  graph.ctx={...ctx,strokeText(){}};
  graph.drawLabels([{...label,grid:group}],new Map(),{});
  const point=(x,y,mods={})=>({clientX:20+width/2+x*zoom,clientY:30+height/2+y*zoom,
    pointerId:1,pointerType:'mouse',button:0,preventDefault(){},...mods});
  const title=point((label.x-width/2)/zoom,(label.y-height/2)/zoom);
  return {graph,point,title,calls,group};
}

test('clicking a grid title or vacant cell selects the entire grid, while notes and background take their own selection',()=>{
  for(const stages of [null,['Idea','Review','Done']]){
    const {graph,point,title,group}=setup({stages});
    const click=event=>{graph.pointerDown(event);graph.pointerUp(event)};
    graph.select('n');
    const selections=[];
    graph.callbacks.onSelect=(id,ids)=>selections.push([id,ids,graph.selectedGridId]);
    click(title);
    assert.deepEqual(selections.at(-1),[null,[],'g']);
    click(point(-96,0));
    assert.deepEqual(selections.at(-1),['n',['n'],null]);
    click(point(0,96));
    assert.deepEqual(selections.at(-1),[null,[],'g']);
    click(point(-64,25));
    assert.deepEqual(selections.at(-1),['n',['n'],null],'space around an occupied seat still targets its note');
    click(title);
    click(point(225,150));
    assert.deepEqual(selections.at(-1),[null,[],null]);
    click(title);
    graph.setData([],[{id:'g',name:'Renamed',grid:group.grid}]);
    assert.equal(graph.selectedGridId,'g');
    graph.setData([],[{id:'g',name:'Folder'}]);
    assert.deepEqual(selections.at(-1),[null,[],null]);
    assert.equal(graph.hitGridLabel(graph.local(title)),undefined);
  }
});

test('the whole grid context targets the clicked title or vacant seat and survives touch release',()=>{
  const {graph,point,title}=setup(),contexts=[];
  graph.callbacks.onContext=(...args)=>contexts.push(args);
  graph.callbacks.onStageContext=()=>{};
  for(const event of [title,point(0,96,{pointerType:'touch'})]){
    graph.select('n');
    if(event.pointerType==='touch')graph.pointerDown(event);
    graph.contextMenu(event);
    graph.pointerUp(event);
    assert.deepEqual(contexts.at(-1),[null,event.clientX,event.clientY,'g']);
    assert.equal(graph.selectedGridId,'g');
    assert.equal(graph.selectedIds.size,0);
  }
  graph.contextMenu(point(96,-57));
  assert.equal(graph.selectedGridId,null,'a stage menu releases the whole-track selection');
  assert.equal(contexts.length,2);
});

test('a marquee around a grid or stage track selects the whole object for reversible deletion',()=>{
  const headings=['Idea','Review','Done'];
  for(const [stages,zoom,occupied] of [[null,.65,false],[headings,1,false],[headings,1.5,true]]){
    const {graph,group,point}=setup({stages,zoom});
    const area={id:'g',name:'Dock',grid:group.grid};
    const space={areas:[area],notes:occupied?[
      {id:'first',areaId:'g',slot:0,x:-96,y:0,links:['last']},
      {id:'last',areaId:'g',slot:5,x:96,y:96,links:[]}
    ]:[]};
    const before=structuredClone(space);
    graph.setData(space.notes,space.areas);

    // Enclose the headers and last row of dots without guessing the invisible bottom gutter.
    const topLeft=point(-165,-108),bottomRight=point(165,105);
    const [from,to]=stages?[bottomRight,topLeft]:[topLeft,bottomRight];
    graph.pointerDown(from);
    graph.pointerUp(to); // A fast drag can deliver the final position only on release.
    assert.equal(graph.selectedGridId,'g');
    assert.equal(graph.selectedIds.size,0);

    assert.equal(deleteAreaWithHistory(space,graph.selectedGridId),area);
    graph.setData(space.notes,space.areas);
    assert.equal(graph.selectedGridId,null);
    assert.equal(graph.selectedIds.size,0);
    assert.equal(space.areas.length,0);
    assert.deepEqual(space.notes.map(n=>[n.id,n.links]),before.notes.map(n=>[n.id,n.links]));
    graph.pointerDown(from);graph.pointerUp(to);
    assert.deepEqual([...graph.selectedIds],space.notes.map(n=>n.id));
    assert.equal(undoMapAction(space).kind,'area-delete');
    assert.deepEqual(space,before);
  }
});

test('full enclosure takes precedence over intersecting notes, while partial and additive marquees pick notes',()=>{
  const {graph,point,group}=setup();
  const area={id:'g',name:'Dock',grid:group.grid};
  graph.setData([{id:'n',areaId:'g',slot:0},{id:'loose',x:218,y:90}],[area]);
  const start=point(-165,-90),end=point(248,156);
  graph.pointerDown(start);graph.pointerMove(end);
  assert.equal(graph.drag.previewGridId,'g');
  assert.equal(graph.drag.preview.size,0);
  graph.pointerUp(end);
  assert.equal(graph.selectedGridId,'g');
  assert.equal(graph.selectedIds.size,0);

  graph.pointerDown(start);graph.pointerUp(point(-65,20));
  assert.equal(graph.selectedGridId,null);
  assert.deepEqual([...graph.selectedIds],['n']);
  graph.select('loose');
  graph.pointerDown({...start,shiftKey:true});graph.pointerUp(point(155,156,{shiftKey:true}));
  assert.equal(graph.selectedGridId,null);
  assert.deepEqual(graph.selectedIds,new Set(['loose','n']));

  const other={id:'second',name:'Other',grid:{x:215,y:55,rows:1,cols:1,spacing:40}};
  graph.setData([{id:'n',areaId:'g',slot:0},{id:'loose',x:218,y:90}],[area,other]);
  graph.pointerDown(start);graph.pointerUp(end);
  assert.equal(graph.selectedGridId,null);
  assert.equal(graph.selectedIds.size,0,'several enclosed grids must not accidentally target their notes for deletion');
});

test('a one-seat grid can be selected separately from its only note',()=>{
  const {graph,point}=setup({stages:null});
  graph.setData([{id:'n',areaId:'g',slot:0}],[{id:'g',grid:{cols:1,rows:1,x:0,y:0,spacing:96}}]);
  const start=point(-60,-56);
  graph.pointerDown(start);graph.pointerUp(point(30,30));
  assert.equal(graph.selectedGridId,null);
  assert.deepEqual([...graph.selectedIds],['n']);
  graph.pointerDown(start);graph.pointerUp(point(56,56));
  assert.equal(graph.selectedGridId,'g');
  assert.equal(graph.selectedIds.size,0);
});

test('Control and Command toggle individual notes including in the margin of an occupied seat',()=>{
  for(const modifier of ['ctrlKey','metaKey','shiftKey']){
    const {graph,point,calls,group}=setup();
    graph.setData([{id:'n',areaId:'g',slot:0},{id:'other',x:220,y:0}], [{id:'g',name:'Track',grid:group.grid}]);
    const margin=point(-64,25,{[modifier]:true}), bubble=point(-96,0,{[modifier]:true});
    graph.select('other');
    graph.pointerDown(margin);graph.pointerUp(margin);
    assert.deepEqual([...graph.selectedIds],['other','n'],modifier);
    graph.pointerDown(bubble);graph.pointerUp(bubble);
    assert.deepEqual([...graph.selectedIds],['other'],modifier);
    graph.doubleClick(margin);
    assert.deepEqual(calls.opens,[]);
    assert.deepEqual(calls.seats,[]);
  }
});

test('dragging from an occupied seat margin moves the note without moving its grid or track',()=>{
  for(const stages of [null,['Idea','Review','Done']]){
    const {graph,point,group,calls}=setup({stages});
    const releases=[];
    graph.callbacks.onReleaseSeats=notes=>releases.push(notes);
    const start=point(-64,25),end=point(-210,98);
    assert.equal(graph.hit(graph.local(start)),null);
    graph.pointerMove(start);
    assert.equal(graph.canvas.style.cursor,'pointer');
    graph.pointerDown(start);graph.pointerMove(end);graph.pointerUp(end);
    assert.deepEqual(calls.moves,[]);
    assert.deepEqual([group.grid.x,group.grid.y],[-96,0]);
    assert.deepEqual(releases,[[{id:'n',x:-242,y:73}]]);
  }
});

test('dragging a stage heading or empty seat moves the whole track, preserving the occupied seats',()=>{
  for(const header of [true,false]){
    const {graph,point,calls,group}=setup({zoom:1.5});
    const start=header ? point(0,-57) : point(30,30);
    const end={...start,clientX:start.clientX+60,clientY:start.clientY+30};
    graph.pointerMove(start);assert.equal(graph.canvas.style.cursor,'grab');
    graph.pointerDown(start);graph.pointerMove(end);
    assert.equal(graph.canvas.style.cursor,'grabbing');
    assert.deepEqual([group.grid.x,group.grid.y],[-56,20]);
    const note=graph.nodes.get('n');
    assert.deepEqual([note.x,note.y,note.slot],[-56,20,0]);
    assert.deepEqual(calls.moves,[]);
    graph.pointerUp(end);
    assert.equal(graph.canvas.style.cursor,'grab');
    assert.deepEqual(calls.moves,[['g',-56,20]]);
    assert.deepEqual(calls.sizes,[]);
  }
});

test('track gestures respect Shift selection, note drag, pan, corner resize and cancellation',()=>{
  const {graph,point,calls,group}=setup();
  const start=point(-130,-30,{shiftKey:true}), end=point(-60,30,{shiftKey:true});
  graph.pointerDown(start);graph.pointerMove(end);graph.pointerUp(end);
  assert.deepEqual([...graph.selectedIds],['n']);
  const blank=point(30,30);graph.pointerDown(blank);graph.pointerUp(blank);
  assert.equal(graph.selectedIds.size,0);
  graph.pointerDown(point(-96,0));assert.equal(graph.drag.node.id,'n');assert.ok(!graph.drag.grid);
  graph.cancelDrag();
  const body=point(20,20),moved=point(45,35);
  graph.pointerDown(body);graph.pointerMove(moved);graph.cancelDrag();
  assert.deepEqual([group.grid.x,group.grid.y],[-96,0]);
  const grip=point(144,144);graph.pointerMove(grip);assert.equal(graph.canvas.style.cursor,'nwse-resize');
  graph.pointerDown(grip);graph.pointerMove(point(119,129));graph.pointerUp(point(119,129));
  assert.deepEqual(calls.sizes,[['g',{spacing:86,rowSpacing:86}]]);
  graph.callbacks.recordingRoute=()=>true;
  graph.pointerDown(body);assert.equal(graph.drag.pan,true);
  graph.pointerMove(moved);graph.pointerUp(moved);
  assert.deepEqual([graph.camera.x,graph.camera.y],[-25,-15]);
  assert.deepEqual(calls.moves,[]);
});

test('double click renames the pointed stage, creates in an empty seat, and opens occupied notes',()=>{
  const {graph,point,calls}=setup({zoom:1.5});
  const heading=point(96,-57);
  graph.doubleClick(heading);
  assert.deepEqual(calls.edits,[['g',2,{x:heading.clientX,y:heading.clientY}]]);
  assert.equal(graph.contextGridId(graph.local(heading),null),'g');
  graph.doubleClick(point(0,96));
  graph.doubleClick(point(-96,0));
  graph.doubleClick(point(-70,28));
  assert.deepEqual(calls.seats,[['g',4,{x:0,y:96}]]);
  assert.deepEqual(calls.opens,['n','n']);
  graph.callbacks.recordingRoute=()=>true;
  graph.doubleClick(heading);assert.equal(calls.edits.length,1);
});

test('ordinary grid interiors still select by rectangle; hidden stage headings have no hit zone',()=>{
  const plain=setup({stages:null});
  plain.graph.pointerDown(plain.point(20,20));assert.equal(plain.graph.drag.marquee,true);
  const far=setup({zoom:.25});
  assert.deepEqual(far.graph.stageHeaders,[]);
});

test('double click creates directly in an ordinary grid cell at the current zoom',()=>{
  for(const zoom of [.65,1.5]){
    const {graph,point,calls}=setup({stages:null,zoom});
    graph.doubleClick(point(96,96));
    graph.doubleClick(point(-96,0));
    graph.doubleClick(point(-64,25));
    graph.doubleClick(point(168,96));
    assert.deepEqual(calls.seats.map(([id,slot])=>[id,slot]),[['g',5]]);
    assert.ok(Math.hypot(calls.seats[0][2].x-96,calls.seats[0][2].y-96)<1e-9);
    assert.deepEqual(calls.opens,['n','n']);
  }
});

test('the stage context menu targets the named column and releases a pending touch gesture',()=>{
  const {graph,point}=setup({zoom:1.5}),stages=[],ordinary=[];
  graph.callbacks.onStageContext=(...args)=>stages.push(args);
  graph.callbacks.onContext=(...args)=>ordinary.push(args);
  const heading=point(96,-57,{pointerType:'touch'});
  graph.pointerDown(heading);graph.contextMenu(heading);
  assert.deepEqual(stages,[['g',2,{x:heading.clientX,y:heading.clientY}]]);
  assert.equal(graph.drag,null);
  assert.equal(graph.contacts.size,0);
  graph.contextMenu(point(-96,0));graph.contextMenu(point(-64,25));graph.contextMenu(point(0,96));
  assert.deepEqual(ordinary.map(([id,,,areaId])=>[id,areaId]),[['n','g'],['n','g'],[null,'g']]);
});
