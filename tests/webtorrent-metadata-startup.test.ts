import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import parseTorrent from 'parse-torrent';

const require = createRequire(import.meta.url);
const originalSource = readFileSync('src-tauri/src/webtorrent-server.cjs', 'utf8');
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function sidecar(platform = 'linux') {
  let dnsOrder = '';
  const messages: any[] = [];
  class Torrent extends EventEmitter {
    files: any[] = [];
    destroyed = false;
    announce: string[];
    discovery = { tracker: new EventEmitter() };
    infoHash = '0123456789012345678901234567890123456789';
    owner: Client;
    readyCallback: (torrent: Torrent) => void;
    constructor(owner: Client, readyCallback: (torrent: Torrent) => void) {
      super();
      this.owner = owner;
      this.readyCallback = readyCallback;
      this.announce = owner.options.tracker.announce;
    }
    destroy(_options: unknown, callback: () => void) {
      // Like WebTorrent, a second destroy returns without calling back.
      if (this.destroyed) return;
      this.destroyed = true;
      this.owner.torrents = this.owner.torrents.filter((torrent) => torrent !== this);
      this.emit('close');
      callback();
    }
    makeReady() {
      this.files = [{ name: 'Example.mkv', path: 'Example.mkv', length: 1024 }];
      this.readyCallback(this);
    }
  }
  class Client extends EventEmitter {
    torrents: Torrent[] = [];
    listening = true;
    options: any;
    addOptions: any[] = [];
    constructor(options: any) { super(); this.options = options; }
    add(_source: unknown, options: unknown, callback: (torrent: Torrent) => void) {
      this.addOptions.push(options);
      const torrent = new Torrent(this, callback);
      this.torrents.push(torrent);
      setImmediate(() => torrent.emit('infoHash'));
      return torrent;
    }
  }
  class FakeChunkStore {
    opts: any;
    constructor(_chunkLength: number, opts: any) { this.opts = opts; }
  }
  let stdinHandler: (data: string) => Promise<void> = async () => {};
  const source = originalSource
    .replace("import('webtorrent')", 'Promise.resolve({ default: FakeClient })')
    .replace("import('parse-torrent')", 'Promise.resolve({ default: fakeParse })')
    .replace("import('fs-chunk-store')", 'Promise.resolve({ default: FakeChunkStore })')
    .replace(/^main\(\);\r?$/m, '')
    + '\n globalThis.api = { startTorrent, stopTorrent, getHealth, getProgress, normalizeMagnetUri, resolveTorrentSource, toSafeStorePath, ready: clientReady, getClient: () => client, setParse: (parse) => { parseTorrentSource = parse; } };';
  const context: any = {
    FakeClient: Client,
    FakeChunkStore,
    fakeParse: () => ({ infoHash: '0123456789012345678901234567890123456789' }),
    require: (name: string) => {
      if (name === 'dns') return { setDefaultResultOrder: (order: string) => { dnsOrder = order; } };
      if (name === 'fs') return { rmSync() {}, existsSync: () => false, mkdirSync() {} };
      if (name === 'fs-native-extensions') return { sparse() {} };
      return require(name);
    },
    process: {
      platform, env: {}, pid: 1, on() {},
      stderr: { write() {} },
      stdout: { on() {}, write: (line: string) => messages.push(JSON.parse(line)) },
      stdin: {
        setEncoding() {},
        on(event: string, handler: (data: string) => Promise<void>) {
          if (event === 'data') stdinHandler = handler;
        },
        once() {},
      },
    },
    Buffer, URL, setImmediate, clearInterval, clearTimeout,
    setTimeout: (callback: () => void) => setTimeout(callback, 0),
  };
  vm.runInNewContext(source, context, { filename: 'webtorrent-server.cjs' });
  await context.api.ready;
  const send = (command: unknown) => stdinHandler(`${JSON.stringify(command)}\n`);
  return { ...context.api, dnsOrder, messages, send };
}

// WebTorrent destroys and unregisters a source before it reports the error.
function failLikeWebTorrent(torrent: any, error: Error) {
  torrent.destroyed = true;
  torrent.owner.torrents = torrent.owner.torrents.filter((entry: unknown) => entry !== torrent);
  torrent.emit('error', error);
  torrent.emit('close');
}

