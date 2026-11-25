import assert from 'node:assert/strict';

const paragraph = (text) => ({ type: 'paragraph', runs: text ? [{ text }] : [] });
const code = (text, language = 'json') => ({ type: 'code', language, text });
const rich = (...blocks) => ({
  body: blocks.map((block) => (typeof block === 'string' ? paragraph(block) : block))
});
const data = (dataText, dataLanguage = 'text') => ({ type: 'data', dataText, dataLanguage, body: [] });
const rows = (page) => page.locator('.ve-text[contenteditable="true"]');
const block = (page) => page.locator('.ve-code-source');
const byButton = (page, name) => page.getByRole('button', { name, exact: true });
const undo = async (ctx) => ctx.page.keyboard.press(ctx.primary + '+z');
const redo = async (ctx) => ctx.page.keyboard.press(ctx.primary + '+Shift+z');
const home = (ctx) => (ctx.primary === 'Meta' ? 'Meta+ArrowLeft' : 'Home');
const end = (ctx) => (ctx.primary === 'Meta' ? 'Meta+ArrowRight' : 'End');
async function setup(ctx, note, other = []) {
  const notes = [{ id: 'draft', title: 'Audit draft', ...note }, ...other].map((n, i) => ({
    x: i * 120,
    y: 0,
    areaId: null,
    tags: [],
    links: [],
    body: [],
    bodyVersion: 1,
    plain: '',
    ...n
  }));
  await ctx.seed({ version: 1, areas: [], notes });
  await ctx.openNote('draft');
  await ctx.page.locator('.vd-editor').waitFor();
}
async function back(page) {
  await page.locator('.vd-editor .ve-head button').first().click();
  await page.locator('.vd-editor').waitFor({ state: 'hidden' });
}
function find(page) {
  const panel = page.locator('.note-find:visible');
  return {
    panel,
    q: panel.locator('input').first(),
    replacement: panel.locator('input').nth(1),
    act: (k) => panel.locator('[data-find-action="' + k + '"]'),
    count: panel.locator('output')
  };
}
async function openSearch(ctx, replace = false) {
  const { page, primary } = ctx;
  await page.keyboard.press(replace ? (primary === 'Meta' ? 'Meta+Alt+f' : 'Control+h') : primary + '+f');
  const f = find(page);
  await f.q.waitFor();
  return f;
}
async function count(f, value) {
  await f.count.filter({ hasText: new RegExp('^' + value + '$') }).waitFor();
}
async function grid(page) {
  await page.locator('[data-data-view=table]').click();
  await page.locator('.vd-grid-root[data-state=ready]').waitFor();
}
async function source(page) {
  await page.locator('[data-data-view=text]').click();
  await page.locator('.cm-content').waitFor();
}
async function waitLines(page, values) {
  await page.waitForFunction(
    (v) =>
      JSON.stringify([...document.querySelectorAll('.cm-line')].map((n) => n.textContent)) ===
      JSON.stringify(v),
    values
  );
}
async function lineOp(page, id) {
  await page.locator('.vd-data-menu-button').click();
  await page.locator('[data-operation="' + id + '"]').click();
}

