import {
  ensureValidToken,
  isAuthenticated as hasStoredTraktSession,
  getWatchedShowsResult,
  getWatchedMoviesResult,
  getWatchlistResult,
  addToWatchlist as traktAddToWatchlist,
  removeFromWatchlist as traktRemoveFromWatchlist,
  markAsWatched as traktMarkAsWatched,
  removeFromHistory as traktRemoveFromHistory,
  markSeasonAsWatched as traktMarkSeasonAsWatched,
  getLastActivities,
  getPlaybackProgressResult,
  getWatchHistoryResult,
  addHistoryBatch,
  removeHistoryBatch,
  addWatchlistBatch,
  removeWatchlistBatch,
  getTraktRateLimitRetryAt,
  getTraktErrorDiagnostics,
  isTraktRateLimitError,
  TraktHistorySyncPayload,
  TraktWatchlistSyncPayload,
  TraktHistoryItem,
  TraktWatchedShow,
  TraktWatchedMovie
} from '../services/trakt';
import { enrichTmdbItemsById } from '../services/tmdb';
import { useStore, MetaPreview, ContinueWatchingItem, PendingTraktHistoryAction, PendingTraktWatchlistAction } from '../store';

export type StartupTraktSyncState = 'pending' | 'running' | 'settled';

let startupTraktSyncState: StartupTraktSyncState = 'pending';
const startupTraktSyncListeners = new Set<() => void>();

function setStartupTraktSyncState(state: StartupTraktSyncState): void {
  if (startupTraktSyncState === state) return;
  startupTraktSyncState = state;
  startupTraktSyncListeners.forEach((listener) => listener());
}

export function getStartupTraktSyncState(): StartupTraktSyncState {
  return startupTraktSyncState;
}

export function subscribeStartupTraktSyncState(listener: () => void): () => void {
  startupTraktSyncListeners.add(listener);
  return () => startupTraktSyncListeners.delete(listener);
}

function mergeContinueWatching(
  local: ContinueWatchingItem[],
  remote: ContinueWatchingItem[],
  watchedMovieIds: Set<string>,
  watchedEpisodeKeys: Set<string>
): ContinueWatchingItem[] {
  const merged = new Map<string, ContinueWatchingItem>();
  const isWatchedResumeItem = (item: ContinueWatchingItem) => {
    if (item.type === 'movie') {
      return watchedMovieIds.has(item.metaId);
    }

    if (typeof item.season !== 'number' || typeof item.episode !== 'number') {
      return false;
    }

    return watchedEpisodeKeys.has(getEpisodeKey(parseTmdbId(item.metaId), item.season, item.episode));
  };
  const shouldKeepResumeItem = (item: ContinueWatchingItem) =>
    item.progress >= 0 && item.progress < 90 && !isWatchedResumeItem(item);
  const resumeScore = (item: ContinueWatchingItem) =>
    (typeof item.playbackTime === 'number' ? 2 : 0) +
    (typeof item.duration === 'number' ? 2 : 0) +
    (typeof item.season === 'number' && typeof item.episode === 'number' ? 1 : 0);
  const chooseNewestResumeItem = (
    current: ContinueWatchingItem,
    candidate: ContinueWatchingItem
  ) => {
    const currentDate = parseTimestamp(current.pausedAt);
    const candidateDate = parseTimestamp(candidate.pausedAt);

    if (candidateDate > currentDate) {
      return candidate;
    }

    if (candidateDate < currentDate) {
      return current;
    }

    return resumeScore(candidate) > resumeScore(current) ? candidate : current;
  };

  remote.forEach(item => {
    if (!shouldKeepResumeItem(item)) {
      return;
    }
    const existing = merged.get(item.metaId);
    merged.set(item.metaId, existing ? chooseNewestResumeItem(existing, item) : item);
  });

  local.forEach(item => {
    if (!shouldKeepResumeItem(item)) {
      return;
    }
    const existing = merged.get(item.metaId);
    if (existing) {
      merged.set(item.metaId, chooseNewestResumeItem(existing, item));
      return;
    }

    merged.set(item.metaId, item);
  });

  return Array.from(merged.values()).sort((a, b) => parseTimestamp(b.pausedAt) - parseTimestamp(a.pausedAt));
}

function dedupeByMetaId(items: ContinueWatchingItem[]): ContinueWatchingItem[] {
  const deduped = new Map<string, ContinueWatchingItem>();
  
  for (const item of items) {
    const existing = deduped.get(item.metaId);
    if (!existing) {
      deduped.set(item.metaId, item);
    } else if (parseTimestamp(item.pausedAt) > parseTimestamp(existing.pausedAt)) {
      deduped.set(item.metaId, item);
    } else if (
      parseTimestamp(item.pausedAt) === parseTimestamp(existing.pausedAt) &&
      item.progress > existing.progress
    ) {
      deduped.set(item.metaId, item);
    }
  }
  
  return Array.from(deduped.values());
}

async function enrichContinueWatchingPosters(
  items: ContinueWatchingItem[],
): Promise<ContinueWatchingItem[]> {
  const previews = await enrichTmdbItemsById(items.flatMap((item) => {
    const match = /^(movie|tv):(\d+)$/.exec(item.metaId);
    if (!match) return [];
    return [{
      tmdbId: Number(match[2]),
      mediaType: match[1] as 'movie' | 'tv',
      name: item.title,
    }];
  }));
  const postersById = new Map(previews.map((preview) => [preview.id, preview.poster]));
  return items.map((item) => ({
    ...item,
    poster: item.poster || postersById.get(item.metaId) || '',
  }));
}

async function buildContinueWatchingFromEpisodeHistory(
  historyItems: TraktHistoryItem[],
  watchedEpisodeKeys: Set<string>
): Promise<ContinueWatchingItem[]> {
  const latestByShow = new Map<string, TraktHistoryItem>();

  const recentEpisodeHistory = historyItems
    .filter((item) => item.show?.ids?.tmdb && item.episode)
    .sort((a, b) => parseTimestamp(b.watched_at) - parseTimestamp(a.watched_at))
    .slice(0, 50);

  for (const item of recentEpisodeHistory) {
    if (!item.show?.ids?.tmdb || !item.episode) {
      continue;
    }

    const metaId = `tv:${item.show.ids.tmdb}`;
    const existing = latestByShow.get(metaId);
    if (!existing || parseTimestamp(item.watched_at) > parseTimestamp(existing.watched_at)) {
      latestByShow.set(metaId, item);
    }
  }

  const continueItems: ContinueWatchingItem[] = [];
  for (const item of latestByShow.values()) {
    const tmdbId = item.show?.ids?.tmdb;
    const show = item.show;
    const watchedEpisode = item.episode;
    if (!tmdbId || !show || !watchedEpisode) {
      continue;
    }

    let nextSeason = watchedEpisode.season;
    let nextEpisode = watchedEpisode.number + 1;

    if (watchedEpisodeKeys.has(getEpisodeKey(tmdbId, nextSeason, nextEpisode))) {
      continue;
    }

    continueItems.push({
      metaId: `tv:${tmdbId}`,
      type: 'series',
      title: show.title,
      poster: '',
      progress: 0,
      pausedAt: item.watched_at,
      episodeId: `${nextSeason}:${nextEpisode}`,
      season: nextSeason,
      episode: nextEpisode
    });
  }

  return enrichContinueWatchingPosters(continueItems);
}

