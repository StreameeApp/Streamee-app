const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TMDB_MIN_SEARCH_QUERY_LENGTH = 2;
const TMDB_RECENT_EPISODE_CACHE_TTL_MS = 6 * HOUR_MS;
const TMDB_HISTORICAL_EPISODE_CACHE_TTL_MS = 30 * DAY_MS;
const UP_NEXT_NO_RESULT_CACHE_BASE_TTL_MS = DAY_MS;
const UP_NEXT_NO_RESULT_CACHE_STAGGER_MS = 6 * HOUR_MS;
const UP_NEXT_NO_RESULT_CACHE_STAGGER_BUCKETS = 4;
const UP_NEXT_ACTIVE_NO_RESULT_CACHE_BASE_TTL_MS = 7 * DAY_MS;
const UP_NEXT_ACTIVE_NO_RESULT_CACHE_STAGGER_MS = DAY_MS;
const UP_NEXT_TERMINAL_NO_RESULT_CACHE_BASE_TTL_MS = 30 * DAY_MS;
const UP_NEXT_TERMINAL_NO_RESULT_CACHE_STAGGER_MS = 7 * DAY_MS;
const UP_NEXT_SCHEDULED_NO_RESULT_CACHE_MAX_TTL_MS = 30 * DAY_MS;
const UP_NEXT_SCHEDULED_NO_RESULT_CACHE_STAGGER_MS = 2 * HOUR_MS;
const UP_NEXT_SCHEDULED_TODAY_CACHE_BASE_TTL_MS = 6 * HOUR_MS;

export const UP_NEXT_RESOLVED_RESULT_CACHE_TTL_MS = 365 * DAY_MS;

export interface UpNextSeriesSchedule {
  status: string | null;
  inProduction: boolean;
  nextEpisodeAirDate: string | null;
}

export interface UpNextNoResultCachePolicy {
  ttlMs: number;
  policy: 'scheduled' | 'active' | 'terminal' | 'unknown';
}

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

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getUpNextNoResultCachePolicy(
  tmdbId: number,
  schedule: UpNextSeriesSchedule,
  now: number = Date.now(),
): UpNextNoResultCachePolicy {
  const staggerBucket = Math.abs(tmdbId) % UP_NEXT_NO_RESULT_CACHE_STAGGER_BUCKETS;
  if (schedule.nextEpisodeAirDate) {
    if (schedule.nextEpisodeAirDate === localDateKey(now)) {
      return {
        ttlMs: UP_NEXT_SCHEDULED_TODAY_CACHE_BASE_TTL_MS
          + staggerBucket * UP_NEXT_SCHEDULED_NO_RESULT_CACHE_STAGGER_MS,
        policy: 'scheduled',
      };
    }

    const airDate = new Date(`${schedule.nextEpisodeAirDate}T00:00:00`).getTime();
    if (Number.isFinite(airDate) && airDate > now) {
      return {
        ttlMs: Math.max(
          UP_NEXT_SCHEDULED_TODAY_CACHE_BASE_TTL_MS,
          Math.min(
            airDate - now + staggerBucket * UP_NEXT_SCHEDULED_NO_RESULT_CACHE_STAGGER_MS,
            UP_NEXT_SCHEDULED_NO_RESULT_CACHE_MAX_TTL_MS,
          ),
        ),
        policy: 'scheduled',
      };
    }
  }

  if (!schedule.inProduction && (schedule.status === 'Ended' || schedule.status === 'Canceled')) {
    return {
      ttlMs: UP_NEXT_TERMINAL_NO_RESULT_CACHE_BASE_TTL_MS
        + staggerBucket * UP_NEXT_TERMINAL_NO_RESULT_CACHE_STAGGER_MS,
      policy: 'terminal',
    };
  }

  if (
    schedule.inProduction
    || schedule.status === 'Returning Series'
    || schedule.status === 'In Production'
    || schedule.status === 'Planned'
    || schedule.status === 'Pilot'
  ) {
    return {
      ttlMs: UP_NEXT_ACTIVE_NO_RESULT_CACHE_BASE_TTL_MS
        + staggerBucket * UP_NEXT_ACTIVE_NO_RESULT_CACHE_STAGGER_MS,
      policy: 'active',
    };
  }

  return {
    ttlMs: UP_NEXT_NO_RESULT_CACHE_BASE_TTL_MS + staggerBucket * UP_NEXT_NO_RESULT_CACHE_STAGGER_MS,
    policy: 'unknown',
  };
}
