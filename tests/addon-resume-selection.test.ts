import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectAddonResumeResult,
  shouldResolveAddonResumeSource,
} from '../src/renderer/services/addon-resume-selection.ts';
import type { TorrentResult } from '../src/renderer/store/index.ts';

function result(overrides: Partial<TorrentResult>): TorrentResult {
  return {
    id: 'stream',
    title: 'Episode.mkv',
    infoHash: 'same-hash',
    magnetUri: '',
    size: 7_000,
    seeds: 0,
    peers: 0,
    quality: '1080p',
    indexer: 'Example',
    sourceProvider: 'addon',
    directStreamProvider: 'addon',
    streamHandle: 'opaque',
    streamFilename: 'Episode.mkv',
    sourceFileIndex: 2,
    addonInstallationId: 'original-installation',
    addonId: 'example-addon',
    ...overrides,
  };
}

test('Continue prefers the original installation for the same hash and file', () => {
  const equivalentOtherInstallation = result({
    id: 'other-stream',
    addonInstallationId: 'other-installation',
  });
  const original = result({ id: 'original-stream' });
  assert.equal(
    selectAddonResumeResult([equivalentOtherInstallation, original], {
      installationId: 'original-installation',
      addonId: 'example-addon',
      infoHash: 'SAME-HASH',
      fileIndex: 2,
    }),
    original,
  );
});

test('Continue falls back to another installation when the original is unavailable', () => {
  const fallback = result({ addonInstallationId: 'other-installation' });
  assert.equal(
    selectAddonResumeResult([fallback], {
      installationId: 'missing-installation',
      addonId: 'example-addon',
      infoHash: 'same-hash',
      fileIndex: 2,
    }),
    fallback,
  );
});

test('Continue re-resolves an add-on torrent only when a series target changes', () => {
  const route = {
    sourceType: 'webtorrent' as const,
    isTvShow: true,
    hasAddonOrigin: true,
    storedSeason: 1,
    storedEpisode: 2,
    targetSeason: 1,
    targetEpisode: 3,
  };
  assert.equal(shouldResolveAddonResumeSource(route), true);
  assert.equal(
    shouldResolveAddonResumeSource({ ...route, targetEpisode: 2 }),
    false,
  );
  assert.equal(
    shouldResolveAddonResumeSource({ ...route, isTvShow: false }),
    false,
  );
});

test('Continue always re-resolves a direct add-on stream', () => {
  assert.equal(shouldResolveAddonResumeSource({
    sourceType: 'addon',
    isTvShow: false,
    hasAddonOrigin: true,
  }), true);
});