const TRAKT_STARTUP_BASELINE_KEY = 'streamee-trakt-startup-push-baseline-v1';

interface SyncResult {
  success: boolean;
  conflicts: string[];
  warnings: string[];
  retryAt?: number;
}

interface TraktPullOptions {
  fullHistory?: boolean;
}

function parseTmdbId(metaId: string): number {
  const parts = metaId.split(':');
  return parseInt(parts[1], 10);
}

function parseTimestamp(value?: string | null): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function setLatestWatchedAt(watchedAtMap: Map<string, string>, key: string, watchedAt?: string | null): void {
  const watchedAtTime = parseTimestamp(watchedAt);
  if (watchedAtTime <= 0) {
    return;
  }

  const existingTime = parseTimestamp(watchedAtMap.get(key));
  if (watchedAtTime > existingTime) {
    watchedAtMap.set(key, watchedAt!);
  }
}

function getMetaType(meta: Pick<MetaPreview, 'type'>): 'movie' | 'show' {
  return meta.type === 'movie' ? 'movie' : 'show';
}

function getWatchlistActivityTime(activities: Awaited<ReturnType<typeof getLastActivities>>): number {
  const candidates = [
    typeof activities?.watchlist === 'string' ? activities.watchlist : undefined,
    typeof activities?.watchlist === 'object' ? activities.watchlist.updated_at : undefined,
    typeof activities?.watchlist === 'object' ? activities.watchlist.added_at : undefined,
    typeof activities?.watchlist === 'object' ? activities.watchlist.deleted_at : undefined,
    activities?.lists?.updated_at,
    activities?.lists?.liked_at,
    activities?.movies?.watchlisted_at,
    activities?.shows?.watchlisted_at
  ];

  return candidates.reduce((latest, value) => Math.max(latest, parseTimestamp(value)), 0);
}

function getHistoryActivityTime(activities: Awaited<ReturnType<typeof getLastActivities>>): number {
  const categories = [activities?.movies, activities?.episodes, activities?.shows];

  return categories.reduce((latest, category) => {
    if (!category) {
      return latest;
    }
    return Math.max(latest, parseTimestamp(category.watched_at), parseTimestamp(category.paused_at));
  }, 0);
}

function hasReusableEnrichedMetadata(item?: MetaPreview): boolean {
  return !!(
    item?.poster &&
    item.background &&
    item.rating !== undefined &&
    item.imdbId
  );
}

async function enrichMetaPreviews(items: MetaPreview[]): Promise<MetaPreview[]> {
  const targets = items.flatMap((item) => {
    if (hasReusableEnrichedMetadata(item)) return [];
    const match = /^(movie|tv):(\d+)$/.exec(item.id);
    if (!match) return [];
    return [{
      tmdbId: Number(match[2]),
      mediaType: match[1] as 'movie' | 'tv',
      name: item.name,
      releaseDate: item.releaseDate,
    }];
  });
  if (targets.length === 0) return items;

  const enriched = await enrichTmdbItemsById(targets);
  const enrichedById = new Map(enriched.map((item) => [item.id, item]));
  return items.map((item) => {
    const metadata = enrichedById.get(item.id);
    if (!metadata) return item;
    return {
      ...item,
      poster: item.poster || metadata.poster,
      background: item.background || metadata.background,
      rating: item.rating ?? metadata.rating,
      year: item.year || metadata.year,
      imdbId: item.imdbId || metadata.imdbId,
    };
  });
}

function getOldestListedAt(a?: string, b?: string): string | undefined {
  const aTime = parseTimestamp(a);
  const bTime = parseTimestamp(b);

  if (aTime > 0 && bTime > 0) {
    return aTime <= bTime ? a : b;
  }

  return aTime > 0 ? a : bTime > 0 ? b : (a ?? b);
}

function mergeWatchlistByListedAt(local: MetaPreview[], remote: MetaPreview[]): MetaPreview[] {
  const merged = new Map<string, MetaPreview>();

  local.forEach(item => {
    merged.set(item.id, item);
  });

  remote.forEach(item => {
    const existing = merged.get(item.id);
    if (!existing) {
      merged.set(item.id, item);
      return;
    }

    merged.set(item.id, {
      ...existing,
      ...item,
      poster: item.poster ?? existing.poster,
      background: item.background ?? existing.background,
      year: item.year ?? existing.year,
      imdbId: item.imdbId ?? existing.imdbId,
      rating: item.rating ?? existing.rating,
      listedAt: getOldestListedAt(existing.listedAt, item.listedAt)
    });
  });

  return Array.from(merged.values());
}

function getEpisodeKey(tmdbId: string | number, season: number, episode: number): string {
  return `${tmdbId}:${season}:${episode}`;
}

async function runPendingHistoryAction(action: PendingTraktHistoryAction): Promise<boolean> {
  const tmdbId = parseTmdbId(action.metaId);
  if (!Number.isFinite(tmdbId)) {
    return false;
  }

  if (action.action === 'add') {
    return traktMarkAsWatched(action.mediaType, tmdbId, action.season, action.episode, action.watchedAt);
  }

  return traktRemoveFromHistory(action.mediaType, tmdbId, action.season, action.episode);
}

async function runPendingWatchlistAction(action: PendingTraktWatchlistAction): Promise<boolean> {
  const tmdbId = parseTmdbId(action.metaId);
  if (!Number.isFinite(tmdbId)) {
    return false;
  }

  if (action.action === 'add') {
    return traktAddToWatchlist(action.mediaType, tmdbId);
  }

  return traktRemoveFromWatchlist(action.mediaType, tmdbId);
}

async function hasTraktAccess(): Promise<boolean> {
  return Boolean(await ensureValidToken());
}

async function syncHistoryAction(action: Omit<PendingTraktHistoryAction, 'queuedAt'>): Promise<boolean> {
  const queuedAction: PendingTraktHistoryAction = {
    ...action,
    queuedAt: new Date().toISOString()
  };

  useStore.getState().queuePendingTraktHistory(queuedAction);
  try {
    if (!(await hasTraktAccess())) {
      return false;
    }
    const success = await runPendingHistoryAction(queuedAction);
    if (success) {
      useStore.getState().removePendingTraktHistory(queuedAction);
      return true;
    }
  } catch (e) {
    console.error('[Sync] Failed Trakt history action:', {
      action: queuedAction.action,
      mediaType: queuedAction.mediaType,
      hasEpisode: typeof queuedAction.episode === 'number',
      error: getTraktErrorDiagnostics(e)
    });
  }

  return false;
}

