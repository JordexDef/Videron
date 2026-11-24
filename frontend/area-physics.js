import { contourGap, contourSupport, measureContour } from './map-contours.js';
import { slotGridBounds } from './map-slots.js';

const anchored = note => note.pinned || note.inMapGroup;

// Compare siblings in their parent's space. A child travels with its branch.
export function areaContactFamilies(groups) {
  const siblings = new Map();
  for (let i=groups.length-1;i>=0;i--) {
    const group=groups[i], key=group.parentId || null;
    if (!siblings.has(key)) siblings.set(key,[]);
    siblings.get(key).push(group);
    let x=0,y=0,count=0;
    group.pins=[];
    if (group.grid) {
      const box=slotGridBounds(group.grid);
      x=(box.left+box.right)/2;y=(box.top+box.bottom)/2;count=1;
    } else {
      for (const note of group.nodes) if (anchored(note)) {
        group.pins.push(note);x+=note.x;y+=note.y;count++;
      }
      for (const child of group.children) if (child.fixedCentre) {
        const c=child.fixedCentre;x+=c.x*c.count;y+=c.y*c.count;count+=c.count;
      }
    }
    group.fixedCentre=count ? {x:x/count,y:y/count,count} : null;
    group.mobile=!group.grid && (!group.nodes.length && !group.children.length ||
      group.nodes.some(n=>!anchored(n)) || group.children.some(g=>g.mobile));
  }
  return [...siblings.values()].filter(family=>family.length>1);
}

export function measureAreaHulls(groups) {
  for (let i=groups.length-1;i>=0;i--) {
    const group=groups[i];
    if (group.grid) {
      const b=group.gridBounds=slotGridBounds(group.grid);
      group.hull={x:(b.left+b.right)/2,y:(b.top+b.bottom)/2,r:Math.hypot(b.right-b.left,b.bottom-b.top)/2};
    } else group.hull=measureContour(group);
  }
}

function frontOfBox(box,nx,ny) {
  return (nx>=0?box.right:box.left)*nx+(ny>=0?box.bottom:box.top)*ny;
}

// Take up the soft rim first. A long thin child grid can leave a very large
// empty crescent in the enclosing circle; let it compress around its contents.
function contactRadius(hull,nx,ny) {
  const core=contourSupport(hull,nx,ny);
  return Math.max(core,Math.min(hull.r-9,core+34));
}

// A pinned note or a fixed grid establishes the furthest point beyond which
// its side cannot yield. Include room for the enclosing nested contours.
function fixedFront(group,nx,ny) {
  if (!group.fixedCentre) return -Infinity;
  if (group.grid) return frontOfBox(group.gridBounds,nx,ny);
  let front=-Infinity;
  for (const note of group.nodes) if (anchored(note))
    front=Math.max(front,note.x*nx+note.y*ny+note.r+10);
  for (const child of group.children) front=Math.max(front,fixedFront(child,nx,ny)+27);
  return front;
}

// A freely moving branch slides as one body. If anchored, press only objects
// near the facing edge, leaving the far side in place instead of stretching it.
function press(group,nx,ny,plane,depth,rigid=!group.fixedCentre) {
  if (!group.mobile || depth<=.025) return 0;
  let emptyMovement=0;
  function move(point,r) {
    const amount=rigid ? depth : Math.min(depth,Math.max(0,point.x*nx+point.y*ny+r+15-plane));
    if (!amount) return 0;
    point.x-=nx*amount;point.y-=ny*amount;
    // A note initially stranded on the wrong side of its own pin can otherwise
    // get wedged: border pressure and note contact repeatedly undo each other.
    // Slide around the fixed disc as the neighbouring contour presses inward.
    if (amount>2) for (const pin of group.pins) {
      const dx=point.x-pin.x,dy=point.y-pin.y,along=dx*nx+dy*ny,side=dy*nx-dx*ny;
      const radius=r+pin.r+8;
      if (along<=0 || dx*dx+dy*dy>=(radius-4)**2) continue;
      const turn=Math.min(.48,amount/radius);
      const angle=Math.atan2(Math.abs(side),along)+turn;
      const lateral=Math.sin(angle)*radius*(Math.sign(side) || 1);
      const forward=Math.cos(angle)*radius;
      point.x=pin.x+nx*forward-ny*lateral;
      point.y=pin.y+ny*forward+nx*lateral;
    }
    return amount;
  }
  for (const note of group.nodes) if (!anchored(note)) move(note,note.r);
  if (!group.nodes.length && !group.children.length) emptyMovement=move(group.emptyAnchor,22);
  for (const child of group.children)
    emptyMovement=Math.max(emptyMovement,press(child,nx,ny,plane-27,depth,rigid));
  return emptyMovement;
}

