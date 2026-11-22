import { gridRowSpacing, gridSpacing, MIN_GRID_SPACING, MAX_GRID_SPACING, setGridSpacing, slotPoint, validSlot } from './area-grid.js';
import { tr } from './i18n.js';

export function slotGridBounds(grid) {
  const pitchX = gridSpacing(grid), pitchY = gridRowSpacing(grid);
  const left = grid.x - pitchX/2, top = grid.y - pitchY/2;
  return {left, top, right:left + grid.cols*pitchX, bottom:top + grid.rows*pitchY};
}

export function slotAt(grid, point) {
  const col = Math.floor((point.x-grid.x)/gridSpacing(grid) + .5), row = Math.floor((point.y-grid.y)/gridRowSpacing(grid) + .5);
  return col >= 0 && row >= 0 && col < grid.cols && row < grid.rows ? row * grid.cols + col : null;
}

export function draggedGridSpacing(grid, dx, dy) {
  // The opposite corner includes half a cell of padding along each axis.
  const limit = n => Math.max(MIN_GRID_SPACING,Math.min(MAX_GRID_SPACING,Math.round(n)));
  return {spacing:limit(gridSpacing(grid)+dx/(grid.cols-.5)),rowSpacing:limit(gridRowSpacing(grid)+dy/(grid.rows-.5))};
}

export function drawGridGrip(ctx, grid, {ox,oy,zoom,width,height}, active) {
  const {right,bottom} = slotGridBounds(grid), x=ox+right*zoom, y=oy+bottom*zoom;
  if (x < -10 || y < -10 || x > width+10 || y > height+10) return;
  ctx.save();
  ctx.beginPath();ctx.arc(x,y,9,0,Math.PI*2);
  ctx.fillStyle='#252525';ctx.fill();
  ctx.strokeStyle=active?'#ededed':'#8d8d8d';ctx.lineWidth=1;ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x-3.5,y-3.5);ctx.lineTo(x+3.5,y+3.5);
  ctx.moveTo(x,y+3.5);ctx.lineTo(x+3.5,y+3.5);ctx.lineTo(x+3.5,y);
  ctx.strokeStyle='#dedede';ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();
  ctx.restore();
}

// The first cell starts at the requested point. Slide the entire range just
// far enough to clear any occupied horizontal intervals at this height.
export function suggestGrid(rows, cols, point, space, spacing) {
  const grid = {rows, cols, x:point.x, y:point.y};
  if (spacing!==undefined) setGridSpacing(grid,spacing);
  const box = slotGridBounds(grid), width = box.right - box.left, clearance = 28;
  const intervals = [];
  function avoid(left,top,right,bottom) {
    if (top < box.bottom + clearance && bottom > box.top - clearance && right + clearance > box.left)
      intervals.push({left:left-clearance, right:right+clearance});
  }
  const gridIds = new Set();
  const occupiedAreas = new Set(space.notes.map(note=>note.areaId));
  for (const area of space.areas) if (area.parentId) occupiedAreas.add(area.parentId);
  for (const area of space.areas) {
    if (area.grid) {
      gridIds.add(area.id);
      const bounds = slotGridBounds(area.grid);
      avoid(bounds.left, bounds.top, bounds.right, bounds.bottom);
    } else if (!occupiedAreas.has(area.id) && Number.isFinite(area.anchor?.x) && Number.isFinite(area.anchor?.y)) {
      const {x,y} = area.anchor, radius = 42; // empty contour drop target
      avoid(x-radius, y-radius, x+radius, y+radius);
    }
  }
  // An occupied seat already lies inside its grid's interval.
  for (const note of space.notes) {
    if (gridIds.has(note.areaId) || !Number.isFinite(note.x) || !Number.isFinite(note.y)) continue;
    const radius = 78; // maximum note radius on the map
    avoid(note.x-radius, note.y-radius, note.x+radius, note.y+radius);
  }
  let left = box.left;
  for (const interval of intervals.sort((a,b)=>a.left-b.left)) {
    if (interval.left >= left + width) break;
    left = Math.max(left, interval.right);
  }
  grid.x += left - box.left;
  return grid;
}

