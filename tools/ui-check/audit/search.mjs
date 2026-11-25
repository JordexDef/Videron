import assert from 'node:assert/strict';

const dialog = (p) => p.getByRole('dialog', { name: 'Search notes', exact: true });
const query = (p) => dialog(p).getByRole('combobox', { name: 'Search query' });
const note = (id, title, text, other = {}) => ({
  id,
  title,
  plain: text,
  body: [{ type: 'paragraph', runs: [{ text }] }],
  tags: [],
  links: [],
  x: 0,
  y: 0,
  created: 1,
  modified: 1,
  ...other
});
const area = (id, parentId) => ({ id, name: id, color: '#8295b1', parentId });
async function found(p, titles) {
  await p.waitForFunction(
    (expected) => {
      const rows = document.querySelector('.vs-results');
      if (
        !rows ||
        rows.getAttribute('aria-busy') === 'true' ||
        document.querySelector('.vs-status')?.dataset.state !== 'ready'
      )
        return false;
      const names = [...rows.querySelectorAll('[role=option] strong')].map((n) => n.textContent).sort();
      return JSON.stringify(names) === JSON.stringify(expected);
    },
    [...titles].sort()
  );
}
async function start(p, primary) {
  await p.locator('#graph').focus();
  await p.keyboard.press(primary + '+k');
  await query(p).waitFor();
}
async function back(p) {
  await p.locator('.vd-editor .ve-head button').first().click();
  await query(p).waitFor();
}
async function expectTitle(p, title) {
  await p.waitForFunction((v) => document.querySelector('.vd-editor .ve-title')?.value === v, title);
}