// Resolve an offset from the actual rendered glyphs, including styled runs.
async function textPoint(field, offset) {
  return field.evaluate((node, at) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let leaf; (leaf = walker.nextNode()); ) {
      if (at <= leaf.length) {
        const range = document.createRange();
        range.setStart(leaf, at);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y + rect.height / 2 };
      }
      at -= leaf.length;
    }
    throw Error('Text point outside paragraph');
  }, offset);
}
async function dragText(page, start, finish, beforeRelease) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(finish.x, finish.y, { steps: 16 });
    if (beforeRelease) await beforeRelease();
  } finally {
    await page.mouse.up();
  }
}
async function captureClipboard(page) {
  // Exercise the application copy command without accessing the host clipboard.
  await page.evaluate(() => {
    window.runtime = { ...window.runtime, ClipboardSetText: async value => { window.auditCopied = value; } };
  });
}
export const cases = {
  'editor.rename-quote': async (ctx) => {
    const { page } = ctx, title = 'Расчёт / sprint 2', values = ['before', 'quoted', 'after'];
    await setup(ctx, rich(...values));
    await page.getByLabel('Note title').fill(title);
    await rows(page).nth(1).click();
    await page.locator('.ve-toolbar select').first().selectOption({ label: 'Quote' });
    await page.keyboard.press(ctx.primary + '+s');
    await back(page);
    await page.getByRole('treeitem', { name: title, exact: true }).click();
    assert.equal(await page.getByLabel('Note title').inputValue(), title);
    assert.deepEqual(await rows(page).allTextContents(), values);
    assert.deepEqual(await rows(page).evaluateAll(list => list.map(el => el.classList.contains('ve-quote'))), [false, true, false]);
  },
  'editor.inline-ink-link': async (ctx) => {
    const { page, primary } = ctx, row = rows(page).first(), url = 'https://example.test/notes?q=2';
    await setup(ctx, rich('a marked plain label end', 'outside'));
    async function select(from, to) {
      await dragText(page, await textPoint(row, from), await textPoint(row, to));
      assert.equal(await page.evaluate(() => getSelection().toString()), (await row.textContent()).slice(from, to));
    }
    await select(2, 8);
    await page.keyboard.press(primary + '+b');
    await select(2, 8);
    await page.keyboard.press(primary + '+i');
    await select(2, 8);
    await byButton(page, 'Text color').click();
    const swatch = page.locator('.ve-swatch').nth(2);
    const color = await swatch.evaluate(n => {
      const span = document.createElement('span');
      span.style.color = n.dataset.color;
      return span.style.color;
    });
    await swatch.click();
    await select(15, 20);
    await page.keyboard.press(primary + '+k');
    await page.getByPlaceholder('https://').fill(url);
    await byButton(page, 'Insert').click();
    await back(page);
    await ctx.openNote('draft');
    assert.deepEqual(await rows(page).allTextContents(), ['a marked plain label end', 'outside']);
    const marked = await row.evaluate(node => {
      const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let leaf; (leaf = walk.nextNode()); ) {
        if (leaf.data === 'marked') {
          const style = getComputedStyle(leaf.parentElement);
          return { bold: Number(style.fontWeight) >= 600, italic: style.fontStyle, color: style.color };
        }
      }
    });
    assert.deepEqual(marked, { bold: true, italic: 'italic', color });
    assert.equal(await row.locator('a').textContent(), 'label');
    assert.equal(await row.locator('a').getAttribute('href'), url);
    assert.deepEqual(await row.evaluate(n => [...n.childNodes].filter(v => v.nodeType === Node.TEXT_NODE).map(v => v.textContent)), ['a ', ' plain ', ' end']);
  },
  'editor.number-to-task': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich(''));
    await rows(page).click();
    await page.keyboard.type('1) first');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    const markers = () => rows(page).evaluateAll(nodes => nodes.map(n => n.dataset.marker));
    const before = await markers();
    assert.match(before[0], /^1[.)]$/);
    assert.match(before[1], /^2[.)]$/);
    await byButton(page, 'Task').click();
    assert.equal(await page.getByRole('checkbox', { name: 'Task complete' }).count(), 1);
    assert.equal(await rows(page).first().getAttribute('data-marker'), before[0]);
    assert.deepEqual(await rows(page).allTextContents(), ['first', 'second']);
    await undo(ctx);
    assert.deepEqual(await markers(), before);
    assert.equal(await page.getByRole('checkbox', { name: 'Task complete' }).count(), 0);
  },
  'editor.code-clipboard': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('left CODE right', 'LR'));
    await captureClipboard(page);
    const text = rows(page);
    await dragText(page, await textPoint(text.first(), 5), await textPoint(text.first(), 9));
    await byButton(page, 'Insert code block').click();
    assert.equal(await block(page).inputValue(), 'CODE');
    await block(page).fill('first\nsecond');
    await byButton(page, 'Copy code').click();
    assert.equal(await page.evaluate(() => window.auditCopied), 'first\nsecond');
    const at = await textPoint(text.last(), 1);
    await page.mouse.click(at.x, at.y);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', window.auditCopied);
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: data });
      document.activeElement.dispatchEvent(event);
    });
    assert.deepEqual(await text.allTextContents(), ['left ', ' right', 'Lfirst\nsecondR']);
    await undo(ctx);
    assert.deepEqual(await text.allTextContents(), ['left ', ' right', 'LR']);
    assert.equal(await block(page).inputValue(), 'first\nsecond');
  },
  'editor.erase-one-image': async (ctx) => {
    const { page } = ctx, src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/je0AAAAASUVORK5CYII=';
    const img = alt => ({ type: 'image', src, alt });
    await setup(ctx, rich('left', img('first'), img('second'), 'right'));
    const images = () => page.locator('.ve-media img').evaluateAll(nodes => nodes.map(n => n.alt));
    await page.locator('.ve-media').nth(1).hover();
    await byButton(page, 'Remove block').nth(1).click();
    assert.deepEqual(await images(), ['first']);
    assert.deepEqual(await rows(page).allTextContents(), ['left', 'right']);
    await undo(ctx);
    await back(page);
    await ctx.openNote('draft');
    assert.deepEqual(await images(), ['first', 'second']);
    assert.deepEqual(await rows(page).allTextContents(), ['left', 'right']);
  },
  'editor.drag-rich-span': async (ctx) => {
    const { page } = ctx, before = ['begin alpha', 'bravo', 'charlie end', 'destination'];
    await setup(ctx, rich(before[0], { type: 'paragraph', runs: [{ text: before[1], bold: true }] }, ...before.slice(2)));
    const text = rows(page), point = (i, k) => textPoint(text.nth(i), k);
    await dragText(page, await point(0, 6), await point(2, 7));
    await dragText(page, await point(1, 2), await point(3, 4), () => page.locator('.ve-text-drop-caret').waitFor());
    const after = ['begin  end', 'destalpha', 'bravo', 'charlieination'];
    assert.deepEqual(await text.allTextContents(), after);
    await undo(ctx);
    assert.deepEqual(await text.allTextContents(), before);
    await redo(ctx);
    await back(page);
    await ctx.openNote('draft');
    assert.deepEqual(await text.allTextContents(), after);
    assert.equal(await text.nth(2).locator('strong').textContent(), 'bravo');
  },
  'editor.data-edit-location': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, data('first,one\nkey,two\nkey,three'));
    await page.getByLabel('Data format').selectOption('csv');
    await page.locator('.cm-content').click();
    await page.keyboard.press(ctx.primary + '+g');
    const go = page.locator('.cm-panel input').first();
    await go.fill('3');
    await go.press('Enter');
    await page.keyboard.press(home(ctx));
    await page.keyboard.insertText('!');
    const original = ['first,one', 'key,two', '!key,three'];
    await waitLines(page, original);
    await page.keyboard.press(ctx.mac ? 'Meta+Alt+f' : 'Control+h');
    const panel = page.locator('.cm-search');
    const replacement = panel.locator('input[name=replace]');
    assert(await replacement.evaluate(n => n === document.activeElement));
    await panel.locator('input[name=search]').fill('key');
    await replacement.fill('new');
    await panel.locator('[name=replaceAll]').click();
    await waitLines(page, ['first,one', 'new,two', '!new,three']);
    await replacement.press('Escape');
    await undo(ctx);
    await waitLines(page, original);
    await back(page);
    await ctx.openNote('draft');
    assert.equal(await page.getByLabel('Data format').inputValue(), 'csv');
    await waitLines(page, original);
  },
  'editor.cancel-line-job': async (ctx) => {
    const { page } = ctx, values = ['z', 'b', 'a'];
    await setup(ctx, data(values.join('\n')));
    // Hold just the first real worker request to make the cancellation window deterministic.
    await page.evaluate(() => {
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (...args) {
        if (args[0]?.operation !== 'sort-asc') return send.apply(this, args);
        Worker.prototype.postMessage = send;
        window.auditReleaseJob = () => send.apply(this, args);
      };
    });
    await lineOp(page, 'sort-asc');
    await page.waitForFunction(() => !!window.auditReleaseJob);
    await byButton(page, 'Cancel').click();
    await page.getByText('Operation cancelled', { exact: true }).waitFor();
    await page.evaluate(() => window.auditReleaseJob());
    await waitLines(page, values);
    await lineOp(page, 'sort-asc');
    await waitLines(page, ['a', 'b', 'z']);
    await undo(ctx);
    await waitLines(page, values);
  },
  'editor.copy-grid-edges': async (ctx) => {
    const { page, primary } = ctx, value = 'last,cell\n' + 'full text '.repeat(250) + 'END';
    const records = Array.from({ length: 80 }, (_, r) => Array.from({ length: 20 }, (_, c) => 'r' + r + 'c' + c));
    records[1][0] = 'first';
    records.at(-1)[19] = '"' + value + '"';
    await setup(ctx, data(records.map(row => row.join(',')).join('\n'), 'csv'));
    await captureClipboard(page);
    await grid(page);
    await page.getByRole('gridcell', { name: 'first', exact: true }).click();
    for (const direction of ['Down','Right']) await page.keyboard.press(primary + '+Arrow' + direction);
    await page.keyboard.press(primary + '+c');
    await page.waitForFunction(v => window.auditCopied === v, value);
    for (const direction of ['Up','Left']) await page.keyboard.press(primary + '+Arrow' + direction);
    await page.keyboard.press(primary + '+c');
    await page.waitForFunction(() => window.auditCopied === 'first');
    assert.equal(await page.locator('[role=gridcell][aria-selected=true]').innerText(), 'first');
  },
  'editor.clipboard-paste': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('KEEP prefix', 'suffix END', 'outside'));
    const text = rows(page);
    // Use real pointer selection. Supply standard clipboard formats in memory
    // so this check never replaces the clipboard of the person running it.
    await text.first().scrollIntoViewIfNeeded();
    for (const reverse of [false, true]) {
      const a = await textPoint(text.first(), 5),
        b = await textPoint(text.nth(1), 6);
      const [start, finish] = reverse ? [b, a] : [a, b];
      await dragText(page, start, finish);
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/html', '<div><b>ONE</b></div><div><i>TWO</i></div>');
        data.setData('text/plain', 'ONE\nTWO');
        const ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: data });
        const field = document.activeElement.closest('.ve-text');
        if (!field) throw Error('Paste target lost note focus');
        field.dispatchEvent(ev);
      });
      assert.deepEqual(await text.allTextContents(), ['KEEP ONE', 'TWO END', 'outside']);
      const marks = await text.evaluateAll((fields) => {
        function property(word, key) {
          const walker = document.createTreeWalker(
            fields.find((node) => node.textContent.includes(word)),
            NodeFilter.SHOW_TEXT
          );
          for (let leaf; (leaf = walker.nextNode()); )
            if (leaf.data.includes(word)) return getComputedStyle(leaf.parentElement)[key];
        }
        return [property('ONE', 'fontWeight'), property('TWO', 'fontStyle')];
      });
      assert(Number(marks[0]) >= 600);
      assert.equal(marks[1], 'italic');
      await text.nth(1).click();
      const styles = page.locator('.ve-toolbar select').first();
      const heading = 've-heading';
      await styles.selectOption({ label: 'Heading' });
      assert(!(await text.first().getAttribute('class')).includes(heading));
      assert((await text.nth(1).getAttribute('class')).includes(heading));
      await undo(ctx);
      await undo(ctx);
      assert.deepEqual(await text.allTextContents(), ['KEEP prefix', 'suffix END', 'outside']);
    }
  },
  'editor.regex-captures': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('item-12', code('{"value":"item-34"}')));
    await rows(page).first().click();
    const f = await openSearch(ctx, true);
    await f.act('regex').click();
    await f.q.fill('item-(\\d+)');
    await f.replacement.fill('ref:$1');
    await f.count.filter({ hasText: /[12] \/ 2/ }).waitFor();
    await f.act('replaceAll').click();
    assert.equal(await rows(page).first().innerText(), 'ref:12');
    assert.equal(await block(page).inputValue(), '{"value":"ref:34"}');
    await page.keyboard.press('Escape');
    await undo(ctx);
    assert.equal(await rows(page).first().innerText(), 'item-12');
    assert.equal(await block(page).inputValue(), '{"value":"item-34"}');
  },
  'editor.bad-regex': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('cat cat'));
    await rows(page).click();
    const f = await openSearch(ctx);
    await f.act('regex').click();
    await f.q.fill('(');
    await count(f, 'Invalid regex');
    assert(await f.act('next').isDisabled());
    assert.equal(await f.q.getAttribute('aria-invalid'), 'true');
    await f.q.fill('cat');
    await count(f, '1 / 2');
    await f.act('next').click();
    await count(f, '2 / 2');
  },
  'editor.word-case': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('CAT cat catfish'));
    await rows(page).click();
    await page.keyboard.press(home(ctx));
    const f = await openSearch(ctx);
    await f.q.fill('cat');
    await count(f, '1 / 3');
    await f.act('wholeWord').click();
    await count(f, '1 / 2');
    await f.act('matchCase').click();
    await count(f, '1 / 1');
    await f.act('matchCase').click();
    const before = await f.count.innerText();
    await f.q.press('Enter');
    assert.notEqual(await f.count.innerText(), before);
    await f.q.press('Shift+Enter');
    assert.equal(await f.count.innerText(), before);
    await f.q.press('Escape');
    assert.equal(await rows(page).innerText(), 'CAT cat catfish');
  },
  'editor.preserved-case': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('CAT cat Cat'));
    await rows(page).click();
    await page.keyboard.press(home(ctx));
    const f = await openSearch(ctx, true);
    await f.q.fill('cat');
    await f.replacement.fill('dog');
    await f.act('preserveCase').click();
    await f.act('replace').click();
    assert.equal(await rows(page).innerText(), 'DOG cat Cat');
    await f.act('replaceAll').click();
    assert.equal(await rows(page).innerText(), 'DOG dog Dog');
    await f.replacement.press('Escape');
    await undo(ctx);
    assert.equal(await rows(page).innerText(), 'DOG cat Cat');
  },
  'editor.find-history': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('alpha beta alpha beta'), [
      { id: 'other', title: 'Another note', ...rich('private') }
    ]);
    await rows(page).click();
    const f = await openSearch(ctx);
    await f.q.fill('alpha');
    await f.q.press('Enter');
    await f.q.fill('beta');
    await f.q.press('Enter');
    await f.q.press('ArrowUp');
    await f.q.press('ArrowUp');
    assert.equal(await f.q.inputValue(), 'alpha');
    await f.q.press('Escape');
    await back(page);
    await ctx.openNote('other');
    await rows(page).click();
    await openSearch(ctx);
    assert.equal(await f.q.inputValue(), '');
    await f.q.press('ArrowUp');
    assert.equal(await f.q.inputValue(), '');
  },
  'editor.scope-edit': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('fox fox', 'fox outside'));
    const field = rows(page).first();
    await field.click();
    await field.press(end(ctx));
    for (let i = 0; i < 3; i++) await field.press('Shift+ArrowLeft');
    const f = await openSearch(ctx, true);
    assert.equal(await f.q.inputValue(), 'fox');
    await f.act('scope').click();
    await f.replacement.fill('cat');
    await field.click();
    await field.press(home(ctx));
    await page.keyboard.insertText('fox ');
    await f.act('replaceAll').click();
    assert.deepEqual(await rows(page).allInnerTexts(), ['fox fox cat', 'fox outside']);
  },
  'editor.format-json-undo': async (ctx) => {
    const { page } = ctx,
      compact = '{"a":{"b":2}}';
    await setup(ctx, rich('before', code(compact), 'after'));
    await byButton(page, 'Format JSON').click();
    const formatted = await block(page).inputValue();
    assert(formatted.includes('\n'));
    assert.deepEqual(JSON.parse(formatted), { a: { b: 2 } });
    await block(page).click();
    await undo(ctx);
    assert.equal(await block(page).inputValue(), compact);
    await redo(ctx);
    assert.equal(await block(page).inputValue(), formatted);
    await back(page);
    await ctx.openNote('draft');
    assert.equal(await block(page).inputValue(), formatted);
    assert.deepEqual(await rows(page).allInnerTexts(), ['before', 'after']);
  },
  'editor.invalid-json': async (ctx) => {
    const { page } = ctx,
      invalid = '{"x":\n}';
    await setup(ctx, rich(code(invalid, 'plain'), 'untouched'));
    await page.getByLabel('Code language').selectOption('json');
    for (let i = 0; i < 2; i++) await byButton(page, 'Format JSON').click();
    assert.match(await page.locator('.ve-code-status').innerText(), /Invalid JSON.*line.*column/i);
    assert.equal(await block(page).inputValue(), invalid);
    assert(await block(page).evaluate((n) => n === document.activeElement));
    assert.equal(await rows(page).innerText(), 'untouched');
  },
  'editor.indent-code': async (ctx) => {
    const { page, primary } = ctx,
      original = 'red\nblue';
    await setup(ctx, rich(code(original, 'plain'), 'tail'));
    const field = block(page);
    await field.click();
    await field.press(primary + '+a');
    await field.press('Tab');
    assert((await field.inputValue()).split('\n').every((line) => /^\s+/.test(line)));
    await field.press('Shift+Tab');
    assert.equal(await field.inputValue(), original);
    await field.press(primary + '+Enter');
    await page.keyboard.insertText('!');
    assert.equal(await field.inputValue(), original);
    assert.equal(await rows(page).innerText(), '!tail');
  },
  'editor.remove-code-undo': async (ctx) => {
    const { page, primary } = ctx;
    await setup(ctx, rich('before', code('x = 2', 'python'), 'after'));
    await byButton(page, 'Remove code block').click();
    assert.equal(await block(page).count(), 0);
    assert.deepEqual(await rows(page).allInnerTexts(), ['before', 'after']);
    await undo(ctx);
    assert.equal(await block(page).inputValue(), 'x = 2');
    await page.keyboard.press(primary + '+s');
    await back(page);
    await ctx.openNote('draft');
    assert.equal(await page.getByLabel('Code language').inputValue(), 'python');
    assert.equal(await block(page).inputValue(), 'x = 2');
    assert.equal(await block(page).getAttribute('aria-label'), 'Code, block 2');
  },
  'editor.task-state': async (ctx) => {
    const { page, primary } = ctx;
    await setup(ctx, rich('Ship'));
    await rows(page).click();
    await byButton(page, 'Cancellable task').click();
    const done = page.getByRole('checkbox', { name: 'Task complete' }),
      cancel = page.getByRole('checkbox', { name: 'Task cancelled' });
    await rows(page).click();
    await page.keyboard.press(primary + '+Enter');
    assert.equal(await done.getAttribute('aria-checked'), 'true');
    await cancel.click();
    assert.equal(await done.getAttribute('aria-checked'), 'false');
    assert.equal(await cancel.getAttribute('aria-checked'), 'true');
    await undo(ctx);
    assert.equal(await done.getAttribute('aria-checked'), 'true');
    await redo(ctx);
    assert.equal(await cancel.getAttribute('aria-checked'), 'true');
    assert.equal(await rows(page).innerText(), 'Ship');
  },
  'editor.nested-list': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich(''));
    await rows(page).click();
    await page.keyboard.type('- Parent');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.insertText('Child');
    assert.equal(
      await rows(page)
        .last()
        .evaluate((n) => parseFloat(n.style.marginInlineStart)),
      20
    );
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    assert.deepEqual(
      (await rows(page).allTextContents()).map((s) => s.trim()),
      ['Parent', 'Child', '']
    );
    assert.equal(await page.locator('.ve-list-item').count(), 2);
    assert.equal(await rows(page).last().getAttribute('data-marker'), null);
  },
  'editor.divider-delete': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('before', '', 'after'));
    await rows(page).nth(1).click();
    await page.keyboard.type('---');
    await page.keyboard.press('Enter');
    const rule = page.getByRole('separator').and(page.locator('.ve-rule'));
    await rule.waitFor();
    await rule.focus();
    await page.keyboard.press('Delete');
    assert.equal(await rule.count(), 0);
    await undo(ctx);
    assert.equal(await rule.count(), 1);
    assert.deepEqual(await rows(page).allInnerTexts(), ['before', 'after']);
    assert.equal(await rule.evaluate((n) => n.previousElementSibling.textContent), 'before');
  },
  'editor.selected-lines': async (ctx) => {
    const { page } = ctx,
      initial = ['header', 'item10', 'item2', 'footer'];
    await setup(ctx, data(initial.join('\n')));
    await page.locator('.cm-line').nth(1).click();
    await page.keyboard.press(home(ctx));
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await lineOp(page, 'sort-asc');
    await waitLines(page, ['header', 'item2', 'item10', 'footer']);
    await undo(ctx);
    await waitLines(page, initial);
  },
  'editor.line-cleanup': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, data(' b \nb\n \na'));
    await lineOp(page, 'trim');
    await waitLines(page, ['b', 'b', '', 'a']);
    await page.locator('.cm-line').first().click();
    await lineOp(page, 'remove-empty');
    await waitLines(page, ['b', 'b', 'a']);
    await page.locator('.cm-line').first().click();
    await lineOp(page, 'unique');
    await waitLines(page, ['b', 'a']);
    await undo(ctx);
    await waitLines(page, ['b', 'b', 'a']);
  },
  'editor.csv-tuple': async (ctx) => {
    const { page } = ctx,
      initial = ['id,region,label', '1,US,first', '1,CA,keep', '1,US,later', '2,US,last'];
    await setup(ctx, data(initial.join('\n'), 'csv'));
    await grid(page);
    await page.getByRole('checkbox', { name: 'Compare duplicates by column id', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Compare duplicates by column region', exact: true }).check();
    await page.locator('.vd-grid-unique').click();
    await page.getByText('Duplicates removed: 1', { exact: true }).waitFor();
    await source(page);
    await waitLines(page, [initial[0], initial[1], initial[2], initial[4]]);
    await undo(ctx);
    await waitLines(page, initial);
  },
  'editor.csv-quoted-sort': async (ctx) => {
    const { page } = ctx,
      initial = ['id,note', '10,"one,two"', '2,"first', 'second"'];
    await setup(ctx, data(initial.join('\n'), 'csv'));
    await grid(page);
    await byButton(page, 'Sort by column id').click();
    await page.getByText('Sorted', { exact: true }).waitFor();
    await source(page);
    await waitLines(page, [initial[0], initial[2], initial[3], initial[1]]);
    await undo(ctx);
    await waitLines(page, initial);
  },
  'editor.tsv-first-row': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, data('alpha\t42\nbeta\t54', 'tsv'));
    await grid(page);
    await page.getByRole('checkbox', { name: 'First row contains headers' }).uncheck();
    await page.getByRole('gridcell', { name: 'alpha', exact: true }).waitFor();
    await back(page);
    await ctx.openNote('draft');
    await grid(page);
    assert.equal(await page.getByRole('checkbox', { name: 'First row contains headers' }).isChecked(), false);
    await page.getByRole('gridcell', { name: 'alpha', exact: true }).dblclick();
    await page.locator('.cm-content').waitFor();
    assert.match(await page.locator('.cm-content').innerText(), /^alpha/);
  },
  'editor.malformed-csv': async (ctx) => {
    const { page } = ctx,
      initial = ['id,title', '1,"unfinished'];
    await setup(ctx, data(initial.join('\n'), 'csv'));
    await page.locator('[data-data-view=table]').click();
    await page.locator('.vd-grid-root[data-state=error]').waitFor();
    assert.match(await page.locator('.vd-grid-status').innerText(), /quotes/i);
    await source(page);
    await waitLines(page, initial);
  },
  'editor.insert-file': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, data('LR'));
    await page.locator('.cm-line').click();
    await page.keyboard.press(home(ctx));
    await page.keyboard.press('ArrowRight');
    const fileChooser = page.waitForEvent('filechooser');
    await byButton(page, 'Insert file…').click();
    await (
      await fileChooser
    ).setFiles({
      name: 'sample.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('\uFEFFпример', 'utf16le')
    });
    await waitLines(page, ['LпримерR']);
    await undo(ctx);
    await waitLines(page, ['LR']);
  },
  'editor.invalid-import': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, data('LR'));
    await page.locator('.cm-line').click();
    await page.keyboard.press(home(ctx));
    await page.keyboard.press('ArrowRight');
    const chooser = page.waitForEvent('filechooser');
    await byButton(page, 'Insert file…').click();
    await (
      await chooser
    ).setFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from([0xc3, 0x28]) });
    await page.getByText('Use a UTF-8 file or UTF-16 with BOM', { exact: true }).waitFor();
    await waitLines(page, ['LR']);
    await page.locator('.cm-content').focus();
    await page.keyboard.insertText('!');
    await waitLines(page, ['L!R']);
  },
  'editor.image-batch': async (ctx) => {
    const { page } = ctx;
    await setup(ctx, rich('LR'));
    await rows(page).click();
    await page.keyboard.press(home(ctx));
    await page.keyboard.press('ArrowRight');
    const chooser = page.waitForEvent('filechooser');
    await byButton(page, 'Insert image').click();
    const buffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/je0AAAAASUVORK5CYII=',
      'base64'
    );
    await (
      await chooser
    ).setFiles(['first.png', 'second.png'].map((name) => ({ name, mimeType: 'image/png', buffer })));
    const images = page.locator('.ve-media img');
    async function checkImages() {
      await images.nth(1).waitFor();
      assert.deepEqual(await images.evaluateAll((nodes) => nodes.map((n) => n.alt)), [
        'first.png',
        'second.png'
      ]);
      assert.deepEqual(await rows(page).allInnerTexts(), ['L', 'R']);
    }
    await checkImages();
    await undo(ctx);
    assert.equal(await images.count(), 0);
    assert.deepEqual(await rows(page).allInnerTexts(), ['LR']);
    await redo(ctx);
    await checkImages();
    await back(page);
    await ctx.openNote('draft');
    await checkImages();
  }
};
