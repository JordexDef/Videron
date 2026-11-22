import assert from 'node:assert/strict';
import test from 'node:test';
import { GRID_PITCH as pitch, slotPoint } from '../frontend/area-grid.js';
import { drawSlotGrid, draggedGridSpacing, gridFocusCamera, slotAt, slotGridBounds, suggestGrid } from '../frontend/map-slots.js';

test('seat centres round trip to their cell; adjacent seat ranges share precisely one edge', () => {
  const grid = {x:-231,y:47,rows:100,cols:100};
  const {left,top,right,bottom} = slotGridBounds(grid);
  for (const index of [0,1,99,100,873,9999])
    assert.equal(slotAt(grid,slotPoint(grid,index)),index);
  assert.equal(slotAt(grid,{x:left,y:top}),0);
  assert.equal(slotAt(grid,{x:left+pitch,y:top+pitch}),101);
  assert.equal(slotAt(grid,{x:right-.01,y:bottom-.01}),9999);
  assert.equal(slotAt(grid,{x:right,y:top}),null);
  assert.equal(slotAt(grid,{x:left,y:bottom}),null);
  assert.equal(slotAt(grid,{x:left-.001,y:top}),null);
});

test('grid creation honours its origin and finds space around earlier grids and nearby free notes', () => {
  const first={rows:2,cols:6,x:45,y:60}, origin={x:first.x,y:first.y};
  assert.deepEqual(suggestGrid(2,6,origin,{areas:[],notes:[]}),first);
  const edge=slotGridBounds(first).right, inTheWay={x:edge+150,y:60};
  const second=suggestGrid(2,6,origin,{areas:[{id:'a',grid:first}],notes:[inTheWay]});
  assert.ok(slotGridBounds(second).left > inTheWay.x + 78);
  assert.equal(second.y,first.y);
  const clear={x:0,y:2000};
  assert.deepEqual(suggestGrid(1,1,clear,{areas:[{id:'a',grid:first}],notes:[inTheWay]}),{...clear,rows:1,cols:1});
});

test('new grids leave room for the map drop targets of empty nested and top-level folders', () => {
  const point={x:40,y:70};
  const parent={id:'parent',anchor:{x:-1500,y:50}};
  const nested={id:'child',parentId:'parent',anchor:point};
  const root={id:'root',anchor:{x:325,y:70}};
  assert.ok(slotGridBounds(suggestGrid(2,4,point,{areas:[parent,nested],notes:[]})).left >= nested.anchor.x+42+28);
  const grid=suggestGrid(2,4,point,{areas:[parent,nested,root],notes:[]});
  assert.ok(slotGridBounds(grid).left >= root.anchor.x+42+28);
  const elsewhere={x:100,y:650};
  assert.deepEqual(suggestGrid(2,4,elsewhere,{areas:[parent,nested,root],notes:[]}),{rows:2,cols:4,...elsewhere});
});

test('opening a large grid shows a legible first page; a named cell can always be centred', () => {
  const grid={rows:100,cols:100,x:80,y:-70}, width=1000,height=640;
  const first=gridFocusCamera(grid,width,height);
  assert.ok(first.zoom >= .6);
  const screen = p => ({x:(p.x-first.x)*first.zoom+width/2,y:(p.y-first.y)*first.zoom+height/2});
  const p=screen(slotPoint(grid,0));
  assert.ok(p.x >= 0 && p.x <= width/2 && p.y >= 0 && p.y <= height/2);
  assert.deepEqual(gridFocusCamera(grid,width,height,9999),{...slotPoint(grid,9999),zoom:1});
});

test('a 10,000-seat grid paints only visible marks and reports the actual first free seat', () => {
  const counts={arc:0,rect:0};
  const ctx={save(){},restore(){},beginPath(){},fill(){},stroke(){},moveTo(){},lineTo(){},arc(){counts.arc++},rect(){counts.rect++}};
  const group={grid:{rows:100,cols:100,x:10,y:40},tint:'160,160,160',name:'Atlas'};
  const view={ox:100,oy:10,zoom:1,width:880,height:460};
  const label=drawSlotGrid(ctx,group,view,{active:true,slots:new Map([['new',1],['other',2]]),hoverSlot:0});
  assert.ok(counts.arc>3 && counts.arc<30);
  assert.match(label.text,/(место|seat) 2/);
  assert.equal(label.titleLabel.text,group.name);
  assert.ok(drawSlotGrid(ctx,group,view,{active:true,slots:null,blocked:true,hoverSlot:0}));
  drawSlotGrid(ctx,group,{...view,zoom:.04});
  assert.ok(counts.rect>0 && counts.rect<2501);
  assert.equal(drawSlotGrid(ctx,group,{...view,ox:2000}),null);
});

