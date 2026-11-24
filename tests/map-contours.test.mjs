import assert from 'node:assert/strict';
import test from 'node:test';
import { Graph } from '../frontend/graph.js';
import { defaultMapView, newLibrary, readLibrary, serializeLibrary } from '../frontend/data.js';
import { placeAreaNotes, releaseGridNotes } from '../frontend/areas.js';
import { rememberMapAction, undoMapAction } from '../frontend/map-history.js';
import { contourGap, contourSupport, insideContour, measureContour, shapeSiblingContours } from '../frontend/map-contours.js';

function map(notes,areas) {
  const space={notes,areas};
  const calls = {drop:[],move:[],manual:[],grid:[]};
  const graph = Object.assign(Object.create(Graph.prototype), {
    canvas:{style:{},focus(){},getBoundingClientRect:()=>({left:0,top:0}),
      setPointerCapture(){},hasPointerCapture:()=>false}, width:1000,height:600,camera:{x:0,y:0,zoom:1},
    contacts:new Map(),nodes:new Map(),selectedIds:new Set(),heating:new Set(),tool:'select',view:{...defaultMapView},repaint(){},
    callbacks:{
      onMapDrop:(...args)=>calls.drop.push(args),
      onReleaseSeats:positions=>{
        const {ok,before,after}=releaseGridNotes(space,positions,{movePinned:graph.view.manualLayout});
        assert.ok(ok);
        rememberMapAction(space,{kind:'placement',before,after});
        graph.setData(notes,areas);
      },
      onManualMove:(...args)=>calls.manual.push(args),
      onGridMove:(...args)=>calls.grid.push(args),
      onMove:positions=>calls.move.push(...positions)
    }
  });
  graph.setData(notes,areas);
  graph.measureGroups();
  const point = (x,y=0)=>({clientX:500+x,clientY:300+y,pointerId:1,button:0,pointerType:'mouse',preventDefault(){}});
  return {graph,point,calls,space};
}

test('free layout freezes the current frame, new data and overlapping notes until automatic layout resumes',()=>{
  const notes=[{id:'a',x:0,y:0,tags:['shared']},{id:'b',x:1,y:0,links:['a']},{id:'c',x:150,y:0,tags:['shared']}];
  const {graph,calls}=map(notes,[]);
  graph.step();
  graph.setView({manualLayout:true});
  assert.ok(calls.move.length>0);
  const edges=graph.edges;
  assert.equal(edges.length,2);
  assert.equal(graph.remaining,0);
  for (const n of graph.nodes.values()) assert.deepEqual([n.vx,n.vy],[0,0]);
  const layout=[...graph.nodes.values()].map(n=>[n.x,n.y]);
  graph.wake();graph.step();
  assert.deepEqual([...graph.nodes.values()].map(n=>[n.x,n.y]),layout);
  assert.equal(graph.edges,edges);
  graph.setData([...notes,{id:'d',x:150,y:0}],[]);
  graph.step();
  assert.equal(graph.remaining,0);
  assert.equal(graph.nodes.get('d').x,150);
  graph.setView({manualLayout:false});
  assert.ok(graph.remaining>0);
  graph.step();
  assert.notEqual(graph.nodes.get('d').x,150);
});

test('free placement can leave a full destination and release a seated group at exact offsets',()=>{
  const notes=[{id:'seat',x:-250,y:0,areaId:'source',slot:0,links:['pin']},
    {id:'pin',x:-180,y:25,areaId:'parent',pinned:true},{id:'resident',x:150,y:0,areaId:'dest',slot:0}];
  const areas=[{id:'parent'},{id:'source',parentId:'parent',grid:{rows:1,cols:1,x:-250,y:0}},
    {id:'dest',grid:{rows:1,cols:2,x:150,y:0}}];
  const {graph,point,calls,space}=map(notes,areas);
  graph.setView({manualLayout:true});
  graph.changeSelection(new Set(['seat','pin']));
  const start=structuredClone(notes);
  graph.pointerDown(point(-250));
  graph.pointerMove(point(156,9));
  assert.equal(graph.drag.mapTarget.blocked,true);
  graph.cancelDrag();
  assert.deepEqual([...graph.nodes.values()].map(n=>[n.x,n.y]),start.map(n=>[n.x,n.y]));
  graph.pointerDown(point(-180,25)); // Grab the pinned member this time.
  graph.pointerMove(point(226,34)); // Too few seats for both notes.
  graph.pointerUp(point(226,134)); // Release the group on the open canvas.
  assert.deepEqual(notes.map(n=>[n.areaId,n.x,n.y]),[['parent',156,109],['parent',226,134],['dest',150,0]]);
  assert.deepEqual(notes[0].links,['pin']);
  assert.equal(notes[1].pinned,true);
  assert.equal(graph.remaining,0);
  assert.deepEqual(calls.drop,[]);
  assert.ok(undoMapAction(space));
  assert.deepEqual(notes,start);
});