export const cases = {
  async 'search.draft-return'({ page: p, primary, openNote, seed }) {
    await seed({
      areas: [],
      notes: [
        note('draft', 'Field log', 'Copper'),
        note('a', 'Harbor', 'zebra', { modified: 30 }),
        note('b', 'Meadow', 'zebra', { modified: 20 })
      ]
    });
    await openNote('draft');
    const paragraph = p.locator('.ve-text').first();
    await paragraph.click();
    await paragraph.press(primary === 'Meta' ? 'Meta+ArrowRight' : 'End');
    await p.keyboard.insertText('Ω');
    await p.keyboard.press(primary + '+Shift+f');
    const q = query(p);
    await q.fill('CopperΩ');
    await found(p, ['Field log']);
    await q.fill('zebra');
    await found(p, ['Harbor', 'Meadow']);
    assert.deepEqual(await dialog(p).locator('[role=option] strong').allTextContents(), ['Harbor', 'Meadow']);
    await q.press('ArrowDown');
    await q.press('Enter');
    await expectTitle(p, 'Meadow');
    await back(p);
    await found(p, ['Harbor', 'Meadow']);
    assert.equal(await q.inputValue(), 'zebra');
    assert.equal(await dialog(p).locator('[role=option][aria-selected=true] strong').innerText(), 'Meadow');
    assert.deepEqual(await dialog(p).locator('[role=option] strong').allTextContents(), ['Harbor', 'Meadow']);
    await q.press('Escape');
    await expectTitle(p, 'Field log');
    assert.equal(await paragraph.innerText(), 'CopperΩ');
    await p.reload();
    await openNote('draft');
    assert.equal(await paragraph.innerText(), 'CopperΩ');
  },
  async 'search.area-filters'({ page: p, primary, seed }) {
    const notes = [
      note('parent', 'Parent pin', 'Fox', { areaId: 'Parent', pinned: true }),
      note('child', 'Child pin', 'Fox', { areaId: 'Child', pinned: true }),
      note('lo', 'Lowercase', 'fox', { areaId: 'Child', pinned: true }),
      note('loose', 'Unpinned', 'Fox', { areaId: 'Parent' }),
      note('other', 'Other area', 'Fox', { areaId: 'Other', pinned: true }),
      note('root', 'Outside', 'Fox', { pinned: true })
    ];
    await seed({ areas: [area('Parent'), area('Child', 'Parent'), area('Other')], notes });
    await start(p, primary);
    await query(p).fill('Fox');
    await found(
      p,
      notes.map((n) => n.title)
    );
    const d = dialog(p),
      scope = d.getByRole('combobox', { name: 'Search area' });
    await scope.selectOption('Parent');
    await found(p, ['Parent pin', 'Child pin', 'Unpinned', 'Lowercase']);
    await d.getByRole('button', { name: 'Match case' }).click();
    await found(p, ['Parent pin', 'Child pin', 'Unpinned']);
    await d.getByRole('button', { name: 'Pinned only' }).click();
    await found(p, ['Parent pin', 'Child pin']);
    await scope.selectOption('Child');
    await found(p, ['Child pin']);
    await scope.selectOption('_none');
    await found(p, ['Outside']);
    await query(p).press('Escape');
  },
  async 'search.regex-code'({ page: p, primary, seed }) {
    const text = Array.from({ length: 120 }, (_, i) =>
      i === 108 ? 'Message(ERR-42);' : 'log(' + i + ');'
    ).join('\n');
    await seed({
      areas: [],
      notes: [note('code', 'Trace', text, { body: [{ type: 'code', language: 'javascript', text }] })]
    });
    await start(p, primary);
    const d = dialog(p),
      q = query(p);
    await d.getByRole('button', { name: 'Regular expression' }).click();
    await q.fill('(');
    await p.locator('.vs-status[data-state=error]').waitFor();
    assert.match(await p.locator('.vs-status').innerText(), /invalid regular expression/i);
    await q.press('Enter');
    assert.equal(await d.isVisible(), true);
    const pattern = 'ERR-\\d{2}';
    await q.fill(pattern);
    await found(p, ['Trace']);
    assert.equal(await d.getByRole('option').locator('mark').innerText(), 'ERR-42');
    await q.press('Enter');
    await expectTitle(p, 'Trace');
    const field = p.locator('.ve-code-source');
    await p.locator('.ve-search-flash i').first().waitFor();
    assert.equal(await field.evaluate((f) => f.selectionStart), text.indexOf('ERR-42'));
    assert.deepEqual(await field.evaluate((f) => [f === document.activeElement, f.scrollTop > 0]), [
      true,
      true
    ]);
    const hit = await p.locator('.ve-search-flash i').first().boundingBox();
    const box = await field.boundingBox();
    assert.ok(hit.y >= box.y && hit.y + hit.height <= box.y + box.height + 1);
    await back(p);
    await found(p, ['Trace']);
    assert.equal(await q.inputValue(), pattern);
    assert.equal(
      await d.getByRole('button', { name: 'Regular expression' }).getAttribute('aria-pressed'),
      'true'
    );
    await q.press('Escape');
  },
  async 'search.space-isolation'({ page: p, primary, origin }) {
    await p.goto(origin + '/__qa_seed');
    const spaces = {
      personal: { name: 'North', areas: [], notes: [note('part', 'North journal', 'shared NorthOnly')] },
      south: { name: 'South', areas: [], notes: [note('part', 'South journal', 'shared SouthOnly')] }
    };
    await p.evaluate((spaces) => {
      localStorage.setItem(
        'videron.library.v1',
        JSON.stringify({ version: 3, active: 'personal', spaces, plugins: [], view: { manualLayout: true } })
      );
    }, spaces);
    await p.goto(origin);
    await start(p, primary);
    const q = query(p);
    await q.fill('shared');
    await found(p, ['North journal']);
    await q.press('Enter');
    await expectTitle(p, 'North journal');
    await back(p);
    await found(p, ['North journal']);
    await q.press('Escape');
    await p.locator('#workspace-switch').click();
    await p.getByRole('menuitemradio', { name: 'South', exact: true }).click();
    await p.waitForFunction(() => document.querySelector('#space-name').textContent === 'South');
    await start(p, primary);
    assert.equal(await q.inputValue(), '');
    await q.fill('shared');
    await found(p, ['South journal']);
    await q.fill('NorthOnly');
    await found(p, []);
    await q.press('Escape');
  },
  async 'search.latest-enter'({ page: p, primary, seed }) {
    await seed({ areas: [], notes: [note('left', 'Plateau', 'granite'), note('right', 'Marsh', 'willow')] });
    await start(p, primary);
    const q = query(p);
    await q.fill('granite');
    await found(p, ['Plateau']);
    await q.fill('willow');
    await q.press('Enter');
    await expectTitle(p, 'Marsh');
    await back(p);
    await found(p, ['Marsh']);
    await q.fill('not-in-any-note');
    await q.press('Enter');
    await found(p, []);
    assert.equal(await dialog(p).isVisible(), true);
    await q.press('Escape');
  }
};
