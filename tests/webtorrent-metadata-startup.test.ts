import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
    constructor(options: any) { super(); this.options = options; }
    add(_source: unknown, _options: unknown, callback: (torrent: Torrent) => void) {
      const torrent = new Torrent(this, callback);
      this.torrents.push(torrent);
      setImmediate(() => torrent.emit('infoHash'));
      return torrent;
    }
  }
  const source = originalSource
    .replace("import('webtorrent')", 'Promise.resolve({ default: FakeClient })')
    .replace("import('parse-torrent')", 'Promise.resolve({ default: fakeParse })')
    .replace(/^main\(\);\r?$/m, '')
    + '\n globalThis.api = { startTorrent, stopTorrent, getHealth, getProgress, normalizeMagnetUri, ready: clientReady, getClient: () => client, setParse: (parse) => { parseTorrentSource = parse; } };';
  const context: any = {
    FakeClient: Client,
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
      stdout: { write: (line: string) => messages.push(JSON.parse(line)) },
      stdin: { setEncoding() {}, on() {} },
    },
    Buffer, URL, setImmediate, clearInterval, clearTimeout,
    setTimeout: (callback: () => void) => setTimeout(callback, 0),
  };
  vm.runInNewContext(source, context, { filename: 'webtorrent-server.cjs' });
  await context.api.ready;
  return { ...context.api, dnsOrder, messages };
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