test('metadata discovery is active immediately and stop destroys the pending torrent', async () => {
  const api = await sidecar();
  const starting = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  assert.equal(api.getHealth().status, 'waiting_for_metadata');
  const torrent = api.getClient().torrents[0];
  await api.stopTorrent();
  assert.equal(await starting, null);
  assert.equal(torrent.destroyed, true);
  assert.equal(api.getClient().torrents.length, 0);
  assert.equal(api.getHealth().status, 'idle');
  torrent.makeReady();
  await flush();
  assert.equal(api.getHealth().status, 'idle');
  assert.equal(api.messages.filter((message: any) => message.type === 'ready').length, 0);
});

test('restarting a pending source replaces it and accepts only the new ready callback', async () => {
  const api = await sidecar();
  const first = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  const previous = api.getClient().torrents[0];
  const next = api.startTorrent('magnet:?xt=urn:btih:example');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await first, null);
  assert.equal(previous.destroyed, true);
  assert.equal(api.getClient().torrents.length, 1);
  previous.makeReady();
  assert.equal(api.getHealth().metadata_ready, false);
  api.getClient().torrents[0].makeReady();
  const result = await next;
  assert.equal(result.files.length, 1);
  assert.equal(api.getHealth().status, 'active');
  assert.equal(api.messages.filter((message: any) => message.type === 'ready').length, 1);
  await api.stopTorrent();
});

test('stop during asynchronous source parsing cannot add a torrent afterwards', async () => {
  const api = await sidecar();
  let finishParse!: (value: unknown) => void;
  api.setParse(() => new Promise((resolve) => { finishParse = resolve; }));
  const starting = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  await api.stopTorrent();
  finishParse({ infoHash: '0123456789012345678901234567890123456789' });
  assert.equal(await starting, null);
  assert.equal(api.getClient().torrents.length, 0);
});

test('pending torrent errors reject startup before the ready callback', async () => {
  const api = await sidecar();
  const starting = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  const rejected = assert.rejects(starting, /metadata exchange failed/);
  api.getClient().torrents[0].emit('error', new Error('metadata exchange failed'));
  await rejected;
  await api.stopTorrent();
});

test('hash-only sources have tracker discovery and IPv4 DNS preference', async () => {
  const api = await sidecar();
  assert.equal(api.dnsOrder, 'ipv4first');
  assert.deepEqual(Array.from(api.getClient().options.tracker.announce), [
    'udp://tracker.opentrackr.org:1337/announce',
  ]);
});

test('storage setup failures are not hidden by the torrent close event', async () => {
  const api = await sidecar('win32');
  const starting = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  const rejected = assert.rejects(starting, /Sparse WebTorrent storage could not locate/);
  api.getClient().torrents[0].makeReady();
  await rejected;
  await flush();
  assert.equal(api.getHealth().metadata_ready, false);
});

test('torrent errors still reach the app after startup succeeds', async () => {
  const api = await sidecar();
  const starting = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  const torrent = api.getClient().torrents[0];
  torrent.makeReady();
  await starting;
  torrent.emit('error', new Error('stream transfer failed'));
  assert.equal(api.messages.at(-1).message, 'stream transfer failed');
  await api.stopTorrent();
});

test('saved magnets with encoded identity separators remain playable through the real parser', async () => {
  const api = await sidecar();
  const infoHash = '0123456789012345678901234567890123456789';
  const tracker = 'https://tracker.example.com/announce?mode=lawful%20stream';
  const saved = `magnet:?xt=urn%3Abtih%3A${infoHash}&tr=${encodeURIComponent(tracker)}`;
  await assert.rejects(parseTorrent(saved), /Invalid torrent identifier/);
  api.setParse(parseTorrent);
  const starting = api.startTorrent(saved);
  await flush();
  assert.equal(api.getHealth().status, 'waiting_for_metadata');
  const parsed = await parseTorrent(api.normalizeMagnetUri(saved));
  assert.equal(parsed.infoHash, infoHash);
  assert.deepEqual(parsed.announce, [tracker]);
  await api.stopTorrent();
  assert.equal(await starting, null);
});

test('magnet recovery leaves invalid identities, binary sources and remote URLs intact', async () => {
  const api = await sidecar();
  for (const source of [
    'magnet:?xt=urn%3Abtih%3Ainvalid',
    'magnet:?xt=%invalid',
    'https://example.com/source.torrent?xt=urn%3Abtih%3Aexample',
    Buffer.from('example'),
  ]) {
    assert.equal(api.normalizeMagnetUri(source), source);
  }
});

