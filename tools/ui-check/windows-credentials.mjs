// node tools/ui-check/windows-credentials.mjs [report.json]
// Requires Windows, installed WebView2, Go and the Go module cache used to build Videron.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

if (process.platform !== 'win32') throw Error('The desktop credentials check needs Windows and WebView2');
const repo = fileURLToPath(new URL('../../', import.meta.url)),
  temp = await realpath(os.tmpdir());
const dir = await mkdtemp(path.join(temp, 'videron-credentials-audit-'));
const started = new Date().toISOString(),
  reportPath = process.argv[2];
const result = {
  id: 'editor.protected-credentials',
  area: 'editor',
  engine: 'webview2',
  status: 'fail',
  note: 'Real desktop note encryption, encrypted persistence, unlock after restart and local search. Copy delivery is checked with an in-memory clipboard, outside the physical OS clipboard.'
};
const profile = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(APPDATA|LOCALAPPDATA|VIDERON_.+|WEBVIEW2_.+)$/i.test(k))
);
for (const [k, v] of [
  ['APPDATA', 'roaming'],
  ['LOCALAPPDATA', 'local'],
  ['VIDERON_FIXTURE_WEBVIEW', 'webview']
]) {
  profile[k] = path.join(dir, v);
  await mkdir(profile[k]);
}
const exe = path.join(dir, 'Audit.exe');
const btn = (host, name) => host.getByRole('button', { name, exact: true });
const password = randomUUID() + ' audit',
  resource = ['Audit North', 'Audit South'],
  login = ['login-A', 'login-B'],
  secret = ['fixture-A-' + randomUUID(), 'fixture-B-' + randomUUID()];
const title = 'Private audit ' + randomUUID(),
  body = 'A fictional private record';
let child, browser, page;
const errors = [];

async function build() {
  const go = (...args) =>
    execFileSync('go', args, {
      cwd: repo,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, GOPROXY: 'off' }
    });
  const moduleName = 'github.com/wailsapp/go-webview2',
    modDir = go('list', '-m', '-f', '{{.Dir}}', moduleName).trim();
  const localModule = path.join(dir, 'webview2'),
    mod = path.join(dir, 'fixture.mod');
  await cp(modDir, localModule, { recursive: true });
  await copyFile(path.join(repo, 'go.mod'), mod);
  await copyFile(path.join(repo, 'go.sum'), path.join(dir, 'fixture.sum'));
  go('mod', 'edit', '-modfile=' + mod, '-replace=' + moduleName + '=' + localModule);
  const Replace = {};
  async function overlay(file, name, changes) {
    let source = await readFile(file, 'utf8');
    for (const [before, after] of changes) {
      assert(source.includes(before), 'Missing overlay point in ' + file);
      source = source.replace(before, after);
    }
    Replace[file] = path.join(dir, name);
    await writeFile(Replace[file], source);
  }
  await overlay(path.join(repo, 'main.go'), 'audit-main.go', [
    ['afe0835b-a0ad-44f7-bef5-437391d33cb8', randomUUID()],
    [
      'WindowClassName:  desktopWindowClass,',
      'WebviewUserDataPath: os.Getenv("VIDERON_FIXTURE_WEBVIEW"), WindowClassName: desktopWindowClass,'
    ]
  ]);
  await overlay(path.join(repo, 'window_state.go'), 'audit-window.go', [
    ['"VideronMainWindow"', '"VideronAudit' + randomUUID() + '"'],
    ['"github.com/wailsapp/wails/v2/pkg/runtime"', ''],
    ['runtime.WindowShow(ctx)', '// The test uses a hidden WebView2 window.']
  ]);
  const args = 'strings.Join(e.AdditionalBrowserArgs, " ")';
  await overlay(path.join(localModule, 'pkg/edge/chromium.go'), 'audit-webview.go', [
    [
      args,
      args +
        ' + " --disable-background-networking --disable-component-update --remote-debugging-address=127.0.0.1 --remote-debugging-port=" + os.Getenv("VIDERON_FIXTURE_DEBUG_PORT")'
    ]
  ]);
  const overlayPath = path.join(dir, 'overlay.json');
  await writeFile(overlayPath, JSON.stringify({ Replace }));
  go(
    'build',
    '-buildvcs=false',
    '-tags=desktop,production',
    '-modfile=' + mod,
    '-overlay',
    overlayPath,
    '-ldflags',
    '-H windowsgui',
    '-o',
    exe,
    '.'
  );
}

