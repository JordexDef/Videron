import assert from 'node:assert/strict';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/je0AAAAASUVORK5CYII=';
const shape = (id, x, extras = {}) => ({
  id,
  type: 'rect',
  x,
  y: 0,
  w: 80,
  h: 60,
  fill: '#888888',
  ...extras
});
const sheet = (cells, extras = {}) => ({
  id: 'sheet',
  type: 'table',
  x: 0,
  y: 0,
  w: 380,
  h: 225,
  rows: 4,
  cols: 3,
  name: 'Prices',
  cells,
  ...extras
});
const boardNote = (id, elements) => ({
  id,
  title: id,
  body: [],
  x: 0,
  y: 0,
  links: [],
  tags: [],
  plain: '',
  type: 'canvas',
  board: { version: 1, elements }
});
async function start({ seed, openNote }, elements, other = []) {
  await seed({ areas: [], notes: [boardNote('Sketch', elements), ...other] });
  await openNote('Sketch');
}
const obj = (p, id) => p.locator('.vb-object[data-id="' + id + '"]');
const grid = (p, id = 'sheet') => p.locator('[data-table-id="' + id + '"]');
const cell = (p, addr, id) => grid(p, id).locator('[data-vt-addr="' + addr + '"]');
const values = (p, id) =>
  grid(p, id)
    .locator('[data-vt-addr]')
    .evaluateAll((nodes) =>
      Object.fromEntries(nodes.filter((n) => n.textContent).map((n) => [n.dataset.vtAddr, n.textContent]))
    );
const hdr = (p, axis, i) => grid(p).locator('[data-vt-' + axis + '="' + i + '"]');
const ids = (p) => p.locator('.vb-object').evaluateAll((nodes) => nodes.map((n) => n.dataset.id));
const xPos = (p, id) => obj(p, id).evaluate((n) => parseFloat(n.style.left));
const key = (p, primary, letter) => p.keyboard.press(primary + '+' + letter);
const edit = (p) => p.locator('.vt-editor:visible');
const btn = (p, name) => p.locator('.vd-editor').first().getByRole('button', { name, exact: true });
async function leave(page) {
  await page.locator('.vd-editor .ve-head > button').first().click();
  await page.locator('.vd-editor').waitFor({ state: 'hidden' });
}
const undo = (c) => key(c.page, c.primary, 'z');
const redo = (c) => key(c.page, c.primary, 'Shift+z');
async function editCell(p, addr, value, id) {
  await cell(p, addr, id).click();
  await p.keyboard.press('F2');
  await edit(p).fill(value);
  await edit(p).press('Enter');
}

async function point(locator, fracX = 0.5, fracY = 0.5) {
  const b = await locator.boundingBox();
  assert(b, 'visible pointer target');
  return [b.x + b.width * fracX, b.y + b.height * fracY];
}
async function drag(p, from, to) {
  await p.mouse.move(...from);
  await p.mouse.down();
  await p.mouse.move(...to, { steps: 7 });
  await p.mouse.up();
}
async function createChart(p) {
  await cell(p, 'A1').click();
  await p.keyboard.press('Shift+ArrowDown');
  await btn(p, 'Create chart').click();
  await p.locator('.vt-chart-plot').waitFor();
}
async function plotText(p) {
  return p.locator('.vt-chart-plot').evaluate((node) => node.textContent);
}

