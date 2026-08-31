import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FiChevronRight, FiHeart, FiEye, FiEyeOff, FiX, FiClock, FiBookmark, FiTrendingUp } from 'react-icons/fi';
import { useStore, ContinueWatchingItem, ContinueWatchingViewItem, MetaPreview } from '../../store';
import { enrichTmdbItemsById, EpisodeDetail, getTmdbBoardCatalogs, getTmdbEpisodes, getTmdbSeriesSchedule, isTmdbConfigured } from '../../services/tmdb';
import { getAnticipatedMovies, getAnticipatedShows, getTrendingMovies, getTrendingShows, hasTraktCredentials } from '../../services/trakt';
import {
  getStartupTraktSyncState,
  pushUnwatchedToTrakt,
  pushWatchedToTrakt,
  pushWatchlistToTrakt,
  subscribeStartupTraktSyncState,
} from '../../services/trakt-sync';
import { createPerformanceTrace } from '../../services/performance';
import { logger } from '../../services/logger';
import { readPersistentlyCachedValue, writePersistentlyCachedValue } from '../../services/request-cache';
import {
  DISCOVERY_CONTENT_CHANGED_EVENT,
  fetchFilteredDiscoveryPage,
  formatDiscoveryCatalogTitle,
  getDiscoveryContentMode,
  type DiscoveryContentMode,
  type DiscoverySourcePage,
} from '../../services/discovery-content';
import XrelQualityBadge from '../../components/XrelQualityBadge';
import { scheduleAddonReleaseQualityProbes } from '../../services/addon-release-probes';
import { getXrelQualitySnapshot, subscribeXrelQualitySnapshot } from '../../services/xrel';
import { getUpNextNoResultCachePolicy, UP_NEXT_RESOLVED_RESULT_CACHE_TTL_MS } from '../../services/tmdb-request-policy';
import './Board.css';

function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return '';
  
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  
  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffWeek < 4) return `${diffWeek}w ago`;
  return `${diffMonth}mo ago`;
}

