import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dependencies = path.resolve('src-tauri/sidecar-runtime/node_modules');
const nativeBuffer = path.join(dependencies, 'bufferutil/prebuilds/win32-x64/bufferutil.node');
const available = process.platform === 'win32' && existsSync(nativeBuffer);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function stopProbe(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await once(child, 'exit');
}

async function waitFor(predicate: () => boolean, description: string) {
  const started = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - started < 10_000, description);
    await delay(25);
  }
}

for (const closeBeforeReady of [false, true]) {
  test(`streaming backend exits when parent input closes ${closeBeforeReady ? 'during startup' : 'after startup'}`,
    { skip: !available, timeout: 20_000 }, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'streamee-parent-test-'));
      const script = path.join(root, 'webtorrent-server.cjs');
      copyFileSync(path.resolve('src-tauri/src/webtorrent-server.cjs'), script);
      symlinkSync(dependencies, path.join(root, 'node_modules'), 'junction');
      const child = spawn(process.execPath, [script], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TMP: root, TEMP: root, STREAMEE_TORRENT_PORT: '' },
      });
      let output = '';
      child.stdout!.on('data', data => { output += data.toString(); });
      child.stderr!.resume();
      try {
        if (!closeBeforeReady) await waitFor(() => output.includes('server_ready'), 'backend never became ready');
        child.stdin!.end();
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'backend survived parent closure');
        assert.equal(child.exitCode, 0);
      } finally {
        await stopProbe(child);
        rmSync(root, { recursive: true, force: true });
      }
    });
}

test('installer cleanup releases an installed native library and preserves a helper outside that installation',
  { skip: !available, timeout: 25_000 }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'streamee-installer-test-'));
    const installed = path.join(root, 'install with spaces');
    const outside = `${installed}-other`;
    mkdirSync(installed);
    mkdirSync(outside);
    const installedRuntime = path.join(installed, 'streameenode.exe');
    const outsideRuntime = path.join(outside, 'streameenode.exe');
    const library = path.join(installed, 'bufferutil.node');
    copyFileSync(process.execPath, installedRuntime);
    copyFileSync(process.execPath, outsideRuntime);
    copyFileSync(nativeBuffer, library);
    const helper = spawn(installedRuntime, ['-e', "require(process.argv[1]); console.log('ready'); setInterval(()=>{},1000)", library],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const unrelated = spawn(outsideRuntime, ['-e', "console.log('ready'); setInterval(()=>{},1000)"],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = 0;
    helper.stdout!.once('data', () => { ready++; });
    unrelated.stdout!.once('data', () => { ready++; });
    helper.stderr!.resume();
    unrelated.stderr!.resume();
    try {
      await waitFor(() => ready === 2, 'probe helpers did not start');
      // Windows must refuse to overwrite the loaded native module before cleanup.
      assert.throws(() => copyFileSync(nativeBuffer, library));
      const cleanup = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve('src-tauri/windows/stop-installed-helpers.ps1'), '-InstallDir', installed],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = '';
      cleanup.stdout!.on('data', data => { errors += data.toString(); });
      cleanup.stderr!.on('data', data => { errors += data.toString(); });
      const [code] = await once(cleanup, 'exit');
      assert.equal(code, 0, errors);
      await waitFor(() => helper.exitCode !== null || helper.signalCode !== null, 'installed helper survived cleanup');
      assert.equal(unrelated.exitCode, null);
      assert.equal(unrelated.signalCode, null);
      copyFileSync(nativeBuffer, library);
      renameSync(library, `${library}.replaced`);
    } finally {
      await stopProbe(helper);
      await stopProbe(unrelated);
      rmSync(root, { recursive: true, force: true });
    }
  });
