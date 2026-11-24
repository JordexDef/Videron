import { isLightTheme } from './theme.js';

export const darkMap = {
  canvas:'#171717', dots:'190,190,190', base:27, ink:'#ededed', inkRGB:'237,237,237',
  hover:'#dedede', caption:'#b2b2b2', icon:'rgba(240,240,240,.92)', badge:'#252525',
  grip:'#8d8d8d', marquee:'235,235,235', warning:'#dfac97', spark:'#d8dce7',
  stageInk:'#ededef', stageFill:'#29282c', stageEdge:'rgba(237,235,245,.92)', stageTip:'#edeaf3',
  route:'#c1b7d6', routeEdge:'#938c9c', routeBadge:'#302d36', routeActive:'#dfd9eb',
  routeInk:'#e6e1eb', routeActiveInk:'#29262d', metric:'#232323', metricEdge:'#505156'
};

export const lightMap = {
  canvas:'#fafafa', dots:'76,78,84', base:251, ink:'#282a30', inkRGB:'40,42,48',
  hover:'#34363c', caption:'#565960', icon:'#35383f', badge:'#fff',
  grip:'#787b83', marquee:'68,71,82', warning:'#933e2b', spark:'#46506d',
  stageInk:'#383844', stageFill:'#fff', stageEdge:'#57516e', stageTip:'#57516e',
  route:'#726087', routeEdge:'#897799', routeBadge:'#f3eef7', routeActive:'#61506f',
  routeInk:'#4f405d', routeActiveInk:'#fff', metric:'#fff', metricEdge:'#b6b6bf'
};

export const mapPalette = () => isLightTheme() ? lightMap : darkMap;

const inkCache = new WeakMap();

// User colours stay in the fill. Cap the luminance of their outline and text
// on paper so even a white or pastel swatch has a readable edge.
export function mapInk(item, palette) {
  if (!item.tint) return palette.inkRGB;
  if (palette !== lightMap) return item.tint;
  const cached = inkCache.get(item);
  if (cached?.tint === item.tint) return cached.ink;
  const [r,g,b] = item.tint.split(',').map(Number);
  const factor = Math.min(1, 88 / Math.max(1, .2126*r + .7152*g + .0722*b));
  const ink = [r,g,b].map(channel => Math.round(channel*factor)).join(',');
  inkCache.set(item,{tint:item.tint,ink});
  return ink;
}