test('free layout previews, commits and undoes a group drop into a nested grid',()=>{
  // Older free layouts can leave a note directly over a seat without assigning it.
  const notes=[{id:'locked',sealed:'opaque',pinned:true,x:144,y:0,areaId:null,slot:null,links:['plain']},
    {id:'plain',x:-260,y:20,areaId:null,slot:null}];
  const areas=[{id:'folder'},{id:'dock',parentId:'folder',grid:{x:80,y:0,cols:3,rows:1,spacing:64}}];
  const {graph,point,space}=map(notes,areas);
  graph.callbacks.onMapDrop=(ids,id,slot,positions)=>{
    const change=placeAreaNotes(space,ids,id,slot,positions);
    assert.ok(change.ok);
    rememberMapAction(space,{kind:'placement',before:change.before,after:change.after});
    graph.setData(notes,areas,new Set(ids));
  };
  const before=structuredClone(notes);
  graph.setView({manualLayout:true});
  graph.changeSelection(new Set(['plain','locked']));
  graph.pointerDown(point(144,0));
  graph.pointerMove(point(156,8));
  assert.deepEqual([...graph.drag.mapTarget.seats],[['locked',1],['plain',2]]);
  assert.deepEqual(notes,before);
  graph.pointerUp(point(156,8));
  graph.step();
  assert.deepEqual(notes.map(n=>[n.areaId,n.slot,n.x,n.y]),[['dock',1,144,0],['dock',2,208,0]]);
  assert.equal(graph.remaining,0);
  assert.ok(undoMapAction(space));
  assert.deepEqual(notes,before);
});

test('a free layout drag onto a different folder keeps membership and saves the exact position of a pinned note',()=>{
  const notes=[{id:'pin',x:-200,y:0,areaId:'a',pinned:true},{id:'other',x:150,y:20,areaId:'b'}];
  const {graph,point,calls}=map(notes,[{id:'a'},{id:'b'}]);
  graph.setView({manualLayout:true});
  graph.pointerDown(point(-200));graph.pointerUp(point(150,20));
  assert.deepEqual(calls.move,[{id:'pin',x:150,y:20}]);
  assert.deepEqual(calls.drop,[]);
  assert.equal(graph.nodes.get('pin').areaId,'a');
  assert.equal(graph.remaining,0);
  assert.equal(graph.nodes.get('other').x,150);
});

test('libraries share free layout between spaces, preserve the links preference and default older saves to automatic layout',()=>{
  const library=newLibrary();
  library.spaces.demo={notes:[],areas:[]};
  library.view={links:false};
  const legacy=readLibrary(serializeLibrary(library));
  assert.equal(legacy.view.manualLayout,false);
  assert.equal(legacy.view.links,false);
  legacy.view.manualLayout=true;
  legacy.active='demo';
  const reopened=readLibrary(serializeLibrary(legacy)), {graph}=map([],[]);
  graph.setView(reopened.view);
  graph.setData(reopened.spaces.demo.notes,[]);
  graph.setData(reopened.spaces.personal.notes,[]);
  assert.equal(graph.view.manualLayout,true);
  graph.setView({manualLayout:false});
  assert.equal(graph.view.links,false);
});