test('each grid uses its own spacing for the last drawn seat, drop geometry and camera', () => {
  for (const spacing of [40,96,320]) {
    const grid={x:11,y:73,cols:100,rows:100,spacing};
    const final=slotPoint(grid,9999);
    assert.deepEqual(final,{x:11+99*spacing,y:73+99*spacing});
    assert.equal(slotAt(grid,final),9999);
    assert.equal(slotAt(grid,{x:final.x+spacing/2,y:final.y}),null);
    assert.deepEqual(gridFocusCamera(grid,960,640,9999),{...final,zoom:1});
    const centres=[];
    const ctx={save(){},restore(){},beginPath(){},fill(){},stroke(){},moveTo(){},lineTo(){},arc(x,y){centres.push([x,y]);}};
    drawSlotGrid(ctx,{grid,name:'Last row',tint:'180,180,180'},
      {ox:-final.x+90,oy:-final.y+80,zoom:1,width:160,height:160});
    assert.ok(centres.some(([x,y])=>x===90 && y===80));
    assert.ok(centres.every(([x,y])=>(x-90)%spacing===0 && (y-80)%spacing===0));
  }
  const grid = {x:0,y:0,cols:2,rows:2,spacing:320};
  const next = suggestGrid(2,2,{x:0,y:0},{areas:[{id:'a',grid}],notes:[]},40);
  assert.equal(next.spacing,40);
  assert.equal(slotGridBounds(next).left,slotGridBounds(grid).right+28);
});

test('overview zoom only removes seats from the previous level of detail',()=>{
  const group={name:'Grid',tint:'180,180,180',grid:{x:0,y:0,cols:64,rows:1,spacing:24}};
  function visibleSeats(zoom){
    const indices=new Set();
    const ctx={save(){},restore(){},beginPath(){},fill(){},
      rect(x){indices.add(Math.round((x+1)/(24*zoom)))}};
    drawSlotGrid(ctx,group,{width:640,height:200,ox:0,oy:30,zoom});
    return indices;
  }
  const nearer=visibleSeats(.22),farther=visibleSeats(.17);
  assert.ok(farther.size>1);
  assert.ok([...farther].every(index=>nearer.has(index)));
});

test('dragging the outer corner works across one cell, one row or one column, at both limits', () => {
  for (const [cols,rows] of [[1,1],[1,8],[8,1],[6,4]]) {
    const grid={x:-160,y:40,cols,rows,spacing:96};
    const a=slotGridBounds(grid), b=slotGridBounds({...grid,spacing:53});
    assert.deepEqual(draggedGridSpacing(grid,b.right-a.right,b.bottom-a.bottom),{spacing:53,rowSpacing:53});
    assert.deepEqual(draggedGridSpacing(grid,1e6,-1e6),{spacing:320,rowSpacing:24});
    assert.deepEqual(draggedGridSpacing(grid,0,b.bottom-a.bottom),{spacing:96,rowSpacing:53});
  }
});

test('rectangular tracks draw the seats and stage headings at the same coordinates used for drops and camera',()=>{
  const grid={x:80,y:50,cols:3,rows:4,spacing:110,rowSpacing:24,stages:['A','B','C']};
  const marks=[];
  const ctx={save(){},restore(){},beginPath(){},fill(){},stroke(){},moveTo(){},lineTo(){},arc(){},
    rect(x,y){marks.push([x+1,y+1])},fillText(){},measureText(name){return {width:name.length*6}}};
  const label=drawSlotGrid(ctx,{grid,name:'Track',tint:'120,120,120'},{ox:0,oy:0,zoom:1,width:430,height:200});
  assert.equal(label.stageHeader.pitch,110);
  assert.deepEqual(slotGridBounds(grid),{left:25,top:38,right:355,bottom:134});
  assert.deepEqual(marks,Array.from({length:12},(_,slot)=>{
    const p=slotPoint(grid,slot);
    assert.equal(slotAt(grid,p),slot);return [p.x,p.y];
  }));
  assert.deepEqual(gridFocusCamera(grid,430,200,11),{x:300,y:122,zoom:1});
});

test('stage captions follow pans and edits while avoiding repeated or offscreen text measurement',()=>{
  const grid={x:80,y:80,rows:100,cols:100,spacing:80,stages:Array.from({length:100},(_,i)=>'Long stage '+i)};
  const group={grid,name:'Track',tint:'160,160,160'};
  const view={ox:0,oy:0,zoom:1,width:400,height:240};
  const labels=[],highlights=[];
  let measurements=0;
  const ctx={save(){},restore(){},beginPath(){},fill(){},stroke(){},moveTo(){},lineTo(){},arc(){},
    fillText(text){labels.push(text)},fillRect(...args){highlights.push(args)},
    measureText(text){measurements++;return {width:text.length*6}}};
  const first=drawSlotGrid(ctx,group,view).stageHeader;
  const initialText=labels[0];
  assert.ok(measurements>0 && initialText.endsWith('…'));
  measurements=0;
  const pan=drawSlotGrid(ctx,group,{...view,ox:1}).stageHeader;
  assert.equal(measurements,0);
  assert.equal(pan.titles.get(0).l,first.titles.get(0).l+1);
  labels.length=0;grid.stages[0]='X';
  const renamed=drawSlotGrid(ctx,group,view).stageHeader;
  assert.equal(labels[0],'X');
  assert.equal(measurements,1);
  assert.ok(renamed.titles.get(0).l>first.titles.get(0).l);
  grid.stages[0]='Another long stage';
  drawSlotGrid(ctx,group,view);
  labels.length=0;
  grid.spacing=200;
  drawSlotGrid(ctx,group,view);
  assert.equal(labels[0],grid.stages[0]);
  measurements=0;labels.length=0;
  const offscreen=drawSlotGrid(ctx,group,{...view,oy:-1000},{active:true,hoverSlot:500});
  assert.equal(measurements,0);
  assert.equal(labels.length,0);
  assert.equal(offscreen.stageHeader,undefined);
  assert.equal(highlights.length,1);
});