async function syncWatchlistAction(action: Omit<PendingTraktWatchlistAction, 'queuedAt'>): Promise<boolean> {
  const queuedAction: PendingTraktWatchlistAction = {
    ...action,
    queuedAt: new Date().toISOString()
  };

  useStore.getState().queuePendingTraktWatchlist(queuedAction);
  try {
    if (!(await hasTraktAccess())) {
      return false;
    }
    const success = await runPendingWatchlistAction(queuedAction);
    if (success) {
      useStore.getState().removePendingTraktWatchlist(queuedAction);
      return true;
    }
  } catch (e) {
    console.error('[Sync] Failed Trakt watchlist action:', {
      action: queuedAction.action,
      mediaType: queuedAction.mediaType,
      error: getTraktErrorDiagnostics(e)
    });
  }

  return false;
}

const WATCH_HISTORY_DEFAULT_MAX_PAGES = 3;
const EPISODE_HISTORY_FULL_SYNC_MAX_PAGES = 100;

interface WatchHistoryLoadResult {
  data: Awaited<ReturnType<typeof getWatchHistoryResult>>['data'];
  success: boolean;
}

async function loadWatchHistory(
  media: 'movies' | 'episodes' | 'shows',
  maxPages: number = WATCH_HISTORY_DEFAULT_MAX_PAGES,
  startAt?: string
): Promise<WatchHistoryLoadResult> {
  const all: WatchHistoryLoadResult['data'] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const historyResult = await getWatchHistoryResult(media, page, 100, startAt);
    if (!historyResult.success) {
      return { data: all, success: false };
    }
    const history = historyResult.data;
    if (history.length === 0) {
      break;
    }

    all.push(...history);
    page += 1;
    if (history.length < 100) {
      hasMore = false;
    }
  }

  if (hasMore) {
    console.warn(`[Sync] ${media} history hit the ${maxPages} page sync limit; older items may not be imported`);
  }

  return { data: all, success: true };
}

function showToMetaPreview(show: { title?: string; year?: number; ids?: { tmdb?: number }; poster?: string } | undefined): MetaPreview | null {
  if (!show || !show.ids?.tmdb) {
    return null;
  }
  return {
    id: `tv:${show.ids.tmdb}`,
    type: 'series',
    name: show.title || 'Unknown',
    poster: show.poster,
    year: show.year?.toString()
  };
}

function movieToMetaPreview(movie: { title?: string; year?: number; ids?: { tmdb?: number }; poster?: string } | undefined): MetaPreview | null {
  if (!movie || !movie.ids?.tmdb) {
    return null;
  }
  return {
    id: `movie:${movie.ids.tmdb}`,
    type: 'movie',
    name: movie.title || 'Unknown',
    poster: movie.poster,
    year: movie.year?.toString()
  };
}

export async function checkTraktConnection(): Promise<boolean> {
  try {
    return await hasTraktAccess();
  } catch (error) {
    console.warn(
      '[Sync] Trakt connection check was temporarily unavailable:',
      getTraktErrorDiagnostics(error)
    );
    return hasStoredTraktSession();
  }
}

let activePullSync: Promise<SyncResult> | null = null;