export const cases = {
  async 'board.group-pan-nudge'(c) {
    const { page: p, primary } = c;
    const members = ['one', 'two', 'other'];
    await start(
      c,
      members.map((id, i) => shape(id, i * 130))
    );
    const positions = () => Promise.all(members.map((id) => xPos(p, id)));
    const centers = () => Promise.all(members.map((id) => point(obj(p, id))));
    await obj(p, 'one').click();
    await obj(p, 'two').click({ modifiers: ['Shift'] });
    await key(p, primary, 'g');
    await p.keyboard.press('Escape');
    const initial = await positions();
    await obj(p, 'one').click({ modifiers: [primary] });
    await p.keyboard.press('ArrowRight');
    const moved = await positions();
    assert(moved[0] > initial[0]);
    assert.deepEqual(moved.slice(1), initial.slice(1));
    await btn(p, 'Hand').click();
    const before = await centers();
    const from = await point(p.locator('.vb-stage'), 0.5, 0.65);
    await drag(p, from, [from[0] + 65, from[1] - 35]);
    const after = await centers();
    for (let i = 0; i < members.length; i++) {
      assert(Math.abs(after[i][0] - before[i][0] - 65) <= 1);
      assert(Math.abs(after[i][1] - before[i][1] + 35) <= 1);
    }
    assert.deepEqual(await positions(), moved);
    await undo(c);
    assert.deepEqual(await positions(), initial);
    await redo(c);
    assert.deepEqual(await positions(), moved);
    await leave(p);
    await c.openNote('Sketch');
    assert.deepEqual(await positions(), moved);
    await obj(p, 'one').click();
    await p.keyboard.press('ArrowRight');
    const grouped = await positions();
    assert(grouped[0] > moved[0]);
    assert.equal(grouped[1] - moved[1], grouped[0] - moved[0]);
    assert.equal(grouped[2], moved[2]);
  },
  async 'board.stroke-corners-pattern'(c) {
    const { page: p } = c;
    const initial = { stroke: '#464a50', roughness: 0, rounded: false, fillStyle: 'solid' };
    await start(c, [shape('target', 0, initial), shape('sibling', 180, initial)]);
    const paths = (id) =>
      obj(p, id)
        .locator('svg path')
        .evaluateAll((nodes) =>
          nodes.map((n) => ['d', 'stroke', 'fill'].map((attr) => n.getAttribute(attr)))
        );
    const sibling = await paths('sibling');
    const snapshots = [await paths('target')];
    await obj(p, 'target').click();
    await btn(p, 'Object style').click();
    const color = p.getByLabel('Stroke / text', { exact: true });
    await color.fill('#e04061');
    // A color field rendered as a text input commits its value on blur.
    await color.press('Tab');
    snapshots.push(await paths('target'));
    assert(snapshots[1].some(([, stroke]) => stroke?.toLowerCase() === '#e04061'));
    await btn(p, 'Rounded corners').click();
    snapshots.push(await paths('target'));
    await btn(p, 'Crosshatched fill').click();
    snapshots.push(await paths('target'));
    for (let i = 1; i <= 3; i++) assert.notDeepEqual(snapshots[i], snapshots[i - 1]);
    for (let i = 2; i >= 0; i--) {
      await undo(c);
      assert.deepEqual(await paths('target'), snapshots[i]);
    }
    for (let i = 1; i <= 3; i++) {
      await redo(c);
      assert.deepEqual(await paths('target'), snapshots[i]);
    }
    await leave(p);
    await c.openNote('Sketch');
    assert.deepEqual(await paths('target'), snapshots[3]);
    assert.deepEqual(await paths('sibling'), sibling);
  },
  async 'board.inline-frame-history'(c) {
    const { page: p } = c;
    const para = (text) => ({ type: 'paragraph', runs: [{ text }] });
    const drawing = {
      type: 'drawing',
      presentation: 'drawing',
      frame: { width: 460, height: 235 },
      board: { version: 1, elements: [shape('art', 24)] }
    };
    await c.seed({
      areas: [],
      notes: [
        {
          id: 'Article',
          title: 'Article',
          body: [para('Before'), drawing, para('After')],
          x: 0,
          y: 0,
          links: [],
          tags: []
        }
      ]
    });
    await c.openNote('Article');
    const frame = p.locator('figure.ve-inline-board');
    const handle = frame.getByRole('button', { name: 'Resize area', exact: true });
    const size = () => frame.evaluate((n) => [n.offsetWidth, n.offsetHeight]);
    const art = () =>
      obj(p, 'art').evaluate((n) => [n.style.left, n.style.top, n.style.width, n.style.height]);
    const geometry = await art();
    const initial = await size();
    await obj(p, 'art').click();
    const from = await point(handle);
    await drag(p, from, [from[0] + 45, from[1] + 30]);
    const dragged = await size();
    assert.deepEqual(dragged, [initial[0] + 45, initial[1] + 30]);
    await handle.press('Shift+ArrowDown');
    const resized = [dragged[0], dragged[1] + 40];
    assert.deepEqual(await size(), resized);
    await undo(c);
    assert.deepEqual(await size(), dragged);
    await undo(c);
    assert.deepEqual(await size(), initial);
    await redo(c);
    assert.deepEqual(await size(), dragged);
    await redo(c);
    assert.deepEqual(await size(), resized);
    await leave(p);
    await c.openNote('Article');
    assert.deepEqual(await size(), resized);
    assert.deepEqual(await art(), geometry);
    assert.deepEqual(await p.locator('.ve-text[contenteditable=true]').allTextContents(), [
      'Before',
      'After'
    ]);
  },
  async 'board.tsv-row-history'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A1: 'keep', B2: '1', C3: '2', A4: 'tail', C4: '=B2+C3' })]);
    const initial = { A1: 'keep', B2: '1', C3: '2', A4: 'tail', C4: '3' };
    const pasted = { A1: 'keep', B2: '10', C2: '20', B3: '30', C3: '40', A4: 'tail', C4: '50' };
    const shifted = { A1: 'keep', B3: '10', C3: '20', B4: '30', C4: '40', A5: 'tail', C5: '50' };
    assert.deepEqual(await values(p), initial);
    await cell(p, 'B2').click();
    await cell(p, 'B2').evaluate((n) => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', '10\t20\n30\t40');
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      n.dispatchEvent(event);
    });
    assert.deepEqual(await values(p), pasted);
    await hdr(p, 'row', 1).click({ button: 'right' });
    await p.getByRole('menuitem', { name: 'Insert row above', exact: true }).click();
    assert.deepEqual(await values(p), shifted);
    async function checkFormula() {
      await cell(p, 'C5').click();
      await p.keyboard.press('F2');
      assert.equal(await edit(p).inputValue(), '=B3+C4');
      await edit(p).press('Escape');
    }
    await checkFormula();
    await undo(c);
    assert.deepEqual(await values(p), pasted);
    await undo(c);
    assert.deepEqual(await values(p), initial);
    await redo(c);
    assert.deepEqual(await values(p), pasted);
    await redo(c);
    assert.deepEqual(await values(p), shifted);
    await leave(p);
    await c.openNote('Sketch');
    assert.deepEqual(await values(p), shifted);
    await checkFormula();
  },
  async 'board.bound-arrow-drag'(c) {
    const { page: p } = c;
    await start(c, [shape('left', 0), shape('right', 250)]);
    await btn(p, 'Arrow').click();
    await drag(p, await point(obj(p, 'left'), 1, 0.5), await point(obj(p, 'right'), 0, 0.5));
    const arrow = p.locator('.vb-object[data-kind=arrow]');
    await arrow.waitFor();
    const geometry = (loc) =>
      loc.evaluate((n) => [n.style.left, n.style.top, n.style.width, n.style.height].map(parseFloat));
    const near = (a, b) => assert(Math.abs(a - b) < 2, 'expected ' + a + ' near ' + b);
    async function follow() {
      const [x, y, w, h] = await geometry(arrow),
        [lx, ly, lw, lh] = await geometry(obj(p, 'left')),
        [rx, ry, , rh] = await geometry(obj(p, 'right'));
      near(x, lx + lw);
      near(y, ly + lh / 2);
      near(x + w, rx);
      near(y + h, ry + rh / 2);
    }
    const initial = await geometry(arrow);
    await follow();
    await btn(p, 'Select').click();
    const center = await point(obj(p, 'right'));
    await drag(p, center, [center[0] + 55, center[1] + 64]);
    const moved = await geometry(arrow);
    assert(moved[2] > initial[2] && moved[3] > initial[3]);
    await follow();
    await undo(c);
    assert.deepEqual(await geometry(arrow), initial);
    await follow();
    await redo(c);
    assert.deepEqual(await geometry(arrow), moved);
    await follow();
    await leave(p);
    await c.openNote('Sketch');
    assert.deepEqual(await geometry(arrow), moved);
    await follow();
    // Move again after loading to distinguish a live attachment from a saved coincident endpoint.
    await obj(p, 'right').click();
    await p.keyboard.press('Shift+ArrowRight');
    await follow();
  },
  async 'board.remove-related-inline-table'(c) {
    const { page: p } = c;
    const para = (text) => ({ type: 'paragraph', runs: [{ text }] });
    const block = (e) => ({ type: 'drawing', board: { version: 1, elements: [e] } });
    const src = sheet({ A1: '8', B2: 'memo' }),
      sum = sheet({ A1: '=Prices::A1*2' }, { id: 'summary', name: 'Summary' });
    await c.seed({
      areas: [],
      notes: [
        {
          id: 'Report',
          title: 'Report',
          body: [para('Top'), block(src), para('Bottom'), block(sum)],
          x: 0,
          y: 0,
          tags: [],
          links: []
        }
      ]
    });
    await c.openNote('Report');
    const paragraphs = () => p.locator('.ve-text[contenteditable=true]').allTextContents();
    async function whole() {
      assert.deepEqual(await values(p), { A1: '8', B2: 'memo' });
      assert.deepEqual(await values(p, 'summary'), { A1: '16' });
      assert.deepEqual(await paragraphs(), ['Top', 'Bottom']);
    }
    async function removed() {
      assert.equal(await grid(p).count(), 0);
      assert.deepEqual(await values(p, 'summary'), { A1: '#REF!' });
      assert.deepEqual(await paragraphs(), ['Top', 'Bottom']);
    }
    await whole();
    await cell(p, 'A1').click();
    await grid(p).getByRole('button', { name: 'Table actions' }).click();
    await p.getByRole('menuitem', { name: 'Remove table' }).click();
    await removed();
    await undo(c);
    await whole();
    await redo(c);
    await removed();
    await undo(c);
    await whole();
    await leave(p);
    await c.openNote('Report');
    await whole();
  },
  async 'board.image-transform'(c) {
    const { page: p } = c;
    await start(c, [shape('sibling', 0)]);
    const data = await p.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#cc5439';
      ctx.fillRect(6, 8, 48, 28);
      return canvas.toDataURL();
    });
    const picker = p.waitForEvent('filechooser');
    await btn(p, 'Insert image').click();
    await (
      await picker
    ).setFiles({
      name: 'example.png',
      mimeType: 'image/png',
      buffer: Buffer.from(data.split(',')[1], 'base64')
    });
    const image = p.locator('.vb-object[data-kind=image]');
    await image.waitFor();
    const geometry = () => image.evaluate((n) => [n.style.width, n.style.height, n.style.transform]);
    const original = await geometry();
    const corner = await point(p.locator('.vb-handle[data-handle=se]'));
    await drag(p, corner, [corner[0] + 43, corner[1] + 25]);
    const resized = await geometry();
    assert.notDeepEqual(resized.slice(0, 2), original.slice(0, 2));
    const center = await point(image),
      handle = await point(p.locator('.vb-handle[data-handle=rotate]'));
    await p.keyboard.down('Shift');
    try {
      await drag(p, handle, [center[0] + 55, center[1]]);
    } finally {
      await p.keyboard.up('Shift');
    }
    const rotated = await geometry();
    assert.notEqual(rotated[2], resized[2]);
    const deg = Number(rotated[2].match(/rotate\(([-\d.]+)deg\)/)[1]);
    assert.equal(deg % 15, 0);
    await undo(c);
    assert.deepEqual(await geometry(), resized);
    await undo(c);
    assert.deepEqual(await geometry(), original);
    await redo(c);
    await redo(c);
    await leave(p);
    await c.openNote('Sketch');
    assert.deepEqual(await geometry(), rotated);
    assert.equal(await image.locator('img').getAttribute('src'), data);
    assert.equal(await xPos(p, 'sibling'), 0);
  },
  async 'board.image-delete'(c) {
    const { page: p } = c;
    const image = (id, x) => shape(id, x, { type: 'image', src: png });
    await start(c, [image('img1', 0), shape('keep', 130), image('img2', 255)]);
    await obj(p, 'img1').click();
    await obj(p, 'img2').click({ modifiers: ['Shift'] });
    await p.keyboard.press('Delete');
    assert.deepEqual(await ids(p), ['keep']);
    await undo(c);
    assert.deepEqual(await ids(p), ['img1', 'keep', 'img2']);
    for (const id of ['img1', 'img2']) assert.equal(await obj(p, id).locator('img').getAttribute('src'), png);
    await redo(c);
    assert.deepEqual(await ids(p), ['keep']);
  },
  async 'board.locked-group'(c) {
    const { page: p } = c;
    await start(c, [
      shape('a', 0, { groupIds: ['g'] }),
      shape('b', 130, { locked: true, groupIds: ['g'] }),
      shape('c', 260)
    ]);
    await obj(p, 'c').click();
    await key(p, c.primary, 'a');
    await p.keyboard.press('Delete');
    assert.deepEqual(await ids(p), ['a', 'b']);
    await undo(c);
    assert.deepEqual(await ids(p), ['a', 'b', 'c']);
  },
  async 'board.nested-group'(c) {
    const { page: p, primary } = c;
    await start(c, [shape('a', 0), shape('b', 130), shape('c', 260)]);
    await obj(p, 'a').click();
    await obj(p, 'b').click({ modifiers: ['Shift'] });
    await key(p, primary, 'g');
    await obj(p, 'c').click({ modifiers: ['Shift'] });
    await key(p, primary, 'g');
    await key(p, primary, 'Shift+g');
    await p.keyboard.press('Escape');
    await obj(p, 'a').click();
    await p.keyboard.press('ArrowRight');
    assert((await xPos(p, 'a')) > 0);
    assert.equal((await xPos(p, 'b')) - 130, await xPos(p, 'a'));
    assert.equal(await xPos(p, 'c'), 260);
  },
  async 'board.layer-history'(c) {
    const { page: p } = c;
    await start(c, [shape('a', 0), shape('b', 130), shape('c', 260)]);
    await obj(p, 'b').click();
    await btn(p, 'Bring to front').click();
    assert.deepEqual(await ids(p), ['a', 'c', 'b']);
    const focus = await p.evaluate(() => document.activeElement.tagName);
    await undo(c);
    assert.deepEqual(await ids(p), ['a', 'b', 'c'], 'Undo after clicking Bring to front; focus ' + focus);
    await redo(c);
    assert.deepEqual(await ids(p), ['a', 'c', 'b']);
    await btn(p, 'Send to back').click();
    assert.deepEqual(await ids(p), ['b', 'a', 'c']);
  },
  async 'board.caption-delete'(c) {
    const { page: p } = c;
    await start(c, [shape('title', 0, { label: 'AB' }), shape('sibling', 160)]);
    await obj(p, 'title').click();
    await p.keyboard.press('Enter');
    const field = p.getByRole('textbox', { name: 'Text inside shape' });
    await field.press('End');
    await field.press('Shift+ArrowLeft');
    await field.press('Delete');
    assert.equal(await field.inputValue(), 'A');
    await field.press('Escape');
    await p.keyboard.press('Delete');
    assert.deepEqual(await ids(p), ['sibling']);
    await undo(c);
    assert.deepEqual(await ids(p), ['title', 'sibling']);
    assert.equal(await obj(p, 'title').textContent(), 'A');
  },
  async 'board.duplicate-history'(c) {
    const { page: p, primary } = c;
    await start(c, [shape('original', 0)]);
    await obj(p, 'original').click();
    await key(p, primary, 'd');
    const items = await ids(p);
    assert.equal(items.length, 2);
    const copy = items[1],
      before = await xPos(p, copy);
    await p.keyboard.press('ArrowRight');
    const after = await xPos(p, copy);
    assert(after > before);
    await leave(p);await c.openNote('Sketch');await p.locator('.vb-stage').focus();
    await undo(c);
    assert.equal(await xPos(p, copy), before);
    await undo(c);
    assert.deepEqual(await ids(p), ['original']);
    await leave(p);await c.openNote('Sketch');await p.locator('.vb-stage').focus();
    await redo(c);
    await redo(c);
    assert.equal(await xPos(p, copy), after);
    assert.equal(await xPos(p, 'original'), 0);
  },
  async 'board.disjoint-rows'(c) {
    const { page: p } = c;
    const data = { A1: 'first', A2: 'second', A3: 'third', A4: 'fourth' };
    await start(c, [sheet(data)]);
    await hdr(p, 'row', 0).click();
    await hdr(p, 'row', 2).click({ modifiers: [c.primary] });
    await p.keyboard.press('Delete');
    assert.deepEqual(await values(p), { A1: 'second', A2: 'fourth' });
    await undo(c);
    assert.deepEqual(await values(p), data);
  },
  async 'board.delete-last-axis'(c) {
    const { page: p } = c;
    const data = { A1: 'left', B2: 'middle', C3: 'right' };
    await start(c, [sheet(data)]);
    await hdr(p, 'col', 0).click();
    await hdr(p, 'col', 2).click({ modifiers: ['Shift'] });
    await p.keyboard.press('Delete');
    assert.equal(await grid(p).locator('[data-vt-col]').count(), 1);
    assert.equal(await grid(p).locator('[data-vt-row]').count(), 4);
    assert.deepEqual(await values(p), {});
    await undo(c);
    assert.deepEqual(await values(p), data);
  },
  async 'board.clear-range'(c) {
    const { page: p } = c;
    const data = { A1: '1', B1: '2', C1: '3', A2: '4', B2: '5', C2: '6', A3: '7', B3: '8', C3: '9' };
    await start(c, [sheet(data, { rows: 3 })]);
    await cell(p, 'A1').click();
    await p.keyboard.press('Shift+ArrowRight');
    await p.keyboard.press('Shift+ArrowDown');
    await p.keyboard.press('Delete');
    assert.equal(await grid(p).locator('[data-vt-addr]').count(), 9);
    assert.deepEqual(await values(p), { C1: '3', C2: '6', A3: '7', B3: '8', C3: '9' });
    await undo(c);
    assert.deepEqual(await values(p), data);
  },
  async 'board.tab-cancel'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A2: 'preserve' })]);
    await cell(p, 'C1').click();
    await p.keyboard.press('F2');
    await edit(p).fill('keep');
    await edit(p).press('Tab');
    assert.equal(await p.locator('.vt-address').innerText(), 'A2');
    await p.keyboard.press('F2');
    await edit(p).fill('draft');
    await edit(p).press('Escape');
    await p.keyboard.press('Shift+Tab');
    assert.equal(await p.locator('.vt-address').innerText(), 'C1');
    assert.deepEqual(await values(p), { C1: 'keep', A2: 'preserve' });
  },
  async 'board.formula-picks'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A1: '2', B1: '5' })]);
    await cell(p, 'C2').click();
    await p.keyboard.press('F2');
    await edit(p).fill('=SUM(');
    await cell(p, 'A1').click();
    await cell(p, 'B1').click();
    await p.keyboard.insertText(')');
    assert.equal(await edit(p).inputValue(), '=SUM(A1,B1)');
    await edit(p).press('Enter');
    assert.deepEqual(await values(p), { A1: '2', B1: '5', C2: '7' });
    await undo(c);
    assert.deepEqual(await values(p), { A1: '2', B1: '5' });
  },
  async 'board.cross-rename'(c) {
    const { page: p } = c;
    await start(c, [
      sheet({ A1: '7' }),
      sheet({ A1: '=Prices::A1*2' }, { id: 'tot', name: 'Totals', x: 410 })
    ]);
    assert.equal(await cell(p, 'A1', 'tot').locator('.vt-value').textContent(), '14');
    await grid(p).hover();
    await grid(p).getByRole('button', { name: 'Table actions' }).click();
    await p.getByRole('menuitem', { name: 'Rename' }).click();
    const field = p.getByRole('textbox', { name: 'Table name' });
    await field.fill('New prices');
    await field.press('Enter');
    assert.equal(await grid(p).locator('.vt-name').innerText(), 'New prices');
    assert.equal(await cell(p, 'A1', 'tot').locator('.vt-value').textContent(), '14');
    await cell(p, 'A1', 'tot').click();
    await p.keyboard.press('F2');
    assert.match(await edit(p).inputValue(), /New prices/);
    await edit(p).press('Escape');
    await undo(c);
    assert.equal(await grid(p).locator('.vt-name').innerText(), 'Prices');
    assert.equal(await cell(p, 'A1', 'tot').locator('.vt-value').textContent(), '14');
  },
  async 'board.insert-dependency'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A1: '4', B1: '5', C1: '=A1+B1' })]);
    await hdr(p, 'col', 1).click({ button: 'right' });
    await p.getByRole('menuitem', { name: 'Insert column left' }).click();
    assert.deepEqual(await values(p), { A1: '4', C1: '5', D1: '9' });
    await cell(p, 'D1').click();
    await p.keyboard.press('F2');
    assert.equal(await edit(p).inputValue(), '=A1+C1');
    await edit(p).press('Escape');
    await undo(c);
    assert.deepEqual(await values(p), { A1: '4', B1: '5', C1: '9' });
  },
  async 'board.chart-update'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A1: '2', A2: '5' })]);
    await createChart(p);
    const chart = p.locator('.vt-chart');
    await chart.hover();
    const target = chart.locator('button[aria-pressed=false]');
    const kind = await target.getAttribute('data-chart-type');
    await target.click();
    const before = await plotText(p);
    await editCell(p, 'A2', '50');
    assert.notEqual(await plotText(p), before);
    assert.equal(
      await chart.locator('[data-chart-type="' + kind + '"]').getAttribute('aria-pressed'),
      'true'
    );
    await undo(c);
    assert.equal(await plotText(p), before);
    assert.deepEqual(await values(p), { A1: '2', A2: '5' });
  },
  async 'board.minimal-table'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A1: 'Original' })]);
    await grid(p).hover();
    await grid(p).getByRole('button', { name: 'Table actions' }).click();
    for (const name of ['Header in first row', 'Row numbers', 'Column letters', 'Table name'])
      await p.getByRole('menuitemcheckbox', { name, exact: true }).click();
    await p.keyboard.press('Escape');
    await editCell(p, 'A1', 'Persist');
    await leave(p);
    await c.openNote('Sketch');
    assert.equal(await hdr(p, 'row', 0).count(), 0);
    assert.equal(await hdr(p, 'col', 0).count(), 0);
    assert.equal(await cell(p, 'A1').getAttribute('role'), 'columnheader');
    assert.equal(await cell(p, 'A1').locator('.vt-value').textContent(), 'Persist');
    assert.equal(await grid(p).locator('.vt-name').isVisible(), false);
    await cell(p, 'B2').click();
    assert.equal(await p.locator('.vt-address').innerText(), 'B2');
  },
  async 'board.autofill-cancel'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A1: '1', A2: '3' })]);
    await cell(p, 'A1').click();
    await p.keyboard.press('Shift+ArrowDown');
    const handle = grid(p).getByRole('button', { name: 'Autofill' });
    async function pull() {
      await p.mouse.move(...(await point(handle)));
      await p.mouse.down();
      await p.mouse.move(...(await point(cell(p, 'A4'))), { steps: 9 });
    }
    await pull();
    await p.keyboard.press('Escape');
    await p.mouse.up();
    assert.deepEqual(await values(p), { A1: '1', A2: '3' });
    await p.keyboard.down('Control');
    try {
      await pull();
      await p.mouse.up();
    } finally {
      await p.keyboard.up('Control');
    }
    assert.deepEqual(await values(p), { A1: '1', A2: '3', A3: '1', A4: '3' });
    await undo(c);
    assert.deepEqual(await values(p), { A1: '1', A2: '3' });
  },
  async 'board.sum-neighbour'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A1: '2', A2: '3', A3: 'keep' })]);
    await cell(p, 'A1').click();
    await p.keyboard.press('Shift+ArrowDown');
    const sum = p.getByRole('button', { name: 'Sum 5', exact: true });
    await sum.click();
    assert.deepEqual(await values(p), { A1: '2', A2: '3', A3: 'keep', A4: '5' });
    await undo(c);
    assert.deepEqual(await values(p), { A1: '2', A2: '3', A3: 'keep' });
  },
  async 'board.inline-reopen'(c) {
    const { page: p } = c;
    const para = (text) => ({ type: 'paragraph', runs: [{ text }] });
    await c.seed({
      areas: [],
      notes: [
        {
          id: 'Article',
          title: 'Article',
          body: [
            para('Before'),
            {
              type: 'drawing',
              board: { version: 1, elements: [sheet({ A1: '2' }), shape('neighbour', 500)] }
            },
            para('After')
          ],
          x: 0,
          y: 0,
          links: [],
          tags: []
        }
      ]
    });
    await c.openNote('Article');
    await editCell(p, 'A1', '23');
    await leave(p);
    await c.openNote('Article');
    assert.equal(await cell(p, 'A1').locator('.vt-value').textContent(), '23');
    assert.deepEqual(await p.locator('.ve-text[contenteditable=true]').allTextContents(), [
      'Before',
      'After'
    ]);
  },
  async 'board.polyline-bend'(c) {
    const { page: p } = c;
    await start(c, []);
    await btn(p, 'Line').click();
    const stage = p.locator('.vb-stage');
    const vertices = [
      [0.3, 0.45],
      [0.47, 0.61],
      [0.65, 0.43]
    ];
    for (const [x, y] of vertices) await p.mouse.click(...(await point(stage, x, y)));
    await p.keyboard.press('Enter');
    const handles = p.locator('.vb-vertex');
    assert.equal(await handles.count(), 3);
    const getEndpoints = async () => Promise.all([point(handles.first()), point(handles.last())]);
    const endpoints = await getEndpoints();
    const mid = await point(p.locator('.vb-midpoint').first());
    await drag(p, mid, [mid[0] - 12, mid[1] + 35]);
    assert.equal(await handles.count(), 4);
    await p.locator('.vb-vertex[data-index="1"]').click({ modifiers: ['Alt'] });
    assert.equal(await handles.count(), 3);
    const remaining = await getEndpoints();
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) assert(Math.abs(remaining[i][j] - endpoints[i][j]) < 1);
    await undo(c);
    assert.equal(await handles.count(), 4);
  },
  async 'board.chart-interchange'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A1: '2', A2: '=A1*3' })], [boardNote('Import', [])]);
    await createChart(p);
    await btn(p, 'File').click();
    const download = p.waitForEvent('download');
    await btn(p, 'Save .excalidraw…').click();
    const file = await download;
    assert.match(file.suggestedFilename(), /\.excalidraw$/);
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const original = await plotText(p);
    await leave(p);
    await c.openNote('Import');
    await btn(p, 'File').click();
    const chooser = p.waitForEvent('filechooser');
    await btn(p, 'Open .excalidraw…').click();
    await (
      await chooser
    ).setFiles({ name: 'roundtrip.excalidraw', mimeType: 'application/json', buffer: bytes });
    const table = p.locator('[data-table-id]');
    await table.waitFor();
    const imported = await table.getAttribute('data-table-id');
    assert.equal(await cell(p, 'A2', imported).locator('.vt-value').textContent(), '6');
    await editCell(p, 'A1', '20', imported);
    assert.equal(await cell(p, 'A2', imported).locator('.vt-value').textContent(), '60');
    assert.notEqual(await plotText(p), original);
    await leave(p);
    await c.openNote('Sketch');
    assert.deepEqual(await values(p), { A1: '2', A2: '6' });
    assert.equal(await plotText(p), original);
  },
  async 'board.frame-default'(c) {
    const { page: p } = c;
    await start(c, [], [boardNote('Blank', [])]);
    async function drawArea() {
      await btn(p, 'Text').click();
      const stage = p.locator('.vb-stage');
      await drag(p, await point(stage, 0.35, 0.4), await point(stage, 0.6, 0.57));
      await p.locator('.vb-rich-frame').waitFor();
    }
    const transparent = () =>
      p
        .locator('.vb-rich-frame')
        .evaluate((n) => [n.style.backgroundColor, n.style.borderColor].every((k) => k === 'transparent'));
    await drawArea();
    await p.keyboard.press('Escape');
    await btn(p, 'Object style').click();
    await btn(p, 'Text only').click();
    await btn(p, 'Save as default').click();
    assert(await transparent());
    await leave(p);
    await c.openNote('Blank');
    await drawArea();
    const text = p.locator('.vb-rich-frame .ve-text').first();
    await text.click();
    await p.keyboard.insertText('Visible note');
    await p.keyboard.press('Escape');
    await btn(p, 'Fit canvas').click();
    assert.equal(await text.innerText(), 'Visible note');
    assert(await transparent());
  },
  async 'board.dock-focus'(c) {
    const { page: p } = c;
    await start(c, [shape('origin', 0, { label: 'Before' }), shape('other', 155)]);
    await obj(p, 'origin').click();
    await btn(p, 'Duplicate').click();
    assert.equal((await ids(p)).length, 3);
    await btn(p, 'Zoom in').click();
    await undo(c);
    assert.deepEqual(await ids(p), ['origin', 'other']);
    await obj(p, 'origin').click();
    const back = btn(p, 'Send to back'),
      front = btn(p, 'Bring to front');
    await back.focus();
    await p.keyboard.press('Tab');
    assert(await front.evaluate((n) => document.activeElement === n));
    await p.keyboard.press('Enter');
    assert.deepEqual(await ids(p), ['other', 'origin']);
    assert(await front.evaluate((n) => document.activeElement === n));
    await obj(p, 'origin').dblclick();
    const field = p.getByRole('textbox', { name: 'Text inside shape' });
    await field.press('End');
    await p.keyboard.insertText(' now');
    assert.equal(await field.inputValue(), 'Before now');
    await undo(c);
    assert.equal(await field.inputValue(), 'Before');
    assert.deepEqual(await ids(p), ['other', 'origin']);
  },
  async 'board.style-history'(c) {
    const { page: p } = c;
    await start(c, [shape('paper', 0), shape('other', 150)]);
    await obj(p, 'paper').click();
    await btn(p, 'Object style').click();
    const fillPath = (id) => obj(p, id).locator('path[fill="#888888"]').count();
    assert(await fillPath('paper'));
    await btn(p, 'Sketchy outline').click();
    await btn(p, 'No fill').click();
    assert.equal(await fillPath('paper'), 0);
    assert(await fillPath('other'));
    await undo(c);
    assert(await fillPath('paper'));
    assert.equal(await btn(p, 'Sketchy outline').getAttribute('aria-pressed'), 'true');
    await redo(c);
    assert.equal(await fillPath('paper'), 0);
    assert(await fillPath('other'));
  },
  async 'board.sketch-marquee'(c) {
    const { page: p } = c;
    await start(c, []);
    const stage = p.locator('.vb-stage');
    for (const [tool, x1, y1, x2, y2] of [
      ['Rectangle', 0.2, 0.38, 0.33, 0.52],
      ['Diamond', 0.45, 0.38, 0.54, 0.54],
      ['Ellipse', 0.67, 0.38, 0.77, 0.55],
      ['Line', 0.26, 0.65, 0.41, 0.67],
      ['Pen', 0.57, 0.65, 0.68, 0.72]
    ]) {
      await btn(p, tool).click();
      await drag(p, await point(stage, x1, y1), await point(stage, x2, y2));
    }
    const kinds = () => p.locator('.vb-object').evaluateAll((nodes) => nodes.map((n) => n.dataset.kind));
    assert.deepEqual(await kinds(), ['rect', 'diamond', 'ellipse', 'line', 'pen']);
    await btn(p, 'Eraser').click();
    await p.mouse.click(...(await point(stage, 0.625, 0.685)));
    await btn(p, 'Select').click();
    const order = ['rect', 'diamond', 'ellipse', 'line'];
    assert.deepEqual(await kinds(), order);
    const b = await p.locator('.vb-object[data-kind="rect"]').boundingBox(),
      startCorner = [b.x + b.width * 0.45, b.y - 15],
      endCorner = [b.x + b.width + 15, b.y + b.height + 15];
    await drag(p, startCorner, endCorner);
    await p.keyboard.press('Delete');
    assert.deepEqual(await kinds(), order);
    await drag(p, endCorner, startCorner);
    await p.keyboard.press('Delete');
    assert.deepEqual(await kinds(), order.slice(1));
    await undo(c);
    assert.deepEqual(await kinds(), order);
  },
  async 'board.grow-function'(c) {
    const { page: p } = c;
    await start(c, [sheet({ A1: '2', A2: '3' })]);
    await grid(p).hover();
    await btn(p, 'Add row').click();
    await grid(p).hover();
    await btn(p, 'Add column').click();
    assert.equal(await grid(p).locator('[data-vt-addr]').count(), 20);
    await cell(p, 'A1').click();
    await key(p, c.primary, 'ArrowDown');
    assert.equal(await p.locator('.vt-address').innerText(), 'A2');
    await cell(p, 'D5').click();
    await btn(p, 'All functions').click();
    await p.getByRole('listbox', { name: 'Formula functions' }).waitFor();
    await edit(p).press('Escape');
    await edit(p).fill('=s');
    await p.getByRole('option').filter({ hasText: 'SUM(' }).first().waitFor();
    await edit(p).press('Tab');
    assert.equal(await edit(p).inputValue(), '=SUM()');
    await p.keyboard.insertText('A1:A2');
    await edit(p).press('Enter');
    assert.equal(await cell(p, 'D5').locator('.vt-value').textContent(), '5');
    await undo(c);
    assert.equal(await grid(p).locator('[data-vt-addr]').count(), 20);
    assert.deepEqual(await values(p), { A1: '2', A2: '3' });
  }
};
