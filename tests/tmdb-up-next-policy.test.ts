import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const boardSource = fs.readFileSync(
  new URL('../src/renderer/features/board/Board.tsx', import.meta.url),
  'utf8',
);
const tmdbSource = fs.readFileSync(
  new URL('../src/renderer/services/tmdb.ts', import.meta.url),
  'utf8',
);
const tmdbApiSource = fs.readFileSync(
  new URL('../src/renderer/services/tmdb-api.ts', import.meta.url),
  'utf8',
);
const loggerSource = fs.readFileSync(
  new URL('../src/renderer/services/logger.ts', import.meta.url),
  'utf8',
);

test('Up Next caches confirmed empty results in staggered cohorts', () => {
  assert.match(boardSource, /board:up-next:v3:/);
  assert.match(boardSource, /writePersistentlyCachedValue\(\s*cacheKey,\s*\{ nextEpisode: null \}/);
  assert.match(boardSource, /getUpNextNoResultCacheTtlMs\(show\.tmdbId\)/);
  assert.match(boardSource, /UP_NEXT_NO_RESULT_CACHE_STAGGER_BUCKETS = 4/);
});

test('Up Next preserves transient TMDB failures instead of negative-caching them', () => {
  assert.match(tmdbSource, /options: \{ throwOnError\?: boolean \} = \{\}/);
  assert.match(tmdbSource, /if \(options\.throwOnError\) throw error/);
  assert.match(boardSource, /getTmdbSeasons\(show\.tmdbId, \{ throwOnError: true \}\)/);
  assert.match(boardSource, /getTmdbEpisodes\(show\.tmdbId, season\.season_number, \{ throwOnError: true \}\)/);
  assert.match(boardSource, /failed: true,\s*errorKind:/);
});

test('TMDB request summaries use the initialized structured logger directly', () => {
  assert.match(tmdbApiSource, /import \{ logger \} from '\.\/logger\.ts'/);
  assert.doesNotMatch(tmdbApiSource, /import\('\.\/logger\.ts'\)/);
  assert.match(loggerSource, /typeof window\.addEventListener !== 'function'/);
});
