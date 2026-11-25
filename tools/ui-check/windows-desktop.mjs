import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, cp, copyFile, readFile, writeFile} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const repo=fileURLToPath(new URL('../../',import.meta.url));

export async function buildDesktop(dir) {
  const exe = path.join(dir, 'Audit.exe');
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
    ['"afe0835b-a0ad-44f7-bef5-437391d33cb8"', 'os.Getenv("VIDERON_FIXTURE_INSTANCE")'],
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
  return exe;
}

export async function launchDesktop(exe, dir, errors = []) {
  const profile = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(APPDATA|LOCALAPPDATA|VIDERON_.+|WEBVIEW2_.+)$/i.test(key))
  );
  for (const [key, folder] of [['APPDATA','roaming'], ['LOCALAPPDATA','local'], ['VIDERON_FIXTURE_WEBVIEW','webview']]) {
    profile[key] = path.join(dir, folder);
    await mkdir(profile[key], {recursive:true});
  }
  profile.VIDERON_FIXTURE_INSTANCE = randomUUID();
  let child, browser, page;
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
  try {
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
    return {page, pid:child.pid, stop};
  } catch (error) {
    await stop();
    throw error;
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      await page?.evaluate(() => window.go.main.App.FinishClose()).catch(() => {});
      await Promise.race([exit, sleep(1000)]);
      if (child.exitCode === null) child.kill();
      await exit;
    }
    await browser?.close().catch(() => {});
    child = browser = page = undefined;
  }
}