test('a source closed by an error reports failure and does not block the next start', async () => {
  const api = await sidecar();
  const first = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  const failed = api.getClient().torrents[0];
  failed.makeReady();
  await first;
  failLikeWebTorrent(failed, new Error('disk is full'));
  assert.equal(api.getHealth().status, 'failed');
  assert.equal(api.getHealth().message, 'disk is full');

  const next = api.startTorrent('magnet:?xt=urn:btih:example');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.getHealth().status, 'waiting_for_metadata');
  api.getClient().torrents[0].makeReady();
  assert.equal((await next).files.length, 1);
  await api.stopTorrent();
  assert.equal(api.getHealth().status, 'idle');
});

test('a new start never reports the previous source as ready', async () => {
  const api = await sidecar();
  const first = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  api.getClient().torrents[0].makeReady();
  await first;
  assert.equal(api.getHealth().metadata_ready, true);

  // The app checks health right after the start command replies.
  const next = api.startTorrent('magnet:?xt=urn:btih:example');
  assert.equal(api.getHealth().metadata_ready, false);
  assert.equal(api.getProgress().metadata_ready, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  api.getClient().torrents[0].makeReady();
  assert.equal((await next).files.length, 1);
  assert.equal(api.getHealth().metadata_ready, true);
  await api.stopTorrent();
});

test('replacing a source is not reported as a failure', async () => {
  const api = await sidecar();
  const first = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  const previous = api.getClient().torrents[0];
  previous.makeReady();
  await first;
  // Like WebTorrent: marked destroyed and unregistered at once, closed later.
  let healthWhileClosing: any = null;
  previous.destroy = (_options: unknown, callback: () => void) => {
    previous.destroyed = true;
    previous.owner.torrents = previous.owner.torrents.filter((torrent: unknown) => torrent !== previous);
    healthWhileClosing = api.getHealth();
    setTimeout(() => {
      previous.emit('close');
      callback();
    }, 30);
  };
  const next = api.startTorrent('magnet:?xt=urn:btih:example');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(healthWhileClosing, 'the previous source was not closed');
  assert.notEqual(healthWhileClosing.status, 'failed');
  api.getClient().torrents[0].makeReady();
  assert.equal((await next).files.length, 1);
  await api.stopTorrent();
});

test('a start that fails before metadata is reported by health', async () => {
  const api = await sidecar();
  api.setParse(() => Promise.reject(new Error('Invalid torrent identifier')));
  await api.send({ action: 'start', magnet: 'magnet:?xt=urn:btih:invalid', requestId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.messages.find((message: any) => message.requestId === 7).type, 'started');
  assert.equal(api.getHealth().status, 'failed');
  assert.match(api.getHealth().message, /Invalid torrent identifier/);
  await api.stopTorrent();
  assert.equal(api.getHealth().status, 'idle');
});

test('a destroyed client is rebuilt so later starts can add sources', async () => {
  const api = await sidecar();
  const original = api.getClient();
  original.destroyed = true;
  original.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
  assert.notEqual(api.getClient(), original);
  const starting = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  assert.equal(api.getClient().torrents.length, 1);
  await api.stopTorrent();
  assert.equal(await starting, null);
});

test('stored folder and file names are valid on Windows', async () => {
  const api = await sidecar();
  assert.equal(
    api.toSafeStorePath('Title: Part 1/CON/Episode?.mkv'),
    ['Title Part 1', '_CON', 'Episode.mkv'].join(path.sep),
  );
  assert.equal(api.toSafeStorePath('Trailing. /name '), ['Trailing', 'name'].join(path.sep));

  const starting = api.startTorrent('magnet:?xt=urn:btih:example');
  await flush();
  const Store = api.getClient().addOptions[0].store;
  const store = new Store(16384, { files: [{ path: 'Show: S1/E1?.mkv', length: 4, offset: 0 }] });
  assert.equal(store.opts.files[0].path, ['Show S1', 'E1.mkv'].join(path.sep));
  await api.stopTorrent();
  assert.equal(await starting, null);
});

test('remote metadata must be a bencoded file within the size limit', async () => {
  const api = await sidecar();
  const server = http.createServer((req, res) => {
    if (req.url === '/media') {
      res.end(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    } else if (req.url === '/huge') {
      res.writeHead(200, { 'Content-Length': String(64 * 1024 * 1024) });
      res.flushHeaders();
    } else {
      res.end('d4:infod4:name4:testee');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(api.resolveTorrentSource(`${base}/media`), /did not return torrent metadata/);
    await assert.rejects(api.resolveTorrentSource(`${base}/huge`), /too large/);
    assert.equal(String(await api.resolveTorrentSource(`${base}/source.torrent`)), 'd4:infod4:name4:testee');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
