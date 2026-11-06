import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const INFO_HASH = '0123456789012345678901234567890123456789';
const originalSource = fs.readFileSync('src-tauri/src/webtorrent-server.cjs', 'utf8');

// Loads the sidecar against a private cache root on real disk, so its startup
// cleanup and pruner run for real without touching a live Streamee cache.
function sidecar(sessionRoot: string) {
  const rootDefinition = "const STREAM_CACHE_ROOT = path.join(os.tmpdir(), 'Streamee', 'webtorrent-stream-cache');";
  assert.ok(originalSource.includes(rootDefinition));
  const source = originalSource
    .replace(rootDefinition, 'const STREAM_CACHE_ROOT = testSessionRoot;')
    .replace("import('webtorrent')", 'Promise.resolve({ default: FakeClient })')
    .replace("import('parse-torrent')", `Promise.resolve({ default: () => ({ infoHash: '${INFO_HASH}' }) })`)
    .replace(/^main\(\);\r?$/m, '')
    + '\n globalThis.api = { prunePersistentStreamCache, startTorrent, stopTorrent, persistentCacheKey, getClient: () => client };';
  class FakeTorrent extends EventEmitter {
    destroyed = false;
    announce: string[] = [];
    destroy(_options: unknown, callback: () => void) {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('close');
      callback();
    }
  }
  class FakeClient extends EventEmitter {
    torrents: FakeTorrent[] = [];
    listening = true;
    addOptions: any[] = [];
    add(_source: unknown, options: unknown) {
      this.addOptions.push(options);
      const torrent = new FakeTorrent();
      this.torrents.push(torrent);
      return torrent;
    }
  }
  const context: any = {
    testSessionRoot: sessionRoot,
    FakeClient,
    require: (name: string) => (name === 'fs-native-extensions' ? { sparse() {} } : require(name)),
    process: {
      platform: 'win32', env: {}, pid: 1, on() {},
      kill: (pid: number, signal: number) => process.kill(pid, signal),
      stderr: { write() {} },
      stdout: { on() {}, write() {} },
      stdin: { setEncoding() {}, on() {}, once() {} },
    },
    Buffer, URL, setImmediate, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.runInNewContext(source, context, { filename: 'webtorrent-server.cjs' });
  return context.api;
}

function exitedPid() {
  // A process that has already exited; its PID is not running.
  return spawnSync(process.execPath, ['-e', '0']).pid as number;
}

function tempRoot(name: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `streamee-${name}-`));
}

test('startup cleanup keeps session folders of other running sidecars', () => {
  const sessionRoot = tempRoot('sessions');
  const live = path.join(sessionRoot, `${process.pid}-1-1`);
  const exited = path.join(sessionRoot, `${exitedPid()}-1-1`);
  const unknown = path.join(sessionRoot, 'leftover');
  for (const directory of [live, exited, unknown]) fs.mkdirSync(directory);
  try {
    sidecar(sessionRoot);
    assert.equal(fs.existsSync(live), true, 'another running sidecar lost its active session');
    assert.equal(fs.existsSync(exited), false);
    assert.equal(fs.existsSync(unknown), false);
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

test('the persistent pruner never removes entries another running process uses', () => {
  const sessionRoot = tempRoot('sessions');
  const cacheRoot = tempRoot('persistent');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  const entry = (name: string, lastAccessMs: number, owner?: number, withManifest = true) => {
    const directory = path.join(cacheRoot, name);
    fs.mkdirSync(directory);
    if (withManifest) {
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
        version: 1, cache_key: name, provider: 'test', total_size: 100,
        resident_bytes: 100, last_access_ms: lastAccessMs, covered_ranges: [], resident_blocks: [],
      }));
    }
    if (owner) fs.writeFileSync(path.join(directory, 'in-use.lock'), String(owner));
    return directory;
  };
  try {
    const api = sidecar(sessionRoot);
    const inUse = entry('in-use', 1, other.pid);
    const staleMarker = entry('stale-marker', 2, exitedPid());
    const pending = entry('pending', 3, other.pid, false);
    const unused = entry('unused', 4);
    api.prunePersistentStreamCache(cacheRoot, 150);
    assert.equal(fs.existsSync(inUse), true, 'an entry another process uses was pruned');
    assert.equal(fs.existsSync(pending), true, 'an entry still being prepared elsewhere was pruned');
    assert.equal(fs.existsSync(staleMarker), false, 'a marker from an exited process protected its entry');
    assert.equal(fs.existsSync(unused), false);
  } finally {
    other.kill();
    fs.rmSync(sessionRoot, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('a reopened cached title reuses its saved piece map and is marked in use', async () => {
  const sessionRoot = tempRoot('sessions');
  const cacheRoot = tempRoot('persistent');
  try {
    const api = sidecar(sessionRoot);
    const key = api.persistentCacheKey(`webtorrent:${INFO_HASH}`);
    const entryDirectory = path.join(cacheRoot, key);
    fs.mkdirSync(entryDirectory);
    fs.writeFileSync(path.join(entryDirectory, 'manifest.json'), JSON.stringify({
      version: 1, cache_key: key, provider: 'webtorrent', total_size: 100, resident_bytes: 10,
      last_access_ms: 1, covered_ranges: [], resident_blocks: [],
      bitfield: Buffer.from([0x81, 0x02]).toString('base64'),
    }));

    const starting = api.startTorrent(`magnet:?xt=urn:btih:${INFO_HASH}`, {
      persistentCacheEnabled: true,
      persistentCacheRoot: cacheRoot,
      persistentCacheLimitBytes: 1024 ** 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [options] = api.getClient().addOptions;
    assert.deepEqual([...options.bitfield], [0x81, 0x02]);
    assert.equal(fs.readFileSync(path.join(entryDirectory, 'in-use.lock'), 'utf8'), '1');

    await api.stopTorrent();
    assert.equal(await starting, null);
    assert.equal(fs.existsSync(path.join(entryDirectory, 'in-use.lock')), false);
    assert.equal(fs.existsSync(path.join(entryDirectory, 'manifest.json')), true);
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});
