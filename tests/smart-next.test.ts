import assert from 'node:assert/strict';
import test from 'node:test';
import type { TorrentResult } from '../src/renderer/store/index.ts';
import {
  fingerprintRelease,
  orderSmartEpisodeSeasons,
  rankSmartNextCandidates,
  rememberCompletedSmartNextRequest,
  selectSmartEpisodeInSeason,
  shouldAutoloadSmartNext,
  shouldExecuteSmartNextRequest,
  shouldReuseSmartNextPreparation,
  smartNextRequestKey,
} from '../src/renderer/services/smart-next.ts';

test('previous episode traverses regular seasons backward without falling into specials', () => {
  assert.deepEqual(
    orderSmartEpisodeSeasons([0, 1, 2, 3], { season: 2, episode: 1 }, 'previous'),
    [2, 1],
  );
  assert.deepEqual(
    orderSmartEpisodeSeasons([0, 1, 2], { season: 1, episode: 1 }, 'previous'),
    [1],
  );
});

test('previous episode selects the closest lower episode from unsorted data', () => {
  assert.equal(
    selectSmartEpisodeInSeason([1, 3, 2], 2, { season: 2, episode: 4 }, 'previous'),
    3,
  );
  assert.equal(
    selectSmartEpisodeInSeason([1, 3, 2], 1, { season: 2, episode: 1 }, 'previous'),
    3,
  );
  assert.equal(
    selectSmartEpisodeInSeason([1], 1, { season: 1, episode: 1 }, 'previous'),
    null,
  );
});

test('next episode keeps forward regular-season traversal semantics', () => {
  assert.deepEqual(
    orderSmartEpisodeSeasons([0, 1, 2, 3], { season: 2, episode: 3 }, 'next'),
    [2, 3],
  );
  assert.equal(
    selectSmartEpisodeInSeason([5, 4, 2], 2, { season: 2, episode: 3 }, 'next'),
    4,
  );
  assert.equal(
    selectSmartEpisodeInSeason([2, 1], 3, { season: 2, episode: 3 }, 'next'),
    1,
  );
});

test('autoload starts only at the enabled 70 percent boundary', () => {
  assert.equal(shouldAutoloadSmartNext(false, 70, 100), false);
  assert.equal(shouldAutoloadSmartNext(true, 69.99, 100), false);
  assert.equal(shouldAutoloadSmartNext(true, 70, 100), true);
  assert.equal(shouldAutoloadSmartNext(true, 90, 0), false);
  assert.equal(shouldAutoloadSmartNext(true, null, 100), false);
});

test('completed warmup remains reusable after search metadata expires', () => {
  const now = 1_000_000;

  assert.equal(shouldReuseSmartNextPreparation('episode-3', 'episode-3', now - 1, true, now), true);
  assert.equal(shouldReuseSmartNextPreparation('episode-3', 'episode-3', now - 1, false, now), false);
  assert.equal(shouldReuseSmartNextPreparation('episode-2', 'episode-3', now + 60_000, true, now), false);
});

function torrent(title: string, overrides: Partial<TorrentResult> = {}): TorrentResult {
  return {
    id: title,
    title,
    infoHash: '',
    magnetUri: `magnet:?dn=${encodeURIComponent(title)}`,
    size: 8_000_000_000,
    seeds: 10,
    peers: 2,
    quality: '4K',
    indexer: 'Test',
    ...overrides,
  };
}

test('fingerprints the release traits used by Smart Next', () => {
  assert.deepEqual(
    fingerprintRelease(torrent('Lioness.S01E01.2160p.WEB-DL.DDP5.1.SDR.H.265-BTM.mkv')),
    {
      resolution: '4K',
      dynamicRange: 'sdr',
      source: 'web-dl',
      videoCodec: 'hevc',
      audioCodec: 'ddp',
      atmos: false,
      releaseGroup: 'btm',
    },
  );
});

test('prefers the matching release group, resolution, and dynamic range', () => {
  const current = torrent('Lioness S01E01 2160p WEB-DL SDR H265 BTM');
  const candidates = [
    torrent('Lioness S01E02 2160p WEB-DL SDR H265 FLUX', { seeds: 500, cached: true }),
    torrent('Lioness S01E02 1080p WEB-DL SDR H265 BTM', { quality: '1080p', seeds: 200 }),
    torrent('Lioness S01E02 2160p WEB-DL SDR H265 BTM', { seeds: 5 }),
  ];

  const ranked = rankSmartNextCandidates(current, candidates);
  assert.equal(ranked[0].result.title, 'Lioness S01E02 2160p WEB-DL SDR H265 BTM');
  assert.ok(ranked[0].matchedTraits.includes('group BTM'));
});

test('falls back to the closest cached release when the group is unavailable', () => {
  const current = torrent('Lioness S01E01 2160p WEB-DL SDR H265 BTM');
  const candidates = [
    torrent('Lioness S01E02 1080p WEB-DL SDR H265 NTb', { quality: '1080p', seeds: 100 }),
    torrent('Lioness S01E02 2160p WEB-DL SDR H265 FLUX', { cached: true, seeds: 20 }),
    torrent('Lioness S01E02 2160p WEB-DL DV H265 FLUX', { cached: true, seeds: 200 }),
  ];

  const ranked = rankSmartNextCandidates(current, candidates);
  assert.equal(ranked[0].result.title, 'Lioness S01E02 2160p WEB-DL SDR H265 FLUX');
});

test('deduplicates event and recovery delivery within one MPV session', () => {
  const request = { request_id: 130_346, mpv_pid: 42_140 };
  const completed = new Set<string>();

  assert.equal(shouldExecuteSmartNextRequest(completed, null, request), true);
  rememberCompletedSmartNextRequest(completed, smartNextRequestKey(request));
  assert.equal(shouldExecuteSmartNextRequest(completed, null, request), false);
});

test('does not confuse matching request ids from different MPV sessions', () => {
  const completed = new Set<string>();
  const previousSession = { request_id: 10_000, mpv_pid: 100 };
  const nextSession = { request_id: 10_000, mpv_pid: 200 };

  rememberCompletedSmartNextRequest(completed, smartNextRequestKey(previousSession));
  assert.equal(shouldExecuteSmartNextRequest(completed, null, previousSession), false);
  assert.equal(shouldExecuteSmartNextRequest(completed, null, nextSession), true);
});

test('completed request ledger stays bounded while preserving recent dedupe', () => {
  const completed = new Set<string>();
  for (let requestId = 1; requestId <= 40; requestId += 1) {
    rememberCompletedSmartNextRequest(
      completed,
      smartNextRequestKey({ request_id: requestId, mpv_pid: 99 }),
      32,
    );
  }

  assert.equal(completed.size, 32);
  assert.equal(completed.has('99:1'), false);
  assert.equal(completed.has('99:40'), true);
});
