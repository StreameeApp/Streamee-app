import assert from 'node:assert/strict';
import test from 'node:test';
import parseTorrent from 'parse-torrent';
import { buildAddonMagnetUri } from '../src/renderer/services/torrent-utils.ts';

const infoHash = '0123456789012345678901234567890123456789';

test('add-on trackers survive the torrent parser with their query parameters intact', async () => {
  const tracker = 'https://tracker.example.com/announce?passkey=example&mode=stream';
  const uri = buildAddonMagnetUri(infoHash, [
    'tracker:udp://tracker.example.com:1337/announce',
    `tracker:${tracker}`,
    `tracker:${tracker}`,
  ]);
  const magnet = new URL(uri);
  assert.equal(magnet.searchParams.get('xt'), `urn:btih:${infoHash}`);
  assert.deepEqual(magnet.searchParams.getAll('tr'), [
    'udp://tracker.example.com:1337/announce', tracker,
  ]);
  const parsed = await parseTorrent(uri);
  assert.equal(parsed.infoHash, infoHash);
  assert.deepEqual(parsed.announce, magnet.searchParams.getAll('tr'));
});

test('invalid and non-tracker hints cannot alter the magnet identity', () => {
  const magnet = new URL(buildAddonMagnetUri(infoHash, [
    'dht:example-node', 'tracker:not a URL', 'tracker:file:///tmp/source',
    'tracker:https://user:secret@tracker.example.com/announce',
    'tracker:https://tracker.example.com/announce#fragment',
  ]));
  assert.equal(magnet.searchParams.get('xt'), `urn:btih:${infoHash}`);
  assert.deepEqual(magnet.searchParams.getAll('tr'), []);
});

test('older add-on responses without discovery hints still produce a parseable magnet', async () => {
  const magnet = buildAddonMagnetUri(infoHash);
  assert.equal(new URL(magnet).searchParams.get('xt'), `urn:btih:${infoHash}`);
  assert.equal((await parseTorrent(magnet)).infoHash, infoHash);
});

test('tracker query spaces retain percent encoding understood by the torrent parser', async () => {
  const tracker = 'https://tracker.example.com/announce?label=lawful%20stream';
  const parsed = await parseTorrent(buildAddonMagnetUri(infoHash, [`tracker:${tracker}`]));
  assert.deepEqual(parsed.announce, [tracker]);
});
