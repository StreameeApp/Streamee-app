const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TMDB_MIN_SEARCH_QUERY_LENGTH = 2;
const TMDB_RECENT_EPISODE_CACHE_TTL_MS = 6 * HOUR_MS;
const TMDB_HISTORICAL_EPISODE_CACHE_TTL_MS = 30 * DAY_MS;

export function isTmdbSearchQueryReady(query: string): boolean {
  return query.trim().length >= TMDB_MIN_SEARCH_QUERY_LENGTH;
}

export function getTmdbEpisodeCacheTtlMs(
  episodes: Array<{ air_date: string | null }>,
  now: number = Date.now(),
): number {
  const latestAirDate = episodes.reduce((latest, episode) => {
    const timestamp = Date.parse(episode.air_date || '');
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
  return latestAirDate > 0 && latestAirDate < now - 30 * DAY_MS
    ? TMDB_HISTORICAL_EPISODE_CACHE_TTL_MS
    : TMDB_RECENT_EPISODE_CACHE_TTL_MS;
}
