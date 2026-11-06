import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { Readable } = require('streamx');
const originalSource = readFileSync('src-tauri/src/webtorrent-server.cjs', 'utf8');

const FILE_LENGTH = 5000;
const PIECE_LENGTH = 100;
const fileBytes = Buffer.from(Array.from({ length: FILE_LENGTH }, (_, index) => index % 251));

function sidecar() {
  const source = originalSource
    .replace('const FORWARD_SEGMENT_BYTES = 128 * 1024 * 1024;', 'const FORWARD_SEGMENT_BYTES = 1000;')
    .replace('const TAIL_SEGMENT_BYTES = 64 * 1024 * 1024;', 'const TAIL_SEGMENT_BYTES = 500;')
    .replace("import('webtorrent')", 'Promise.resolve({ default: FakeClient })')
    .replace("import('parse-torrent')", 'Promise.resolve({ default: () => ({}) })')
    .replace(/^main\(\);\r?$/m, '')
    + `\n globalThis.api = {
      createHttpServer,
      prioritizeFullCache,
      setTorrent: (torrent) => { currentTorrent = torrent; },
      setSourceId: (id) => { currentSourceId = id; },
      enableFullCache: (fileIndex) => { fullCacheEnabled = true; fullCacheFileIndex = fileIndex; },
      getFullCacheWorker: () => fullCacheWorker,
      stopFullCacheWorker,
      // The sidecar checks instanceof Uint8Array, so build bitfields in its realm.
      makeBitfield: (length) => new Uint8Array(length),
    };`;
  class FakeClient extends EventEmitter {
    torrents = [];
    listening = true;
  }
  const context: any = {
    FakeClient,
    require: (name: string) => {
      if (name === 'fs') return { rmSync() {}, existsSync: () => false, mkdirSync() {} };
      if (name === 'fs-native-extensions') return { sparse() {} };
      return require(name);
    },
    process: {
      platform: 'win32', env: {}, pid: 1, on() {},
      stderr: { write() {} },
      stdout: { on() {}, write() {} },
      stdin: { setEncoding() {}, on() {}, once() {} },
    },
    Buffer, URL, setImmediate, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.runInNewContext(source, context, { filename: 'webtorrent-server.cjs' });
  return context.api;
}

// WebTorrent 3 builds file streams with streamx Readable.from(asyncIterator).
function fakeFile(reads: Array<[number, number]> = []) {
  return {
    name: 'Example.mkv',
    length: FILE_LENGTH,
    offset: 0,
    downloaded: FILE_LENGTH,
    createReadStream({ start, end }: { start: number; end: number }) {
      reads.push([start, end]);
      return Readable.from((async function* () {
        for (let offset = start; offset <= end; offset += 64) {
          yield fileBytes.subarray(offset, Math.min(end + 1, offset + 64));
        }
      })());
    },
  };
}

function fakeTorrent(api: any, file: ReturnType<typeof fakeFile>, cachedPieces = Number.POSITIVE_INFINITY) {
  const pieceCount = Math.ceil(FILE_LENGTH / PIECE_LENGTH);
  const bitfield = api.makeBitfield(Math.ceil(pieceCount / 8));
  for (let piece = 0; piece < Math.min(pieceCount, cachedPieces); piece += 1) {
    bitfield[piece >> 3] |= 1 << (7 - (piece % 8));
  }
  return { files: [file], pieceLength: PIECE_LENGTH, pieces: new Array(pieceCount), bitfield, downloaded: 0 };
}

async function listen(api: any) {
  const server: http.Server = api.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function get(port: number, path: string, headers: Record<string, string> = {}, agent?: http.Agent) {
  return new Promise<{ status: number; body: Buffer; complete: boolean }>((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers, agent }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks),
        complete: response.complete,
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

test('a range response streams across every on-demand segment boundary', async () => {
  const api = sidecar();
  api.setTorrent(fakeTorrent(api, fakeFile()));
  const { server, port } = await listen(api);
  // Keep-alive clients do not reconnect on their own; the body must be whole.
  const agent = new http.Agent({ keepAlive: true });
  try {
    const ranged = await get(port, '/stream/0', { Range: 'bytes=0-' }, agent);
    assert.equal(ranged.status, 206);
    assert.equal(ranged.complete, true);
    assert.deepEqual(ranged.body, fileBytes);

    const middle = await get(port, '/stream/0', { Range: 'bytes=950-4600' }, agent);
    assert.deepEqual(middle.body, fileBytes.subarray(950, 4601));

    const full = await get(port, '/stream/0', {}, agent);
    assert.equal(full.status, 200);
    assert.deepEqual(full.body, fileBytes);
  } finally {
    agent.destroy();
    server.close();
  }
});

test('requests from web pages or non-loopback hosts are rejected', async () => {
  const api = sidecar();
  api.setTorrent(fakeTorrent(api, fakeFile()));
  const { server, port } = await listen(api);
  try {
    assert.equal((await get(port, '/stream/0', { Host: 'rebound.example:80' })).status, 403);
    assert.equal((await get(port, '/stream/0', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await get(port, '/stream/0', { Host: `localhost:${port}`, Range: 'bytes=0-9' })).status, 206);
  } finally {
    server.close();
  }
});

test('a finished whole-file cache pass is not restarted for cached data', () => {
  const api = sidecar();
  const reads: Array<[number, number]> = [];
  const file = fakeFile(reads);
  api.setTorrent(fakeTorrent(api, file));
  api.enableFullCache(0);
  api.prioritizeFullCache(file, 0, 1200);
  assert.equal(api.getFullCacheWorker(), null);
  assert.deepEqual(reads, []);
});

test('a whole-file cache pass resumes at the first missing piece', () => {
  const api = sidecar();
  const reads: Array<[number, number]> = [];
  const file = fakeFile(reads);
  api.setTorrent(fakeTorrent(api, file, 30));
  api.enableFullCache(0);
  api.prioritizeFullCache(file, 0, 1200);
  assert.deepEqual(reads, [[3000, FILE_LENGTH - 1]]);
  assert.equal(api.getFullCacheWorker().priorityStart, 1200);
  api.stopFullCacheWorker(true);
});

test('a stream URL from a replaced source is refused', async () => {
  const api = sidecar();
  api.setTorrent(fakeTorrent(api, fakeFile()));
  api.setSourceId(5);
  const { server, port } = await listen(api);
  try {
    assert.equal((await get(port, '/stream/0?source=4', { Range: 'bytes=0-9' })).status, 410);
    assert.equal((await get(port, '/whisper/0?source=4', { Range: 'bytes=0-9' })).status, 410);
    const current = await get(port, '/stream/0?source=5', { Range: 'bytes=0-9' });
    assert.equal(current.status, 206);
    assert.deepEqual(current.body, fileBytes.subarray(0, 10));
  } finally {
    server.close();
  }
});
