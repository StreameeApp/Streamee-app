import assert from 'node:assert/strict';
import test from 'node:test';

import type { TorrentResult } from '../src/renderer/store/index.ts';
import { selectDirectStartupReplacement } from '../src/renderer/services/direct-startup-failover.ts';

const result = (overrides: Partial<TorrentResult>): TorrentResult => ({
  id: 'stream',
  title: 'Show.S01E01.1080p.WEB-DL-GROUP',
  magnetUri: 'streamee-direct://opaque',
  size: 1_000,
  seeds: 0,
  quality: '1080p',
  indexer: 'Addon · Primary',
  cached: true,
  addonInstallationId: 'primary',
  streamHandle: 'opaque-handle',
  ...overrides,
});

test('startup failover prefers the identical info hash and file index', () => {
  const current = result({ infoHash: 'ABC', sourceFileIndex: 4 });
  const alternate = result({ id: 'alternate', infoHash: 'DEF', sourceFileIndex: 1 });
  const exact = result({ id: 'exact', infoHash: 'abc', sourceFileIndex: 4 });
  assert.equal(selectDirectStartupReplacement(current, [alternate, exact])?.id, 'exact');
});

test('startup failover chooses the best equivalent installed add-on stream', () => {
  const current = result({ title: 'Show.S01E01.1080p.WEB-DL-GROUP', infoHash: 'ABC' });
  const unmatched = result({ id: 'unmatched', infoHash: 'DEF', quality: '4K', addonInstallationId: undefined, streamHandle: undefined });
  const weak = result({ id: 'weak', infoHash: 'GHI', title: 'Show.S01E01.720p.HDTV-OTHER', quality: '720p' });
  const equivalent = result({ id: 'equivalent', infoHash: 'JKL', title: 'Show.S01E01.1080p.WEB-DL-GROUP' });
  assert.equal(selectDirectStartupReplacement(current, [unmatched, weak, equivalent])?.id, 'equivalent');
});

test('startup failover accepts a playable result from another installed add-on', () => {
  const current = result({ infoHash: 'ABC', addonInstallationId: 'first' });
  const replacement = result({
    id: 'replacement',
    infoHash: 'DEF',
    directStreamProvider: undefined,
    addonInstallationId: 'second',
    addonName: 'Add-on Beta',
    streamHandle: 'opaque-handle',
  });

  assert.equal(selectDirectStartupReplacement(current, [replacement])?.id, 'replacement');
});
