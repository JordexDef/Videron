export function isLightTheme(){
  return globalThis.document?.documentElement?.dataset?.theme==='light';
}

// Wails draws the title bar and the surface behind the WebView separately.
export function syncWindowTheme(){
  const runtime=window.runtime;
  if(!runtime)return;
  const light=isLightTheme(),channel=light?250:23;
  if(light)runtime.WindowSetLightTheme?.();
  else runtime.WindowSetDarkTheme?.();
  runtime.WindowSetBackgroundColour?.(channel,channel,channel,255);
}

export function setTheme(theme){
  if(theme!=='light' && theme!=='dark')return;
  document.documentElement.dataset.theme=theme;
  try{localStorage.setItem('videron.theme.v1',theme)}catch{}
  syncWindowTheme();
  window.dispatchEvent(new CustomEvent('videron:themechange',{detail:theme}));
}