test('moving 512 of 3072 linked notes across branches and undoing matches a fresh map',()=>{
  const areas=[{id:'root'},{id:'branch',parentId:'root'},{id:'left',parentId:'branch'},
    {id:'other',parentId:'root'},{id:'right',parentId:'other'}];
  const size=3072;
  const notes=Array.from({length:size},(_,i)=>({id:'n'+i,x:(i%64)*51,y:Math.floor(i/64)*51,areaId:i<size/2?'left':'right',
    tags:['shared'+(i%23)],links:['n'+((i+1)%size),'n'+((i+64)%size)],pinned:i%13===0}));
  const {graph,space}=map(notes,areas);
  const ids=notes.slice(0,512).map(n=>n.id), edges=graph.edges;
  const change=placeAreaNotes(space,ids,'right',null,ids.map((id,i)=>({id,x:(i%32)*60,y:75+Math.floor(i/32)*60})));
  assert.equal(change.after.length,ids.length);
  function compare() {
    graph.setData(notes,areas,new Set(ids));
    const {graph:fresh}=map(notes,areas);
    const edgeData=g=>g.edges.map(e=>[e.a.id,e.b.id,e.strength,e.maxPull,e.gap]);
    const tags=g=>g.tagSets.map(group=>group.map(n=>n.id));
    const membership=g=>g.groups.map(a=>[a.id,a.count,a.nodes.map(n=>[n.id,n.x,n.y,n.tint])]);
    assert.equal(graph.edges,edges);
    assert.deepEqual(edgeData(graph),edgeData(fresh));
    assert.deepEqual(tags(graph),tags(fresh));
    assert.deepEqual(membership(graph),membership(fresh));
  }
  compare();
  rememberMapAction(space,{kind:'placement',before:change.before,after:change.after});
  assert.ok(undoMapAction(space));compare();
});

test('zoom reuses settled nested outlines and a new simulation step updates them',()=>{
  const {graph}=map([{id:'a',areaId:'child',x:0,y:0},{id:'b',areaId:'child',x:150,y:0}],
    [{id:'parent'},{id:'child',parentId:'parent'}]);
  graph.view={labels:false,grid:false,links:false};graph.dpr=1;
  graph.ctx=new Proxy({},{get:(ctx,key)=>ctx[key]??(()=>{})});
  graph.draw();
  const before=graph.groups.map(g=>g.hull);
  graph.zoomAt(1.3,{x:275,y:190});graph.draw();
  assert.ok(graph.groups.every((g,i)=>g.hull===before[i]));
  graph.step();graph.draw();
  assert.ok(graph.groups.every((g,i)=>g.hull!==before[i]));
});

test('position-only changes keep existing link forces and local tag groups',()=>{
  const notes=Array.from({length:8},(_,i)=>({id:'n'+i,x:i*51,y:0,tags:['shared']}));
  const {graph}=map(notes,[]);
  const tags=graph.tagSets;
  notes[0].x+=40;
  graph.setData(notes,[],new Set(['n0']));
  assert.equal(graph.nodes.get('n0').x,notes[0].x);
  assert.equal(graph.tagSets,tags);
});

test('a free contour stays round; only the contact side yields, keeping contents inside',()=>{
  const groups = [0,60,400].map(x=>({nodes:[{x,y:0,r:16}],children:[]}));
  for (const g of groups) g.hull=measureContour(g);
  shapeSiblingContours(groups);
  const [left,right,free] = groups.map(g=>g.hull);
  assert.equal(free.points,undefined);
  assert.ok(insideContour(free,{x:400,y:42}));
  assert.ok(insideContour(left,{x:-42,y:0}));
  assert.ok(!insideContour(left,{x:30,y:0}));
  assert.ok(!insideContour(right,{x:30,y:0}));
  for (const h of [left,right]) {
    for (let i=0;i<360;i++) {
      const a=i*Math.PI/180;
      assert.ok(insideContour(h,{x:h.x+Math.cos(a)*16,y:h.y+Math.sin(a)*16}));
    }
  }
});

function contoursOf(...sets) {
  const groups = sets.map(nodes=>({nodes,children:[]}));
  for (const g of groups) g.hull=measureContour(g);
  shapeSiblingContours(groups);
  return groups.map(g=>g.hull);
}

test('unmoved compressed contours reuse their boundary while a neighbour can reshape a new one',()=>{
  const groups=[0,60,600,660].map(x=>({nodes:[{x,y:0,r:16}],children:[]}));
  function frame(){
    for(const group of groups) group.hull=measureContour(group);
    shapeSiblingContours(groups);
  }
  frame();
  const [initial,,distant]=groups.map(group=>group.hull.points);
  const frozen={...groups[0].hull};
  const oldEdge=insideContour(frozen,{x:28,y:0});
  groups[1].nodes[0].x+=12;
  frame();
  assert.notEqual(groups[0].hull.points,initial);
  assert.equal(groups[2].hull.points,distant);
  assert.notEqual(insideContour(groups[0].hull,{x:28,y:0}),oldEdge);
  assert.equal(insideContour(frozen,{x:28,y:0}),oldEdge);
  groups[1].nodes[0].x=160;
  frame();
  assert.equal(groups[0].hull.points,undefined);
  assert.ok(insideContour(groups[0].hull,{x:40,y:0}));
});

