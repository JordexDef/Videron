const keyPrefix='videron.map-camera.v1.';

function validCamera(camera){
  return camera && Number.isFinite(camera.x) && Math.abs(camera.x)<=Number.MAX_SAFE_INTEGER &&
    Number.isFinite(camera.y) && Math.abs(camera.y)<=Number.MAX_SAFE_INTEGER &&
    Number.isFinite(camera.zoom) && camera.zoom>=.005 && camera.zoom<=5;
}

// Navigation belongs to this device. Panning must not make a space dirty or start a sync.
export function createMapCameraMemory(){
  let space='',last=null,timer=null;

  function flush(){
    if(timer===null)return;
    clearTimeout(timer);timer=null;
    try{localStorage.setItem(keyPrefix+space,JSON.stringify(last))}catch{}
  }
  function open(id){
    flush();
    space=id;last=null;
    if(space)try{
      const stored=JSON.parse(localStorage.getItem(keyPrefix+space));
      if(validCamera(stored))last={x:stored.x,y:stored.y,zoom:stored.zoom};
    }catch{}
    return last;
  }
  function remember(camera){
    if(!space || !camera || (last && camera.x===last.x && camera.y===last.y && camera.zoom===last.zoom) || !validCamera(camera))return;
    last={x:camera.x,y:camera.y,zoom:camera.zoom};
    clearTimeout(timer);
    timer=setTimeout(flush,400);
  }
  function forget(id){
    if(!id)return;
    if(space===id){clearTimeout(timer);timer=null;last=null;space=''}
    try{localStorage.removeItem(keyPrefix+id)}catch{}
  }
  return {open,remember,flush,forget};
}
