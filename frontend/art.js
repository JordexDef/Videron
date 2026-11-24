import { isLightTheme } from './theme.js';

const paths = {
  agent:'<path d="M12 3c0 5.8 2.4 8.2 8 9-5.6.8-8 3.2-8 9-.6-5.8-3.2-8.2-8-9 4.8-.8 7.4-3.2 8-9Z"/><path d="M19 2v4m-2-2h4"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 5V4a1 1 0 0 0-1-1H5a2 2 0 0 0-2 2v10a1 1 0 0 0 1 1h1"/>',
  newData:'<path d="M8 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7l-4-4H8Zm7 0v5h5M9 11l-3 3 3 3m5-6 3 3-3 3"/>',
  zoomIn:'<circle cx="10" cy="10" r="6.5"/><path d="M15 15l5 5M7 10h6m-3-3v6"/>',
  route:'<circle cx="5" cy="16" r="2.3"/><circle cx="19" cy="7" r="2.3"/><path d="M7.4 16h5.3a2.3 2.3 0 0 0 0-4.6H10a2.2 2.2 0 0 1 0-4.4h6.5"/>',
  track:'<path d="M3 5h5m2 0h5m2 0h4M5.5 10v8m7-8v4m7-4v6" /><circle cx="5.5" cy="18" r="1.5"/><circle cx="12.5" cy="14" r="1.5"/><circle cx="19.5" cy="16" r="1.5"/>',
  metric:'<path d="M3 18h18M4 14l5-6 4 3 7-7"/><circle cx="9" cy="8" r="1.3"/>',
  slots:'<g fill="currentColor" stroke="none"><circle cx="5" cy="5" r="1.7"/><circle cx="12" cy="5" r="1.7"/><circle cx="19" cy="5" r="1.7"/><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/><circle cx="5" cy="19" r="1.7"/><circle cx="12" cy="19" r="1.7"/><circle cx="19" cy="19" r="1.7"/></g>',
  newTextNote:'<path d="M13 2.8H6A1.8 1.8 0 0 0 4.2 4.6v14.8A1.8 1.8 0 0 0 6 21.2h12a1.8 1.8 0 0 0 1.8-1.8V9.6z"/><path d="M13 3v6.5h6.5M8 13h8m-8 3.5h5"/>',
  newCanvas:'<path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5V8m13-5h3.5A1.5 1.5 0 0 1 21 4.5V8M3 16v3.5A1.5 1.5 0 0 0 4.5 21H8m8 0h3.5a1.5 1.5 0 0 0 1.5-1.5V16"/><circle cx="9" cy="9" r="2.5"/><path d="m11.5 15 3.2-4 3.2 4z"/>',
  lock:'<rect x="4.5" y="10" width="15" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  panelClose:'<rect x="2.5" y="4" width="19" height="16" rx="2.2"/><path d="M8.5 4v16m7-11-3 3 3 3"/>',
  panelOpen:'<rect x="2.5" y="4" width="19" height="16" rx="2.2"/><path d="M8.5 4v16m4-11 3 3-3 3"/>',
  chevronDown:'<path d="m6 9 6 6 6-6"/>',
  board:'<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><circle cx="9" cy="9.5" r="2"/><path d="m8 16 3.5-3 2.5 1.5 3-4"/>',
  appearance:'<path d="M12 3a9 9 0 1 0 0 18h1.2a2.1 2.1 0 0 0 1.3-3.7c-.6-.6-.2-1.6.7-1.6H17a4.3 4.3 0 0 0 4.3-4.3C21.3 6.7 17 3 12 3Z"/><circle cx="7.5" cy="11.5" r=".75"/><circle cx="10" cy="7.8" r=".75"/><circle cx="14.5" cy="7.6" r=".75"/><circle cx="17.6" cy="10.7" r=".75"/>',
  globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  layers:'<path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  chevrons:'<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',
  map:'<circle cx="6" cy="15" r="3"/><circle cx="16" cy="6" r="2.5"/><circle cx="18" cy="17" r="3.5"/><path d="m8.3 13 5.7-5.3m-5 8 5.6.8m2-8 .8 5"/>',
  list:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 8h7m-7 4h7m-7 4H13"/>',
  pin:'<path d="m15 3 6 6-3 .8-4.4 4.4-.6 3.3-6.5-6.5 3.3-.6L14.2 6zM8.7 15.3 4 20"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',
  extensions:'<path d="M14 4H9v4a2.7 2.7 0 1 0-4 4H3v7h6v-2a2.6 2.6 0 1 1 5 0v2h5v-5h1a2.6 2.6 0 0 0 0-5h-1V4z"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.7 9.2a2.5 2.5 0 1 1 4 2.1c-1.2.7-1.7 1.3-1.7 2.8m0 2.4h.01"/>',
  panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  chevron:'<path d="m9 6 6 6-6 6"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  folder:'<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zM3 9h18"/>',
  sliders:'<path d="M4 7h4m4 0h8M4 17h9m4 0h3"/><circle cx="10" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
  arrowUpRight:'<path d="M6 18 18 6M7 6h11v11"/>',
  pointer:'<path d="M5 3.5 19 13l-7 .6-3.3 6.6z"/>',
  hand:'<path d="M7.5 13V7.5a1.5 1.5 0 0 1 3 0v3.7-6.5a1.5 1.5 0 0 1 3 0V11 5.7a1.5 1.5 0 0 1 3 0v6-3.2a1.5 1.5 0 0 1 3 0v6.3c0 4.3-2.9 6.2-6.2 6.2-2.8 0-4.2-1.1-6-3.3L4.5 14c-1.3-1.9.8-3.5 2.2-1.9l1.9 2.3"/>',
  link:'<path d="m10 13.5 4-4m-6 3-1.5 1.6a3.4 3.4 0 0 0 4.8 4.8l3.2-3.2a3.4 3.4 0 0 0 0-4.8m1.5.6 1.5-1.6a3.4 3.4 0 1 0-4.8-4.8L9.5 8.3a3.4 3.4 0 0 0 0 4.8"/>',
  fit:'<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',x:'<path d="m6 6 12 12M18 6 6 18"/>',
  check:'<path d="m4 12 5 5L20 6"/>', more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  circle:'<circle cx="12" cy="12" r="8"/>', edit:'<path d="m4 20 1-5L16 4l4 4L9 19zM14 6l4 4"/>',
  trash:'<path d="M3 6h18M9 6V4h6v2M6 6l1 14h10l1-14M10 10v6m4-6v6"/>',
  tag:'<path d="M3 4h8l10 10-7 7L3 10z"/><circle cx="7" cy="7.5" r=".8"/>',
  grid:'<path d="M8 3v18m8-18v18M3 8h18M3 16h18"/>', text:'<path d="M4 6h16M12 6v14M8 20h8"/>',
  space:'<circle cx="12" cy="12" r="7.5"/><ellipse cx="12" cy="12" rx="11" ry="3.3" transform="rotate(-32 12 12)"/>',
  back:'<path d="M20 12H4m7-7-7 7 7 7"/>', keyboard:'<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h1m3 0h1m3 0h1m3 0h.1m-12 5h1m3 0h6"/>'
};
export function icon(name) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" class="ico">'+(paths[name]||paths.circle)+'</svg>';
}
export function paintIcons(root=document){
  root.querySelectorAll('[data-i]').forEach(el=>el.innerHTML=icon(el.dataset.i));
}

