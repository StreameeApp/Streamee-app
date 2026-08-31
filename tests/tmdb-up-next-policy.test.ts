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

test('Up Next applies the tested status-aware cache policy and logs its decision', () => {
  assert.match(boardSource, /board:up-next:v3:/);
  assert.match(boardSource, /getUpNextNoResultCachePolicy\(show\.tmdbId, schedule\)/);
  assert.match(boardSource, /noResultCacheTtlMs: noResultCache\.ttlMs/);
  assert.match(boardSource, /noResultCache\.ttlMs,\s*\);/);
  assert.match(boardSource, /nextEpisodeAirDate: schedule\.nextEpisodeAirDate/);
  assert.match(boardSource, /no_result_cache_policy_counts: summary\.noResultCachePolicyCounts/);
  assert.match(boardSource, /no_result_cache_ttl_hours:/);
});

test('Up Next retains a resolved episode with the long-lived policy TTL', () => {
  assert.match(boardSource, /UP_NEXT_RESOLVED_RESULT_CACHE_TTL_MS/);
  assert.match(boardSource, /UP_NEXT_RESOLVED_RESULT_CACHE_TTL_MS,\s*\);/);
});

test('cancelled Up Next scans retain enough counters and reason to explain Worker traffic', () => {
  assert.match(boardSource, /const logCancelledRefresh = \(cancellationStage:/);
  assert.match(boardSource, /unresolved_candidate_count: summary\.unresolvedCandidateCount/);
  assert.match(boardSource, /cached_result_count: summary\.cachedResultCount/);
  assert.match(boardSource, /cache_miss_count: summary\.cacheMissCount/);
  assert.match(boardSource, /season_list_lookups: summary\.seasonListLookups/);
  assert.match(boardSource, /episode_list_lookups: summary\.episodeListLookups/);
  assert.match(boardSource, /no_result_cache_policy_counts: summary\.noResultCachePolicyCounts/);
  assert.match(boardSource, /cancellation_reason: getCancellationReason\(\)/);
  assert.match(boardSource, /if \(!boardMountedRef\.current\) return 'board_unmounted'/);
  assert.match(boardSource, /logCancelledRefresh\('candidate_resolution'\)/);
  assert.match(boardSource, /logCancelledRefresh\('metadata_enrichment'\)/);
});

test('Up Next gets lifecycle metadata with the existing TV details lookup', () => {
  assert.match(tmdbSource, /export async function getTmdbSeriesSchedule/);
  assert.match(tmdbSource, /tmdbClient\.get<TmdbMetaData>\(`\/tv\/\$\{tmdbId\}`\)/);
  assert.match(tmdbSource, /status: typeof details\.status === 'string'/);
  assert.match(tmdbSource, /nextEpisodeAirDate: details\.next_episode_to_air\?\.air_date \|\| null/);
  assert.match(boardSource, /getTmdbSeriesSchedule\(show\.tmdbId, \{ throwOnError: true \}\)/);
});

test('Up Next preserves transient TMDB failures instead of negative-caching them', () => {
  assert.match(tmdbSource, /options: \{ throwOnError\?: boolean \} = \{\}/);
  assert.match(tmdbSource, /if \(options\.throwOnError\) throw error/);
  assert.match(boardSource, /getTmdbSeriesSchedule\(show\.tmdbId, \{ throwOnError: true \}\)/);
  assert.match(boardSource, /getTmdbEpisodes\(show\.tmdbId, season\.season_number, \{ throwOnError: true \}\)/);
  assert.match(boardSource, /failed: true,\s*errorKind:/);
});

test('TMDB request summaries use the initialized structured logger directly', () => {
  assert.match(tmdbApiSource, /import \{ logger \} from '\.\/logger\.ts'/);
  assert.doesNotMatch(tmdbApiSource, /import\('\.\/logger\.ts'\)/);
  assert.match(loggerSource, /typeof window\.addEventListener !== 'function'/);
});