async function syncFromTraktInternal(
  _onConflict?: (msg: string) => void,
  options: TraktPullOptions = {}
): Promise<SyncResult> {
  const result: SyncResult = { success: false, conflicts: [], warnings: [] };

  try {
    if (!(await hasTraktAccess())) {
      console.log('[Sync] Not authenticated, skipping pull');
      return result;
    }

    const store = useStore.getState();
    const lastSync = store.traktLastSync || 0;
    console.log(`[Sync] Pull: lastSync=${lastSync}, local watched count=${store.watched.length}, continueWatching=${store.continueWatching.length}`);

    const playbackResult = await getPlaybackProgressResult();
    const playbackProgress = playbackResult.data;
    console.log(`[Sync] Pull: got ${playbackProgress.length} playback progress items`);

    const activities = await getLastActivities();
    const isIncrementalStartup = options.fullHistory === false && lastSync > 0 && !!activities;
    const historyChanged = !isIncrementalStartup || getHistoryActivityTime(activities) > lastSync;
    const watchlistChanged = !isIncrementalStartup || getWatchlistActivityTime(activities) > lastSync;
    // Playback progress can change even when the broad activity timestamp does not.
    // If the API failed (activities === null) we must proceed — we don't know the real state.
    if (activities) {
      const lastActivityTime = new Date(activities.all).getTime();
      if (lastActivityTime <= lastSync && lastSync > 0) {
        console.log('[Sync] Pull: account activity unchanged; still merging playback progress');
      }
    }

    const [watchedShowsResult, watchedMoviesResult, watchlistResult] = await Promise.all([
      historyChanged ? getWatchedShowsResult() : Promise.resolve({ data: [], success: true }),
      historyChanged ? getWatchedMoviesResult() : Promise.resolve({ data: [], success: true }),
      watchlistChanged ? getWatchlistResult() : Promise.resolve({ data: [], success: true })
    ]);
    const watchedShows = watchedShowsResult.data;
    const watchedMovies = watchedMoviesResult.data;
    const watchlist = watchlistResult.data;
    console.log(
      `[Sync] Pull: historyChanged=${historyChanged}, watchlistChanged=${watchlistChanged}, watchedShows=${watchedShows.length}, watchedMovies=${watchedMovies.length}, watchlist=${watchlist.length}`
    );

    const traktWatched: MetaPreview[] = [];
    const watchedMovieIds = new Set(store.watched.filter((item) => item.type === 'movie').map((item) => item.id));
    const watchedAtMap = new Map<string, string>();
    const nextWatchedEpisodes: Record<string, string | boolean> = { ...store.watchedEpisodes };
    const watchedEpisodeKeys = new Set(Object.keys(nextWatchedEpisodes));
    watchedShows.forEach(s => {
      const preview = showToMetaPreview(s.show);
      if (preview) traktWatched.push(preview);

      // Sync individual episode watched status
      if (s.show?.ids?.tmdb && s.seasons) {
        const tmdbId = s.show.ids.tmdb.toString();
        let latestShowWatchedAt: string | undefined;
        for (const season of s.seasons) {
          for (const episode of season.episodes) {
            const episodeKey = getEpisodeKey(tmdbId, season.number, episode.number);
            watchedEpisodeKeys.add(episodeKey);
            nextWatchedEpisodes[episodeKey] = episode.last_watched_at || new Date().toISOString();
            if (parseTimestamp(episode.last_watched_at) > parseTimestamp(latestShowWatchedAt)) {
              latestShowWatchedAt = episode.last_watched_at;
            }
          }
        }
        setLatestWatchedAt(watchedAtMap, `tv:${tmdbId}`, latestShowWatchedAt);
      }
    });
    watchedMovies.forEach(m => {
      const preview = movieToMetaPreview(m.movie);
      if (preview) {
        traktWatched.push(preview);
        watchedMovieIds.add(preview.id);
        const watchedAt = (m as TraktWatchedMovie & { last_watched_at?: string }).last_watched_at ?? m.watched;
        setLatestWatchedAt(watchedAtMap, preview.id, watchedAt);
      }
    });

    const episodeHistoryMaxPages = EPISODE_HISTORY_FULL_SYNC_MAX_PAGES;
    const incrementalHistoryStartAt = isIncrementalStartup
      ? new Date(lastSync).toISOString()
      : undefined;
    console.log(
      `[Sync] Pull: episode history mode=${options.fullHistory === false ? 'incremental' : 'full'}, maxPages=${episodeHistoryMaxPages}`
    );
    const historyResults = historyChanged
      ? await Promise.all([
          loadWatchHistory(
            'movies',
            isIncrementalStartup ? EPISODE_HISTORY_FULL_SYNC_MAX_PAGES : WATCH_HISTORY_DEFAULT_MAX_PAGES,
            incrementalHistoryStartAt
          ),
          loadWatchHistory('episodes', episodeHistoryMaxPages, incrementalHistoryStartAt),
          loadWatchHistory(
            'shows',
            isIncrementalStartup ? EPISODE_HISTORY_FULL_SYNC_MAX_PAGES : 1,
            incrementalHistoryStartAt
          )
        ])
      : [
          { data: [], success: true },
          { data: [], success: true },
          { data: [], success: true }
        ];

    const pullFetchSucceeded =
      playbackResult.success &&
      watchedShowsResult.success &&
      watchedMoviesResult.success &&
      watchlistResult.success &&
      historyResults.every((historyResult) => historyResult.success);
    if (!pullFetchSucceeded) {
      result.warnings.push('Trakt pull was incomplete; local state was left unchanged and the sync will retry.');
      applyRateLimitFailure(result, null);
      console.warn('[Sync] Pull aborted because one or more required Trakt reads failed');
      return result;
    }

    const historyItems = historyResults.flatMap((historyResult) => historyResult.data);
    let historyEpisodeImportCount = 0;
    historyItems.forEach((item) => {
      const watchedAt = item.watched_at;
      const movieId = item.movie?.ids?.tmdb;
      const showId = item.show?.ids?.tmdb;

      if (movieId) {
        setLatestWatchedAt(watchedAtMap, `movie:${movieId}`, watchedAt);
      }

      if (showId) {
        setLatestWatchedAt(watchedAtMap, `tv:${showId}`, watchedAt);
      }

      if (item.type === 'episode' && showId && item.episode) {
        const season = item.episode.season;
        const episode = item.episode.number;
        if (typeof season === 'number' && typeof episode === 'number') {
          const episodeKey = getEpisodeKey(showId, season, episode);
          if (!watchedEpisodeKeys.has(episodeKey)) {
            historyEpisodeImportCount += 1;
          }
          watchedEpisodeKeys.add(episodeKey);
          nextWatchedEpisodes[episodeKey] = watchedAt || new Date().toISOString();
        }
      }
    });
    if (historyEpisodeImportCount > 0) {
      console.log(`[Sync] Pull: imported ${historyEpisodeImportCount} watched episodes from history`);
    }

    const existingWatched = store.watched;
    const existingWatchedById = new Map(existingWatched.map((item) => [item.id, item]));
    const traktWatchedWithDates: MetaPreview[] = traktWatched.map(item => {
      const existing = existingWatchedById.get(item.id);
      return {
        ...existing,
        ...item,
        poster: item.poster || existing?.poster,
        background: item.background || existing?.background,
        rating: item.rating ?? existing?.rating,
        imdbId: item.imdbId || existing?.imdbId,
        watchedAt: watchedAtMap.get(item.id) || existing?.watchedAt
      };
    });
    const BATCH_SIZE = 20;
    for (let i = 0; i < traktWatchedWithDates.length; i += BATCH_SIZE) {
      const batch = traktWatchedWithDates.slice(i, i + BATCH_SIZE);
      const enrichedBatch = await enrichMetaPreviews(batch);
      traktWatchedWithDates.splice(i, enrichedBatch.length, ...enrichedBatch);
    }

    const mergedWatched = mergeByLastWrite(existingWatched, traktWatchedWithDates);
    
    if (mergedWatched.length !== existingWatched.length) {
      result.conflicts.push(`Watched: merged ${existingWatched.length} -> ${mergedWatched.length} items`);
    }

    store.setWatched(mergedWatched);

    const existingWatchlist = store.watchlist;
    const existingWatchlistById = new Map(existingWatchlist.map((item) => [item.id, item]));
    let traktWatchlist: MetaPreview[] = [];
    for (let i = 0; i < watchlist.length; i++) {
      const item = watchlist[i];
      let poster: string | undefined;
      const listedAt = item.listed_at || undefined;
      if (item.type === 'show' && item.show) {
        const preview = showToMetaPreview(item.show);
        if (preview) {
          const existing = existingWatchlistById.get(preview.id);
          const enriched = existing && hasReusableEnrichedMetadata(existing)
            ? { ...existing, ...preview, poster: existing.poster, listedAt }
            : { ...preview, listedAt };
          poster = enriched.poster;
          traktWatchlist.push({ ...enriched, poster, listedAt });
        }
      } else if (item.type === 'movie' && item.movie) {
        const preview = movieToMetaPreview(item.movie);
        if (preview) {
          const existing = existingWatchlistById.get(preview.id);
          const enriched = existing && hasReusableEnrichedMetadata(existing)
            ? { ...existing, ...preview, poster: existing.poster, listedAt }
            : { ...preview, listedAt };
          poster = enriched.poster;
          traktWatchlist.push({ ...enriched, poster, listedAt });
        }
      }
    }

    traktWatchlist = await enrichMetaPreviews(traktWatchlist);
    const mergedWatchlist = mergeWatchlistByListedAt(existingWatchlist, traktWatchlist);

    store.setWatchlist(mergedWatchlist);

    // Remote deletes are inferred from the item's own add date, not the last sync time.
    const remoteWatchlistActivityTime = getWatchlistActivityTime(activities);
    if (watchlistChanged && remoteWatchlistActivityTime > 0) {
      const traktIds = new Set(traktWatchlist.map(item => item.id));
      for (const localItem of existingWatchlist) {
        if (traktIds.has(localItem.id)) continue;
        const listedAt = parseTimestamp(localItem.listedAt);
        if (listedAt > 0 && listedAt <= remoteWatchlistActivityTime) {
          console.log(`[Sync] Pull watchlist: removing locally ${localItem.id} (missing on Trakt after watchlist activity)`);
          store.removeFromWatchlist(localItem.id);
        }
      }
    }

    const remoteContinueWatching: ContinueWatchingItem[] = [];
    
    if (playbackProgress.length > 0) {
      for (const progress of playbackProgress) {
        if (progress.progress < 90) {
          let item: ContinueWatchingItem | null = null;
          
          if (progress.show) {
            const season = progress.episode?.season ?? progress.show.season;
            const episode = progress.episode?.number ?? progress.show.episode;
            if (typeof season !== 'number' || typeof episode !== 'number') {
              console.warn('[Sync] Skipping Trakt playback progress without episode identity:', {
                hasShow: Boolean(progress.show),
                hasEpisode: Boolean(progress.episode)
              });
              continue;
            }

            item = {
              metaId: `tv:${progress.show.ids.tmdb}`,
              type: 'series',
              title: progress.show.title,
              poster: '',
              progress: progress.progress,
              pausedAt: progress.paused_at,
              episodeId: `${season}:${episode}`,
              season,
              episode
            };
          } else if (progress.movie) {
            item = {
              metaId: `movie:${progress.movie.ids.tmdb}`,
              type: 'movie',
              title: progress.movie.title,
              poster: '',
              progress: progress.progress,
              pausedAt: progress.paused_at
            };
          }
          
          if (item) {
            remoteContinueWatching.push(item);
          }
        }
      }
    }

    remoteContinueWatching.splice(
      0,
      remoteContinueWatching.length,
      ...await enrichContinueWatchingPosters(remoteContinueWatching),
    );
    const historyContinueWatching = await buildContinueWatchingFromEpisodeHistory(historyItems, watchedEpisodeKeys);
    const dedupedRemote = dedupeByMetaId([...remoteContinueWatching, ...historyContinueWatching]);

    const existingContinueWatching = store.continueWatching;
    const mergedContinueWatching = mergeContinueWatching(existingContinueWatching, dedupedRemote, watchedMovieIds, watchedEpisodeKeys);
    store.setWatchedEpisodes(nextWatchedEpisodes);
    store.setContinueWatching(mergedContinueWatching);
    console.log(
      `[Sync] Continue Watching: playback=${remoteContinueWatching.length}, history=${historyContinueWatching.length}, local=${existingContinueWatching.length}, merged=${mergedContinueWatching.length}`
    );
    result.conflicts.push(
      `Continue Watching: ${existingContinueWatching.length} -> ${mergedContinueWatching.length} items`
    );

    const serverActivityWatermark = parseTimestamp(activities?.all);
    if (serverActivityWatermark > 0) {
      store.setTraktLastSync(serverActivityWatermark);
    }
    result.success = true;
    return result;
  } catch (e) {
    if (!applyRateLimitFailure(result, e)) {
      console.error('Sync from Trakt failed:', getTraktErrorDiagnostics(e));
    }
    return result;
  }
}

