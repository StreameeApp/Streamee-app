import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FiChevronRight, FiHeart, FiEye, FiEyeOff, FiX, FiClock, FiBookmark, FiTrendingUp } from 'react-icons/fi';
import { useStore, ContinueWatchingItem, ContinueWatchingViewItem, MetaPreview } from '../../store';
import { enrichTmdbItemsById, EpisodeDetail, getTmdbEpisodes, getTmdbMovies, getTmdbSeasons, getTmdbTv, isTmdbConfigured } from '../../services/tmdb';
import { getAnticipatedMovies, getAnticipatedShows, getTrendingMovies, getTrendingShows, hasTraktCredentials } from '../../services/trakt';
import { pushUnwatchedToTrakt, pushWatchedToTrakt, pushWatchlistToTrakt } from '../../services/trakt-sync';
import { createPerformanceTrace } from '../../services/performance';
import {
  DISCOVERY_CONTENT_CHANGED_EVENT,
  fetchFilteredDiscoveryPage,
  formatDiscoveryCatalogTitle,
  getDiscoveryContentMode,
  type DiscoveryContentMode,
  type DiscoverySourcePage,
} from '../../services/discovery-content';
import XrelQualityBadge from '../../components/XrelQualityBadge';
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

function sortCatalogRows(rows: CatalogRow[]): CatalogRow[] {
  return [...rows].sort((a, b) => {
    const aIndex = CATALOG_ORDER.indexOf(`${a.source}:${a.id}:${a.type}`);
    const bIndex = CATALOG_ORDER.indexOf(`${b.source}:${b.id}:${b.type}`);
    return (aIndex === -1 ? CATALOG_ORDER.length : aIndex) -
      (bIndex === -1 ? CATALOG_ORDER.length : bIndex);
  });
}