async function launch() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  child = spawn(exe, [], {
    cwd: dir,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...profile, VIDERON_FIXTURE_DEBUG_PORT: String(port) }
  });
  const until = Date.now() + 15000;
  while (!browser && Date.now() < until) {
    assert.equal(child.exitCode, null);
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 350 });
    } catch {
      await sleep(125);
    }
  }
  assert(browser, 'The fixture WebView2 endpoint did not start');
  while (!page && Date.now() < until) {
    page = browser
      .contexts()[0]
      ?.pages()
      .find((p) => p.url().includes('wails.localhost'));
    if (!page) await sleep(100);
  }
  assert(page, 'The frontend did not load');
  page.setDefaultTimeout(9000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.go?.main?.App?.UnlockNoteFor);
  await page.evaluate(() => {
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
}

async function stop() {
  if (child && child.exitCode === null) {
    const exit = once(child, 'exit');
    await page?.evaluate(() => window.go.main.App.FinishClose()).catch(() => {});
    await Promise.race([exit, sleep(1000)]);
    if (child.exitCode === null) child.kill();
    await exit;
  }
  await browser?.close().catch(() => {});
  child = browser = page = undefined;
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
  await block.getByRole('searchbox').fill(login[1]);
  assert.equal(await block.locator('.ve-credential-entry:visible').count(), 1);
  await btn(entries.nth(1), 'Show password').click();
  assert.equal(await field('password', 1).getAttribute('type'), 'text');
  await btn(entries.nth(1), 'Hide password').click();
  assert.equal(await field('password', 1).getAttribute('type'), 'password');
  await btn(entries.nth(1), 'Copy login:password').click();
  assert.equal(await page.evaluate(() => window.__auditClipboard.at(-1)), login[1] + ':' + secret[1]);
  const back = async () => {
    await btn(page, 'Back to map').click();
    await page.locator('.ve-title').waitFor({ state: 'hidden' });
  };
  await back();
  const disk = await readFile(path.join(profile.APPDATA, 'Videron', 'workspace.json'), 'utf8');
  const library = JSON.parse(disk),
    record = library.spaces[library.active].notes[0];
  assert(record.sealed && !record.title && !record.body.length);
  for (const marker of [title, body, password, ...secret, ...resource, ...login])
    assert(!disk.includes(marker), 'Sensitive marker in public catalog');
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
  await page.getByRole('treeitem', { name: 'Encrypted note', exact: true }).click();
  const unlock = page.getByRole('dialog', { name: 'Unlock note', exact: true });
  await unlock.getByLabel('Password', { exact: true }).fill(password);
  await btn(unlock, 'Unlock').click();
  const restored = page.locator('.ve-credential-entry');
  await restored.nth(1).waitFor();
  assert.equal(await restored.count(), 2);
  for (let i = 0; i < 2; i++) {
    const f = (key) => restored.nth(i).locator('[data-credential-field="' + key + '"]');
    assert.equal(await f('password').getAttribute('type'), 'password');
    assert.equal(await f('password').inputValue(), secret[i]);
    assert.equal(await f('login').inputValue(), login[i]);
    assert.equal(await f('resource').inputValue(), resource[i]);
  }
  assert.deepEqual(errors, []);
}
try {
  await build();
  await check();
  result.status = 'pass';
} catch (error) {
  result.reason = String(error).replaceAll(dir, '[temporary profile]');
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
  await writeFile(reportPath, JSON.stringify({ started, catalog: [], results: [result] }, null, 2) + '\n');
}
console.log(result.status + ' ' + result.id + ' (' + result.engine + '). ' + (result.reason ?? result.note));