test('asymmetric folders share one seam and keep their full gap at its shoulders',()=>{
  const [a,b] = contoursOf([0,0,0,100].map(x=>({x,y:0,r:20})),[{x:162,y:0,r:20}]);
  const rightA = Math.max(...a.points.map(p=>p.x)), leftB = Math.min(...b.points.map(p=>p.x));
  assert.ok(leftB-rightA >= contourGap);
  assert.ok(insideContour(a,{x:120,y:0}));
  assert.ok(insideContour(b,{x:142,y:0}));
});

test('an oblique seam separates a fixed diagonal row from another anchored folder',()=>{
  const members = [-60,60].map(x=>({x,y:x,r:10}));
  const [a,b] = contoursOf(members,[{x:0,y:65,r:10}]);
  const {nx,ny} = a.cuts[0];
  assert.ok(Math.abs(nx) > .25);
  const project = p=>p.x*nx+p.y*ny;
  assert.ok(Math.min(...b.points.map(project))-Math.max(...a.points.map(project)) >= contourGap-.01);
  for (const p of members) assert.ok(insideContour(a,p));
  assert.ok(insideContour(b,{x:0,y:65}));
});

test('a narrow grid inside a normal folder lends its width only to horizontal contact',()=>{
  const bounds = {left:-300,top:-24,right:300,bottom:24};
  const child = {gridBounds:bounds,count:1,hull:{x:0,y:0,r:Math.hypot(300,24)}};
  const parent = measureContour({nodes:[],children:[child]});
  assert.equal(contourSupport(parent,0,1,0),24);
  assert.equal(contourSupport(parent,1,0,0),300);
});

test('dragging one member stretches the contour around the moving note and its pinned neighbour before release',()=>{
  const {graph,point,calls}=map(
    [{id:'fixed',x:-200,y:0,pinned:true,areaId:'a'},{id:'moving',x:-140,y:0,areaId:'a'}],
    [{id:'a',name:'Area'}]);
  const area=graph.groups[0];
  graph.pointerDown(point(-140));
  for (const x of [40,220]) {
    graph.pointerMove(point(x));
    graph.measureGroups();
    assert.ok(insideContour(area.hull,{x:x+graph.nodes.get('moving').r,y:0}));
    assert.ok(insideContour(area.hull,{x:-200-graph.nodes.get('fixed').r,y:0}));
    assert.equal(graph.drag.mapTarget,null);
  }
  graph.pointerUp(point(220));
  assert.deepEqual(calls.drop,[]);
  assert.deepEqual(calls.manual,[[[{id:'moving',x:-140,y:0}],[{id:'moving',x:220,y:0}]]]);
  assert.equal(graph.nodes.get('moving').areaId,'a');
});

test('a dragged selection carries the child and parent outlines and cancellation restores both',()=>{
  const {graph,point,calls}=map(
    [{id:'a',x:-240,y:-30,areaId:'child'},{id:'b',x:-180,y:-30,areaId:'child'}],
    [{id:'parent'},{id:'child',parentId:'parent'}]);
  const start=graph.groups.map(({hull})=>({x:hull.x,y:hull.y,r:hull.r}));
  graph.changeSelection(new Set(['a','b']));
  graph.pointerDown(point(-240,-30));
  for (const [dx,dy] of [[140,35],[290,100]]) {
    graph.pointerMove(point(-240+dx,-30+dy));
    graph.measureGroups();
    for (const [index,{hull}] of graph.groups.entries()) {
      assert.deepEqual([hull.x,hull.y,hull.r],[start[index].x+dx,start[index].y+dy,start[index].r]);
      assert.ok(!insideContour(hull,start[index]));
    }
    assert.equal(graph.drag.mapTarget,null);
  }
  graph.flushPositions();
  graph.cancelDrag();
  graph.pointerUp(point(50,70));
  graph.measureGroups();
  assert.deepEqual(graph.groups.map(({hull})=>({x:hull.x,y:hull.y,r:hull.r})),start);
  assert.deepEqual(calls.move,[]);
  assert.deepEqual(calls.manual,[]);
  assert.deepEqual(calls.drop,[]);
});