const getItemsPerRow = (): number => {
  const width = window.innerWidth - 250;
  const itemWidth = 220;
  return Math.max(3, Math.floor(width / itemWidth));
};

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
  const [itemsPerRow, setItemsPerRow] = useState(getItemsPerRow);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [renderedFeatured, setRenderedFeatured] = useState<FeaturedItem | null>(null);
  const [heroReady, setHeroReady] = useState(false);
  const continueRefreshGenerationRef = useRef(0);
  const { setSelectedMeta, continueWatching, continueWatchingView, setContinueWatchingView, addToContinueWatching, removeFromContinueWatching, setSelectedCatalog, setCatalogItems, setCatalogPage, setCatalogCacheKey, watchlist, addToWatchlist, removeFromWatchlist, watched, addToWatched, removeFromWatched, boardScrollPosition, setBoardScrollPosition, traktConnected, watchedEpisodes } = useStore();

  useEffect(() => {
    const handleResize = () => setItemsPerRow(getItemsPerRow());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const handleContentModeChange = (event: Event) => {
      const mode = (event as CustomEvent<DiscoveryContentMode>).detail;
      setDiscoveryContentMode(mode || getDiscoveryContentMode());
    };
    window.addEventListener(DISCOVERY_CONTENT_CHANGED_EVENT, handleContentModeChange);
    return () => window.removeEventListener(DISCOVERY_CONTENT_CHANGED_EVENT, handleContentModeChange);
  }, []);

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
    let catalogExpansionTimer: number | undefined;
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

        const initialTraktLimit = Math.min(20, Math.max(6, getItemsPerRow() * 2));
        const createTraktTasks = (limit: number): Array<Promise<void>> => [
          fetchTraktCatalogItems('anticipated', 'movie', 1, limit, discoveryContentMode)
            .then((items) => publishCatalog({ id: 'anticipated', title: formatDiscoveryCatalogTitle('Anticipated Movies', discoveryContentMode), type: 'movie', source: 'trakt', items, hideWatchedToggle: true })),
          fetchTraktCatalogItems('anticipated', 'series', 1, limit, discoveryContentMode)
            .then((items) => publishCatalog({ id: 'anticipated', title: formatDiscoveryCatalogTitle('Anticipated TV', discoveryContentMode), type: 'series', source: 'trakt', items, hideWatchedToggle: true }))
        ];
        const tasks: Array<Promise<void>> = [
          getTmdbMovies('trending').then((items) => publishCatalog({ id: 'trending', title: formatDiscoveryCatalogTitle('Trending Movies', discoveryContentMode), type: 'movie', source: 'tmdb', items })),
          getTmdbMovies('popular').then((items) => publishCatalog({ id: 'popular', title: formatDiscoveryCatalogTitle('Popular Movies', discoveryContentMode), type: 'movie', source: 'tmdb', items })),
          getTmdbTv('trending').then((items) => publishCatalog({ id: 'trending', title: formatDiscoveryCatalogTitle('Trending TV', discoveryContentMode), type: 'series', source: 'tmdb', items })),
          getTmdbTv('popular').then((items) => publishCatalog({ id: 'popular', title: formatDiscoveryCatalogTitle('Popular TV', discoveryContentMode), type: 'series', source: 'tmdb', items }))
        ];

        if (hasTrakt) {
          tasks.push(...createTraktTasks(initialTraktLimit));
        }

        await Promise.allSettled(tasks);
        if (hasTrakt && initialTraktLimit < 20 && !cancelled) {
          catalogExpansionTimer = window.setTimeout(() => {
            void Promise.allSettled(createTraktTasks(20));
          }, 1500);
        }
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
      if (catalogExpansionTimer !== undefined) window.clearTimeout(catalogExpansionTimer);
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

    let cancelled = false;
    const refreshGeneration = ++continueRefreshGenerationRef.current;
    const isCurrentRefresh = () =>
      !cancelled && continueRefreshGenerationRef.current === refreshGeneration;

    const findNextAvailableEpisode = async (
      tmdbId: number,
      watchedEpisodeKeys: Set<string>
    ): Promise<{ season: number; episode: number } | null> => {
      if (!isCurrentRefresh()) {
        return null;
      }
      const seasons = await getTmdbSeasons(tmdbId);

      for (const season of seasons.sort((a, b) => a.season_number - b.season_number)) {
        if (!isCurrentRefresh()) {
          return null;
        }
        const episodes = await getTmdbEpisodes(tmdbId, season.season_number);
        const nextEpisode = episodes
          .filter(isAvailableEpisode)
          .sort((a, b) => a.episode_number - b.episode_number)
          .find((episode) => !watchedEpisodeKeys.has(getEpisodeKey(tmdbId, season.season_number, episode.episode_number)));

        if (nextEpisode) {
          return {
            season: season.season_number,
            episode: nextEpisode.episode_number
          };
        }
      }

      return null;
    };

    const refreshBoardContinueWatching = async () => {
      const watchedEpisodeKeys = new Set<string>();
      const watchedShows = new Map<number, {
        tmdbId: number;
        lastWatchedAt: string;
        lastWatchedTime: number;
        latestSeason: number;
        latestEpisode: number;
      }>();
      const watchedMovieIds = new Set(watched.filter((item) => item.type === 'movie').map((item) => item.id));

      for (const [key, value] of Object.entries(watchedEpisodes)) {
        const parsed = parseWatchedEpisodeKey(key);
        if (!parsed) {
          continue;
        }

        const watchedTime = parseTimestamp(value);
        const watchedAt = typeof value === 'string' && value ? value : new Date(0).toISOString();
        watchedEpisodeKeys.add(getEpisodeKey(parsed.tmdbId, parsed.season, parsed.episode));

        const current = watchedShows.get(parsed.tmdbId);
        const isLaterEpisodeAtSameTime = !!current &&
          watchedTime === current.lastWatchedTime &&
          (
            parsed.season > current.latestSeason ||
            (parsed.season === current.latestSeason && parsed.episode > current.latestEpisode)
          );
        if (!current || watchedTime > current.lastWatchedTime || isLaterEpisodeAtSameTime) {
          watchedShows.set(parsed.tmdbId, {
            tmdbId: parsed.tmdbId,
            lastWatchedAt: watchedAt,
            lastWatchedTime: watchedTime,
            latestSeason: parsed.season,
            latestEpisode: parsed.episode
          });
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
        meta: MetaPreview | undefined;
      }> = [];
      let nextCandidateIndex = 0;
      const workerCount = Math.min(4, upNextCandidates.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (isCurrentRefresh() && nextCandidateIndex < upNextCandidates.length) {
          const show = upNextCandidates[nextCandidateIndex++];
          const [nextEpisode, enriched] = await Promise.all([
            findNextAvailableEpisode(show.tmdbId, watchedEpisodeKeys),
            enrichTmdbItemsById([{ tmdbId: show.tmdbId, mediaType: 'tv' as const }])
          ]);
          resolvedEpisodes.push({
            show,
            nextEpisode,
            meta: enriched[0]
          });
        }
      });
      await Promise.all(workers);
      const upNextItems: ContinueWatchingViewItem[] = [];

      for (const { show, nextEpisode, meta } of resolvedEpisodes) {
        if (!nextEpisode) {
          continue;
        }

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
      }
    };

    const refreshTimeout = window.setTimeout(() => {
      refreshBoardContinueWatching().catch((error) => {
        console.error('Failed to refresh board Continue Watching:', error);
      });
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimeout);
    };
  }, [continueWatching, loading, setContinueWatchingView, watched, watchedEpisodes]);

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
          <div className="board-grid">
            {sortedContinueWatching.slice(0, 6).map((item) => (
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
          {sortedContinueWatching.length > 6 && (
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

      {catalogs.map((catalog) => (
        <section key={catalog.source + catalog.id + catalog.type} className="board-section">
          <div className="board-section-header">
            <div>
              <span className="board-section-kicker">{catalog.type === 'movie' ? 'Movies' : 'Series'}</span>
              <h2>{catalog.title}</h2>
            </div>
          </div>
          <div className="board-grid">
            {catalog.items.slice(0, itemsPerRow * 2).map((item) => (
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