// A miniature atlas illustrates note size, affinity and glow before the first node exists.
export function drawAtlas(canvas){
  const light=isLightTheme();
  const ctx=canvas.getContext('2d');
  ctx.setTransform(2,0,0,2,0,0);
  ctx.clearRect(0,0,430,195);
  function ring(x,y,r,stroke,fill=null){
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);
    if(fill){ctx.fillStyle=fill;ctx.fill()}
    ctx.strokeStyle=stroke;ctx.stroke();
  }
  function cross(x,y,r,color){
    ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(x-r,y);ctx.lineTo(x+r,y);ctx.moveTo(x,y-r);ctx.lineTo(x,y+r);ctx.stroke();
  }
  function line(points,color){
    ctx.beginPath();ctx.moveTo(points[0],points[1]);ctx.bezierCurveTo(...points.slice(2));ctx.strokeStyle=color;ctx.stroke();
  }
  ctx.lineWidth=.7;
  ctx.save();ctx.translate(211,102);ctx.rotate(-.25);ctx.setLineDash([2,5]);
  ctx.beginPath();ctx.ellipse(0,0,162,60,0,0,Math.PI*2);ctx.strokeStyle='#66666688';ctx.stroke();ctx.restore();
  line([46,144,96,160,124,101,180,104],'#69696970');
  line([173,102,218,119,254,55,332,66],'#8080809c');
  line([142,78,206,51,237,124,281,132],'#6f6f6f5e');
  line([86,57,107,64,118,107,162,108],'#6969696f');
  let seed=37;
  function rnd(){seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296}
  function cluster(x,y,limit,big,count,rgb){
    let nodes=[{x:0,y:0,r:big}];
    for(let i=0;i<count;i++){
      const r=2+rnd()*5.7;
      for(let j=0;j<65;j++){
        const parent=nodes[Math.floor(rnd()*nodes.length)],a=rnd()*Math.PI*2;
        const nx=parent.x+Math.cos(a)*(parent.r+r+1.8),ny=parent.y+Math.sin(a)*(parent.r+r+1.8);
        if(Math.hypot(nx,ny)+r>limit-3||nodes.some(n=>Math.hypot(n.x-nx,n.y-ny)<n.r+r+.7))continue;
        nodes.push({x:nx,y:ny,r});break;
      }
    }
    ring(x,y,limit,'rgba('+rgb+',.37)','rgba('+rgb+',.018)');
    for(const [i,n] of nodes.entries()){
      let intensity=i%5===0?.85:.45;
      ring(x+n.x,y+n.y,n.r,'rgba('+rgb+','+intensity+')','rgba('+rgb+','+(i%8===0?.12:.028)+')');
    }
  }
  let halo=ctx.createRadialGradient(177,100,0,177,100,87);halo.addColorStop(0,light?'#6f72801c':'#c0c0c030');halo.addColorStop(1,light?'#6f728000':'#c0c0c000');
  ctx.fillStyle=halo;ctx.fillRect(85,12,185,180);
  cluster(176,99,55,12,59,light?'75,77,82':'220,220,220');
  cluster(291,65,28,6.1,14,light?'87,89,95':'174,174,174');
  cluster(282,137,22,4.8,12,light?'93,95,100':'166,166,166');
  cluster(82,62,13,3.1,4,light?'99,101,106':'160,160,160');
  const loose=[[48,138,5],[59,132,3],[70,141,6],[88,122,3],[103,119,5],[251,79,3],[331,65,6],[345,61,3],[363,75,4],[229,148,3],[115,49,2],[233,43,2]];
  loose.forEach(([x,y,r])=>ring(x,y,r,'#979797a0','#87878710'));
  ctx.lineWidth=.75;
  [[44,72],[116,147],[238,27],[327,113],[383,49],[214,173]].forEach(([x,y])=>cross(x,y,3,'#7f7f7f9c'));
  ctx.fillStyle=light?'#44464c':'#d7d7d7';ctx.fillRect(173.8,96.8,4.4,4.4);
}
