import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { scriptedPeer } from './workspace-sync.mjs';

const libraryKey = 'videron.library.v1',
  cameraKey = 'videron.map-camera.v1.personal';
const note = (id, x = 0, y = 0, other = {}) => ({
  id,
  title: id,
  body: [{ type: 'paragraph', runs: [{ text: id }] }],
  plain: id,
  x,
  y,
  tags: [],
  links: [],
  pinned: true,
  created: 1,
  modified: 1,
  ...other
});
const area = (id, more = {}) => ({ id, name: id, color: '#8295b1', ...more });
const grid = (more = {}) => area('Grid', { grid: { cols: 2, rows: 1, x: -85, y: 0, spacing: 140, ...more } });
const stroke = (id, x) => ({
  id,
  x,
  y: 0,
  w: 40,
  h: 20,
  type: 'pen',
  stroke: '#999999',
  lineWidth: 3,
  points: [
    [0, 0],
    [0.5, 0.5],
    [1, 1]
  ]
});
const button = (p, name) => p.getByRole('button', { name, exact: true });
const onMap = (p) => p.locator('#graph');
const tree = (p, id) => p.locator('.tree-note-link[data-note-id="' + id + '"]');
const folder = (p, id) => p.locator('.area-tree-row[data-area-id="' + id + '"] [role=treeitem]');
const back = async (p) => {
  await p.locator('.vd-editor .ve-head > button').first().click();
  await p.locator('.vd-editor').waitFor({ state: 'hidden' });
};
const press = (p, key) => p.keyboard.press(key);
const library = (p) => p.evaluate((key) => JSON.parse(localStorage.getItem(key)), libraryKey);
const camera = (p) => p.evaluate((key) => JSON.parse(localStorage.getItem(key)), cameraKey);
function sorted(space) {
  return space.notes.map((n) => n.id).sort();
}
async function eventually(read, check) {
  const limit = Date.now() + 4400;
  for (;;) {
    const actual = await read();
    try {
      check(actual);
      return actual;
    } catch (error) {
      if (Date.now() >= limit) throw error;
    }
    await delay(45);
  }
}
const saved = (p, check) =>
  eventually(
    () => library(p),
    (l) => check(l.spaces[l.active], l)
  );
const focused = (p) => p.evaluate(() => document.activeElement?.textContent.trim());
async function at(p, x, y) {
  const box = await onMap(p).boundingBox();
  return { x: box.x + box.width / 2 + x, y: box.y + box.height / 2 + y };
}
async function clickAt(p, x, y, opts) {
  const loc = await at(p, x, y);
  await p.mouse.click(loc.x, loc.y, opts);
}
async function drag(p, x, y, dx, dy) {
  const a = await at(p, x, y);
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  await p.mouse.move(a.x + dx, a.y + dy, { steps: 10 });
  await p.mouse.up();
}
async function confirm(p, label) {
  await button(p.getByRole('dialog'), label).click();
}
async function menu(p, label) {
  await p.getByRole('menuitem', { name: label, exact: true }).click();
}
async function setup(seed, notes, areas = [], mapInk = []) {
  await seed({ notes, areas, mapInk });
}

async function seedProjects(p, origin, spaces) {
  await p.goto(origin + '/__qa_seed');
  await p.evaluate(({ spaces, libraryKey }) => {
    localStorage.setItem(libraryKey, JSON.stringify({
      version: 3, active: 'personal', spaces, view: { manualLayout: true }, plugins: []
    }));
  }, { spaces, libraryKey });
  await p.goto(origin);
  await eventually(() => p.locator('#space-name').innerText(), label => assert.equal(label, spaces.personal.name));
}

async function switchProject(p, name) {
  await p.locator('#workspace-switch').click();
  await p.getByRole('menuitemradio', { name, exact: true }).click();
  await eventually(() => p.locator('#space-name').innerText(), label => assert.equal(label, name));
}

