// node tools/ui-check/windows-credentials.mjs [report.json] [--system-clipboard] [--explorer]
// Requires Windows, installed WebView2, Go and the Go module cache used to build Videron.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {buildDesktop,launchDesktop} from './windows-desktop.mjs';

if (process.platform !== 'win32') throw Error('The desktop credentials check needs Windows and WebView2');
const repo = fileURLToPath(new URL('../../', import.meta.url)),
  temp = await realpath(os.tmpdir());
const { values, positionals } = parseArgs({
  options: { 'system-clipboard': { type: 'boolean' }, explorer: { type: 'boolean' } },
  allowPositionals: true
});
if (positionals.length > 1) throw Error('Pass at most one report path');
const dir = await mkdtemp(path.join(temp, 'videron-credentials-audit-'));
const started = new Date().toISOString(), [reportPath] = positionals;
const result = {
  id: 'editor.protected-credentials',
  area: 'editor',
  engine: 'webview2',
  status: 'fail',
  note: 'Protected content stayed out of search and the public catalog. Undo and redo survived locking and unlocking in the same process. A new process restored both credentials and the final text with empty history.'
};
const cases = [{ result, action: check }];
if (values['system-clipboard']) cases.push({
  result: {
    id: result.id, area: 'editor', engine: 'os-clipboard', status: 'fail',
    note: 'Filtered to the second synthetic login. A separate process verified the exact login:password via the Windows clipboard API and restored the previous clipboard formats.'
  },
  action: copyThroughWindows
});
if (values.explorer) cases.push({
  result: {
    id: 'editor.folder-link-label', area: 'editor', engine: 'native-picker', status: 'fail',
    note: 'Selected a temporary directory in the native folder picker and opened the saved link in Windows Explorer.'
  },
  action: async () => {
    const { checkFolder } = await import('./windows-folder.mjs');
    const instance = await launch();
    await checkFolder({ ...instance, dir });
  }
});
const results = cases.map(test => test.result);
const roaming = path.join(dir,'roaming');
let exe;
const btn = (host, name) => host.getByRole('button', { name, exact: true });
const password = randomUUID() + ' audit',
  resource = ['Audit North', 'Audit South'],
  login = ['login-A', 'login-B'],
  secret = ['fixture-A-' + randomUUID(), 'fixture-B-' + randomUUID()];
const title = 'Private audit ' + randomUUID(),
  body = 'A fictional private record';
let instance, page;
const clipboardExe = path.join(dir, 'AuditClipboard.exe');
const errors = [];

async function launch(useSystemClipboard = false) {
  instance = await launchDesktop(exe, dir, errors);
  page = instance.page;
  if (!useSystemClipboard) await page.evaluate(() => {
    window.__auditClipboard = [];
    window.runtime.ClipboardSetText = async (value) => {
      window.__auditClipboard.push(value);
      return true;
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.__auditClipboard.push(value);
        }
      }
    });
  });
  await page.locator('#language-select').selectOption('en');
  return instance;
}

async function clipboardResponse(lines, expected) {
  let timer;
  try {
    const {value} = await Promise.race([
      lines.next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Windows clipboard check timed out')), 18000); })
    ]);
    if (value !== expected) throw Error('Windows clipboard observer: ' + (value || 'exited'));
  } finally { clearTimeout(timer); }
}

async function stop() {
  await instance?.stop();
  instance = page = undefined;
}

