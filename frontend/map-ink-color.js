import { tr } from './i18n.js';
import { boardInk } from './board-theme.js';

const swatches = ['#232323','#f4f4f5','#f27d75','#efbc67','#75ba99','#72acdf','#9a7af0','#dd82b5'];
const clamp = n => Math.max(0,Math.min(1,n));

function toHSV(hex) {
  const [r,g,b] = hex.slice(1).match(/../g).map(byte=>parseInt(byte,16)/255);
  const v = Math.max(r,g,b), span = v - Math.min(r,g,b);
  const sector = span === 0 ? 0 : v === r ? (g-b)/span : v === g ? 2+(b-r)/span : 4+(r-g)/span;
  return {h:(sector*60+360)%360, s:v === 0 ? 0 : span/v, v};
}

function toHex({h,s,v}) {
  const channel = n => {
    const k = (n + h/60)%6;
    return Math.round(255 * v * (1 - s * Math.max(0,Math.min(k,4-k,1)))).toString(16).padStart(2,'0');
  };
  return '#' + channel(5) + channel(3) + channel(1);
}

export function mountInkColor({bar, canvas, signal, target, commit, repaint}) {
  const doc = bar.ownerDocument;
  const make = (tag, cls) => {
    const el = doc.createElement(tag);
    el.className = cls;
    if (tag === 'button') el.type = 'button';
    return el;
  };
  const listen = (el,type,fn,capture=false) => el.addEventListener(type,fn,{capture,signal});
  const trigger = make('button','icon-button map-ink-color');
  trigger.setAttribute('aria-expanded','false');
  const panel = make('div','map-ink-palette');
  panel.setAttribute('role','group');
  panel.hidden = true;
  const square = make('button','ink-color-field');
  const hue = make('input','ink-color-hue');
  hue.type = 'range'; hue.min = '0'; hue.max = '360';
  const presets = make('div','ink-color-presets');
  for (const hex of swatches) {
    const button = make('button','ink-color-preset');
    button.style.backgroundColor = hex;
    button.setAttribute('aria-label',hex);
    listen(button,'pointerenter',()=>pickHex(hex));
    listen(button,'focus',()=>pickHex(hex));
    listen(button,'click',()=>accept(hex));
    presets.append(button);
  }
  const code = make('input','ink-color-hex');
  code.type = 'text'; code.maxLength = 7; code.spellcheck = false; code.autocomplete = 'off';
  const footer = make('div','ink-color-footer');
  footer.append(presets,code);
  panel.append(square,hue,footer);
  bar.append(trigger,panel);

  let owner = null, candidate = null, hsv, dragging = null;
  function base() {
    const stroke = boardInk(target()).stroke;
    if (/^#[\da-f]{6}$/i.test(stroke)) return stroke;
    if (/^#[\da-f]{3}$/i.test(stroke)) return '#' + [...stroke.slice(1)].map(n=>n+n).join('');
    return '#d4d4d4';
  }
  const focusCanvas = () => canvas.focus({preventScroll:true});

  function renderSwatch() {
    trigger.style.setProperty('--ink-swatch',candidate || base());
  }
  function update(hex,updateCode=true) {
    square.style.setProperty('--ink-hue',String(hsv.h));
    square.style.setProperty('--ink-s',hsv.s*100+'%');
    square.style.setProperty('--ink-v',(1-hsv.v)*100+'%');
    hue.value = String(Math.round(hsv.h));
    if (updateCode) code.value = hex;
    if (candidate !== hex) { candidate = hex; renderSwatch(); repaint(); }
  }
  function pickHex(hex,updateCode=true) {
    if (!owner) return;
    hsv = toHSV(hex);
    update(hex,updateCode);
  }
  function close() {
    if (!owner) return;
    owner = null; candidate = null;
    if (dragging && dragging.control.hasPointerCapture(dragging.id)) dragging.control.releasePointerCapture(dragging.id);
    dragging = null;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded','false');
    renderSwatch(); repaint();
  }
  function open() {
    owner = target();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded','true');
    pickHex(base());
    square.focus({preventScroll:true});
  }
  function accept(hex,stayOpen=false) {
    if (!owner || owner !== target()) {close();return}
    close();
    commit(hex);
    if (stayOpen) { open(); hue.focus({preventScroll:true}); }
    else focusCanvas();
  }
  function fieldPoint(e) {
    const rect = square.getBoundingClientRect();
    hsv.s = clamp((e.clientX-rect.left)/rect.width);
    hsv.v = clamp(1-(e.clientY-rect.top)/rect.height);
    update(toHex(hsv));
  }
  listen(trigger,'click',()=>owner ? close() : open());
  function bindSurface(control, sample, stayOpen) {
    listen(control,'pointermove',e=>{
      if (owner && (!dragging || dragging.id===e.pointerId && dragging.control===control)) sample(e);
    });
    listen(control,'pointerdown',e=>{
      if (!owner || e.button!==0 || dragging) return;
      e.preventDefault();
      control.focus({preventScroll:true});
      dragging = {control,id:e.pointerId};
      control.setPointerCapture(e.pointerId); sample(e);
    });
    listen(control,'pointerup',e=>{
      if (dragging?.id !== e.pointerId || dragging.control!==control) return;
      sample(e); accept(candidate,stayOpen);
    });
    listen(control,'pointercancel',close);
  }
  bindSurface(square,fieldPoint,false);
  listen(square,'keydown',e=>{
    if (e.key==='Enter' || e.key===' ') { e.preventDefault(); accept(candidate); return; }
    const step=e.shiftKey ? .10 : .01;
    if (e.key==='ArrowLeft') hsv.s = clamp(hsv.s-step);
    else if (e.key==='ArrowRight') hsv.s = clamp(hsv.s+step);
    else if (e.key==='ArrowUp') hsv.v = clamp(hsv.v+step);
    else if (e.key==='ArrowDown') hsv.v = clamp(hsv.v-step);
    else return;
    e.preventDefault(); update(toHex(hsv));
  });
  function pickHue(value) {
    hsv.h = Number(value);
    // A hue chosen from a neutral starting colour should be visible immediately.
    if (hsv.s===0 || hsv.v===0) { hsv.s=.82; hsv.v=.92; }
    update(toHex(hsv));
  }
  bindSurface(hue,e=>{
    const rect = hue.getBoundingClientRect();
    pickHue(Math.round(360*clamp((e.clientX-rect.left)/rect.width)));
  },true);
  listen(hue,'input',()=>pickHue(hue.value));
  listen(hue,'change',()=>accept(toHex(hsv),true));
  function inputHex() {
    const match=/^#?([\da-f]{6})$/i.exec(code.value.trim());
    return match ? '#'+match[1].toLowerCase() : null;
  }
  listen(code,'input',()=>{ const hex=inputHex(); if (hex) pickHex(hex,false); });
  listen(code,'keydown',e=>{
    if (e.key==='Enter') { e.preventDefault(); const hex=inputHex(); if(hex)accept(hex); }
  });
  listen(panel,'keydown',e=>{
    e.stopPropagation();
    if (e.key==='Escape') { e.preventDefault(); close(); trigger.focus({preventScroll:true}); }
  });
  listen(doc,'pointerdown',e=>{
    if (owner && !trigger.contains(e.target) && !panel.contains(e.target)) close();
  },true);
  listen(doc,'focusin',e=>{
    if (owner && !trigger.contains(e.target) && !panel.contains(e.target)) close();
  });
  listen(doc.defaultView,'blur',close);
  function refreshLanguage() {
    const name=tr('Цвет штриха','Stroke color');
    trigger.title = name; trigger.setAttribute('aria-label',name); panel.setAttribute('aria-label',name);
    square.title = tr('Насыщенность и яркость · используйте стрелки', 'Saturation and brightness · use arrow keys');
    square.setAttribute('aria-label',square.title);
    hue.setAttribute('aria-label',tr('Оттенок','Hue'));
    code.setAttribute('aria-label',tr('HEX-код цвета','Hex color'));
    code.title = tr('Введите HEX-код и нажмите Enter','Enter a hex color and press Enter');
  }
  return {close,refreshLanguage,
    sync(disabled) {
      if (owner && (disabled || owner!==target())) close();
      trigger.disabled = disabled; renderSwatch();
    },
    previewFor(item) { return owner && item.id && owner.id===item.id && target()===owner ? candidate : null; }
  };
}
