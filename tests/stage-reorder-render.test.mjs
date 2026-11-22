import test from 'node:test';
import assert from 'node:assert/strict';
import { drawSlotGrid, stageHandleAt, stageHandleBounds, stageTitleAt } from '../frontend/map-slots.js';

const view={ox:100,oy:120,zoom:1,width:540,height:400};
function track(pitch,names) {
  return {name:'Board',tint:'170,180,192',grid:{x:0,y:0,rows:2,cols:names.length,spacing:pitch,stages:names}};
}

function paint(group, options, frame=view) {
  const captions=[], paths=[], boxes=[], dots=[];
  const ctx={save(){},restore(){},moveTo(x,y){paths.push([x,y]);},lineTo(x,y){paths.push([x,y]);},
    fill(){},stroke(){},beginPath(){},arc(x,y,r){if(r===1.1)dots.push({x,y})},fillRect(){},rect(){},roundRect(...rect){boxes.push(rect);},
    measureText(value){return {width:Array.from(value).length*7};},
    fillText(value,x,y){captions.push({value,x,y,width:this.measureText(value).width});}};
  const label=drawSlotGrid(ctx,group,frame,options);
  return {header:label?.stageHeader,captions,paths,boxes,dots};
}

test('only the revealed or dragged stage paints dots; hovering never moves its text',()=>{
  for(const pitch of [24,96,320]){
    const group=track(pitch,['Idea','Work','Done']);
    const plain=paint(group),hot=paint(group,{hoverStage:1});
    assert.deepEqual(plain.dots,[]);
    assert.deepEqual(hot.captions,plain.captions);
    const grip=hot.header.handles.get(1),title=hot.header.titles.get(1);
    assert.equal(hot.dots.length,6);
    for(const {x,y} of hot.dots)assert.ok(x>=grip.l && x<=grip.r && y>=grip.t && y<=grip.b);
    const centre=rect=>({x:(rect.l+rect.r)/2,y:(rect.t+rect.b)/2});
    const start=centre(title),end=centre(grip);
    assert.equal(stageTitleAt(hot.header,start),1);
    assert.equal(stageTitleAt(hot.header,end),null);
    for(let i=0;i<=10;i++){
      const p={x:start.x+(end.x-start.x)*i/10,y:start.y+(end.y-start.y)*i/10};
      assert.equal(stageTitleAt(hot.header,p,1),1);
    }
    const drag=paint(group,{reorder:{from:1,to:2}});
    assert.deepEqual(drag.dots,hot.dots);
    assert.deepEqual(paint(group,{hoverSlot:1}).dots,[]);
  }
});

test('a caption and its grip have distinct click targets even in the smallest visible column',()=>{
  const names=['A','Длинное название','🧭'.repeat(80)];
  for(const pitch of [40,88,320]){
    const {header,captions}=paint(track(pitch,names));
    for(const [col,bounds] of header.handles){
      const text=captions[col], x=(bounds.l+bounds.r)/2,y=(bounds.t+bounds.b)/2;
      assert.equal(stageHandleBounds(header,col),bounds);
      assert.equal(stageHandleAt(header,{x,y}),col);
      assert.ok(bounds.l>=header.l+col*header.pitch);
      assert.ok(text.x>bounds.r && text.x+text.width<=header.l+(col+1)*header.pitch);
      assert.equal(stageHandleAt(header,{x:text.x+text.width/2,y}),null);
      assert.equal(stageHandleAt(header,{x,y:bounds.t-1}),null);
      assert.doesNotMatch(text.value,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    }
  }
});

test('a one-stage track and the overview zoom have no reorder handles',()=>{
  const {header}=paint(track(80,['Only']));
  assert.equal(stageHandleBounds(header,0),null);
  assert.equal(stageHandleAt(header,{x:100,y:65}),null);
  assert.equal(paint(track(40,['A','B']),{}, {...view,zoom:.5}).header,undefined);
});

test('a 24-unit stage keeps both the name and reorder target accessible at reading zoom',()=>{
  const result=paint(track(24,['Incoming','Работа','🧭']));
  assert.ok(result.header);
  for(const [col,grip] of result.header.handles){
    const {value,x,y,width}=result.captions[col];
    assert.ok(value.length && value!=='…');
    assert.ok(x>=result.header.l+col*24 && x+width<=result.header.l+(col+1)*24);
    assert.ok(grip.b<y);
    assert.equal(stageHandleAt(result.header,{x:(grip.l+grip.r)/2,y:(grip.t+grip.b)/2}),col);
    assert.equal(stageHandleAt(result.header,{x:x+width/2,y:y-5}),null);
  }
});

test('a rightward drop marks the trailing edge and a leftward drop marks the leading edge',()=>{
  const group=track(80,['A','B','C']);
  for(const [from,to,boundary] of [[0,2,3],[2,0,0]]){
    const {header,paths,boxes}=paint(group,{reorder:{from,to,boundary,pointerX:200}});
    const x=header.l+boundary*header.pitch;
    assert.ok(paths.some(([px,py])=>px===x && py===header.t-2));
    assert.ok(paths.some(([px,py])=>px===x && py===view.oy+120));
    assert.equal(boxes.length,1);
  }
  const {header,paths,boxes}=paint(group,{reorder:{from:1,to:null,boundary:null,pointerX:200}});
  assert.ok(!paths.some(([,y])=>y===header.t-2));
  assert.equal(boxes.length,1);
});