export const cases = {
  async 'map.mixed-delete'({ page: p, primary, seed }) {
    const ink = [stroke('One', -100), stroke('Two', 15)];
    await setup(seed, [note('Outside', 200, 90)], [], ink);
    await onMap(p).focus();
    await press(p, primary + '+a');
    await press(p, 'Delete');
    assert.match(await p.locator('#toast').innerText(), /select the notes separately/i);
    await press(p, 'Escape');
    await drag(p, -130, -25, 205, 70);
    await button(p, 'Group').waitFor();
    await button(p, 'Zoom in').click();
    await press(p, 'Delete');
    await saved(p, (s) => {
      assert.equal(s.mapInk?.length ?? 0, 0);
      assert.deepEqual(sorted(s), ['Outside']);
    });
    await press(p, primary + '+z');
    await saved(p, (s) => assert.deepEqual(s.mapInk, ink));
    await p.reload();
    await tree(p, 'Outside').waitFor();
    await saved(p, (s) => assert.deepEqual(s.mapInk, ink));
  },
  async 'map.group-move'({ page: p, primary, seed }) {
    const frame = { id: 'frame', type: 'rect', x: 20, y: 0, w: 100, h: 55, lineWidth: 3, stroke: '#999999' };
    await setup(seed, [note('Node', -90, 0)], [], [frame]);
    await clickAt(p, -90, 0);
    await p.keyboard.down('Shift');
    await clickAt(p, 70, 0);
    await p.keyboard.up('Shift');
    await button(p, 'Group').waitFor();
    await press(p, primary + '+g');
    const group = await saved(p, (s) => {
      assert.ok(s.notes[0].mapGroupId);
      assert.equal(s.mapInk[0].mapGroupId, s.notes[0].mapGroupId);
    });
    const initial = group.spaces.personal;
    await drag(p, 70, 0, 58, 37);
    await saved(p, (s) => {
      const dx = s.mapInk[0].x - frame.x,
        dy = s.mapInk[0].y - frame.y;
      assert.ok(dx > 45 && dy > 25);
      assert.equal(s.notes[0].x - initial.notes[0].x, dx);
      assert.equal(s.notes[0].y - initial.notes[0].y, dy);
    });
    await press(p, primary + '+z');
    await saved(p, (s) =>
      assert.deepEqual([s.notes[0].x, s.notes[0].y, s.mapInk[0].x, s.mapInk[0].y], [-90, 0, 20, 0])
    );
    await press(p, primary + '+Shift+g');
    await saved(p, (s) => {
      assert.ok(!s.notes[0].mapGroupId && !s.mapInk[0].mapGroupId);
      assert.equal(s.mapInk[0].id, 'frame');
    });
  },
  async 'map.list-range'({ page: p, primary, seed }) {
    await setup(
      seed,
      ['A', 'B', 'C', 'D'].map((id, i) =>
        note(id, 100 * i, 0, { modified: 4 - i, links: id === 'D' ? ['B'] : [] })
      )
    );
    await p.locator('[data-page=list]').click();
    const checks = p.locator('.note-check');
    await checks.first().click();
    await checks.nth(2).click({ modifiers: ['Shift'] });
    assert.match(await p.locator('#list-selection').innerText(), /3/);
    await press(p, 'Delete');
    await confirm(p, 'Cancel');
    assert.equal(await checks.count(), 4);
    assert.equal(await p.locator('.note-check:checked').count(), 3);
    await press(p, 'Delete');
    await confirm(p, 'Delete');
    await saved(p, (s) => {
      assert.deepEqual(sorted(s), ['D']);
      assert.deepEqual(s.notes[0].links, []);
    });
    await press(p, primary + '+z');
    await saved(p, (s) => {
      assert.deepEqual(sorted(s), ['A', 'B', 'C', 'D']);
      assert.deepEqual(s.notes.find((n) => n.id === 'D').links, ['B']);
    });
  },
  async 'map.row-focus'({ page: p, primary, seed }) {
    await setup(
      seed,
      ['A', 'B', 'C', 'D'].map((id, i) => note(id, 80 * i, 0, { modified: 4 - i }))
    );
    await p.locator('[data-page=list]').click();
    await p.locator('.note-check').first().click();
    await press(p, 'Delete');
    assert.match(await p.getByRole('dialog').innerText(), /“A”/);
    await confirm(p, 'Cancel');
    await button(p, 'Clear selection').click();
    const rows = p.locator('#list-stage .note-row');
    await rows.first().click({ modifiers: [primary] });
    await rows.nth(2).click({ modifiers: ['Shift'] });
    await button(p, 'Move to area…').click();
    const picker = p.locator('.area-picker');
    const field = picker.getByRole('textbox');
    await field.fill('XYZ');
    await field.press(primary === 'Meta' ? 'Meta+ArrowLeft' : 'Home');
    await field.press('Delete');
    assert.equal(await field.inputValue(), 'YZ');
    await field.press('Escape');
    await rows.nth(3).click();
    await press(p, 'Delete');
    assert.match(await p.getByRole('dialog').innerText(), /Selected notes · 4/);
    await confirm(p, 'Cancel');
    assert.equal(await rows.count(), 4);
  },
  async 'map.pinned-filter'({ page: p, primary, seed }) {
    await setup(seed, [
      note('A', -90, 0, { pinned: false }),
      note('B', 30),
      note('C', 140, 0, { pinned: false })
    ]);
    await tree(p, 'A').click({ button: 'right' });
    await menu(p, 'Pin');
    await p.locator('[data-page=pinned]').click();
    const names = p.locator('#list-stage .note-row[data-note-id]');
    assert.deepEqual((await names.evaluateAll((rows) => rows.map((r) => r.dataset.noteId))).sort(), [
      'A',
      'B'
    ]);
    await names.first().focus();
    await press(p, primary + '+a');
    await press(p, 'Delete');
    await confirm(p, 'Delete');
    await saved(p, (s) => {
      assert.deepEqual(sorted(s), ['C']);
      assert.equal(s.notes[0].plain, 'C');
    });
    await press(p, primary + '+z');
    await saved(p, (s) =>
      assert.deepEqual(
        s.notes
          .filter((n) => n.pinned)
          .map((n) => n.id)
          .sort(),
        ['A', 'B']
      )
    );
    await p.locator('[data-page=map]').click();
    await onMap(p).waitFor();
    assert.equal(await p.locator('#all-count').innerText(), '3');
  },
  async 'map.tree-return'({ page: p, seed }) {
    await setup(
      seed,
      [note('Leaf', 200, 0, { areaId: 'Inner' })],
      [area('Outer'), area('Inner', { parentId: 'Outer' })]
    );
    await button(p, 'Zoom in').click();
    const zoom = await p.locator('#actual-size').innerText();
    await folder(p, 'Outer').focus();
    await press(p, 'ArrowLeft');
    await tree(p, 'Leaf').waitFor({ state: 'detached' });
    await press(p, 'ArrowRight');
    await tree(p, 'Leaf').waitFor();
    await press(p, 'ArrowRight');
    await press(p, 'ArrowRight');
    assert.equal(await focused(p), 'Leaf');
    await press(p, 'Enter');
    await p.locator('.ve-title').waitFor();
    assert.equal(await p.locator('.ve-title').inputValue(), 'Leaf');
    await back(p);
    assert.equal(await p.locator('#actual-size').innerText(), zoom);
    assert.equal(await focused(p), 'Leaf');
  },
  async 'map.tree-virtual'({ page: p, seed }) {
    const ids = Array.from({ length: 140 }, (_, i) => 'Note ' + String(i).padStart(3, '0'));
    await setup(
      seed,
      ids.map((id, i) => note(id, 50 * i, 0))
    );
    await tree(p, ids[0]).focus();
    assert.equal(await tree(p, ids.at(-1)).count(), 0);
    await press(p, 'End');
    assert.equal(await focused(p), ids.at(-1));
    await press(p, 'Enter');
    assert.equal(await p.locator('.ve-title').inputValue(), ids.at(-1));
    await back(p);
    assert.equal(await focused(p), ids.at(-1));
  },
  async 'map.empty-grid'({ page: p, primary, seed }) {
    await setup(seed, [note('Keep')]);
    await button(p, 'Create area').click();
    const d = p.getByRole('dialog');
    await button(d, 'Grid').click();
    await d.getByLabel('Columns', { exact: true }).fill('2');
    await d.getByLabel('Rows', { exact: true }).fill('2');
    await button(d, 'Create area').click();
    const lib = await saved(p, (s) => {
      assert.equal(s.areas.length, 1);
      assert.equal(s.areas[0].name, '');
    });
    const id = lib.spaces.personal.areas[0].id;
    await folder(p, id).click();
    await button(p, 'Show on map').click();
    await folder(p, id).focus();
    await press(p, 'Delete');
    await saved(p, (s) => {
      assert.equal(s.areas.length, 0);
      assert.deepEqual(sorted(s), ['Keep']);
    });
    await press(p, primary + '+z');
    await saved(p, (s) => assert.equal(s.areas[0]?.id, id));
    await p.reload();
    await folder(p, id).waitFor();
    await saved(p, (s) => {
      const a = s.areas[0];
      assert.deepEqual([a.name, a.grid.cols, a.grid.rows], ['', 2, 2]);
    });
  },
  async 'map.nested-promotion'({ page: p, primary, seed }) {
    await setup(
      seed,
      [note('Leaf', 0, 0, { areaId: 'Middle', links: ['Peer'] }), note('Peer', 200)],
      [area('Top'), area('Middle', { parentId: 'Top' }), area('Inner', { parentId: 'Middle' })]
    );
    await folder(p, 'Middle').focus();
    await press(p, 'Delete');
    await confirm(p, 'Delete area');
    const placed = (s, parent) => {
      assert.equal(s.notes.find((n) => n.id === 'Leaf').areaId, parent);
      assert.equal(s.areas.find((a) => a.id === 'Inner').parentId, parent);
      assert.deepEqual(s.notes.find((n) => n.id === 'Leaf').links, ['Peer']);
    };
    await saved(p, (s) => {
      assert.equal(s.areas.length, 2);
      placed(s, 'Top');
    });
    await press(p, primary + '+z');
    await saved(p, (s) => {
      assert.equal(s.areas.length, 3);
      placed(s, 'Middle');
    });
    await folder(p, 'Top').focus();
    await press(p, 'ArrowLeft');
    await folder(p, 'Inner').waitFor({ state: 'detached' });
    await press(p, 'ArrowRight');
    await folder(p, 'Inner').waitFor();
  },
  async 'map.links-layout'({ page: p, seed }) {
    await setup(seed, [note('A', -140), note('B', 0), note('C', 140)]);
    await onMap(p).focus();
    await press(p, 'l');
    await clickAt(p, -140, 0);
    await press(p, 'Escape');
    assert.equal(await p.locator('#link-message').isVisible(), false);
    await press(p, 'l');
    await clickAt(p, -140, 0);
    await clickAt(p, 0, 0);
    await saved(p, (s) => assert.deepEqual(s.notes.find((n) => n.id === 'A').links, ['B']));
    await press(p, 'Escape');
    await press(p, 'l');
    await clickAt(p, 0, 0);
    await clickAt(p, -140, 0);
    assert.match(await p.locator('#toast').innerText(), /already linked|already have a manual link/i);
    await press(p, 'Escape');
    for (const enabled of [false, true]) {
      await p.locator('#view').click();
      await p.getByRole('menuitemcheckbox', { name: 'Free layout' }).click();
      await saved(p, (s, l) => assert.equal(l.view.manualLayout, enabled));
    }
    await p.locator('[data-page=pinned]').click();
    assert.equal(await p.locator('.note-row[data-note-id]').count(), 3);
    await saved(p, (s) =>
      assert.deepEqual(
        s.notes.flatMap((n) => n.links),
        ['B']
      )
    );
  },
  async 'map.grid-swap'({ page: p, primary, seed }) {
    const g = { ...grid(), parentId: 'Parent' };
    await setup(
      seed,
      [note('A', -85, 0, { areaId: 'Grid', slot: 0 }), note('B', 55, 0, { areaId: 'Grid', slot: 1 })],
      [area('Parent'), g]
    );
    const seats = (s) => s.notes.map((n) => [n.areaId, n.slot]);
    await drag(p, -85, 0, 140, 0);
    await saved(p, (s) =>
      assert.deepEqual(seats(s), [
        ['Grid', 1],
        ['Grid', 0]
      ])
    );
    await press(p, primary + '+z');
    await saved(p, (s) =>
      assert.deepEqual(seats(s), [
        ['Grid', 0],
        ['Grid', 1]
      ])
    );
    await press(p, 'Escape');
    await tree(p, 'A').click({ button: 'right' });
    await menu(p, 'Take out of grid');
    await saved(p, (s) => {
      assert.equal(s.notes[0].areaId, 'Parent');
      assert.ok(s.notes[0].slot == null);
    });
    await press(p, primary + '+z');
    await saved(p, (s) =>
      assert.deepEqual(seats(s), [
        ['Grid', 0],
        ['Grid', 1]
      ])
    );
  },
  async 'map.grid-capacity'({ page: p, primary, seed }) {
    await setup(
      seed,
      [note('A', -85, 0, { areaId: 'Grid', slot: 0 }), note('B', 55, 0, { areaId: 'Grid', slot: 1 })],
      [grid()]
    );
    await folder(p, 'Grid').click({ button: 'right' });
    await menu(p, 'Edit area');
    const d = p.getByRole('dialog');
    const cols = d.getByLabel('Columns', { exact: true });
    await cols.fill('1');
    await button(d, 'Save').click();
    assert.match(await d.getByRole('status').innerText(), /more slots/i);
    await cols.fill('2');
    await d.getByRole('spinbutton', { name: 'Horizontal spacing' }).fill('120');
    await d.getByRole('spinbutton', { name: 'Vertical spacing' }).fill('70');
    await button(d, 'Save').click();
    await saved(p, (s) => assert.deepEqual([s.areas[0].grid.spacing, s.areas[0].grid.rowSpacing], [120, 70]));
    await press(p, primary + '+z');
    await saved(p, (s) => {
      assert.deepEqual(s.areas[0].grid, grid().grid);
      assert.deepEqual(
        s.notes.map((n) => n.slot),
        [0, 1]
      );
    });
  },
  async 'map.stage-undo'({ page: p, primary, seed }) {
    const track = grid({ stages: ['Inbox', 'Done'] });
    await setup(
      seed,
      [note('A', -85, 0, { areaId: 'Grid', slot: 0 }), note('B', 55, 0, { areaId: 'Grid', slot: 1 })],
      [track]
    );
    const add = p.locator('.stage-insert[data-insert-index="1"]');
    await add.focus();
    await add.press('Enter');
    const d = p.getByRole('dialog', { name: 'Insert stage' });
    await d.getByRole('textbox').fill('Review');
    await d.getByRole('textbox').press('Enter');
    await saved(p, (s) => {
      assert.deepEqual(s.areas[0].grid.stages, ['Inbox', 'Review', 'Done']);
      assert.deepEqual(
        s.notes.map((n) => n.slot),
        [0, 2]
      );
    });
    await press(p, primary + '+z');
    const restored = (s) => {
      assert.deepEqual(s.areas[0].grid.stages, ['Inbox', 'Done']);
      assert.deepEqual(
        s.notes.map((n) => n.slot),
        [0, 1]
      );
    };
    await saved(p, restored);
    const plusBox = await add.boundingBox();
    const header = await at(p, -85, 0);
    await p.mouse.click(header.x, plusBox.y - 13, { button: 'right' });
    await menu(p, 'Delete stage…');
    const remove = p.getByRole('dialog');
    const choices = await remove.locator('option').allTextContents();
    await remove
      .getByRole('combobox')
      .selectOption({ label: choices.find((label) => label.includes('Done')) });
    await button(remove, 'Delete stage').click();
    await saved(p, (s) => {
      assert.deepEqual(s.areas[0].grid.stages, ['Done']);
      assert.deepEqual(
        s.notes.map((n) => n.areaId),
        ['Grid', 'Grid']
      );
      assert.equal(new Set(s.notes.map((n) => n.slot)).size, 2);
    });
    await press(p, primary + '+z');
    await saved(p, restored);
  },
  async 'map.route-order'({ page: p, seed }) {
    await setup(seed, [note('West', -140, 90), note('East', 100, 90)]);
    const initial = await camera(p);
    await button(p, 'Routes').click();
    await button(p, 'New route').click();
    await p.getByPlaceholder('Route name').fill('Visit');
    await clickAt(p, -140, 90);
    await clickAt(p, 100, 90);
    await button(p, 'Stops and excerpts').click();
    await p.locator('.route-edit-stops li').nth(1).getByRole('button', { name: 'Move up' }).click();
    await button(p, 'Save route').click();
    await button(p, 'Play route · Visit').click();
    assert.equal(await p.locator('.route-caption strong').innerText(), 'East');
    await eventually(
      () => p.locator('#actual-size').innerText(),
      (value) => assert.ok(parseInt(value, 10) >= 130)
    );
    await press(p, 'ArrowRight');
    assert.equal(await p.locator('.route-caption strong').innerText(), 'West');
    await press(p, 'Escape');
    await p.locator('.route-caption').waitFor({ state: 'detached' });
    await eventually(
      () => p.locator('#actual-size').innerText(),
      (value) => assert.equal(value, '100%')
    );
    await eventually(
      () => camera(p),
      (c) => assert.deepEqual(c, initial)
    );
    await saved(p, (s) =>
      assert.deepEqual(
        s.routes[0].stops.map((q) => q.noteId),
        ['East', 'West']
      )
    );
    await clickAt(p, -140, 90, { clickCount: 2 });
    assert.equal(await p.locator('.ve-title').inputValue(), 'West');
  },
  async 'map.draw-caption'({ page: p, primary, seed }) {
    await setup(seed, [note('Keep', 210, 130)]);
    await onMap(p).focus();
    await press(p, 'p');
    await button(p, 'Rectangle').click();
    await p.keyboard.down('Shift');
    await drag(p, -120, -45, 105, 64);
    await p.keyboard.up('Shift');
    await saved(p, (s) => {
      assert.equal(s.mapInk[0].type, 'rect');
      assert.equal(s.mapInk[0].w, s.mapInk[0].h);
    });
    await button(p, 'Text').click();
    await clickAt(p, 100, 80);
    const caption = p.getByRole('textbox', { name: 'Map text' });
    await caption.fill('First');
    await caption.press('Enter');
    await p.keyboard.insertText('Second');
    await caption.press(primary + '+Enter');
    await button(p, 'Finish drawing').click();
    await saved(p, (s) => assert.equal(s.mapInk[1].text, 'First\nSecond'));
    await onMap(p).focus();
    await press(p, primary + '+z');
    await saved(p, (s) =>
      assert.deepEqual(
        s.mapInk.map((i) => i.type),
        ['rect']
      )
    );
    await p.reload();
    await tree(p, 'Keep').waitFor();
    await saved(p, (s) =>
      assert.deepEqual(
        s.mapInk.map((i) => i.type),
        ['rect']
      )
    );
  },
  async 'map.workspace-undo'({ page: p, primary, origin }) {
    const spaces = {
      personal: {
        name: 'First audit space',
        areas: [],
        notes: [note('Same', 0, 0, { title: 'First copy', links: ['Peer'] }), note('Peer', 160)]
      },
      other: { name: 'Second audit space', areas: [], notes: [note('Same', 0, 0, { title: 'Second copy' })] }
    };
    await seedProjects(p, origin, spaces);
    await tree(p, 'Same').focus();
    await press(p, 'Delete');
    await confirm(p, 'Delete');
    await saved(p, (s) => assert.deepEqual(sorted(s), ['Peer']));
    await switchProject(p, 'Second audit space');
    await onMap(p).focus();
    await press(p, primary + '+z');
    assert.equal((await tree(p, 'Same').innerText()).trim(), 'Second copy');
    await switchProject(p, 'First audit space');
    await onMap(p).focus();
    await press(p, primary + '+z');
    await saved(p, (s) => {
      assert.deepEqual(sorted(s), ['Peer', 'Same']);
      assert.deepEqual(s.notes.find((n) => n.id === 'Same').links, ['Peer']);
      assert.equal(s.notes.find((n) => n.id === 'Same').title, 'First copy');
    });
  },
  async 'map.editor-project-history'({page:p,primary,origin,openNote}) {
    const spaces={
      personal:{name:'Writing',areas:[],notes:[note('shared',0,0)]},
      other:{name:'Analysis',areas:[],notes:[note('shared',150,30,{
        title:'Data copy',type:'data',body:[],dataText:'in B',dataLanguage:'text'
      })]}
    };
    await seedProjects(p,origin,spaces);
    await drag(p,0,0,80,-30);
    await saved(p,s=>assert.ok(s.notes[0].x>60));
    await openNote('shared');
    const text=p.locator('.ve-content .ve-text').first();
    const end=primary==='Meta'?'Meta+ArrowRight':'End';
    await text.press(end);
    await p.keyboard.insertText(' in A');
    assert.equal(await text.innerText(),'shared in A');
    await back(p);
    await switchProject(p,'Analysis');
    await openNote('shared');
    const field=p.locator('.cm-content');
    const dataText=async()=>(await field.locator('.cm-line').allTextContents()).join('\n');
    await field.press(end);
    await p.keyboard.press(primary+'+z');
    assert.equal(await dataText(),'in B');
    await p.keyboard.insertText(' only');
    assert.equal(await dataText(),'in B only');
    await p.keyboard.press(primary+'+z');
    assert.equal(await dataText(),'in B');
    await p.keyboard.press(primary+'+Shift+z');
    assert.equal(await dataText(),'in B only');
    await back(p);
    await switchProject(p,'Writing');
    await openNote('shared');
    await text.press(end);
    await p.keyboard.press(primary+'+z');
    assert.equal(await text.innerText(),'shared');
    await p.keyboard.press(primary+'+Shift+z');
    assert.equal(await text.innerText(),'shared in A');
    await p.keyboard.insertText(' again');
    await p.keyboard.press(primary+'+z');
    assert.equal(await text.innerText(),'shared in A');
    await back(p);
    await onMap(p).focus();
    await p.keyboard.press(primary+'+z');
    await saved(p,(s,l)=>{
      assert.deepEqual([s.notes[0].x,s.notes[0].y,s.notes[0].plain],[0,0,'shared in A']);
      const [copy]=l.spaces.other.notes;
      assert.deepEqual([copy.x,copy.y,copy.dataText],[150,30,'in B only']);
    });
    await switchProject(p,'Analysis');await openNote('shared');
    await field.press(end);await p.keyboard.press(primary+'+z');
    assert.equal(await dataText(),'in B');
    await back(p);await switchProject(p,'Writing');await switchProject(p,'Analysis');await openNote('shared');
    await field.press(end);await p.keyboard.press(primary+'+Shift+z');
    assert.equal(await dataText(),'in B only');
    await back(p);await switchProject(p,'Writing');
    await p.reload();
    await openNote('shared');
    await text.press(end);await p.keyboard.press(primary+'+z');
    assert.equal(await text.innerText(),'shared in A');
    await back(p);
    await switchProject(p,'Analysis');
    await openNote('shared');
    await field.press(end);await p.keyboard.press(primary+'+z');
    assert.equal(await dataText(),'in B only');
  },
  async 'map.undo-peer-move'({page:p,primary}) {
    await p.evaluate(()=>localStorage.setItem('videron.map-camera.v1.shared',JSON.stringify({x:0,y:0,zoom:1})));
    const peer=await scriptedPeer(p);
    await drag(p,240,0,-35,45);
    await eventually(()=>peer.record('peer'),n=>assert.ok(n.x<225 && n.y>35));
    await drag(p,0,0,65,30);
    await eventually(()=>peer.record('draft'),n=>assert.ok(n.x>55 && n.y>20));
    await peer.publishFields('draft','Base',{x:-70,y:110});
    await eventually(()=>peer.record('draft'),n=>assert.deepEqual([n.x,n.y],[-70,110]));
    await onMap(p).focus();
    await press(p,primary+'+z');
    const toast=p.locator('#toast');
    await toast.filter({hasText:/previous location is no longer available|Move undone/i}).waitFor();
    const firstFeedback=await toast.innerText();
    await press(p,primary+'+z');
    await eventually(()=>peer.record('peer'),n=>assert.deepEqual([n.x,n.y],[240,0]));
    const draft=peer.record('draft');
    assert.deepEqual([draft.x,draft.y,draft.plain],[-70,110,'Base']);
    assert.match(firstFeedback,/previous location is no longer available/i);
    await switchProject(p,'Other');
    await switchProject(p,'Shared');
    // A fresh drag at the remote position must actually pick up the shared note.
    await drag(p,-70,110,25,0);
    await eventually(()=>peer.record('draft'),n=>assert.deepEqual([n.x,n.y],[-45,110]));
    await press(p,primary+'+z');
    await eventually(()=>peer.record('draft'),n=>assert.deepEqual([n.x,n.y],[-70,110]));
  },
  async 'map.camera-return'({ page: p, primary, seed }) {
    await setup(seed, [note('Keep', 200)]);
    await onMap(p).focus();
    await press(p, 'h');
    await drag(p, -180, -140, 80, 40);
    await press(p, 'v');
    await button(p, 'Zoom in').click();
    const before = await eventually(
      () => camera(p),
      (c) => {
        assert.ok(c.x < -40 && c.y < -15 && c.zoom > 1);
      }
    );
    await p.locator('#sidebar-toggle').click();
    assert.equal(await p.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
    await p.locator('#sidebar-toggle').click();
    await onMap(p).focus();
    await press(p, primary + '+n');
    await p.locator('.ve-title').fill('New at center');
    await back(p);
    await saved(p, (s) => {
      const n = s.notes.find((n) => n.title === 'New at center');
      assert.ok(n);
      assert.ok(Math.abs(n.x - before.x) < 1 && Math.abs(n.y - before.y) < 1);
    });
    assert.equal(await p.locator('#actual-size').innerText(), '120%');
    await eventually(
      () => camera(p),
      (c) => assert.deepEqual(c, before)
    );
    await button(p, 'Actual size').click();
    assert.equal(await p.locator('#actual-size').innerText(), '100%');
    await saved(p, (s) => assert.equal(s.notes.length, 2));
  }
};