test('a source outline following the pointer does not intercept a drop into its sibling',()=>{
  const {graph,point,calls}=map(
    [{id:'a',x:-200,y:0,areaId:'source'},{id:'b',x:160,y:0,areaId:'destination',pinned:true}],
    [{id:'source'},{id:'destination'}]);
  const source=graph.groups.find(g=>g.id==='source');
  graph.pointerDown(point(-200));
  graph.pointerMove(point(160));
  graph.measureGroups();
  assert.ok(insideContour(source.hull,{x:160,y:0}));
  graph.pointerMove(point(165));
  assert.equal(graph.drag.mapTarget.group.id,'destination');
  graph.pointerUp(point(165));
  assert.deepEqual(calls.drop,[[['a'],'destination',null,[{id:'a',x:165,y:0}]]]);
  assert.deepEqual(calls.manual,[]);
});

test('an unselected group follows its moving members while a linked note is held elsewhere',()=>{
  const {graph,point}=map(
    [{id:'handle',x:50,y:0,links:['member']},{id:'member',x:-100,y:0,areaId:'a'}],[{id:'a'}]);
  graph.pointerDown(point(50));
  graph.pointerMove(point(280));
  for (let frame=0;frame<45;frame++) graph.step();
  graph.measureGroups();
  const member=graph.nodes.get('member');
  assert.ok(member.x > -80);
  assert.equal(graph.groups[0].hull.x,member.x);
  assert.equal(graph.drag.mapTarget,null);
  graph.cancelDrag();
  graph.measureGroups();
  assert.equal(graph.groups[0].hull.x,-100);
});

test('drag targets use a frozen contour; the leaf and its exposed parent rim are separately addressable',()=>{
  const {graph,point,calls}=map(
    [{id:'a',x:-240,y:0},{id:'b',x:-180,y:0},{id:'c',x:150,y:0,areaId:'leaf'}],
    [{id:'root',name:'Root'},{id:'leaf',name:'Leaf',parentId:'root'}]);
  graph.changeSelection(new Set(['a','b']));
  graph.pointerDown(point(-240));
  graph.pointerMove(point(150));
  assert.equal(graph.drag.mapTarget.group.id,'leaf');
  const initialRadius = graph.drag.mapTarget.group.hull.r;
  graph.nodes.get('c').x+=60;
  graph.measureGroups();
  graph.pointerMove(point(150+initialRadius+8));
  assert.equal(graph.drag.mapTarget.group.id,'root');
  graph.pointerUp(point(150));
  assert.deepEqual(calls.drop,[[['a','b'],'leaf',null,[{id:'a',x:150,y:0},{id:'b',x:210,y:0}]]]);
  assert.equal(graph.nodes.get('c').x,150);
  assert.equal(graph.nodes.get('a').x,-240);
  assert.deepEqual(calls.manual,[]);
});

test('repositioning within the current contour records both positions and accepts an immediate undo',()=>{
  const notes=[{id:'a',x:0,y:0,areaId:'folder'}], areas=[{id:'folder',name:'Folder'}];
  const {graph,point,calls}=map(notes,areas);
  graph.nodes.get('a').x=3; // A simulation tick since the last persisted frame.
  graph.pointerDown(point(3));
  graph.pointerMove(point(18));
  assert.equal(graph.drag.mapTarget,null);
  graph.pointerUp(point(18));
  assert.deepEqual(calls.move,[{id:'a',x:3,y:0},{id:'a',x:18,y:0}]);
  assert.deepEqual(calls.manual,[[[{id:'a',x:3,y:0}],[{id:'a',x:18,y:0}]]]);
  graph.setData([{...notes[0],x:3}],areas);
  assert.equal(graph.nodes.get('a').x,3);
});