export function syncFromTrakt(
  onConflict?: (msg: string) => void,
  options: TraktPullOptions = {}
): Promise<SyncResult> {
  if (!activePullSync) {
    activePullSync = syncFromTraktInternal(onConflict, options).finally(() => {
      activePullSync = null;
    });
  }
  return activePullSync;
}

const TRAKT_SYNC_BATCH_ITEM_LIMIT = 250;

function hasHistoryPayload(payload: TraktHistorySyncPayload): boolean {
  return (payload.movies?.length ?? 0) > 0 || (payload.shows?.length ?? 0) > 0;
}

function hasWatchlistPayload(payload: TraktWatchlistSyncPayload): boolean {
  return (payload.movies?.length ?? 0) > 0 || (payload.shows?.length ?? 0) > 0;
}

function chunkHistoryPayload(payload: TraktHistorySyncPayload): TraktHistorySyncPayload[] {
  type HistoryEntry =
    | { kind: 'movie'; tmdbId: number; watchedAt?: string }
    | { kind: 'show'; tmdbId: number; watchedAt?: string }
    | { kind: 'episode'; tmdbId: number; season: number; episode: number; watchedAt?: string };
  const entries: HistoryEntry[] = [];

  for (const movie of payload.movies ?? []) {
    entries.push({ kind: 'movie', tmdbId: movie.ids.tmdb, watchedAt: movie.watched_at });
  }
  for (const show of payload.shows ?? []) {
    if (!show.seasons?.length) {
      entries.push({ kind: 'show', tmdbId: show.ids.tmdb, watchedAt: show.watched_at });
      continue;
    }
    for (const season of show.seasons) {
      for (const episode of season.episodes) {
        entries.push({
          kind: 'episode',
          tmdbId: show.ids.tmdb,
          season: season.number,
          episode: episode.number,
          watchedAt: episode.watched_at
        });
      }
    }
  }

  const chunks: TraktHistorySyncPayload[] = [];
  for (let offset = 0; offset < entries.length; offset += TRAKT_SYNC_BATCH_ITEM_LIMIT) {
    const movies: NonNullable<TraktHistorySyncPayload['movies']> = [];
    const wholeShows: NonNullable<TraktHistorySyncPayload['shows']> = [];
    const episodesByShow = new Map<number, Map<number, Array<{ number: number; watched_at?: string }>>>();

    for (const entry of entries.slice(offset, offset + TRAKT_SYNC_BATCH_ITEM_LIMIT)) {
      if (entry.kind === 'movie') {
        movies.push({ ids: { tmdb: entry.tmdbId }, ...(entry.watchedAt && { watched_at: entry.watchedAt }) });
      } else if (entry.kind === 'show') {
        wholeShows.push({ ids: { tmdb: entry.tmdbId }, ...(entry.watchedAt && { watched_at: entry.watchedAt }) });
      } else {
        const bySeason = episodesByShow.get(entry.tmdbId) ?? new Map();
        const episodes = bySeason.get(entry.season) ?? [];
        episodes.push({ number: entry.episode, ...(entry.watchedAt && { watched_at: entry.watchedAt }) });
        bySeason.set(entry.season, episodes);
        episodesByShow.set(entry.tmdbId, bySeason);
      }
    }

    const episodeShows = Array.from(episodesByShow, ([tmdbId, seasons]) => ({
      ids: { tmdb: tmdbId },
      seasons: Array.from(seasons, ([number, episodes]) => ({ number, episodes }))
    }));
    chunks.push({
      ...(movies.length > 0 && { movies }),
      ...((wholeShows.length > 0 || episodeShows.length > 0) && { shows: [...wholeShows, ...episodeShows] })
    });
  }
  return chunks;
}

function chunkWatchlistPayload(payload: TraktWatchlistSyncPayload): TraktWatchlistSyncPayload[] {
  const entries = [
    ...(payload.movies ?? []).map(item => ({ type: 'movie' as const, item })),
    ...(payload.shows ?? []).map(item => ({ type: 'show' as const, item }))
  ];
  const chunks: TraktWatchlistSyncPayload[] = [];
  for (let offset = 0; offset < entries.length; offset += TRAKT_SYNC_BATCH_ITEM_LIMIT) {
    const movies: NonNullable<TraktWatchlistSyncPayload['movies']> = [];
    const shows: NonNullable<TraktWatchlistSyncPayload['shows']> = [];
    for (const entry of entries.slice(offset, offset + TRAKT_SYNC_BATCH_ITEM_LIMIT)) {
      (entry.type === 'movie' ? movies : shows).push(entry.item);
    }
    chunks.push({
      ...(movies.length > 0 && { movies }),
      ...(shows.length > 0 && { shows })
    });
  }
  return chunks;
}