function formatReleaseDate(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

interface CatalogRow {
  id: string;
  title: string;
  type: 'movie' | 'series';
  source: 'tmdb' | 'trakt';
  items: MetaPreview[];
  hideWatchedToggle?: boolean;
}

interface FeaturedItem {
  id: string;
  name: string;
  poster?: string;
  background?: string;
  type: 'movie' | 'series';
  rating?: number;
  progress: number | null;
  detail: string;
  source: 'continue' | 'catalog';
}

const CATALOG_ORDER = [
  'tmdb:trending:movie',
  'tmdb:popular:movie',
  'tmdb:trending:series',
  'tmdb:popular:series',
  'trakt:anticipated:movie',
  'trakt:anticipated:series'
];
let boardCatalogSnapshot: CatalogRow[] = [];
let boardCatalogSnapshotMode: DiscoveryContentMode | null = null;
const CONTINUE_VIEW_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
const UP_NEXT_DIAGNOSTIC_SHOW_LIMIT = 10;
const UP_NEXT_PENDING_SYNC_GRACE_MS = 5_000;
const UP_NEXT_SETTLED_REFRESH_DELAY_MS = 1_200;
const BOARD_CATALOG_ITEM_LIMIT = 20;
const ADDON_RELEASE_PROBE_RECHECK_MS = 12 * 60 * 60 * 1000;

function sortCatalogRows(rows: CatalogRow[]): CatalogRow[] {
  return [...rows].sort((a, b) => {
    const aIndex = CATALOG_ORDER.indexOf(`${a.source}:${a.id}:${a.type}`);
    const bIndex = CATALOG_ORDER.indexOf(`${b.source}:${b.id}:${b.type}`);
    return (aIndex === -1 ? CATALOG_ORDER.length : aIndex) -
      (bIndex === -1 ? CATALOG_ORDER.length : bIndex);
  });
}

function getCatalogVisibleItemCount(columns: number): number {
  if (columns > BOARD_CATALOG_ITEM_LIMIT) {
    return BOARD_CATALOG_ITEM_LIMIT;
  }

  const completeRowsWithinLimit = Math.floor(BOARD_CATALOG_ITEM_LIMIT / columns);
  return columns * Math.min(2, completeRowsWithinLimit);
}

function getContinueWatchingVisibleItemCount(columns: number): number {
  return Math.min(columns, BOARD_CATALOG_ITEM_LIMIT);
}

function parseTmdbId(metaId: string): number | null {
  const match = metaId.match(/^(?:tv|movie):(\d+)$/);
  if (!match) return null;

  const tmdbId = Number(match[1]);
  return Number.isFinite(tmdbId) ? tmdbId : null;
}

function parseWatchedEpisodeKey(key: string): { tmdbId: number; season: number; episode: number } | null {
  const [tmdbPart, seasonPart, episodePart] = key.split(':');
  const tmdbId = Number(tmdbPart);
  const season = Number(seasonPart);
  const episode = Number(episodePart);

  if (!Number.isFinite(tmdbId) || !Number.isFinite(season) || !Number.isFinite(episode)) {
    return null;
  }

  return { tmdbId, season, episode };
}

function parseTimestamp(value?: string | boolean | null): number {
  if (typeof value !== 'string' || !value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isAvailableEpisode(episode: EpisodeDetail): boolean {
  if (!episode.air_date) {
    return false;
  }

  const airDate = new Date(`${episode.air_date}T00:00:00`);
  if (Number.isNaN(airDate.getTime())) {
    return false;
  }

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return airDate.getTime() <= today.getTime();
}

function getEpisodeKey(tmdbId: number, season: number, episode: number): string {
  return `${tmdbId}:${season}:${episode}`;
}

function buildContinueViewFingerprint(
  continueWatching: ContinueWatchingItem[],
  watched: MetaPreview[],
  watchedEpisodes: Record<string, string | boolean>,
): string {
  return JSON.stringify({
    continueWatching: continueWatching.map((item) => ({
      metaId: item.metaId,
      type: item.type,
      season: item.season,
      episode: item.episode,
      progress: item.progress,
      pausedAt: item.pausedAt,
    })).sort((a, b) => a.metaId.localeCompare(b.metaId)),
    watchedMovies: watched
      .filter((item) => item.type === 'movie')
      .map((item) => item.id)
      .sort(),
    watchedEpisodes: Object.entries(watchedEpisodes).sort(([a], [b]) => a.localeCompare(b)),
  });
}

function isUnfinishedResume(item: ContinueWatchingItem): boolean {
  return item.progress > 0 && item.progress < 80;
}

function isWatchedSeriesResume(item: ContinueWatchingItem, watchedEpisodeKeys: Set<string>): boolean {
  if (item.type !== 'series' || item.progress < 80) {
    return false;
  }

  const tmdbId = parseTmdbId(item.metaId);
  if (!tmdbId || typeof item.season !== 'number' || typeof item.episode !== 'number') {
    return false;
  }

  return watchedEpisodeKeys.has(getEpisodeKey(tmdbId, item.season, item.episode));
}

function formatEpisodeLabel(item: Pick<ContinueWatchingViewItem, 'season' | 'episode'>): string {
  if (typeof item.season !== 'number' || typeof item.episode !== 'number') {
    return '';
  }

  return `S${item.season.toString().padStart(2, '0')}E${item.episode.toString().padStart(2, '0')}`;
}

async function fetchTraktCatalogItems(
  id: 'trending' | 'anticipated',
  type: 'movie' | 'series',
  page: number = 1,
  limit: number = 12,
  contentMode: DiscoveryContentMode = getDiscoveryContentMode()
): Promise<MetaPreview[]> {
  if (!hasTraktCredentials()) {
    return [];
  }

  const fetchSourcePage = async (sourcePage: number): Promise<DiscoverySourcePage<MetaPreview>> => {
    if (id === 'trending' && type === 'movie') {
      const items = await getTrendingMovies(sourcePage, limit);
      return {
        items: await enrichTmdbItemsById(items.map((item) => ({
          tmdbId: item.movie.ids.tmdb,
          mediaType: 'movie',
          releaseDate: item.movie.released,
          name: item.movie.title
        }))),
        hasMore: items.length === limit,
      };
    }

    if (id === 'trending' && type === 'series') {
      const items = await getTrendingShows(sourcePage, limit);
      return {
        items: await enrichTmdbItemsById(items.map((item) => ({
          tmdbId: item.show.ids.tmdb,
          mediaType: 'tv',
          releaseDate: item.show.first_aired,
          name: item.show.title
        }))),
        hasMore: items.length === limit,
      };
    }

    if (id === 'anticipated' && type === 'movie') {
      const items = await getAnticipatedMovies(sourcePage, limit);
      return {
        items: await enrichTmdbItemsById(items.map((item) => ({
          tmdbId: item.movie.ids.tmdb,
          mediaType: 'movie',
          releaseDate: item.movie.released,
          name: item.movie.title
        }))),
        hasMore: items.length === limit,
      };
    }

    const items = await getAnticipatedShows(sourcePage, limit);
    return {
      items: await enrichTmdbItemsById(items.map((item) => ({
        tmdbId: item.show.ids.tmdb,
        mediaType: 'tv',
        releaseDate: item.show.first_aired,
        name: item.show.title
      }))),
      hasMore: items.length === limit,
    };
  };

  if (contentMode === 'all') {
    return (await fetchSourcePage(page)).items;
  }

  return fetchFilteredDiscoveryPage(fetchSourcePage, page, contentMode, {
    pageSize: limit,
    maxSourcePages: 500,
  });
}

const Board: React.FC = () => {
  const [discoveryContentMode, setDiscoveryContentMode] = useState(getDiscoveryContentMode);
  const [catalogs, setCatalogs] = useState<CatalogRow[]>(() => (
    boardCatalogSnapshotMode === discoveryContentMode ? boardCatalogSnapshot : []
  ));
  const [loading, setLoading] = useState(
    boardCatalogSnapshotMode !== discoveryContentMode || boardCatalogSnapshot.length === 0
  );
  const [tmdbConfigured, setTmdbConfigured] = useState<boolean | null>(null);
  const [itemsPerRow, setItemsPerRow] = useState(3);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [renderedFeatured, setRenderedFeatured] = useState<FeaturedItem | null>(null);
  const [heroReady, setHeroReady] = useState(false);
  const catalogGridRef = useRef<HTMLDivElement>(null);
  const continueRefreshGenerationRef = useRef(0);
  const boardMountedRef = useRef(true);
  const releaseQualitySnapshot = useSyncExternalStore(
    subscribeXrelQualitySnapshot,
    getXrelQualitySnapshot,
    getXrelQualitySnapshot,
  );
  const startupTraktSyncState = useSyncExternalStore(
    subscribeStartupTraktSyncState,
    getStartupTraktSyncState,
    getStartupTraktSyncState,
  );
  const { setSelectedMeta, continueWatching, continueWatchingView, continueWatchingViewFingerprint, continueWatchingViewUpdatedAt, setContinueWatchingView, setContinueWatchingViewRefresh, addToContinueWatching, removeFromContinueWatching, setSelectedCatalog, setCatalogItems, setCatalogPage, setCatalogCacheKey, watchlist, addToWatchlist, removeFromWatchlist, watched, addToWatched, removeFromWatched, boardScrollPosition, setBoardScrollPosition, traktConnected, watchedEpisodes } = useStore();
  const continueRefreshFingerprint = useMemo(
    () => buildContinueViewFingerprint(continueWatching, watched, watchedEpisodes),
    [continueWatching, watched, watchedEpisodes],
  );

  useEffect(() => {
    boardMountedRef.current = true;
    return () => {
      boardMountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const grid = catalogGridRef.current;
    if (!grid) return;

    const updateItemsPerRow = () => {
      const renderedColumns = window.getComputedStyle(grid).gridTemplateColumns
        .split(' ')
        .filter(Boolean)
        .length;
      if (renderedColumns > 0) {
        setItemsPerRow(renderedColumns);
      }
    };

    updateItemsPerRow();
    const observer = new ResizeObserver(updateItemsPerRow);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [catalogs.length, continueWatchingView.length]);

  useEffect(() => {
    const handleContentModeChange = (event: Event) => {
      const mode = (event as CustomEvent<DiscoveryContentMode>).detail;
      setDiscoveryContentMode(mode || getDiscoveryContentMode());
    };
    window.addEventListener(DISCOVERY_CONTENT_CHANGED_EVENT, handleContentModeChange);
    return () => window.removeEventListener(DISCOVERY_CONTENT_CHANGED_EVENT, handleContentModeChange);
  }, []);

  useEffect(() => {
    if (!releaseQualitySnapshot.enabled || releaseQualitySnapshot.backgroundPaused) return;
    const items = catalogs
      .filter((catalog) => catalog.id === 'trending' || catalog.id === 'popular')
      .flatMap((catalog) => catalog.items);
    const schedule = () => scheduleAddonReleaseQualityProbes(items);
    schedule();
    const timer = window.setInterval(schedule, ADDON_RELEASE_PROBE_RECHECK_MS);
    window.addEventListener('online', schedule);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', schedule);
    };
  }, [catalogs, releaseQualitySnapshot.backgroundPaused, releaseQualitySnapshot.enabled]);

  useEffect(() => {
    const container = document.querySelector('.main-content');
    if (!(container instanceof HTMLElement)) {
      return;
    }

    const handleScroll = () => {
      setBoardScrollPosition(container.scrollTop);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [setBoardScrollPosition]);

  useEffect(() => {
    let cancelled = false;
    let firstCatalogPublished = false;
    const performanceTrace = createPerformanceTrace('Board catalogs');
    if (boardCatalogSnapshotMode !== discoveryContentMode) {
      boardCatalogSnapshot = [];
      boardCatalogSnapshotMode = discoveryContentMode;
      setCatalogs([]);
      setLoading(true);
    }
    const publishCatalog = (catalog: CatalogRow) => {
      if (cancelled || catalog.items.length === 0) return;
      if (!firstCatalogPublished) {
        firstCatalogPublished = true;
        performanceTrace.mark('first row ready');
      }
      setCatalogs((current) => {
        const next = sortCatalogRows([
          ...current.filter((row) => !(row.id === catalog.id && row.type === catalog.type && row.source === catalog.source)),
          catalog
        ]);
        boardCatalogSnapshot = next;
        boardCatalogSnapshotMode = discoveryContentMode;
        return next;
      });
    };

    const fetchCatalogs = async () => {
      try {
        const tmdbAvailable = isTmdbConfigured();
        if (cancelled) return;
        setTmdbConfigured(tmdbAvailable);
        if (!tmdbAvailable) {
          console.warn('TMDB Worker URL not configured');
          boardCatalogSnapshot = [];
          setCatalogs([]);
          setLoading(false);
          return;
        }

        const hasTrakt = hasTraktCredentials();
        if (!hasTrakt) {
          setCatalogs((current) => {
            const next = current.filter((row) => row.source !== 'trakt');
            boardCatalogSnapshot = next;
            return next;
          });
        }

        const createTraktTasks = (limit: number): Array<Promise<void>> => [
          fetchTraktCatalogItems('anticipated', 'movie', 1, limit, discoveryContentMode)
            .then((items) => publishCatalog({ id: 'anticipated', title: formatDiscoveryCatalogTitle('Anticipated Movies', discoveryContentMode), type: 'movie', source: 'trakt', items, hideWatchedToggle: true })),
          fetchTraktCatalogItems('anticipated', 'series', 1, limit, discoveryContentMode)
            .then((items) => publishCatalog({ id: 'anticipated', title: formatDiscoveryCatalogTitle('Anticipated TV', discoveryContentMode), type: 'series', source: 'trakt', items, hideWatchedToggle: true }))
        ];
        const tasks: Array<Promise<void>> = [
          getTmdbBoardCatalogs(discoveryContentMode).then((catalogs) => {
            publishCatalog({ id: 'trending', title: formatDiscoveryCatalogTitle('Trending Movies', discoveryContentMode), type: 'movie', source: 'tmdb', items: catalogs.trendingMovies });
            publishCatalog({ id: 'popular', title: formatDiscoveryCatalogTitle('Popular Movies', discoveryContentMode), type: 'movie', source: 'tmdb', items: catalogs.popularMovies });
            publishCatalog({ id: 'trending', title: formatDiscoveryCatalogTitle('Trending TV', discoveryContentMode), type: 'series', source: 'tmdb', items: catalogs.trendingTv });
            publishCatalog({ id: 'popular', title: formatDiscoveryCatalogTitle('Popular TV', discoveryContentMode), type: 'series', source: 'tmdb', items: catalogs.popularTv });
          })
        ];

        if (hasTrakt) {
          tasks.push(...createTraktTasks(BOARD_CATALOG_ITEM_LIMIT));
        }

        await Promise.allSettled(tasks);
      } catch (error) {
        console.error('Failed to fetch catalogs:', error);
      } finally {
        if (!cancelled) {
          setLoading(false);
          performanceTrace.finish('all rows settled');
        }
      }
    };

    void fetchCatalogs();
    return () => {
      cancelled = true;
    };
  }, [discoveryContentMode]);

  const handleItemClick = (item: MetaPreview) => {
    setSelectedMeta({
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster,
      background: item.background,
      year: item.year,
      imdbId: item.imdbId,
      rating: item.rating
    }, 'board');
  };

  const handleContinueItemClick = (item: ContinueWatchingViewItem) => {
    if (item.source === 'up-next') {
      addToContinueWatching({
        metaId: item.metaId,
        type: item.type,
        title: item.title,
        poster: item.poster,
        progress: item.progress,
        playbackTime: item.playbackTime,
        duration: item.duration,
        sourceFilename: item.sourceFilename,
        rating: item.rating,
        pausedAt: item.pausedAt,
        episodeId: item.episodeId,
        season: item.season,
        episode: item.episode
      });
    }

    handleItemClick({
      id: item.metaId,
      type: item.type,
      name: item.title,
      poster: item.poster,
      rating: item.rating
    });
  };

  const handleShowAll = (catalog: CatalogRow) => {
    setSelectedCatalog({
      id: catalog.id,
      title: catalog.title,
      type: catalog.type,
      source: catalog.source,
      hideWatchedToggle: catalog.hideWatchedToggle
    });
  };

  const handleShowAllContinueWatching = () => {
    const items = sortedContinueWatching.map((item): MetaPreview => ({
      id: item.metaId,
      type: item.type,
      name: item.title,
      poster: item.poster,
      rating: item.rating,
      continueSource: item.source,
      continueProgress: item.progress,
      continuePausedAt: item.pausedAt,
      continueSeason: item.season,
      continueEpisode: item.episode,
      continueEpisodeId: item.episodeId
    }));

    setCatalogItems(items);
    setCatalogPage(1);
    setCatalogCacheKey('continue-continue-watching-series');
    setSelectedCatalog({
      id: 'continue-watching',
      title: 'Continue Watching',
      type: 'series',
      source: 'continue',
      hideWatchedToggle: true
    });
  };

  const getPosterUrl = (poster: string | undefined): string => {
    if (!poster) return '';
    return poster;
  };

  useEffect(() => {
    if (loading) return;
    if (startupTraktSyncState === 'running') {
      logger.info('board.up_next_refresh.deferred', '[TMDB Up Next] Refresh deferred for startup sync', {
        status: 'deferred',
        startup_sync_state: startupTraktSyncState,
      }, 'board.tmdb_up_next');
      return;
    }
    const refreshDelayMs = startupTraktSyncState === 'pending'
      ? UP_NEXT_PENDING_SYNC_GRACE_MS
      : UP_NEXT_SETTLED_REFRESH_DELAY_MS;
    if (
      continueWatchingViewFingerprint === continueRefreshFingerprint
      && continueWatchingViewUpdatedAt > 0
      && Date.now() - continueWatchingViewUpdatedAt < CONTINUE_VIEW_REFRESH_TTL_MS
    ) {
      if (import.meta.env.DEV) {
        logger.debug('board.up_next_refresh.skipped', '[TMDB Up Next] Refresh skipped for fresh view cache', {
          status: 'skipped',
          reason: 'fresh_view_cache',
          startup_sync_state: startupTraktSyncState,
          view_cache_age_ms: Date.now() - continueWatchingViewUpdatedAt,
          view_cache_ttl_ms: CONTINUE_VIEW_REFRESH_TTL_MS,
        }, 'board.tmdb_up_next');
      }
      return;
    }

    let cancelled = false;
    const refreshGeneration = ++continueRefreshGenerationRef.current;
    const refreshReason = continueWatchingViewFingerprint === continueRefreshFingerprint
      ? 'ttl_expired'
      : 'view_state_changed';
    const refreshRequestId = `board-up-next-${Date.now()}-${refreshGeneration}`;
    let refreshStartedAt = 0;
    const isCurrentRefresh = () =>
      !cancelled && continueRefreshGenerationRef.current === refreshGeneration;

    const findNextAvailableEpisode = async (
      show: {
        tmdbId: number;
        latestSeason: number;
        latestEpisode: number;
      },
      watchedEpisodeKeys: Set<string>
    ): Promise<{
      nextEpisode: { season: number; episode: number } | null;
      cacheHit: boolean;
      cacheState: 'not_checked' | 'miss' | 'hit_episode' | 'hit_no_result' | 'invalid_episode';
      seasonListLookups: number;
      episodeListLookups: number;
      candidateSeasonCount: number;
      failed: boolean;
      errorKind?: string;
      seriesStatus?: string | null;
      inProduction?: boolean;
      nextEpisodeAirDate?: string | null;
      noResultCachePolicy?: string;
      noResultCacheTtlMs?: number;
    }> => {
      if (!isCurrentRefresh()) {
        return {
          nextEpisode: null,
          cacheHit: false,
          cacheState: 'not_checked',
          seasonListLookups: 0,
          episodeListLookups: 0,
          candidateSeasonCount: 0,
          failed: false,
        };
      }

      const cacheKey = `board:up-next:v3:${show.tmdbId}:s${show.latestSeason}:e${show.latestEpisode}`;
      const cachedResolution = await readPersistentlyCachedValue<{
        nextEpisode: { season: number; episode: number } | null;
        seriesStatus?: string | null;
        inProduction?: boolean;
        nextEpisodeAirDate?: string | null;
        noResultCachePolicy?: string;
        noResultCacheTtlMs?: number;
      }>(cacheKey);
      const cachedEpisode = cachedResolution?.nextEpisode;
      if (cachedResolution && cachedEpisode === null) {
        return {
          nextEpisode: null,
          cacheHit: true,
          cacheState: 'hit_no_result',
          seasonListLookups: 0,
          episodeListLookups: 0,
          candidateSeasonCount: 0,
          failed: false,
          seriesStatus: cachedResolution.seriesStatus,
          inProduction: cachedResolution.inProduction,
          nextEpisodeAirDate: cachedResolution.nextEpisodeAirDate,
          noResultCachePolicy: cachedResolution.noResultCachePolicy,
          noResultCacheTtlMs: cachedResolution.noResultCacheTtlMs,
        };
      }
      if (
        cachedEpisode
        && Number.isFinite(cachedEpisode.season)
        && Number.isFinite(cachedEpisode.episode)
        && (
          cachedEpisode.season > show.latestSeason
          || (cachedEpisode.season === show.latestSeason && cachedEpisode.episode > show.latestEpisode)
        )
        && !watchedEpisodeKeys.has(getEpisodeKey(show.tmdbId, cachedEpisode.season, cachedEpisode.episode))
      ) {
        return {
          nextEpisode: cachedEpisode,
          cacheHit: true,
          cacheState: 'hit_episode',
          seasonListLookups: 0,
          episodeListLookups: 0,
          candidateSeasonCount: 0,
          failed: false,
        };
      }

      let seasonListLookups = 0;
      let episodeListLookups = 0;
      let candidateSeasonCount = 0;
      const cacheState = cachedResolution ? 'invalid_episode' : 'miss';

      try {
        seasonListLookups = 1;
        const schedule = await getTmdbSeriesSchedule(show.tmdbId, { throwOnError: true });
        const candidateSeasons = schedule.seasons
          .filter((season) => season.episode_count > 0 && season.season_number >= show.latestSeason)
          .sort((a, b) => a.season_number - b.season_number);
        candidateSeasonCount = candidateSeasons.length;

        for (const season of candidateSeasons) {
          if (!isCurrentRefresh()) {
            break;
          }
          episodeListLookups += 1;
          const episodes = await getTmdbEpisodes(show.tmdbId, season.season_number, { throwOnError: true });
          const nextEpisode = episodes
            .filter(isAvailableEpisode)
            .filter((episode) => (
              season.season_number > show.latestSeason
              || episode.episode_number > show.latestEpisode
            ))
            .sort((a, b) => a.episode_number - b.episode_number)
            .find((episode) => !watchedEpisodeKeys.has(getEpisodeKey(show.tmdbId, season.season_number, episode.episode_number)));

          if (nextEpisode) {
            const resolvedEpisode = {
              season: season.season_number,
              episode: nextEpisode.episode_number
            };
            await writePersistentlyCachedValue(
              cacheKey,
              {
                nextEpisode: resolvedEpisode,
                seriesStatus: schedule.status,
                inProduction: schedule.inProduction,
                nextEpisodeAirDate: schedule.nextEpisodeAirDate,
              },
              UP_NEXT_RESOLVED_RESULT_CACHE_TTL_MS,
            );
            return {
              nextEpisode: resolvedEpisode,
              cacheHit: false,
              cacheState,
              seasonListLookups,
              episodeListLookups,
              candidateSeasonCount,
              failed: false,
              seriesStatus: schedule.status,
              inProduction: schedule.inProduction,
              nextEpisodeAirDate: schedule.nextEpisodeAirDate,
            };
          }
        }

        if (isCurrentRefresh()) {
          const noResultCache = getUpNextNoResultCachePolicy(show.tmdbId, schedule);
          await writePersistentlyCachedValue(
            cacheKey,
            {
              nextEpisode: null,
              seriesStatus: schedule.status,
              inProduction: schedule.inProduction,
              nextEpisodeAirDate: schedule.nextEpisodeAirDate,
              noResultCachePolicy: noResultCache.policy,
              noResultCacheTtlMs: noResultCache.ttlMs,
            },
            noResultCache.ttlMs,
          );
          return {
            nextEpisode: null,
            cacheHit: false,
            cacheState,
            seasonListLookups,
            episodeListLookups,
            candidateSeasonCount,
            failed: false,
            seriesStatus: schedule.status,
            inProduction: schedule.inProduction,
            nextEpisodeAirDate: schedule.nextEpisodeAirDate,
            noResultCachePolicy: noResultCache.policy,
            noResultCacheTtlMs: noResultCache.ttlMs,
          };
        }
        return {
          nextEpisode: null,
          cacheHit: false,
          cacheState,
          seasonListLookups,
          episodeListLookups,
          candidateSeasonCount,
          failed: false,
        };
      } catch (error) {
        return {
          nextEpisode: null,
          cacheHit: false,
          cacheState,
          seasonListLookups,
          episodeListLookups,
          candidateSeasonCount,
          failed: true,
          errorKind: error instanceof Error ? error.name : 'UnknownError',
        };
      }
    };

    const refreshBoardContinueWatching = async () => {
      const watchedEpisodeKeys = new Set<string>();
      const watchedShows = new Map<number, {
        tmdbId: number;
        title: string;
        lastWatchedAt: string;
        lastWatchedTime: number;
        latestSeason: number;
        latestEpisode: number;
      }>();
      const watchedMovieIds = new Set(watched.filter((item) => item.type === 'movie').map((item) => item.id));
      const watchedShowTitles = new Map<number, string>();
      for (const item of watched) {
        if (item.type !== 'series') continue;
        const tmdbId = parseTmdbId(item.id);
        if (tmdbId !== null) watchedShowTitles.set(tmdbId, item.name);
      }
      for (const item of continueWatching) {
        if (item.type !== 'series') continue;
        const tmdbId = parseTmdbId(item.metaId);
        if (tmdbId !== null && !watchedShowTitles.has(tmdbId)) {
          watchedShowTitles.set(tmdbId, item.title);
        }
      }

      for (const [key, value] of Object.entries(watchedEpisodes)) {
        const parsed = parseWatchedEpisodeKey(key);
        if (!parsed) {
          continue;
        }

        const watchedTime = parseTimestamp(value);
        const watchedAt = typeof value === 'string' && value ? value : new Date(0).toISOString();
        watchedEpisodeKeys.add(getEpisodeKey(parsed.tmdbId, parsed.season, parsed.episode));

        const current = watchedShows.get(parsed.tmdbId);
        if (!current) {
          watchedShows.set(parsed.tmdbId, {
            tmdbId: parsed.tmdbId,
            title: watchedShowTitles.get(parsed.tmdbId) ?? `TMDB ${parsed.tmdbId}`,
            lastWatchedAt: watchedAt,
            lastWatchedTime: watchedTime,
            latestSeason: parsed.season,
            latestEpisode: parsed.episode
          });
          continue;
        }

        if (watchedTime > current.lastWatchedTime) {
          current.lastWatchedAt = watchedAt;
          current.lastWatchedTime = watchedTime;
        }
        if (
          parsed.season > current.latestSeason
          || (parsed.season === current.latestSeason && parsed.episode > current.latestEpisode)
        ) {
          current.latestSeason = parsed.season;
          current.latestEpisode = parsed.episode;
        }
      }

      const resumeItems = continueWatching
        .filter((item) => isUnfinishedResume(item))
        .filter((item) => item.type !== 'movie' || !watchedMovieIds.has(item.metaId))
        .filter((item) => {
          if (item.type !== 'series') {
            return true;
          }

          const tmdbId = parseTmdbId(item.metaId);
          if (!tmdbId || typeof item.season !== 'number' || typeof item.episode !== 'number') {
            return false;
          }

          return !watchedEpisodeKeys.has(getEpisodeKey(tmdbId, item.season, item.episode));
        })
        .map((item): ContinueWatchingViewItem => ({ ...item, source: 'resume' }));
      const watchedSeriesResumeItems = continueWatching
        .filter((item) => isWatchedSeriesResume(item, watchedEpisodeKeys))
        .map((item): ContinueWatchingViewItem => ({ ...item, source: 'resume' }));

      const resumeShowIds = new Set(
        resumeItems
          .filter((item) => item.type === 'series')
          .map((item) => parseTmdbId(item.metaId))
          .filter((tmdbId): tmdbId is number => typeof tmdbId === 'number')
      );
      const upNextCandidates = Array.from(watchedShows.values())
        .filter((show) => !resumeShowIds.has(show.tmdbId))
        .sort((a, b) => b.lastWatchedTime - a.lastWatchedTime);

      logger.info('board.up_next_refresh.started', '[TMDB Up Next] Refresh started', {
        request_id: refreshRequestId,
        status: 'started',
        reason: refreshReason,
        candidate_count: upNextCandidates.length,
        resume_show_count: resumeShowIds.size,
        refresh_generation: refreshGeneration,
        startup_sync_state: startupTraktSyncState,
        settle_delay_ms: refreshDelayMs,
      }, 'board.tmdb_up_next');

      if (isCurrentRefresh()) {
        const existingUpNext = useStore.getState().continueWatchingView
          .filter((item) => item.source === 'up-next')
          .filter((item) => !resumeShowIds.has(parseTmdbId(item.metaId) ?? -1));
        setContinueWatchingView(
          [...resumeItems, ...existingUpNext, ...watchedSeriesResumeItems]
            .filter((item, index, array) => array.findIndex((candidate) => candidate.metaId === item.metaId) === index)
            .sort((a, b) => parseTimestamp(b.pausedAt) - parseTimestamp(a.pausedAt))
        );
      }

      const resolvedEpisodes: Array<{
        show: typeof upNextCandidates[number];
        nextEpisode: { season: number; episode: number } | null;
        cacheHit: boolean;
        cacheState: 'not_checked' | 'miss' | 'hit_episode' | 'hit_no_result' | 'invalid_episode';
        seasonListLookups: number;
        episodeListLookups: number;
        candidateSeasonCount: number;
        failed: boolean;
        errorKind?: string;
        seriesStatus?: string | null;
        inProduction?: boolean;
        nextEpisodeAirDate?: string | null;
        noResultCachePolicy?: string;
        noResultCacheTtlMs?: number;
      }> = [];
      const summarizeResolvedEpisodes = () => {
        const resolvedResultCount = resolvedEpisodes.filter((item) => item.nextEpisode).length;
        const failedResultCount = resolvedEpisodes.filter((item) => item.failed).length;
        const cachedResultCount = resolvedEpisodes.filter((item) => item.cacheHit).length;
        const noResultCachePolicyCounts = resolvedEpisodes.reduce<Record<string, number>>((counts, item) => {
          if (item.noResultCachePolicy) {
            counts[item.noResultCachePolicy] = (counts[item.noResultCachePolicy] ?? 0) + 1;
          }
          return counts;
        }, {});
        return {
          resolvedCandidateCount: resolvedEpisodes.length,
          unresolvedCandidateCount: Math.max(0, upNextCandidates.length - resolvedEpisodes.length),
          cachedResultCount,
          cacheMissCount: resolvedEpisodes.length - cachedResultCount,
          resolvedResultCount,
          noResultCount: resolvedEpisodes.length - resolvedResultCount - failedResultCount,
          failedResultCount,
          seasonListLookups: resolvedEpisodes.reduce((total, item) => total + item.seasonListLookups, 0),
          episodeListLookups: resolvedEpisodes.reduce((total, item) => total + item.episodeListLookups, 0),
          noResultCachePolicyCounts,
        };
      };
      const getCancellationReason = () => {
        if (!boardMountedRef.current) return 'board_unmounted';
        if (continueRefreshGenerationRef.current !== refreshGeneration) return 'refresh_superseded';
        if (cancelled) return 'effect_cleanup';
        return 'unknown';
      };
      const logCancelledRefresh = (cancellationStage: 'candidate_resolution' | 'metadata_enrichment') => {
        const summary = summarizeResolvedEpisodes();
        logger.info('board.up_next_refresh.cancelled', '[TMDB Up Next] Refresh cancelled', {
          request_id: refreshRequestId,
          status: 'cancelled',
          duration_ms: Math.max(0, performance.now() - refreshStartedAt),
          candidate_count: upNextCandidates.length,
          resolved_candidate_count: summary.resolvedCandidateCount,
          unresolved_candidate_count: summary.unresolvedCandidateCount,
          cached_result_count: summary.cachedResultCount,
          cache_miss_count: summary.cacheMissCount,
          resolved_result_count: summary.resolvedResultCount,
          no_result_count: summary.noResultCount,
          failed_result_count: summary.failedResultCount,
          season_list_lookups: summary.seasonListLookups,
          episode_list_lookups: summary.episodeListLookups,
          no_result_cache_policy_counts: summary.noResultCachePolicyCounts,
          cancellation_reason: getCancellationReason(),
          cancellation_stage: cancellationStage,
        }, 'board.tmdb_up_next');
      };
      let nextCandidateIndex = 0;
      const workerCount = Math.min(4, upNextCandidates.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (isCurrentRefresh() && nextCandidateIndex < upNextCandidates.length) {
          const show = upNextCandidates[nextCandidateIndex++];
          const resolution = await findNextAvailableEpisode(show, watchedEpisodeKeys);
          resolvedEpisodes.push({
            show,
            ...resolution,
          });
          if (import.meta.env.DEV) {
            const resolutionStatus = !isCurrentRefresh()
              ? 'cancelled'
              : resolution.failed
                ? 'failed'
                : resolution.cacheHit
                  ? 'cache_hit'
                  : resolution.nextEpisode
                    ? 'resolved'
                    : 'no_result';
            logger.debug('board.up_next_title.resolved', '[TMDB Up Next] Title resolution recorded', {
              request_id: refreshRequestId,
              status: resolutionStatus,
              title: show.title,
              tmdb_id: show.tmdbId,
              cache_key: `board:up-next:v3:${show.tmdbId}:s${show.latestSeason}:e${show.latestEpisode}`,
              cache_state: resolution.cacheState,
              cache_hit: resolution.cacheHit,
              watched_season: show.latestSeason,
              watched_episode: show.latestEpisode,
              tmdb_lookup_attempted: resolution.seasonListLookups > 0 || resolution.episodeListLookups > 0,
              season_list_lookups: resolution.seasonListLookups,
              episode_list_lookups: resolution.episodeListLookups,
              candidate_season_count: resolution.candidateSeasonCount,
              resolved_season: resolution.nextEpisode?.season ?? null,
              resolved_episode: resolution.nextEpisode?.episode ?? null,
              series_status: resolution.seriesStatus ?? null,
              in_production: resolution.inProduction ?? null,
              next_episode_air_date: resolution.nextEpisodeAirDate ?? null,
              no_result_cache_policy: resolution.noResultCachePolicy ?? null,
              no_result_cache_ttl_hours: typeof resolution.noResultCacheTtlMs === 'number'
                ? Math.round(resolution.noResultCacheTtlMs / (60 * 60 * 1000))
                : null,
              error_kind: resolution.errorKind ?? null,
            }, 'board.tmdb_up_next');
          }
        }
      });
      await Promise.all(workers);
      if (!isCurrentRefresh()) {
        logCancelledRefresh('candidate_resolution');
        return;
      }

      const enrichedItems = await enrichTmdbItemsById(
        resolvedEpisodes
          .filter((item) => item.nextEpisode)
          .map(({ show }) => ({ tmdbId: show.tmdbId, mediaType: 'tv' as const })),
      );
      if (!isCurrentRefresh()) {
        logCancelledRefresh('metadata_enrichment');
        return;
      }

      const enrichedById = new Map(enrichedItems.map((item) => [item.id, item]));
      const upNextItems: ContinueWatchingViewItem[] = [];

      for (const { show, nextEpisode } of resolvedEpisodes) {
        if (!nextEpisode) {
          continue;
        }

        const meta = enrichedById.get(`tv:${show.tmdbId}`);
        const fallback = continueWatching.find((item) => item.metaId === `tv:${show.tmdbId}`);
        upNextItems.push({
          metaId: `tv:${show.tmdbId}`,
          type: 'series',
          title: meta?.name || fallback?.title || `TV ${show.tmdbId}`,
          poster: meta?.poster || fallback?.poster || '',
          progress: 0,
          rating: meta?.rating ?? fallback?.rating,
          pausedAt: show.lastWatchedAt,
          episodeId: `${nextEpisode.season}:${nextEpisode.episode}`,
          season: nextEpisode.season,
          episode: nextEpisode.episode,
          source: 'up-next'
        });
      }

      const merged = [...resumeItems, ...upNextItems]
        .filter((item, index, array) => array.findIndex((candidate) => candidate.metaId === item.metaId) === index)
        .sort((a, b) => parseTimestamp(b.pausedAt) - parseTimestamp(a.pausedAt));

      if (isCurrentRefresh()) {
        setContinueWatchingView(merged);
        setContinueWatchingViewRefresh(continueRefreshFingerprint, Date.now());

        const summary = summarizeResolvedEpisodes();
        const highestFanoutShows = [...resolvedEpisodes]
          .sort((a, b) => b.episodeListLookups - a.episodeListLookups)
          .slice(0, UP_NEXT_DIAGNOSTIC_SHOW_LIMIT)
          .map((item) => ({
            tmdb_id: item.show.tmdbId,
            latest_season: item.show.latestSeason,
            latest_episode: item.show.latestEpisode,
            cache_hit: item.cacheHit,
            candidate_season_count: item.candidateSeasonCount,
            episode_list_lookups: item.episodeListLookups,
            resolved_season: item.nextEpisode?.season ?? null,
            resolved_episode: item.nextEpisode?.episode ?? null,
            resolution_status: item.failed
              ? 'failed'
              : item.cacheHit
                ? 'cache_hit'
                : item.nextEpisode
                  ? 'resolved'
                  : 'no_result',
            series_status: item.seriesStatus ?? null,
            in_production: item.inProduction ?? null,
            next_episode_air_date: item.nextEpisodeAirDate ?? null,
            no_result_cache_policy: item.noResultCachePolicy ?? null,
            no_result_cache_ttl_hours: typeof item.noResultCacheTtlMs === 'number'
              ? Math.round(item.noResultCacheTtlMs / (60 * 60 * 1000))
              : null,
            error_kind: item.errorKind ?? null,
          }));

        const logRefreshCompleted = summary.failedResultCount > 0 ? logger.warn : logger.info;
        logRefreshCompleted('board.up_next_refresh.completed', '[TMDB Up Next] Refresh completed', {
          request_id: refreshRequestId,
          status: summary.failedResultCount > 0 ? 'degraded' : 'completed',
          duration_ms: Math.max(0, performance.now() - refreshStartedAt),
          candidate_count: upNextCandidates.length,
          resolved_result_count: summary.resolvedResultCount,
          no_result_count: summary.noResultCount,
          failed_result_count: summary.failedResultCount,
          cached_result_count: summary.cachedResultCount,
          cache_miss_count: summary.cacheMissCount,
          season_list_lookups: summary.seasonListLookups,
          episode_list_lookups: summary.episodeListLookups,
          no_result_cache_policy_counts: summary.noResultCachePolicyCounts,
          metadata_preview_count: enrichedItems.length,
          highest_fanout_shows: highestFanoutShows,
        }, 'board.tmdb_up_next');
      }
    };

    const refreshTimeout = window.setTimeout(() => {
      refreshStartedAt = performance.now();
      refreshBoardContinueWatching().catch((error) => {
        logger.error('board.up_next_refresh.failed', '[TMDB Up Next] Refresh failed', {
          request_id: refreshRequestId,
          status: 'failed',
          duration_ms: Math.max(0, performance.now() - refreshStartedAt),
          error_kind: error instanceof Error ? error.name : 'UnknownError',
        }, 'board.tmdb_up_next');
      });
    }, refreshDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimeout);
    };
  }, [continueRefreshFingerprint, continueWatching, continueWatchingViewFingerprint, continueWatchingViewUpdatedAt, loading, setContinueWatchingView, setContinueWatchingViewRefresh, startupTraktSyncState, watched, watchedEpisodes]);

  const sortedContinueWatching = [...continueWatchingView].sort((a, b) => {
    if (!a.pausedAt && !b.pausedAt) return 0;
    if (!a.pausedAt) return 1;
    if (!b.pausedAt) return -1;
    return new Date(b.pausedAt).getTime() - new Date(a.pausedAt).getTime();
  });
  const featuredCandidates = useMemo<FeaturedItem[]>(() => {
    const continueItems = sortedContinueWatching.map((item) => ({
      id: item.metaId,
      name: item.title,
      poster: item.poster,
      background: item.poster,
      type: item.type,
      rating: item.rating,
      progress: item.source === 'resume' ? Math.round(item.progress) : null,
      detail: item.source === 'up-next'
        ? `${formatEpisodeLabel(item)} ready`
        : item.pausedAt ? `Paused ${formatRelativeTime(item.pausedAt)}` : 'Continue watching',
      source: 'continue' as const
    }));
    const catalogItems = catalogs
      .flatMap((catalog) => catalog.items.slice(0, 2))
      .map((item) => ({
        id: item.id,
        name: item.name,
        poster: item.poster,
        background: item.background || item.poster,
        type: item.type,
        rating: item.rating,
        progress: null as number | null,
        detail: item.releaseDate ? formatReleaseDate(item.releaseDate) : 'Fresh from TMDB',
        source: 'catalog' as const
      }));

    return [...continueItems, ...catalogItems].filter((item, index, array) => {
      return array.findIndex((candidate) => candidate.id === item.id) === index;
    });
  }, [catalogs, sortedContinueWatching]);

  useEffect(() => {
    if (featuredCandidates.length <= 1) {
      setFeaturedIndex(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setFeaturedIndex((current) => (current + 1) % featuredCandidates.length);
    }, 4500);

    return () => window.clearInterval(intervalId);
  }, [featuredCandidates.length]);

  const featuredItem = featuredCandidates.length > 0
    ? featuredCandidates[featuredIndex % featuredCandidates.length]
    : null;

  useEffect(() => {
    if (!featuredItem) {
      setRenderedFeatured(null);
      setHeroReady(false);
      return;
    }

    if (!renderedFeatured) {
      setRenderedFeatured(featuredItem);
      const frameId = window.requestAnimationFrame(() => setHeroReady(true));
      return () => window.cancelAnimationFrame(frameId);
    }

    if (renderedFeatured.id === featuredItem.id) {
      return;
    }

    setHeroReady(false);
    const timeoutId = window.setTimeout(() => {
      setRenderedFeatured(featuredItem);
      setHeroReady(true);
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [featuredItem, renderedFeatured]);

  const activeFeatured = renderedFeatured ?? featuredItem;
  const featuredContinue = activeFeatured?.source === 'continue';

  useEffect(() => {
    if (!activeFeatured?.background) return;
    const image = new Image();
    image.fetchPriority = 'high';
    image.decoding = 'async';
    image.src = activeFeatured.background;
  }, [activeFeatured?.background]);

  useLayoutEffect(() => {
    if (loading || boardScrollPosition <= 0) {
      return;
    }

    const container = document.querySelector('.main-content');
    if (!(container instanceof HTMLElement)) {
      return;
    }

    container.scrollTo({ top: boardScrollPosition, behavior: 'auto' });
  }, [loading, boardScrollPosition]);

  if (tmdbConfigured === false && catalogs.length === 0) {
    return (
      <div className="board">
        <div className="board-loading">
          <span>TMDB service is not configured in this build</span>
        </div>
      </div>
    );
  }

  return (
    <div className="board">
      {activeFeatured && (
        <section className={`board-hero ${heroReady ? 'is-visible' : 'is-transitioning'}`}>
          {activeFeatured.background && (
            <div
              className="board-hero-backdrop"
              style={{ backgroundImage: `url(${activeFeatured.background})` }}
            />
          )}
          <div className="board-hero-overlay" />
          <div className="board-hero-content">
            <div className="board-hero-copy">
              <span className="board-kicker">Streaming workspace</span>
              <h1>{featuredContinue ? 'Pick up where you left off.' : 'Discover something worth watching.'}</h1>
              <p>
                {featuredContinue
                  ? 'Resume unfinished playback or jump into the next aired episode from your history.'
                  : 'Browse trending movies and series with a cleaner, richer browsing experience built for long sessions.'}
              </p>
              <div className="board-hero-actions">
                <button
                  className="board-hero-button primary"
                  onClick={() => handleItemClick({
                    id: activeFeatured.id,
                    type: activeFeatured.type,
                    name: activeFeatured.name,
                    poster: activeFeatured.poster,
                    background: activeFeatured.background,
                    rating: activeFeatured.rating
                  })}
                >
                  {featuredContinue ? <FiClock /> : <FiTrendingUp />}
                  {featuredContinue ? 'Resume Now' : 'Open Details'}
                </button>
                {catalogs[0] && (
                  <button
                    className="board-hero-button secondary"
                    onClick={() => handleShowAll(catalogs[0])}
                  >
                    <FiBookmark />
                    Browse {catalogs[0].title}
                  </button>
                )}
              </div>
              <div className="board-hero-meta">
                <div className="board-hero-stat">
                  <span className="board-hero-stat-label">Featured</span>
                  <strong>{activeFeatured.name}</strong>
                </div>
                <div className="board-hero-stat">
                  <span className="board-hero-stat-label">Status</span>
                  <strong>{activeFeatured.progress !== null ? `${activeFeatured.progress}% complete` : activeFeatured.detail}</strong>
                </div>
                <div className="board-hero-stat">
                  <span className="board-hero-stat-label">Library</span>
                  <strong>{watchlist.length} saved • {watched.length} watched</strong>
                </div>
              </div>
            </div>
            {activeFeatured.poster && (
              <button
                className="board-hero-poster"
                onClick={() => handleItemClick({
                  id: activeFeatured.id,
                  type: activeFeatured.type,
                  name: activeFeatured.name,
                  poster: activeFeatured.poster,
                  background: activeFeatured.background,
                  rating: activeFeatured.rating
                })}
              >
                <img src={activeFeatured.poster} alt={activeFeatured.name} decoding="async" />
                {activeFeatured.progress !== null && (
                  <div className="board-hero-progress">
                    <div style={{ width: `${activeFeatured.progress}%` }} />
                  </div>
                )}
              </button>
            )}
          </div>
        </section>
      )}

      {sortedContinueWatching.length > 0 && (
        <section className="board-section">
          <div className="board-section-header">
            <div>
              <span className="board-section-kicker">History</span>
              <h2>Continue Watching</h2>
            </div>
          </div>
          <div className="board-grid" ref={catalogGridRef}>
            {sortedContinueWatching.slice(0, getContinueWatchingVisibleItemCount(itemsPerRow)).map((item) => (
              <div
                key={item.metaId}
                className="board-item"
                onClick={() => handleContinueItemClick(item)}
              >
                <div 
                  className={`board-item-poster ${item.type === 'movie' && watched.some(w => w.id === item.metaId) ? 'watched' : ''}`}
                >
                  {item.poster ? (
                    <img 
                      src={getPosterUrl(item.poster)} 
                      alt={item.title}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div className="board-item-placeholder" />
                  )}
                  <XrelQualityBadge
                    item={{ id: item.metaId, type: item.type, name: item.title }}
                    queuePriority="library"
                  />
                  {item.source === 'resume' && (
                    <>
                      <div className="poster-progress" style={{ width: `${item.progress}%` }} />
                      <button
                        className="continue-remove-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFromContinueWatching(item.metaId);
                        }}
                        title="Remove from Continue Watching"
                      >
                        <FiX />
                      </button>
                    </>
                  )}
                </div>
                <span className="board-item-title">{item.title}</span>
                <span className="board-item-date">
                  {item.source === 'up-next'
                    ? `Next ${formatEpisodeLabel(item)}`
                    : item.pausedAt ? formatRelativeTime(item.pausedAt) : 'Resume'}
                </span>
              </div>
            ))}
          </div>
          {sortedContinueWatching.length > getContinueWatchingVisibleItemCount(itemsPerRow) && (
            <button
              className="board-show-all"
              onClick={handleShowAllContinueWatching}
            >
              Show All Continue Watching <FiChevronRight />
            </button>
          )}
        </section>
      )}

      {loading && catalogs.length === 0 && (
        <div className="board-loading">
          <div className="loading-spinner" />
          <span>Loading catalogs...</span>
        </div>
      )}

      {!loading && tmdbConfigured && catalogs.length === 0 && (
        <div className="board-loading">
          <span>Catalogs could not be loaded. Check your connection and try again.</span>
        </div>
      )}

      {catalogs.map((catalog, catalogIndex) => (
        <section key={catalog.source + catalog.id + catalog.type} className="board-section">
          <div className="board-section-header">
            <div>
              <span className="board-section-kicker">{catalog.type === 'movie' ? 'Movies' : 'Series'}</span>
              <h2>{catalog.title}</h2>
            </div>
          </div>
          <div
            className="board-grid"
            ref={sortedContinueWatching.length === 0 && catalogIndex === 0 ? catalogGridRef : undefined}
          >
            {catalog.items.slice(0, getCatalogVisibleItemCount(itemsPerRow)).map((item) => (
              <div
                key={item.id}
                className="board-item"
                onClick={() => handleItemClick(item)}
              >
                <div className={`board-item-poster ${watched.some(w => w.id === item.id) ? 'watched' : ''}`}>
                  {item.poster ? (
                    <img 
                      src={getPosterUrl(item.poster)} 
                      alt={item.name}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div className="board-item-placeholder" />
                  )}
                  <XrelQualityBadge
                    item={item}
                    queuePriority={watchlist.some((entry) => entry.id === item.id) ? 'library' : 'normal'}
                  />
                  <div className="board-item-actions">
                    <button 
                      className={`board-item-action ${watchlist.some(w => w.id === item.id) ? 'active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        console.log('[UI] Watchlist toggle clicked for:', item.id, item.type);
                        if (watchlist.some(w => w.id === item.id)) {
                          console.log('[UI] Removing from watchlist...');
                          removeFromWatchlist(item.id);
                          if (traktConnected) pushWatchlistToTrakt(item, 'remove').catch(console.error);
                        } else {
                          console.log('[UI] Adding to watchlist...');
                          const wlMeta = { id: item.id, type: item.type, name: item.name, poster: item.poster, background: item.background, year: item.year, imdbId: item.imdbId, rating: item.rating };
                          addToWatchlist(wlMeta);
                          if (traktConnected) pushWatchlistToTrakt(wlMeta, 'add').catch(console.error);
                        }
                      }}
                      title={watchlist.some(w => w.id === item.id) ? 'Remove from Watchlist' : 'Add to Watchlist'}
                    >
                      <FiHeart />
                    </button>
                    {!catalog.hideWatchedToggle && (
                      <button 
                        className={`board-item-action ${watched.some(w => w.id === item.id) ? 'active' : ''}`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (watched.some(w => w.id === item.id)) {
                            removeFromWatched(item.id);
                            if (useStore.getState().traktConnected) {
                              await pushUnwatchedToTrakt(item);
                            }
                          } else {
                            const watchedMeta = { id: item.id, type: item.type, name: item.name, poster: item.poster, background: item.background, year: item.year, imdbId: item.imdbId, rating: item.rating, watchedAt: new Date().toISOString() };
                            addToWatched(watchedMeta);
                            if (useStore.getState().traktConnected) {
                              await pushWatchedToTrakt(watchedMeta);
                            }
                          }
                        }}
                        title={watched.some(w => w.id === item.id) ? 'Mark as Unwatched' : 'Mark as Watched'}
                      >
                        {watched.some(w => w.id === item.id) ? <FiEyeOff /> : <FiEye />}
                      </button>
                    )}
                  </div>
                  {item.rating !== undefined && item.rating > 0 && (
                    <div className="poster-rating-badge">★ {item.rating.toFixed(1)}</div>
                  )}
                </div>
                <span className="board-item-title">{item.name}</span>
                {item.releaseDate && <span className="board-item-year">{formatReleaseDate(item.releaseDate)}</span>}
              </div>
            ))}
          </div>
          <button className="board-show-all" onClick={() => handleShowAll(catalog)}>
            Show All {catalog.title} <FiChevronRight />
          </button>
        </section>
      ))}
    </div>
  );
};

export default Board;
