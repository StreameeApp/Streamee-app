import assert from 'node:assert/strict';
import test from 'node:test';

import { deduplicateResults } from '../src/renderer/services/source-deduplication.ts';
import type { TorrentResult } from '../src/renderer/store/index.ts';

function torrent(overrides: Partial<TorrentResult> = {}): TorrentResult {
  return {
    id: 'result',
    title: 'Example release',
    infoHash: '',
    magnetUri: '',
    size: 0,
    seeds: 0,
    peers: 0,
    quality: '4K',
    indexer: 'Example add-on',
    ...overrides,
  };
}

test('hides direct add-on duplicates with the same normalized filename', () => {
  const results = [
    torrent({
      id: 'one',
      streamHandle: 'handle-one',
      magnetUri: 'streamee-addon://handle-one',
      streamFilename: 'Folder/Percy.Jackson.S02E01.mkv',
      size: 4_831_838_208,
    }),
    torrent({
      id: 'two',
      streamHandle: 'handle-two',
      magnetUri: 'streamee-addon://handle-two',
      streamFilename: 'percy.jackson.s02e01.mkv',
      size: 4_766_070_784,
    }),
  ];

  assert.deepEqual(deduplicateResults(results).map((result) => result.id), ['one']);
});

test('keeps separate direct add-on rows when their filenames differ', () => {
  const results = [
    torrent({ id: 'one', streamFilename: 'Percy.Jackson.S02E01.mkv' }),
    torrent({ id: 'two', streamFilename: 'Percy.Jackson.S02E01.REPACK.mkv' }),
  ];

  assert.deepEqual(deduplicateResults(results).map((result) => result.id), ['one', 'two']);
});

test('falls back to source identity when no filename is available', () => {
  const results = [
    torrent({ id: 'one', magnetUri: 'streamee-addon://one' }),
    torrent({ id: 'two', magnetUri: 'streamee-addon://two' }),
  ];

  assert.deepEqual(deduplicateResults(results).map((result) => result.id), ['one', 'two']);
});