export function gridFocusCamera(grid, width, height, index) {
  if (validSlot(grid,index))
    return {...slotPoint(grid,index), zoom:1};
  const box = slotGridBounds(grid);
  const usableWidth = Math.max(1,width*.78), usableHeight = Math.max(1,height*.72);
  const zoom = Math.max(.65, Math.min(1.12, usableWidth/(box.right-box.left), usableHeight/(box.bottom-box.top)));
  // Wide or tall grids open at their beginning with individual seats and note
  // labels still legible. Smaller grids fit in the view at this same scale.
  return {
    x:box.left + Math.min(box.right-box.left,usableWidth/zoom)/2,
    y:box.top + Math.min(box.bottom-box.top,usableHeight/zoom)/2,
    zoom
  };
}

export function stageHandleBounds(header, col) {
  return header?.handles?.get(col) || null;
}

export function stageHandleAt(header, point) {
  if (!header) return null;
  const col = Math.floor((point.x - header.l) / header.pitch);
  const bounds = stageHandleBounds(header,col);
  return bounds && point.x >= bounds.l && point.x <= bounds.r && point.y >= bounds.t && point.y <= bounds.b ? col : null;
}

// A title reveals its grip. Once revealed, the narrow gap between the two
// targets is part of the same hover region, including on a compact track.
export function stageTitleAt(header, point, revealed = null) {
  if (!header) return null;
  const col = Math.floor((point.x-header.l)/header.pitch);
  const title = header.titles.get(col), grip = stageHandleBounds(header,col);
  if (!title || !grip) return null;
  const rect = revealed===col ? {
    l:Math.min(title.l,grip.l), r:Math.max(title.r,grip.r),
    t:Math.min(title.t,grip.t), b:Math.max(title.b,grip.b)
  } : title;
  return point.x>=rect.l && point.x<=rect.r && point.y>=rect.t && point.y<=rect.b ? col : null;
}

function fitStageName(ctx, name, width) {
  const naturalWidth = ctx.measureText(name).width;
  if (naturalWidth <= width) return {text:name, width:naturalWidth};
  const letters = Array.from(name);
  let low = 0, high = letters.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(letters.slice(0,mid).join('')+'…').width <= width) low=mid;
    else high=mid-1;
  }
  const text = letters.slice(0,low).join('')+'…';
  return {text,width:ctx.measureText(text).width};
}

const stageCaptions = new WeakMap();

function drawStageHandle(ctx, bounds, emphasized, tint) {
  const x=(bounds.l+bounds.r)/2,y=(bounds.t+bounds.b)/2;
  ctx.beginPath();
  for(const dx of [-2,2]) for(const dy of [-4,0,4]){
    ctx.moveTo(x+dx+1.1,y+dy);ctx.arc(x+dx,y+dy,1.1,0,Math.PI*2);
  }
  ctx.fillStyle=emphasized?'#eeeeef':'rgba('+tint+',.6)';
  ctx.fill();
}

function drawStageInsertion(ctx, header, reorder, bottom, view, tint) {
  const {from,to,pointerX}=reorder;
  const name=header.grid.grid.stages[from];
  if (name === undefined) return;
  if (Number.isInteger(to) && to !== from) {
    const edge=reorder.boundary ?? (to>from ? to+1 : to);
    const x=header.l+header.pitch*edge,top=Math.max(2,header.t-2),end=Math.min(bottom,view.height-1);
    ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,end);
    ctx.strokeStyle='rgba(237,235,245,.92)';ctx.lineWidth=1.75;ctx.stroke();
    ctx.beginPath();ctx.moveTo(x-3.5,top);ctx.lineTo(x+3.5,top);ctx.lineTo(x,top+4.5);
    ctx.fillStyle='#edeaf3';ctx.fill();
  }
  if (!Number.isFinite(pointerX) || view.width < 44 || view.height < 60) return;
  const label=fitStageName(ctx,name,Math.min(168,view.width-34)),w=Math.ceil(label.width)+20,h=24;
  const x=Math.max(4,Math.min(view.width-w-4,pointerX-w/2));
  const y=header.t>=h+24 ? header.t-h-20 : Math.min(view.height-h-4,Math.max(4,header.b+5));
  ctx.beginPath();ctx.roundRect(x,y,w,h,6);
  ctx.fillStyle='#29282c';ctx.fill();
  ctx.strokeStyle='rgba('+tint+',.7)';ctx.lineWidth=1;ctx.stroke();
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#ededef';
  ctx.fillText(label.text,x+w/2,y+h/2);
}