async function check() {
  await launch();
  await btn(page, 'New note').click();
  await page.locator('.ve-title').fill(title);
  await page.locator('.ve-content .ve-text').first().fill(body);
  const insert = () => btn(page, 'Insert logins and passwords').click();
  await insert();
  const enc = page.getByRole('dialog', { name: 'Encrypt note', exact: true });
  await enc.waitFor();
  await btn(enc, 'Cancel').click();
  assert.equal(await page.locator('.ve-credentials').count(), 0);
  await insert();
  await enc.getByLabel('New password', { exact: true }).fill(password);
  await enc.getByLabel('Confirm new password', { exact: true }).fill(password);
  await btn(enc, 'Encrypt').click();
  const block = page.locator('.ve-credentials'),
    entries = block.locator('.ve-credential-entry');
  const field = (key, i) => entries.nth(i).locator('input[data-credential-field="' + key + '"]');
  for (let i = 0; i < 2; i++) {
    if (i) await btn(block, 'Add entry').click();
    await field('resource', i).fill(resource[i]);
    await field('login', i).fill(login[i]);
    await field('password', i).fill(secret[i]);
  }
  await btn(block, 'Add entry').click();
  await field('resource', 2).fill('Discard this fixture');
  await field('login', 2).fill('discarded-login');
  const search = block.getByRole('searchbox');
  await search.fill('discarded-login');
  assert.equal(await block.locator('.ve-credential-entry:visible').count(), 1);
  await btn(entries.nth(2), 'Remove entry').click();
  assert.equal(await block.locator('.ve-credential-entry:visible').count(), 0);
  await search.fill('');
  assert.equal(await entries.count(), 2);
  await block.getByRole('searchbox').fill(login[1]);
  assert.equal(await block.locator('.ve-credential-entry:visible').count(), 1);
  await btn(entries.nth(1), 'Show password').click();
  assert.equal(await field('password', 1).getAttribute('type'), 'text');
  await btn(entries.nth(1), 'Hide password').click();
  assert.equal(await field('password', 1).getAttribute('type'), 'password');
  await btn(entries.nth(1), 'Copy login:password').click();
  assert(await page.evaluate(() => window.__auditClipboard.at(-1)) === login[1] + ':' + secret[1], 'The clipboard mock received the wrong pair');
  const back = async () => {
    await btn(page, 'Back to map').click();
    await page.locator('.ve-title').waitFor({ state: 'hidden' });
  };
  const text = page.locator('.ve-content .ve-text').first();
  const revision = ' — edited while unlocked';
  await text.press('End');
  await page.keyboard.insertText(revision);
  assert.equal(await text.innerText(),body+revision);
  await back();
  const disk = await readFile(path.join(roaming, 'Videron', 'workspace.json'), 'utf8');
  const library = JSON.parse(disk),
    record = library.spaces[library.active].notes[0];
  assert(record.sealed && !record.title && !record.body.length);
  for (const marker of [title, body, revision, password, ...secret, ...resource, ...login])
    assert(!disk.includes(marker), 'Sensitive marker in public catalog');
  await unlockFixture();
  await text.press('Control+z');
  assert.equal(await text.innerText(), body);
  // Deliver the session notification to this isolated app. Its ordinary lock
  // path seals the editor, releases all keys and reloads the actual WebView.
  await page.evaluate(()=>window.runtime.EventsEmit('videron:session-lock'));
  const prompt = page.getByRole('dialog',{name:'Unlock note',exact:true});
  await prompt.waitFor();
  await prompt.getByLabel('Password',{exact:true}).fill(password);
  await btn(prompt,'Unlock').click();
  await text.press('Control+Shift+z');
  assert.equal(await text.innerText(), body+revision);
  await back();
  await btn(page, 'New note').click();
  await page.locator('.ve-title').fill('Control');
  await page.locator('.ve-content .ve-text').first().fill('turnipSolarPositiveX30');
  await back();
  await page.locator('#search').click();
  const q = page.getByPlaceholder('Title, text, or #tag');
  await q.fill('turnipSolarPositiveX30');
  await page.getByText('Notes found · 1', { exact: true }).waitFor();
  await q.fill(secret[1]);
  await page.getByText('No matches', { exact: true }).waitFor();
  await q.press('Escape');
  await stop();
  await launch();
  await unlockFixture();
  const coldText = page.locator('.ve-content .ve-text').first();
  await coldText.press('Control+z');
  assert.equal(await coldText.innerText(), body+revision);
  const restored = page.locator('.ve-credential-entry');
  await restored.nth(1).waitFor();
  assert.equal(await restored.count(), 2);
  for (let i = 0; i < 2; i++) {
    const f = (key) => restored.nth(i).locator('[data-credential-field="' + key + '"]');
    assert.equal(await f('password').getAttribute('type'), 'password');
    assert(await f('password').inputValue() === secret[i], 'The persisted password did not match');
    assert.equal(await f('login').inputValue(), login[i]);
    assert.equal(await f('resource').inputValue(), resource[i]);
  }
  assert.deepEqual(errors, []);
}
async function unlockFixture() {
  await page.getByRole('treeitem', { name: 'Encrypted note', exact: true }).click();
  const unlock = page.getByRole('dialog', { name: 'Unlock note', exact: true });
  await unlock.getByLabel('Password', { exact: true }).fill(password);
  await btn(unlock, 'Unlock').click();
}
async function copyThroughWindows() {
  execFileSync('go', ['build','-o',clipboardExe,path.join(repo,'tools/ui-check/windows-clipboard.go')], {cwd:repo, windowsHide:true});
  await launch(true);
  await unlockFixture();
  const block = page.locator('.ve-credentials');
  await block.getByRole('searchbox').fill(login[1]);
  const row = block.locator('.ve-credential-entry:visible');
  assert.equal(await row.count(), 1);
  const copy = btn(row, 'Copy login:password');
  const guard = spawn(clipboardExe, [], {windowsHide:true, stdio:['pipe','pipe','ignore']});
  const closed = once(guard, 'close');
  const lines = createInterface({input:guard.stdout})[Symbol.asyncIterator]();
  guard.stdin.end(login[1] + ':' + secret[1] + '\n');
  try {
    await clipboardResponse(lines, 'READY');
    await copy.click();
    await row.locator('.ve-credential-copy.is-copied').waitFor();
    await clipboardResponse(lines, 'VERIFIED');
  } finally {
    // The observer also restores after a failed UI assertion or cancellation.
    await closed;
  }
}
async function run(result, action) {
  try {
    await action();
    result.status = 'pass';
  } catch (e) {
    delete result.note;
    result.reason = String(e).replaceAll(dir, '[temporary profile]');
    for (const marker of [password, ...secret]) result.reason = result.reason.replaceAll(marker, '[fixture]');
    process.exitCode = 1;
  } finally { await stop(); }
}
try {
  exe = await buildDesktop(dir);
  for (const test of cases) await run(test.result, test.action);
} catch (error) {
  for (const row of results.filter(row => row.status !== 'pass' && !row.reason)) {
    delete row.note;
    row.reason = String(error).replaceAll(dir, '[temporary profile]');
  }
  process.exitCode = 1;
} finally {
  await stop();
  const resolved = await realpath(dir);
  assert.equal(path.dirname(resolved), temp);
  assert(path.basename(resolved).startsWith('videron-credentials-audit-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 25, retryDelay: 400 });
}
if (reportPath) {
  await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ started, catalog: [], results }, null, 2) + '\n');
}
for (const row of results) console.log(row.status + ' ' + row.id + ' (' + row.engine + '). ' + (row.reason ?? row.note));