async function postHistoryPayload(
  payload: TraktHistorySyncPayload,
  postBatch: (chunk: TraktHistorySyncPayload) => Promise<boolean>
): Promise<boolean> {
  if (!hasHistoryPayload(payload)) return true;
  for (const chunk of chunkHistoryPayload(payload)) {
    if (!(await postBatch(chunk))) return false;
  }
  return true;
}

async function postWatchlistPayload(
  payload: TraktWatchlistSyncPayload,
  postBatch: (chunk: TraktWatchlistSyncPayload) => Promise<boolean>
): Promise<boolean> {
  if (!hasWatchlistPayload(payload)) return true;
  for (const chunk of chunkWatchlistPayload(payload)) {
    if (!(await postBatch(chunk))) return false;
  }
  return true;
}

function applyRateLimitFailure(result: SyncResult, error: unknown): boolean {
  const retryAt = isTraktRateLimitError(error)
    ? error.retryAt
    : getTraktRateLimitRetryAt();
  if (!retryAt) return false;

  result.retryAt = retryAt;
  result.warnings.push(`Trakt rate limit reached. Sync can retry after ${new Date(retryAt).toLocaleTimeString()}.`);
  localStorage.removeItem(TRAKT_STARTUP_BASELINE_KEY);
  return true;
}

async function pushBatchedTraktChanges(
  watchedShows: TraktWatchedShow[],
  watchedMovies: TraktWatchedMovie[],
  watchlist: Awaited<ReturnType<typeof getWatchlistResult>>['data']
): Promise<boolean> {
  const store = useStore.getState();
  const remoteMovieIds = new Set(
    watchedMovies
      .map(item => item.movie?.ids?.tmdb)
      .filter((id): id is number => typeof id === 'number')
  );
  const remoteShowIds = new Set<number>();
  const remoteEpisodeKeys = new Set<string>();
  for (const watchedShow of watchedShows) {
    const tmdbId = watchedShow.show?.ids?.tmdb;
    if (typeof tmdbId !== 'number') continue;
    remoteShowIds.add(tmdbId);
    for (const season of watchedShow.seasons ?? []) {
      for (const episode of season.episodes ?? []) {
        remoteEpisodeKeys.add(getEpisodeKey(tmdbId, season.number, episode.number));
      }
    }
  }
  const remoteWatchlistIds = new Set(
    watchlist.map(item => item.type === 'movie'
      ? `movie:${item.movie?.ids?.tmdb}`
      : `tv:${item.show?.ids?.tmdb}`)
  );

  const pendingHistoryRemovals = store.pendingTraktHistory.filter(action => action.action === 'remove');
  const pendingHistoryAdditions = store.pendingTraktHistory.filter(action => action.action === 'add');
  const pendingWatchlistRemovals = store.pendingTraktWatchlist.filter(action => action.action === 'remove');
  const pendingWatchlistAdditions = store.pendingTraktWatchlist.filter(action => action.action === 'add');
  const historyRemovalKeys = new Set(pendingHistoryRemovals.map(action =>
    `${action.metaId}:${action.season ?? ''}:${action.episode ?? ''}`
  ));
  const watchlistRemovalIds = new Set(pendingWatchlistRemovals.map(action => action.metaId));

  const addHistory: TraktHistorySyncPayload = { movies: [], shows: [] };
  const removeHistory: TraktHistorySyncPayload = { movies: [], shows: [] };
  const addWatchlist: TraktWatchlistSyncPayload = { movies: [], shows: [] };
  const removeWatchlist: TraktWatchlistSyncPayload = { movies: [], shows: [] };

  for (const action of pendingHistoryRemovals) {
    const tmdbId = parseTmdbId(action.metaId);
    if (!Number.isFinite(tmdbId)) continue;
    if (action.mediaType === 'movie') {
      removeHistory.movies!.push({ ids: { tmdb: tmdbId } });
    } else if (typeof action.season === 'number' && typeof action.episode === 'number') {
      removeHistory.shows!.push({
        ids: { tmdb: tmdbId },
        seasons: [{ number: action.season, episodes: [{ number: action.episode }] }]
      });
    } else {
      removeHistory.shows!.push({ ids: { tmdb: tmdbId } });
    }
  }

  for (const item of store.watched) {
    const tmdbId = parseTmdbId(item.id);
    if (!Number.isFinite(tmdbId) || historyRemovalKeys.has(`${item.id}::`)) continue;
    if (item.type === 'movie') {
      if (!remoteMovieIds.has(tmdbId)) {
        addHistory.movies!.push({ ids: { tmdb: tmdbId }, ...(item.watchedAt && { watched_at: item.watchedAt }) });
      }
    } else {
      const hasTrackedEpisodes = Object.keys(store.watchedEpisodes).some(key => key.startsWith(`${tmdbId}:`));
      if (!hasTrackedEpisodes && !remoteShowIds.has(tmdbId)) {
        addHistory.shows!.push({ ids: { tmdb: tmdbId }, ...(item.watchedAt && { watched_at: item.watchedAt }) });
      }
    }
  }

  const episodesByShow = new Map<number, Map<number, Array<{ number: number; watched_at?: string }>>>();
  const addEpisode = (tmdbId: number, season: number, episode: number, watchedAt?: string) => {
    const key = getEpisodeKey(tmdbId, season, episode);
    if (
      remoteEpisodeKeys.has(key) ||
      historyRemovalKeys.has(`tv:${tmdbId}::`) ||
      historyRemovalKeys.has(`tv:${tmdbId}:${season}:${episode}`)
    ) return;
    const seasons = episodesByShow.get(tmdbId) ?? new Map<number, Array<{ number: number; watched_at?: string }>>();
    const episodes = seasons.get(season) ?? [];
    if (!episodes.some(item => item.number === episode)) {
      episodes.push({ number: episode, ...(watchedAt && { watched_at: watchedAt }) });
    }
    seasons.set(season, episodes);
    episodesByShow.set(tmdbId, seasons);
  };
  for (const [key, value] of Object.entries(store.watchedEpisodes)) {
    const [tmdbId, season, episode] = key.split(':').map(Number);
    if ([tmdbId, season, episode].every(Number.isFinite)) {
      addEpisode(tmdbId, season, episode, typeof value === 'string' ? value : undefined);
    }
  }

  const completedProgress = store.continueWatching.filter(item => item.progress >= 80);
  for (const item of completedProgress) {
    const tmdbId = parseTmdbId(item.metaId);
    if (!Number.isFinite(tmdbId) || historyRemovalKeys.has(`${item.metaId}::`)) continue;
    if (item.type === 'movie' && !remoteMovieIds.has(tmdbId)) {
      if (!addHistory.movies!.some(movie => movie.ids.tmdb === tmdbId)) {
        addHistory.movies!.push({ ids: { tmdb: tmdbId }, watched_at: item.pausedAt ?? new Date().toISOString() });
      }
    } else if (typeof item.season === 'number' && typeof item.episode === 'number') {
      addEpisode(tmdbId, item.season, item.episode, item.pausedAt);
    }
  }
  for (const [tmdbId, seasons] of episodesByShow) {
    addHistory.shows!.push({
      ids: { tmdb: tmdbId },
      seasons: Array.from(seasons, ([number, episodes]) => ({ number, episodes }))
    });
  }

  for (const item of store.watchlist) {
    if (remoteWatchlistIds.has(item.id) || watchlistRemovalIds.has(item.id)) continue;
    const tmdbId = parseTmdbId(item.id);
    if (!Number.isFinite(tmdbId)) continue;
    (item.type === 'movie' ? addWatchlist.movies! : addWatchlist.shows!).push({ ids: { tmdb: tmdbId } });
  }
  for (const action of pendingWatchlistRemovals) {
    const tmdbId = parseTmdbId(action.metaId);
    if (!Number.isFinite(tmdbId)) continue;
    (action.mediaType === 'movie' ? removeWatchlist.movies! : removeWatchlist.shows!).push({ ids: { tmdb: tmdbId } });
  }

  const historyRemoved = await postHistoryPayload(removeHistory, removeHistoryBatch);
  if (!historyRemoved) return false;
  pendingHistoryRemovals.forEach(action => useStore.getState().removePendingTraktHistory(action));

  const historyAdded = await postHistoryPayload(addHistory, addHistoryBatch);
  if (!historyAdded) return false;
  pendingHistoryAdditions.forEach(action => useStore.getState().removePendingTraktHistory(action));

  const watchlistRemoved = await postWatchlistPayload(removeWatchlist, removeWatchlistBatch);
  if (!watchlistRemoved) return false;
  pendingWatchlistRemovals.forEach(action => useStore.getState().removePendingTraktWatchlist(action));

  const watchlistAdded = await postWatchlistPayload(addWatchlist, addWatchlistBatch);
  if (!watchlistAdded) return false;
  pendingWatchlistAdditions.forEach(action => useStore.getState().removePendingTraktWatchlist(action));

  for (const item of completedProgress) {
    const tmdbId = parseTmdbId(item.metaId);
    const meta: MetaPreview = {
      id: item.metaId,
      type: item.type,
      name: item.title,
      poster: item.poster,
      rating: item.rating,
      watchedAt: item.pausedAt ?? new Date().toISOString()
    };
    if (item.type === 'movie') {
      useStore.getState().addToWatched(meta);
      useStore.getState().removeFromContinueWatching(item.metaId);
    } else if (Number.isFinite(tmdbId) && typeof item.season === 'number' && typeof item.episode === 'number') {
      useStore.getState().markEpisodeWatched(tmdbId.toString(), item.season, item.episode, meta.watchedAt);
      useStore.getState().updateContinueWatchingProgress(item.metaId, 0);
    }
  }
  return true;
}