export function drawSlotGrid(ctx, group, view, {selected=false, active=false, slots=[], blocked=false, swapping=false, hoverSlot=null, hoverStage=null, hoverHandle=null, reorder=null} = {}) {
  const {grid,tint,name} = group, {ox,oy,zoom,width,height} = view;
  const firstX = ox + grid.x * zoom, firstY = oy + grid.y * zoom;
  const pitchX = gridSpacing(grid)*zoom, pitchY = gridRowSpacing(grid)*zoom;
  const halfX = pitchX/2, halfY = pitchY/2, markerPitch = Math.min(pitchX,pitchY);
  const lastX = firstX + (grid.cols-1)*pitchX, lastY = firstY + (grid.rows-1)*pitchY;
  const compact = pitchX < 40;
  const showStages = grid.stages && (!compact || (zoom >= .65 && pitchX >= 24));
  const headerY = firstY - Math.min(halfY,78*zoom) - 7;
  const headerTop = headerY - (compact && grid.cols>1 ? 32 : 17);
  const top = showStages ? Math.min(firstY-halfY,headerTop) : firstY-halfY;
  if (lastX+halfX < 0 || firstX-halfX > width || lastY+halfY < 0 || top > height) return null;

  const radius = Math.max(2,Math.min(5,markerPitch*.045));
  const visibleLeft = Math.max(0,Math.ceil((-radius-firstX)/pitchX));
  const visibleTop = Math.max(0,Math.ceil((-radius-firstY)/pitchY));
  const visibleRight = Math.min(grid.cols-1,Math.floor((width+radius-firstX)/pitchX));
  const visibleBottom = Math.min(grid.rows-1,Math.floor((height+radius-firstY)/pitchY));
  // Keep the same seats as landmarks across overview levels instead of
  // switching from every third cell to every fourth when the zoom changes.
  const strideX = 2**Math.max(0,Math.ceil(Math.log2(13/pitchX)));
  const strideY = 2**Math.max(0,Math.ceil(Math.log2(13/pitchY)));
  const stepX = Math.ceil(visibleLeft/strideX)*strideX, stepY = Math.ceil(visibleTop/strideY)*strideY;
  const muted = 'rgba('+tint+','+(active ? '.76' : '.47')+')';
  ctx.save();
  if (selected) {
    ctx.beginPath();
    ctx.rect(firstX-halfX,top,grid.cols*pitchX,lastY+halfY-top);
    ctx.fillStyle='rgba('+tint+',.045)';ctx.fill();
    ctx.strokeStyle='rgba('+tint+',.75)';ctx.lineWidth=1.5;ctx.stroke();
  }
  let stageHeader;
  if (showStages) {
    const y = headerY;
    stageHeader={grid:group,l:firstX-halfX,r:lastX+halfX,t:headerTop,b:y+7,pitch:pitchX,handles:new Map(),titles:new Map()};
    ctx.font='500 12px "Segoe UI", sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom';
    const colFirst=Math.max(0,Math.floor((-halfX-firstX)/pitchX)),colLast=Math.min(grid.cols-1,Math.ceil((width+halfX-firstX)/pitchX));
    const gripWidth=grid.cols>1 ? Math.min(24,Math.floor(pitchX*.43)) : 0;
    const room=!compact && gripWidth ? gripWidth+2 : 0;
    const availableWidth=pitchX-6-room;
    const headerVisible=stageHeader.b>=0 && headerTop<=height;
    let captions=stageCaptions.get(group);
    if (headerVisible && (captions?.ctx!==ctx || captions.availableWidth!==availableWidth)) {
      captions={ctx,availableWidth,columns:[]};
      stageCaptions.set(group,captions);
    }
    for(let col=colFirst;col<=colLast;col++){
      const x=firstX+col*pitchX;
      const pointed=active && Number.isInteger(hoverSlot) && hoverSlot%grid.cols===col;
      const source=reorder?.from===col;
      if(pointed || source){
        ctx.fillStyle='rgba('+tint+','+(source?'.085':'.055')+')';
        ctx.fillRect(x-halfX+2,y+4,pitchX-4,lastY+halfY-y-4);
      }
      if (!headerVisible) continue;
      const name=grid.stages[col];
      let label=captions.columns[col];
      if (!label || label.name!==name) {
        label={name,...fitStageName(ctx,name,availableWidth)};
        captions.columns[col]=label;
      }
      const left=Math.max(x-halfX+3+room,x-label.width/2);
      if(gripWidth){
        // On a tight track, place the grip above the name to leave room for text.
        const bounds=compact
          ? {l:x-halfX+2,r:x+halfX-2,t:headerTop,b:y-15}
          : {l:left-room,r:left-2,t:stageHeader.t,b:stageHeader.b};
        stageHeader.handles.set(col,bounds);
        stageHeader.titles.set(col,{l:left-1,r:left+label.width+1,t:y-15,b:y+1});
        if(source || hoverStage===col)drawStageHandle(ctx,bounds,source || hoverHandle===col,tint);
      }
      ctx.fillStyle=pointed || source ? '#ededed':'rgba('+tint+',.88)';
      ctx.fillText(label.text,left,y);
      ctx.strokeStyle='rgba('+tint+',.32)';ctx.lineWidth=1;ctx.beginPath();
      ctx.moveTo(x-halfX+5,y+4);ctx.lineTo(x+halfX-5,y+4);ctx.stroke();
    }
  }
  ctx.beginPath();
  for (let row=stepY;row<=visibleBottom;row+=strideY) {
    for (let col=stepX;col<=visibleRight;col+=strideX) {
      const x = firstX + col*pitchX, y = firstY + row*pitchY;
      if (markerPitch < 38) {
        ctx.rect(x-1,y-1,2,2);
      } else {
        // A small hollow seat with a central point stays distinct from the
        // graph's single-pixel background dots, even when their grids align.
        ctx.moveTo(x+radius,y);ctx.arc(x,y,radius,0,Math.PI*2);
        ctx.moveTo(x-.7,y);ctx.lineTo(x+.7,y);
      }
    }
  }
  if (markerPitch < 38) {ctx.fillStyle=muted;ctx.fill();}
  else {ctx.strokeStyle=muted;ctx.lineWidth=1;ctx.stroke();}

  const pointed = validSlot(grid,hoverSlot);
  let destination = null;
  if (active || pointed) {
    const preview = slots instanceof Map ? slots.values() : slots || [];
    ctx.beginPath();
    const ring = Math.max(4,Math.min(18,markerPitch*.18));
    for (const index of preview) {
      destination ??= index;
      const x = firstX + index%grid.cols*pitchX, y = firstY + Math.floor(index/grid.cols)*pitchY;
      if (x < -ring || x > width+ring || y < -ring || y > height+ring) continue;
      ctx.moveTo(x+ring,y);ctx.arc(x,y,ring,0,Math.PI*2);
    }
    ctx.fillStyle='rgba('+tint+',.16)';ctx.fill();
    ctx.strokeStyle='rgba('+tint+',.96)';ctx.lineWidth=1.6;ctx.stroke();
    if (pointed) {
      const x = firstX + hoverSlot%grid.cols*pitchX, y = firstY + Math.floor(hoverSlot/grid.cols)*pitchY;
      const r = active ? ring+3 : radius+3;
      ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);
      ctx.strokeStyle = blocked ? '#dfac97' : '#e6e6e6';ctx.lineWidth=1.35;ctx.stroke();
    }
  }
  if (reorder && stageHeader) drawStageInsertion(ctx,stageHeader,reorder,lastY+halfY,view,tint);
  ctx.restore();
  const left = firstX-halfX, right = lastX+halfX;
  const label = {
    text:name, group:true, rank:selected ? 4 : 2, tint:selected ? '#ededed' : 'rgba('+tint+',.9)',
    x:(Math.max(left,0)+Math.min(right,width))/2, y:showStages ? headerTop-10 : headerY-5
  };
  if(stageHeader && stageHeader.b>=0 && stageHeader.t<=height)label.stageHeader=stageHeader;
  if (!pointed) return label;
  label.titleLabel = {...label};
  // An occupied seat may advance the assignment to a free one. Name the
  // actual destination while keeping its hint close to the user's pointer.
  const addressed = destination ?? hoverSlot;
  const row = Math.floor(addressed/grid.cols)+1, col = addressed%grid.cols+1;
  const address = grid.stages?.[col-1] ?? tr('Ряд '+row+' · место '+col,'Row '+row+' · seat '+col);
  label.text = blocked ? (grid.stages?tr('На этапе недостаточно мест','Not enough seats in this stage'):tr('Недостаточно мест','Not enough seats'))
    : swapping ? tr('Обмен местами','Swap seats')+' · '+address : address+' · '+name;
  label.x = Math.max(52,Math.min(width-52, firstX+(hoverSlot%grid.cols)*pitchX));
  label.y = Math.max(12,Math.min(height-12, firstY+Math.floor(hoverSlot/grid.cols)*pitchY + (active ? 32 : 17)));
  label.rank = active ? 6 : 3;
  label.tint = blocked ? '#dfac97' : '#ededed';
  return label;
}