test('seat preview matches the grabbed-note order and a full destination restores the group',()=>{
  const notes=[{id:'a',x:-300,y:0},{id:'b',x:-240,y:0},{id:'seated',x:0,y:0,areaId:'grid',slot:0}];
  const grid = {rows:1,cols:3,x:0,y:0};
  const {graph,point,calls} = map(notes,[{id:'grid',name:'Grid',grid}]);
  graph.changeSelection(new Set(['a','b']));
  graph.pointerDown(point(-240));
  graph.pointerMove(point(184));
  assert.deepEqual([...graph.drag.mapTarget.seats],[['b',1],['a',2]]);
  graph.pointerUp(point(184));
  assert.deepEqual(calls.drop[0].slice(0,3),[['b','a'],'grid',1]);
  graph.setData(notes,[{id:'grid',name:'Grid',grid:{...grid,cols:2}}]);
  graph.pointerDown(point(-240));
  graph.pointerMove(point(184));
  assert.equal(graph.drag.mapTarget.blocked,true);
  graph.pointerUp(point(184));
  assert.equal(calls.drop.length,1);
  assert.equal(graph.nodes.get('b').x,-240);
  assert.deepEqual(calls.manual,[]);
});

test('a seat resists links, previews the free drop, and returns on Escape or undo',()=>{
  const grid={rows:1,cols:1,x:160,y:0};
  const {graph,point,calls,space}=map([{id:'seat',x:160,y:0,areaId:'g',slot:0,links:['far']},{id:'far',x:-320,y:0,pinned:true}],
    [{id:'g',grid}]);
  graph.step();
  assert.equal(graph.nodes.get('seat').x,160);
  graph.pointerDown(point(160));
  graph.pointerMove(point(-80));
  assert.equal(graph.nodes.get('seat').x,-80);
  assert.equal(graph.canvas.style.cursor,'grabbing');
  assert.equal(space.notes[0].slot,0);
  graph.cancelDrag();
  assert.equal(graph.nodes.get('seat').x,160);
  graph.pointerDown(point(160));
  graph.pointerUp(point(-80));
  assert.equal(graph.nodes.get('seat').x,-80);
  assert.equal(graph.nodes.get('seat').seated,false);
  assert.deepEqual([space.notes[0].areaId,space.notes[0].slot],[null,null]);
  assert.ok(undoMapAction(space));
  graph.setData(space.notes,space.areas);
  assert.equal(graph.nodes.get('seat').x,160);
  assert.equal(graph.nodes.get('seat').seated,true);
  assert.deepEqual(calls.manual,[]);
  assert.deepEqual(calls.move,[]);
});

test('looking up a grid seat follows swaps and releases after partial map updates',()=>{
  const grid={x:0,y:0,rows:1,cols:2,spacing:100};
  const notes=['a','b'].map((id,slot)=>({id,slot,areaId:'g'})), areas=[{id:'g',grid}];
  const {graph,point,space}=map(notes,areas);
  const occupant=x=>graph.gridCellAt(graph.local(point(x)))?.note?.id;
  assert.deepEqual([occupant(0),occupant(100)],['a','b']);
  const swap=placeAreaNotes(space,['a'],'g',1);
  assert.ok(swap.ok);
  graph.setData(notes,areas,new Set(swap.after.map(n=>n.id)));
  assert.deepEqual([occupant(0),occupant(100)],['b','a']);
  const release=releaseGridNotes(space,[{id:'b',x:-100,y:0}]);
  assert.ok(release.ok);
  graph.setData(notes,areas,new Set(['b']));
  assert.deepEqual([occupant(0),occupant(100)],[undefined,'a']);
});

test('seat preview uses the final centre and size, and leaving the grid restores the free size',()=>{
  const grid={x:70,y:0,rows:2,cols:3,spacing:30,rowSpacing:24};
  const {graph,point,calls}=map([{id:'a',x:-200,y:0,weight:10000}],[{id:'g',grid}]);
  const node=graph.nodes.get('a'),original=node.r;
  graph.pointerDown(point(-200));
  graph.pointerMove(point(110,18));
  assert.equal(graph.drag.mapTarget.seats.get('a'),4);
  assert.deepEqual([node.x,node.y],[100,24]);
  assert.ok(node.r<original);
  graph.pointerMove(point(-90,10));
  assert.deepEqual([node.x,node.y,node.r],[-90,10,original]);
  graph.cancelDrag();
  assert.deepEqual([node.x,node.y,node.r],[-200,0,original]);
  assert.deepEqual(calls.move,[]);
});