async function verifyTraktPushState(): Promise<boolean> {
  const store = useStore.getState();
  const [watchedShowsResult, watchedMoviesResult, watchlistResult] = await Promise.all([
    getWatchedShowsResult(),
    getWatchedMoviesResult(),
    getWatchlistResult()
  ]);
  if (!watchedShowsResult.success || !watchedMoviesResult.success || !watchlistResult.success) {
    console.warn('[Sync] Push verification failed because remote state could not be read');
    return false;
  }
  const watchedShows = watchedShowsResult.data;
  const watchedMovies = watchedMoviesResult.data;
  const watchlist = watchlistResult.data;
  const remoteMovieIds = new Set(
    watchedMovies
      .map((item) => item.movie?.ids?.tmdb)
      .filter((tmdbId): tmdbId is number => typeof tmdbId === 'number')
      .map((tmdbId) => `movie:${tmdbId}`)
  );
  const remoteShowIds = new Set<string>();
  const remoteEpisodeKeys = new Set<string>();
  for (const item of watchedShows) {
    const tmdbId = item.show?.ids?.tmdb;
    if (typeof tmdbId !== 'number') {
      continue;
    }
    remoteShowIds.add(`tv:${tmdbId}`);
    for (const season of item.seasons ?? []) {
      for (const episode of season.episodes ?? []) {
        remoteEpisodeKeys.add(getEpisodeKey(tmdbId, season.number, episode.number));
      }
    }
  }
  const remoteWatchlistIds = new Set(
    watchlist
      .map((item) => {
        if (item.type === 'show' && item.show?.ids?.tmdb) {
          return `tv:${item.show.ids.tmdb}`;
        }
        if (item.type === 'movie' && item.movie?.ids?.tmdb) {
          return `movie:${item.movie.ids.tmdb}`;
        }
        return null;
      })
      .filter((metaId): metaId is string => !!metaId)
  );

  const missingWatched = store.watched.filter((item) => {
    if (item.type === 'movie') {
      return !remoteMovieIds.has(item.id);
    }
    const tmdbId = parseTmdbId(item.id).toString();
    const hasTrackedEpisodes = Object.keys(store.watchedEpisodes).some((key) => key.startsWith(`${tmdbId}:`));
    return !hasTrackedEpisodes && !remoteShowIds.has(item.id);
  });
  const missingEpisodes = Object.keys(store.watchedEpisodes)
    .filter((episodeKey) => !remoteEpisodeKeys.has(episodeKey));
  const missingWatchlist = store.watchlist
    .filter((item) => !remoteWatchlistIds.has(item.id));
  const pendingActions =
    store.pendingTraktHistory.length +
    store.pendingTraktWatchlist.length;
  const verified =
    missingWatched.length === 0 &&
    missingEpisodes.length === 0 &&
    missingWatchlist.length === 0 &&
    pendingActions === 0;

  if (!verified) {
    console.warn(
      `[Sync] Push verification failed: watched=${missingWatched.length}, episodes=${missingEpisodes.length}, watchlist=${missingWatchlist.length}, pending=${pendingActions}`
    );
  }
  return verified;
}

let activePushSync: Promise<SyncResult> | null = null;

