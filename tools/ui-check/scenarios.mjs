import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';
import {serveFrontend} from './serve-frontend.mjs';
import {chromium, webkit} from 'playwright-core';
import {checkTableSelection} from './selection-scope.mjs';

const libraryKey = 'videron.library.v1';
let origin, host;
before(async () => { host=await serveFrontend(); origin=host.origin; });
after(() => host?.close());

function testNote() {
  const paragraphs = ['fox fox', 'fox stays here'];
  return {id:'sample', title:'Sample note', x:300, y:-160, pinned:true, tags:[], links:[],
    bodyVersion:1, body:paragraphs.map(text => ({type:'paragraph', runs:[{text}]})),
    plain:paragraphs.join('\n'), created:1, modified:1};
}

// The first and third strokes share a marquee. The middle layer is outside it.
function mapStrokes() {
  return [{id:'one', x:-85}, {id:'keep', x:140}, {id:'three', x:10}]
    .map(stroke => ({...stroke, type:'pen', y:-20, w:40, h:25, stroke:'#969696',
      lineWidth:3, points:[[0,0], [.4,.8], [1,1]]}));
}

async function startSession(browser, t) {
  const space = {areas:[], notes:[testNote()], mapInk:mapStrokes()};
  const library = {version:1, active:'personal', spaces:{personal:space}, plugins:[], view:{manualLayout:true}};
  const context = await browser.newContext({viewport:{width:1200, height:780}, reducedMotion:'reduce',
    storageState:{cookies:[], origins:[{origin, localStorage:[
      {name:libraryKey, value:JSON.stringify(library)},
      {name:'videron.interface-language.v1', value:'en'},
      {name:'videron.map-camera.v1.personal', value:JSON.stringify({x:0, y:0, zoom:1})}
    ]}]}});
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(origin);
  // Wait for the initial workspace to mount, including the note tree and keyboard handlers.
  await page.getByRole('treeitem', {name:'Sample note', exact:true}).waitFor();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform));
  return {page, mac};
}

async function savedStrokes(page, expected) {
  const ids = expected.map(i => i.id);
  try {
    await page.waitForFunction(({key, ids}) => {
      const items = JSON.parse(localStorage.getItem(key)).spaces.personal.mapInk ?? [];
      return items.map(i => i.id).join(',') === ids.join(',');
    }, {key:libraryKey, ids}, {timeout:5000});
  } catch (cause) {
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).spaces.personal.mapInk, libraryKey);
    throw new Error('Expected saved strokes [' + ids + '], found [' + (saved ?? []).map(i => i.id) + ']', {cause});
  }
  const items = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).spaces.personal.mapInk, libraryKey);
  assert.deepEqual(items, expected, 'stroke contents and layer order');
}

for (const engine of [chromium, webkit]) {
  describe(engine.name(), () => {
    let browser;
    before(async () => { browser = await engine.launch(); });
    after(async () => { await browser?.close(); });

    it('marquee, Delete, one Undo, reload restores stroke geometry and layers', async t => {
      const {page, mac} = await startSession(browser, t);
      const canvas = await page.locator('#graph').boundingBox();
      const centerX = canvas.x + canvas.width / 2, centerY = canvas.y + canvas.height / 2;
      await page.mouse.move(centerX-120, centerY-60);
      await page.mouse.down();
      await page.mouse.move(centerX+75, centerY+40, {steps:8});
      await page.mouse.up();
      await page.getByRole('button', {name:'Group', exact:true}).waitFor();
      await page.keyboard.press('Delete');
      const strokes = mapStrokes();
      await savedStrokes(page, [strokes[1]]);
      await page.keyboard.press(mac ? 'Meta+z' : 'Control+z');
      await savedStrokes(page, strokes);
      // Using a map control with the mouse must leave the selection actionable.
      await page.getByRole('button', {name:'Zoom in', exact:true}).click();
      await page.keyboard.press('Delete');
      await savedStrokes(page, [strokes[1]]);
      await page.keyboard.press(mac ? 'Meta+z' : 'Control+z');
      await savedStrokes(page, strokes);
      await page.reload();
      await page.getByRole('treeitem', {name:'Sample note', exact:true}).waitFor();
      await savedStrokes(page, strokes);
    });

    it('replace in selection stays on the selected occurrence after inserting text before it', async t => {
      const {page, mac} = await startSession(browser, t);
      await page.getByRole('treeitem', {name:'Sample note', exact:true}).click();
      const paragraphs = page.locator('.ve-text[contenteditable="true"]');
      const first = paragraphs.first();
      await first.click();
      await page.keyboard.press(mac ? 'Meta+ArrowRight' : 'End');
      for (let i=0; i<3; i++) await page.keyboard.press('Shift+ArrowLeft');
      assert.equal(await page.evaluate(() => getSelection().toString()), 'fox');
      await page.keyboard.press(mac ? 'Meta+Alt+f' : 'Control+h');
      const panel = page.getByRole('search', {name:'Find in note'});
      assert.equal(await panel.getByRole('textbox', {name:'Find', exact:true}).inputValue(), 'fox');
      await panel.getByRole('button', {name:'Find in selection'}).click();
      await panel.getByRole('textbox', {name:'Replace with'}).fill('CAT');
      await first.click();
      await page.keyboard.press(mac ? 'Meta+ArrowLeft' : 'Home');
      await page.keyboard.insertText('fox ');
      await panel.getByRole('button', {name:'Replace all'}).click();
      const texts = await paragraphs.allInnerTexts();
      assert.deepEqual(texts, ['fox fox CAT', 'fox stays here']);
    });

    it('replace in selected table cells respects the selected range and can be undone', async () => {
      await checkTableSelection(browser, origin);
    });
  });
}