test('dragging a mixed selection out of a seat preserves its offsets and undoes the group in one step',()=>{
  const {graph,point,calls,space}=map([{id:'a',x:160,y:0,areaId:'g',slot:0},{id:'b',x:-100,y:70}],
    [{id:'g',grid:{x:160,y:0,rows:1,cols:1,spacing:64}}]);
  graph.changeSelection(new Set(['a','b']));
  graph.pointerDown(point(160));graph.pointerMove(point(20));
  assert.equal(graph.canvas.style.cursor,'grabbing');
  assert.equal(graph.nodes.get('a').x,20);
  assert.equal(graph.nodes.get('b').x,-240);
  graph.pointerUp(point(20));
  assert.deepEqual(space.notes.map(n=>[n.x,n.y,n.slot??null]),[[20,0,null],[-240,70,null]]);
  assert.ok(undoMapAction(space));
  assert.deepEqual(space.notes.map(n=>[n.x,n.y,n.slot??null]),[[160,0,0],[-100,70,null]]);
  assert.deepEqual(calls.move,[]);
  assert.deepEqual(calls.manual,[]);
});

test('dragging across a full grid previews both ends of each swap and commits only the last one',()=>{
  const area={id:'g',grid:{x:20,y:0,rows:1,cols:3,spacing:80}};
  const notes=['a','b','c'].map((id,slot)=>({id,slot,areaId:'g',x:20+slot*80,y:0}));
  const space={notes,areas:[area]}, {graph,point,calls}=map(notes,space.areas);
  graph.callbacks.onMapDrop=(ids,id,slot,positions)=>{
    const change=placeAreaNotes(space,ids,id,slot,positions);
    assert.ok(change.ok);
    rememberMapAction(space,{kind:'placement',before:change.before,after:change.after});
    graph.setData(notes,space.areas);
  };
  const centres=()=>[...graph.nodes.values()].map(n=>n.x);
  graph.pointerDown(point(20));graph.pointerMove(point(101));
  assert.deepEqual(centres(),[100,20,180]);
  graph.pointerMove(point(178));
  assert.deepEqual(centres(),[180,100,20]);
  graph.pointerMove(point(270));
  assert.deepEqual(centres(),[270,100,180]);
  graph.pointerMove(point(180));graph.cancelDrag();
  assert.deepEqual(centres(),[20,100,180]);
  graph.pointerDown(point(20));graph.pointerUp(point(101));
  assert.deepEqual(centres(),[100,20,180]);
  assert.deepEqual(notes.map(n=>n.slot),[1,0,2]);
  assert.ok(undoMapAction(space));graph.setData(notes,space.areas);
  assert.deepEqual(centres(),[20,100,180]);
  assert.deepEqual(notes.map(n=>n.slot),[0,1,2]);
  assert.deepEqual(calls.move,[]);
});

test('a pinned source carries its group only over an explicit map destination',()=>{
  const {graph,point,calls}=map([{id:'a',x:-200,y:0,pinned:true},{id:'b',x:-160,y:0}],
    [{id:'folder',anchor:{x:200,y:0}}]);
  graph.changeSelection(new Set(['a','b']));
  graph.pointerDown(point(-200));
  graph.pointerMove(point(0));
  assert.equal(graph.nodes.get('a').x,-200);
  graph.pointerMove(point(200));
  assert.equal(graph.nodes.get('a').x,200);
  assert.equal(graph.nodes.get('b').x,240);
  graph.pointerMove(point(0));
  assert.equal(graph.nodes.get('a').x,-200);
  assert.equal(graph.nodes.get('b').x,-160);
  graph.pointerUp(point(200));
  assert.deepEqual(calls.drop,[[['a','b'],'folder',null,[{id:'a',x:200,y:0},{id:'b',x:240,y:0}]]]);
  assert.deepEqual(calls.manual,[]);
});

test('dragging the grid title previews the origin and occupied seats together',()=>{
  const grid={rows:1,cols:2,x:80,y:0};
  const {graph,point,calls}=map([{id:'a',areaId:'g',slot:1}],[{id:'g',grid}]);
  graph.gridLabels=[{l:400,r:440,t:280,b:315,grid:graph.groups[0]}];
  graph.pointerDown(point(-80));
  graph.pointerMove(point(-30,40));
  assert.equal(graph.nodes.get('a').x,80+184+50);
  graph.flushPositions();
  assert.deepEqual(calls.move,[]);
  graph.pointerUp(point(-30,40));
  assert.deepEqual(calls.grid,[['g',130,40]]);
  assert.deepEqual(graph.groups[0].grid,grid);
});

