import test from 'node:test';
import assert from 'node:assert/strict';
import { measureMapText, newMapText, paintMapText } from '../frontend/map-ink-text.js';
import { mapInkBounds } from '../frontend/map-ink.js';

test('map labels keep explicit blank lines and measure the widest line at the stored font size', () => {
  const ink = newMapText({x:-15,y:20}, {stroke:'#d4d4d4',glow:true});
  const text = 'a\n\nВторой ряд\n';
  const ruler = {measureText:line => ({width:[...line].length * 7.5})};
  const item = {...ink, text, ...measureMapText(ruler, ink, text)};
  assert.equal(item.w, 76);
  assert.equal(item.h, Math.ceil(4 * 22 * 1.3));
  assert.deepEqual([item.x,item.y,item.glow],[-15,20,true]);
  assert.match(ruler.font, /^22px /);
  const bounds = mapInkBounds([item]);
  assert.ok(bounds.left <= item.x && bounds.bottom >= item.y + item.h);
});

test('text painting preserves literal content and spacing when the canvas has no font ascent metrics', () => {
  const calls = [], ctx = {measureText:() => ({}),fillText:(...args) => calls.push(args)};
  const item = {...newMapText({x:0,y:0}, {}), fontSize:30, text:'<i>\n\nтекст'};
  paintMapText(ctx,item);
  assert.deepEqual(calls.map(([text])=>text),['<i>','','текст']);
  assert.equal(calls[2][2] - calls[0][2],78);
  assert.ok(calls.every(([_, x, y]) => x === 0 && Number.isFinite(y)));
});
