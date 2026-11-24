import test from 'node:test';
import assert from 'node:assert/strict';
import { mountInkColor } from '../frontend/map-ink-color.js';

function fixture() {
  class Element extends EventTarget {
    children = [];
    style = {setProperty() {}};
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
    focus() {}
    contains(node) { return node === this || this.children.some(child=>child.contains(node)); }
    setPointerCapture(id) { this.capture=id; }
    hasPointerCapture(id) { return id===this.capture; }
    releasePointerCapture() { this.capture=null; }
    getBoundingClientRect() { return {width:100,height:100,left:0,top:0}; }
  }
  const doc = new EventTarget(), bar = new Element(), canvas = new Element();
  doc.createElement=()=>new Element(); doc.defaultView=new EventTarget(); bar.ownerDocument=doc;
  let item={id:'drawing',type:'rect',stroke:'#ff0000'}, writes=0;
  const palette=mountInkColor({bar,canvas,target:()=>item,repaint(){},
    commit(hex){ item={...item,stroke:hex}; writes++; palette.sync(false); }});
  const [trigger,panel]=bar.children, [field,hue,footer]=panel.children, [presets,hex]=footer.children;
  const send=(node,type,attrs={})=>node.dispatchEvent(Object.assign(new Event(type,{cancelable:true}),attrs));
  return {send,field,hue,hex,swatch:presets.children[2],trigger,panel,palette,
    current:()=>item,writes:()=>writes,replaceFromSync:()=>{item={...item,stroke:'#444444'}}};
}

test('hover and drag update the drawing without persisting intermediate colors',()=>{
  const f=fixture(), pen=f.current(), pointer={pointerId:9,button:0,clientX:100,clientY:50};
  f.send(f.trigger,'click');
  f.send(f.field,'pointermove',pointer);
  assert.equal(f.palette.previewFor(pen),'#800000');
  assert.equal(f.palette.previewFor({...pen,id:'other'}),null);
  f.send(f.field,'pointerdown',pointer);
  f.send(f.field,'pointermove',{...pointer,clientY:25});
  assert.equal(f.palette.previewFor(pen),'#bf0000');
  assert.equal(f.writes(),0);
  f.send(f.field,'pointerup',{...pointer,clientY:25});
  assert.equal(f.writes(),1); assert.equal(f.current().stroke,'#bf0000');
  assert.equal(f.panel.hidden,true); assert.equal(f.palette.previewFor(pen),null);
});

test('cancel, exact hex entry and a concurrent change respect the selected record',()=>{
  const f=fixture();
  f.send(f.trigger,'click');
  f.send(f.swatch,'pointerenter');
  assert.equal(f.palette.previewFor(f.current()),'#f27d75');
  f.send(f.panel,'keydown',{key:'Escape'});
  assert.equal(f.writes(),0);assert.equal(f.current().stroke,'#ff0000');
  f.send(f.trigger,'click');
  f.hex.value='1199DD'; f.send(f.hex,'input');
  assert.equal(f.palette.previewFor(f.current()),'#1199dd');
  f.send(f.hex,'keydown',{key:'Enter'});
  assert.equal(f.writes(),1);assert.equal(f.current().stroke,'#1199dd');
  f.send(f.trigger,'click'); f.send(f.swatch,'focus'); f.replaceFromSync();
  assert.equal(f.palette.previewFor(f.current()),null);
  f.send(f.swatch,'click');
  assert.equal(f.writes(),1);assert.equal(f.current().stroke,'#444444');
});

test('choosing a hue leaves the shade field open for another deliberate edit',()=>{
  const f=fixture(), point={button:0,pointerId:1,clientX:50,clientY:0};
  f.send(f.trigger,'click'); f.send(f.hue,'pointermove',point);
  assert.equal(f.palette.previewFor(f.current()),'#00ffff');assert.equal(f.writes(),0);
  f.send(f.hue,'pointerdown',point);f.send(f.hue,'pointerup',point);
  assert.equal(f.writes(),1);assert.equal(f.panel.hidden,false);
  f.send(f.field,'pointermove',{...point,clientY:50,clientX:100});
  assert.equal(f.palette.previewFor(f.current()),'#008080');
  f.send(f.panel,'keydown',{key:'Escape'});
  assert.equal(f.current().stroke,'#00ffff'); assert.equal(f.writes(),1);
});