test('grid corner changes spacing around the first seat, cancelling and committing one whole gesture',()=>{
  const original={rows:2,cols:3,x:-130,y:-50,spacing:96};
  const notes=[{id:'a',areaId:'g',slot:0,weight:10000},{id:'b',areaId:'g',slot:1,weight:1e6},
    {id:'c',areaId:'g',slot:2,weight:1e6}];
  const {graph,point,calls}=map(notes,[{id:'g',grid:original}]);
  const sizes=[];
  graph.callbacks.onGridSpacing=(id,spacing)=>sizes.push({id,spacing});
  const group=graph.groups[0], a=graph.nodes.get('a'), b=graph.nodes.get('b'), c=graph.nodes.get('c');
  const priorRadius=b.r;
  const corner=s=>point(original.x+2.5*s,original.y+1.5*s);
  graph.pointerDown(corner(96));
  graph.pointerMove(corner(40));
  assert.deepEqual([a.x,a.y],[original.x,original.y]);
  assert.deepEqual([b.x,c.x],[original.x+40,original.x+80]);
  assert.ok(a.r<b.r && c.x-b.x-b.r-c.r>=7);
  assert.equal(graph.hit(graph.local(point(b.x,b.y))).id,'b');
  assert.equal(graph.hitSeat(graph.local(point(original.x,original.y+40))).index,3);
  graph.flushPositions();
  assert.deepEqual(calls.move,[]);
  graph.cancelDrag();
  assert.equal(group.grid,original);
  assert.deepEqual([b.x,b.r],[original.x+96,priorRadius]);
  assert.deepEqual(sizes,[]);
  graph.pointerDown(corner(96));graph.pointerMove(corner(79));graph.pointerUp(corner(40));
  assert.deepEqual(sizes,[{id:'g',spacing:{spacing:40,rowSpacing:40}}]);
  graph.setData(notes,[{id:'g',grid:{...original,spacing:40}}]);
  assert.equal(b.x,original.x+40);
  assert.ok(c.x-b.x-b.r-c.r>=7);
  graph.setData(notes.map(n=>({...n,areaId:null,slot:null})),[]);
  assert.ok(b.r>priorRadius);
});

test('wide 100×100 grids fit into the map and start at a readable magnification',()=>{
  const grid={x:0,y:0,rows:100,cols:100,spacing:320};
  const {graph}=map([],[{id:'g',grid}]);
  let camera;
  graph.fly=(x,y,zoom)=>{camera={x,y,zoom}};
  graph.fit();
  assert.ok(32000*camera.zoom<=graph.height);
  graph.fit({readable:true});
  assert.ok(camera.zoom>=.65 && camera.y<graph.height);
});

test('context menu targets the seated note’s own grid, or the deepest empty grid under the pointer',()=>{
  const {graph,point}=map([{id:'a',areaId:'parent',slot:0}],
    [{id:'parent',grid:{x:0,y:0,rows:4,cols:4,spacing:184}},
      {id:'child',parentId:'parent',grid:{x:0,y:0,rows:2,cols:2,spacing:40}}]);
  const target=(x,y)=>{
    const pos=graph.local(point(x,y));
    return graph.contextGridId(pos,graph.hit(pos));
  };
  assert.equal(target(0,0),'parent');
  assert.equal(target(36,36),'child');
  assert.equal(target(60,60),'child'); // corner just outside the slot bounds
  assert.equal(target(140,140),'parent');
  assert.equal(target(-200,-200),null);
});

test('empty folders have their own landing targets and a sibling can be placed beside them',()=>{
  const {graph}=map([],[{id:'root',anchor:{x:150,y:50}}]);
  assert.ok(insideContour(graph.groups[0].hull,{x:150,y:50}));
  assert.deepEqual(graph.suggestAreaAnchor({x:150,y:50},'root'),{x:150,y:50});
  const next = graph.suggestAreaAnchor({x:150,y:50});
  assert.ok(Math.hypot(next.x-150,next.y-50)>84);
  graph.setData([],[{id:'grid',grid:{x:0,y:0,cols:100,rows:100}}]);
  const beside = graph.suggestAreaAnchor({x:0,y:0});
  assert.ok(beside.x <= -92-42 || beside.y <= -92-42);
});
