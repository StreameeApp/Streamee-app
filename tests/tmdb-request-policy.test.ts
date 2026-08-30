import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getUpNextNoResultCachePolicy,
  getTmdbEpisodeCacheTtlMs,
  isTmdbSearchQueryReady,
  UP_NEXT_RESOLVED_RESULT_CACHE_TTL_MS,
} from '../src/renderer/services/tmdb-request-policy.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function episode(airDate: string | null) {
  return {
    id: 1,
    name: 'Episode',
    overview: '',
    still_path: null,
    episode_number: 1,
    season_number: 1,
    air_date: airDate,
    runtime: 45,
    vote_average: 0,
  };
}

test('TMDB search waits for at least two non-whitespace characters', () => {
  assert.equal(isTmdbSearchQueryReady(''), false);
  assert.equal(isTmdbSearchQueryReady(' a '), false);
  assert.equal(isTmdbSearchQueryReady(' ab '), true);
});

test('historical episode lists use a long-lived cache', () => {
  const now = Date.UTC(2026, 7, 27);
  assert.equal(
    getTmdbEpisodeCacheTtlMs([episode('2026-06-01')], now),
    30 * DAY_MS,
  );
});

test('current, future, and undated episode lists refresh within six hours', () => {
  const now = Date.UTC(2026, 7, 27);
  assert.equal(getTmdbEpisodeCacheTtlMs([episode('2026-08-26')], now), 6 * HOUR_MS);
  assert.equal(getTmdbEpisodeCacheTtlMs([episode('2026-09-01')], now), 6 * HOUR_MS);
  assert.equal(getTmdbEpisodeCacheTtlMs([episode(null)], now), 6 * HOUR_MS);
});

test('resolved Up Next episodes remain cached until watched state normally changes the key', () => {
  assert.equal(UP_NEXT_RESOLVED_RESULT_CACHE_TTL_MS, 365 * DAY_MS);
});

test('an episode airing today gets a short scheduled retry instead of a weekly active retry', () => {
  const now = new Date(2026, 7, 31, 12, 0, 0).getTime();
  assert.deepEqual(
    getUpNextNoResultCachePolicy(0, {
      status: 'Returning Series',
      inProduction: true,
      nextEpisodeAirDate: '2026-08-31',
    }, now),
    { policy: 'scheduled', ttlMs: 6 * HOUR_MS },
  );
  assert.deepEqual(
    getUpNextNoResultCachePolicy(3, {
      status: 'Returning Series',
      inProduction: true,
      nextEpisodeAirDate: '2026-08-31',
    }, now),
    { policy: 'scheduled', ttlMs: 12 * HOUR_MS },
  );
});

test('future scheduled episodes recheck by their air date with a thirty-day ceiling', () => {
  const now = new Date(2026, 7, 31, 12, 0, 0).getTime();
  const policy = getUpNextNoResultCachePolicy(0, {
    status: 'Returning Series',
    inProduction: true,
    nextEpisodeAirDate: '2026-12-01',
  }, now);
  assert.equal(policy.policy, 'scheduled');
  assert.equal(policy.ttlMs, 30 * DAY_MS);
});

test('active, terminal, and unknown shows use their intended staggered cohorts', () => {
  const now = new Date(2026, 7, 31, 12, 0, 0).getTime();
  assert.deepEqual(
    getUpNextNoResultCachePolicy(3, {
      status: 'Returning Series',
      inProduction: true,
      nextEpisodeAirDate: null,
    }, now),
    { policy: 'active', ttlMs: 10 * DAY_MS },
  );
  assert.deepEqual(
    getUpNextNoResultCachePolicy(3, {
      status: 'Ended',
      inProduction: false,
      nextEpisodeAirDate: null,
    }, now),
    { policy: 'terminal', ttlMs: 51 * DAY_MS },
  );
  assert.deepEqual(
    getUpNextNoResultCachePolicy(3, {
      status: null,
      inProduction: false,
      nextEpisodeAirDate: null,
    }, now),
    { policy: 'unknown', ttlMs: 42 * HOUR_MS },
  );
});