function circleContact(a,b) {
  const dx=b.hull.x-a.hull.x,dy=b.hull.y-a.hull.y,d=Math.hypot(dx,dy);
  if (d>=a.hull.r+b.hull.r+contourGap) return 0;
  let nx=dx/Math.max(d,.001),ny=dy/Math.max(d,.001);
  if (a.fixedCentre && b.fixedCentre) {
    const ax=b.fixedCentre.x-a.fixedCentre.x,ay=b.fixedCentre.y-a.fixedCentre.y,l=Math.hypot(ax,ay);
    if (l>.001) { nx=ax/l;ny=ay/l; }
  }
  if (Math.abs(nx)+Math.abs(ny)<.001) nx=1;
  const halfGap=contourGap/2;
  const tipA=a.hull.x*nx+a.hull.y*ny+contactRadius(a.hull,nx,ny);
  const tipB=b.hull.x*nx+b.hull.y*ny-contactRadius(b.hull,-nx,-ny);
  if (tipA+contourGap<=tipB) return 0;
  const minPlane=(a.mobile ? fixedFront(a,nx,ny) : tipA)+halfGap;
  const maxPlane=(b.mobile ? -fixedFront(b,-nx,-ny) : tipB)-halfGap;
  const middle=(tipA+tipB)/2;
  const plane=minPlane<=maxPlane ? Math.max(minPlane,Math.min(maxPlane,middle)) : (minPlane+maxPlane)/2;
  const pushA=Math.min(a.fixedCentre ? 48 : 16,Math.max(0,tipA+halfGap-plane)*(a.fixedCentre ? .95 : .58));
  const pushB=Math.min(b.fixedCentre ? 48 : 16,Math.max(0,plane+halfGap-tipB)*(b.fixedCentre ? .95 : .58));
  return Math.max(press(a,nx,ny,plane-halfGap,pushA),press(b,-nx,-ny,-plane-halfGap,pushB));
}

function gridContact(group,box) {
  const h=group.hull;
  const x=Math.max(box.left,Math.min(h.x,box.right)),y=Math.max(box.top,Math.min(h.y,box.bottom));
  let nx=x-h.x,ny=y-h.y;
  const distance=Math.hypot(nx,ny);
  if (distance>0) { nx/=distance;ny/=distance; }
  else {
    const distances=[h.x-box.left,box.right-h.x,h.y-box.top,box.bottom-h.y];
    const side=distances.indexOf(Math.min(...distances));
    nx=side===0?1:side===1?-1:0;ny=side===2?1:side===3?-1:0;
  }
  const plane=-frontOfBox(box,-nx,-ny)-contourGap;
  const depth=h.x*nx+h.y*ny+contactRadius(h,nx,ny)-plane;
  return press(group,nx,ny,plane,Math.min(20,depth*.58));
}

export function separateAreaSiblings(groups,families) {
  if (!families?.length) return 0;
  measureAreaHulls(groups);
  let movement=0;
  // Sweep candidate bounding boxes instead of comparing every area pair.
  for (const family of families) {
    const bounds=family.map(g=>{
      const h=g.hull;
      return {g,box:g.gridBounds || {left:h.x-h.r,right:h.x+h.r,top:h.y-h.r,bottom:h.y+h.r}};
    }).sort((a,b)=>a.box.left-b.box.left);
    for (let i=0;i<bounds.length;i++) {
      const a=bounds[i];
      for (let j=i+1;j<bounds.length && bounds[j].box.left<a.box.right+contourGap;j++) {
        const b=bounds[j];
        if ((!a.g.mobile && !b.g.mobile) || a.box.top>b.box.bottom+contourGap || b.box.top>a.box.bottom+contourGap) continue;
        const amount=a.g.grid ? gridContact(b.g,a.box) : b.g.grid ? gridContact(a.g,b.box) : circleContact(a.g,b.g);
        movement=Math.max(movement,amount);
      }
    }
  }
  return movement;
}
