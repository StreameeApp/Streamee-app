import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTmdbEpisodeCacheTtlMs,
  isTmdbSearchQueryReady,
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