async function syncToTraktInternal(): Promise<SyncResult> {
  const result: SyncResult = { success: false, conflicts: [], warnings: [] };

  try {
    if (!(await hasTraktAccess())) {
      return result;
    }

    // Fetch one status-aware snapshot, then derive and batch every mutation from it.
    // Pending actions are intentionally not flushed separately: doing so can retry the
    // same failed item several times during one sync.
    const [watchedShowsResult, watchedMoviesResult, watchlistResult] = await Promise.all([
      getWatchedShowsResult(),
      getWatchedMoviesResult(),
      getWatchlistResult()
    ]);
    if (!watchedShowsResult.success || !watchedMoviesResult.success || !watchlistResult.success) {
      result.warnings.push('Trakt push could not read the current remote state; pending changes were preserved.');
      applyRateLimitFailure(result, null);
      return result;
    }

    const pushed = await pushBatchedTraktChanges(
      watchedShowsResult.data,
      watchedMoviesResult.data,
      watchlistResult.data
    );
    if (!pushed) {
      localStorage.removeItem(TRAKT_STARTUP_BASELINE_KEY);
      result.warnings.push('Some Trakt changes could not be pushed; pending changes were preserved.');
      return result;
    }

    result.success = await verifyTraktPushState();
    if (!result.success) {
      localStorage.removeItem(TRAKT_STARTUP_BASELINE_KEY);
      result.warnings.push('Trakt push could not be fully verified; pending changes will be retried.');
    }
    return result;
  } catch (e) {
    if (!applyRateLimitFailure(result, e)) {
      console.error('Sync to Trakt failed:', getTraktErrorDiagnostics(e));
    }
    return result;
  }
}

export function syncToTrakt(): Promise<SyncResult> {
  if (!activePushSync) {
    activePushSync = syncToTraktInternal().finally(() => {
      activePushSync = null;
    });
  }
  return activePushSync;
}

export async function pushWatchedToTrakt(meta: MetaPreview): Promise<boolean> {
  const type: 'movie' | 'show' = meta.type === 'movie' ? 'movie' : 'show';
  return syncHistoryAction({
    action: 'add',
    mediaType: type,
    metaId: meta.id,
    watchedAt: meta.watchedAt
  });
}

export async function pushUnwatchedToTrakt(meta: MetaPreview): Promise<boolean> {
  const type: 'movie' | 'show' = meta.type === 'movie' ? 'movie' : 'show';
  return syncHistoryAction({
    action: 'remove',
    mediaType: type,
    metaId: meta.id
  });
}

export async function pushWatchlistToTrakt(meta: MetaPreview, action: 'add' | 'remove'): Promise<boolean> {
  console.log('[Sync] pushWatchlistToTrakt:', action, meta.id, meta.type);
  const result = await syncWatchlistAction({
    action,
    mediaType: getMetaType(meta),
    metaId: meta.id
  });
  console.log(`[Sync] ${action} watchlist result:`, result);
  return result;
}

function mergeByLastWrite(local: MetaPreview[], remote: MetaPreview[]): MetaPreview[] {
  const merged = new Map<string, MetaPreview>();
  
  local.forEach(item => {
    merged.set(item.id, item);
  });
  
  remote.forEach(item => {
    const existing = merged.get(item.id);
    if (!existing) {
      merged.set(item.id, item);
      return;
    }

    merged.set(item.id, {
      ...existing,
      ...item,
      poster: item.poster ?? existing.poster,
      background: item.background ?? existing.background,
      year: item.year ?? existing.year,
      imdbId: item.imdbId ?? existing.imdbId,
      rating: item.rating ?? existing.rating,
      watchedAt: item.watchedAt ?? existing.watchedAt,
      listedAt: item.listedAt ?? existing.listedAt
    });
  });
  
  return Array.from(merged.values());
}

function showSyncToast(result: SyncResult, onConflict?: (msg: string) => void): void {
  if (result.conflicts.length > 0) {
    result.conflicts.forEach(msg => {
      onConflict?.(msg);
    });
  }

  if (result.warnings.length > 0) {
    result.warnings.forEach(msg => {
      console.warn(`[Sync] ${msg}`);
    });
  }
}

export async function autoSyncOnStart(onConflict?: (msg: string) => void): Promise<void> {
  setStartupTraktSyncState('running');
  try {
    try {
      if (!(await hasTraktAccess())) return;
    } catch (error) {
      const authResult: SyncResult = { success: false, conflicts: [], warnings: [] };
      if (applyRateLimitFailure(authResult, error)) {
        showSyncToast(authResult, onConflict);
        onConflict?.(`Trakt asked Streamee to wait until ${new Date(authResult.retryAt!).toLocaleTimeString()}.`);
      } else {
        console.error(
          '[Sync] Unable to verify Trakt access on startup:',
          getTraktErrorDiagnostics(error)
        );
      }
      return;
    }

    const store = useStore.getState();
    const hasStartupPushBaseline = localStorage.getItem(TRAKT_STARTUP_BASELINE_KEY) === 'true';
    const hasPendingStartupPush =
      !hasStartupPushBaseline ||
      store.pendingTraktHistory.length > 0 ||
      store.pendingTraktWatchlist.length > 0 ||
      store.continueWatching.some((item) => item.progress >= 80);

    if (hasPendingStartupPush) {
      console.log('[Sync] Pushing pending local changes to Trakt...');
      const pushResult = await syncToTrakt();
      if (pushResult.success) {
        console.log('[Sync] Pending local changes pushed to Trakt successfully');
        localStorage.setItem(TRAKT_STARTUP_BASELINE_KEY, 'true');
      } else {
        console.warn('[Sync] Some pending local changes failed to push to Trakt');
        showSyncToast(pushResult, onConflict);
        onConflict?.('Trakt push was not completed. Local changes were kept for the next retry.');
        return;
      }
    } else {
      console.log('[Sync] No pending local changes; skipping startup push');
    }

    console.log('[Sync] Pulling from Trakt...');
    const result = await syncFromTrakt(onConflict, { fullHistory: false });
    if (result.success) {
      showSyncToast(result, onConflict);
    } else {
      showSyncToast(result, onConflict);
      onConflict?.(result.retryAt
        ? `Trakt asked Streamee to wait until ${new Date(result.retryAt).toLocaleTimeString()}.`
        : 'Trakt sync failed. Local data was left unchanged and will retry later.');
    }
  } finally {
    setStartupTraktSyncState('settled');
  }
}

export async function pushEpisodeWatchedToTrakt(tmdbId: string, season: number, episode: number, watchedAt?: string): Promise<boolean> {
  return syncHistoryAction({
    action: 'add',
    mediaType: 'show',
    metaId: `tv:${tmdbId}`,
    season,
    episode,
    watchedAt
  });
}

export async function pushEpisodeUnwatchedToTrakt(tmdbId: string, season: number, episode: number): Promise<boolean> {
  return syncHistoryAction({
    action: 'remove',
    mediaType: 'show',
    metaId: `tv:${tmdbId}`,
    season,
    episode
  });
}

export async function pushSeasonWatchedToTrakt(tmdbId: string, seasonNumber: number, episodes: number[], watchedAt?: string): Promise<boolean> {
  try {
    if (!(await hasTraktAccess())) return false;
    const episodeObjs = episodes.map(ep => ({ number: ep, watchedAt }));
    return await traktMarkSeasonAsWatched(parseInt(tmdbId), seasonNumber, episodeObjs);
  } catch (error) {
    console.error(
      '[Sync] Failed Trakt season action; local episode state will retry during full sync:',
      getTraktErrorDiagnostics(error)
    );
    return false;
  }
}
