import React, { useEffect, useLayoutEffect, useState, useMemo, useRef, useCallback } from 'react';
import { FiPlay, FiHeart, FiCheck, FiArrowLeft, FiDownload, FiExternalLink, FiArrowUp, FiArrowDown, FiFilm, FiTv, FiCircle, FiRefreshCw, FiFolder, FiFile, FiThumbsUp, FiThumbsDown, FiChevronRight, FiMoreHorizontal } from 'react-icons/fi';
import { CastMember, MetaDetails as MetaDetailsType, MetaPreview, useStore, TorrentResult, LocalVideoFile } from '../../store';
import { getTmdbTitleBundle, getTrailerSources, getTmdbSeasons, getTmdbEpisodes, getTmdbPersonCredits, getTmdbWatchRegion, Season, EpisodeDetail, type TmdbPersonCreditPreview, type TmdbWatchProvider, type TrailerSource } from '../../services/tmdb';
import { getOmdbRating } from '../../services/omdb';
import { selectAddonResumeResult } from '../../services/addon-source-search';
import { deduplicateResults, searchEnabledSourceProviders } from '../../services/source-search';
import { getEnabledStreamAddons } from '../../services/installed-addons';
import { getRelatedRecommendations, getTraktSentiments, hasTraktCredentials, type TraktSentiments } from '../../services/trakt';
import { pushEpisodeWatchedToTrakt, pushEpisodeUnwatchedToTrakt, pushSeasonWatchedToTrakt, pushUnwatchedToTrakt, pushWatchedToTrakt, pushWatchlistToTrakt } from '../../services/trakt-sync';
import { sortEpisodes } from '../../services/torrent-utils';
import { createPerformanceTrace } from '../../services/performance';
import { ensureXrelQualityForItem } from '../../services/xrel';
import XrelQualityBadge from '../../components/XrelQualityBadge';
import './MetaDetails.css';

type SortBy = 'seeds' | 'size' | 'quality';
type SortOrder = 'desc' | 'asc';
type ActorCreditFilter = 'all' | 'movie' | 'series';
const TORRENT_PAGE_SIZE = 20;
const WATCH_PROVIDER_DISPLAY_LIMIT = 12;
const TORRENT_ACTION_STATE_STORAGE_KEY = 'streamee-torrent-action-state';
const CAST_CARD_MIN_WIDTH = 170;
const CAST_CARD_GAP = 8;
const CAST_MAX_COLUMNS = 6;

type YouTubePlayer = {
  destroy: () => void;
};

type YouTubeApi = {
  Player: new (
    elementId: string,
    options: {
      videoId: string;
      playerVars?: Record<string, number | string>;
      events?: {
        onError?: (event: { data: number }) => void;
      };
    }
  ) => YouTubePlayer;
};

let youtubeIframeApiPromise: Promise<YouTubeApi> | null = null;

function loadYouTubeIframeApi(): Promise<YouTubeApi> {
  const existingApi = (window as unknown as { YT?: YouTubeApi }).YT;
  if (existingApi?.Player) return Promise.resolve(existingApi);

  if (!youtubeIframeApiPromise) {
    youtubeIframeApiPromise = new Promise((resolve) => {
      const windowWithYouTube = window as unknown as {
        YT?: YouTubeApi;
        onYouTubeIframeAPIReady?: () => void;
      };
      const previousReady = windowWithYouTube.onYouTubeIframeAPIReady;

      windowWithYouTube.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        if (windowWithYouTube.YT?.Player) {
          resolve(windowWithYouTube.YT);
        }
      };

      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        document.body.appendChild(script);
      }
    });
  }

  return youtubeIframeApiPromise;
}
type LastSourceMeta = {
  sourceType: 'webtorrent' | 'qbittorrent' | 'addon' | 'local';
  sourceUrl?: string;
  preferredSeason?: number;
  preferredEpisode?: number;
  progress?: number;
  playbackTime?: number;
  duration?: number;
  sourceFilename?: string;
  addonImdbId?: string;
  directStreamProvider?: 'addon';
  addonInfoHash?: string;
  addonFileIndex?: number;
  addonIndexer?: string;
  addonSize?: number;
  addonQuality?: TorrentResult['quality'];
  localFiles?: LocalVideoFile[];
  localSourceKind?: 'files' | 'folder';
};

type EpisodeTarget = {
  season: number;
  episode: number;
};

const formatReleaseDate = (dateStr?: string): string => {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
};

const getStoredSortPreferences = (): { sortBy: SortBy; sortOrder: SortOrder } => {
  try {
    const stored = localStorage.getItem('streamee-sort');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.sortBy && parsed.sortOrder) {
        return parsed;
      }
    }
  } catch {}
  return { sortBy: 'seeds', sortOrder: 'desc' };
};

interface Props {
  meta: MetaDetailsType;
}

const MetaDetails: React.FC<Props> = ({ meta }) => {
  const [details, setDetails] = useState<MetaDetailsType | null>(meta);
  const [trailerSources, setTrailerSources] = useState<TrailerSource[]>([]);
  const [activeTrailerIndex, setActiveTrailerIndex] = useState(0);
  const [trailerError, setTrailerError] = useState<string | null>(null);
  const [showTrailer, setShowTrailer] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [torrents, setTorrents] = useState<TorrentResult[]>([]);
  const [torrentsLoading, setTorrentsLoading] = useState(false);
  const [searchingAddonInstallationId, setSearchingAddonInstallationId] = useState<string | null>(null);
  const [torrentsError, setTorrentsError] = useState<string | null>(null);
  const [showTorrents, setShowTorrents] = useState(false);
  const [watchProviders, setWatchProviders] = useState<TmdbWatchProvider[]>([]);
  const [watchProvidersLoading, setWatchProvidersLoading] = useState(false);
  const [visibleTorrentCount, setVisibleTorrentCount] = useState(TORRENT_PAGE_SIZE);
  const [selectedIndexer, setSelectedIndexer] = useState('all');
  const stored = getStoredSortPreferences();
  const [sortBy, setSortBy] = useState<SortBy>(stored.sortBy);
  const [sortOrder, setSortOrder] = useState<SortOrder>(stored.sortOrder);
  const [hideDuplicates, setHideDuplicates] = useState(() => localStorage.getItem('streamee-hide-duplicates') !== 'false');
  const [recommendations, setRecommendations] = useState<MetaPreview[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [recommendationDebugState, setRecommendationDebugState] = useState<'idle' | 'loading' | 'empty' | 'ready' | 'error'>('idle');
  const [recommendationPage, setRecommendationPage] = useState(1);
  const [recommendationsHasMore, setRecommendationsHasMore] = useState(false);
  const [recommendationsLoadingMore, setRecommendationsLoadingMore] = useState(false);
  const recommendationRequestIdRef = useRef(0);
  const metaRequestIdRef = useRef(0);
  const continueRequestIdRef = useRef(0);
  const [sentiments, setSentiments] = useState<TraktSentiments | null>(null);
  const [sentimentsLoading, setSentimentsLoading] = useState(false);
  const [secondaryMetadataReady, setSecondaryMetadataReady] = useState(false);
  const [showAllCast, setShowAllCast] = useState(false);
  const [castBatchCount, setCastBatchCount] = useState(1);
  const [visibleCastCount, setVisibleCastCount] = useState(CAST_MAX_COLUMNS);
  const castRowRef = useRef<HTMLDivElement | null>(null);
  const [selectedActor, setSelectedActor] = useState<CastMember | null>(null);
  const [actorCredits, setActorCredits] = useState<TmdbPersonCreditPreview[]>([]);
  const [actorCreditsLoading, setActorCreditsLoading] = useState(false);
  const [actorCreditsError, setActorCreditsError] = useState<string | null>(null);
  const [actorCreditFilter, setActorCreditFilter] = useState<ActorCreditFilter>('all');
  const [metaBackStack, setMetaBackStack] = useState<MetaDetailsType[]>([]);
  const [showLocalSourceMenu, setShowLocalSourceMenu] = useState(false);
  const [localSourceError, setLocalSourceError] = useState<string | null>(null);
  const [openTorrentMenuId, setOpenTorrentMenuId] = useState<string | null>(null);
  
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<Season | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<EpisodeDetail | null>(null);
  const [seasonsLoading, setSeasonsLoading] = useState(false);
  const torrentSearchIdRef = useRef(0);
  const torrentSearchAbortRef = useRef<AbortController | null>(null);
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
  const actorRequestIdRef = useRef(0);

  const { watchlist, addToWatchlist, removeFromWatchlist, removeFromWatched, continueWatching, continueWatchingView, setSelectedStream, setSelectedMeta, watchedEpisodes, markEpisodeWatched, markEpisodeUnwatched, markSeasonWatched, watched, traktConnected } = useStore();
  const trailer = trailerSources[activeTrailerIndex] ?? null;
  const filteredActorCredits = useMemo(
    () => actorCreditFilter === 'all'
      ? actorCredits
      : actorCredits.filter((credit) => credit.type === actorCreditFilter),
    [actorCreditFilter, actorCredits]
  );
  const actorMovieCount = useMemo(
    () => actorCredits.filter((credit) => credit.type === 'movie').length,
    [actorCredits]
  );
  const actorSeriesCount = actorCredits.length - actorMovieCount;

  const tmdbId = meta.id.split(':')[1];
  const isTvShow = meta.type === 'series';
  const watchRegion = getTmdbWatchRegion();
  const continueWatchingMetaId = isTvShow ? `tv:${tmdbId}` : meta.id;
  const continueWatchingItem = useMemo(
    () =>
      continueWatching.find(
        (item) => item.metaId === meta.id || item.metaId === continueWatchingMetaId
      ) || null,
    [continueWatching, continueWatchingMetaId, meta.id]
  );
  const continueWatchingViewItem = useMemo(
    () =>
      continueWatchingView.find(
        (item) => item.metaId === meta.id || item.metaId === continueWatchingMetaId
      ) || null,
    [continueWatchingMetaId, continueWatchingView, meta.id]
  );
  const getLastSourceKey = () => `${meta.type}-${tmdbId}`;
  const getDefaultSourceMeta = (sourceUrl?: string): LastSourceMeta => ({
    sourceType: sourceUrl && !sourceUrl.startsWith('magnet:?') ? 'qbittorrent' : 'webtorrent',
    sourceUrl,
  });
  const getLastSourceMeta = (sourceUrl?: string): LastSourceMeta => {
    const sourceMeta = JSON.parse(localStorage.getItem('streamee-last-source-meta') || '{}');
    const storedMeta = sourceMeta[getLastSourceKey()] as LastSourceMeta | undefined;

    if (!storedMeta) {
      return getDefaultSourceMeta(sourceUrl);
    }

    if (sourceUrl && storedMeta.sourceUrl && storedMeta.sourceUrl !== sourceUrl) {
      return getDefaultSourceMeta(sourceUrl);
    }

    return { ...storedMeta, sourceUrl: storedMeta.sourceUrl ?? sourceUrl };
  };
  const sortLocalFiles = (files: LocalVideoFile[]) => {
    const remaining = [...files];
    return sortEpisodes(files.map((file) => file.name))
      .map((name) => {
        const index = remaining.findIndex((file) => file.name === name);
        return index === -1 ? null : remaining.splice(index, 1)[0];
      })
      .filter((file): file is LocalVideoFile => Boolean(file));
  };
  const rememberLastSource = (sourceUrl: string, sourceMeta: Omit<LastSourceMeta, 'sourceUrl'>) => {
    const key = getLastSourceKey();
    const lastSourceMeta = JSON.parse(localStorage.getItem('streamee-last-source-meta') || '{}');
    const lastSources = JSON.parse(localStorage.getItem('streamee-last-sources') || '{}');
    lastSources[key] = sourceUrl;
    lastSourceMeta[key] = {
      ...sourceMeta,
      sourceUrl,
    } satisfies LastSourceMeta;
    localStorage.setItem('streamee-last-sources', JSON.stringify(lastSources));
    localStorage.setItem('streamee-last-source-meta', JSON.stringify(lastSourceMeta));
  };
  const [pressedTorrentActions, setPressedTorrentActions] = useState<Record<string, string[]>>({});
  const getTorrentActionKey = (torrent: TorrentResult) =>
    torrent.infoHash || torrent.id || torrent.magnetUri || torrent.title;
  const loadTorrentActionState = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(TORRENT_ACTION_STATE_STORAGE_KEY) || '{}');
      return stored[getLastSourceKey()] || {};
    } catch {
      return {};
    }
  };
  const markTorrentActionPressed = (torrent: TorrentResult, action: string) => {
    const torrentKey = getTorrentActionKey(torrent);
    setPressedTorrentActions((current) => {
      const nextActions = Array.from(new Set([...(current[torrentKey] || []), action]));
      const next = { ...current, [torrentKey]: nextActions };

      try {
        const stored = JSON.parse(localStorage.getItem(TORRENT_ACTION_STATE_STORAGE_KEY) || '{}');
        stored[getLastSourceKey()] = next;
        localStorage.setItem(TORRENT_ACTION_STATE_STORAGE_KEY, JSON.stringify(stored));
      } catch (error) {
        console.warn('Failed to save source action state:', error);
      }

      return next;
    });
  };
  const wasTorrentActionPressed = (torrent: TorrentResult, action: string) =>
    (pressedTorrentActions[getTorrentActionKey(torrent)] || []).includes(action);

  useEffect(() => {
    setPressedTorrentActions(loadTorrentActionState());
  }, [meta.type, tmdbId]);

  useEffect(() => {
    if (!secondaryMetadataReady && !details?.imdbId && !meta.imdbId) return;
    void ensureXrelQualityForItem({
      id: meta.id,
      type: meta.type,
      name: details?.name ?? meta.name,
      year: details?.year ?? meta.year,
      imdbId: details?.imdbId ?? meta.imdbId,
      originalName: meta.originalName,
      aliases: meta.aliases,
    });
  }, [details?.imdbId, details?.name, details?.year, meta.aliases, meta.id, meta.imdbId, meta.name, meta.originalName, meta.type, meta.year, secondaryMetadataReady]);

  const latestWatchedEpisode = useMemo(() => {
    if (!isTvShow) {
      return null;
    }

    let latest: { season: number; episode: number; watchedAt: string } | null = null;

    for (const [key, value] of Object.entries(watchedEpisodes)) {
      if (!key.startsWith(`${tmdbId}:`)) {
        continue;
      }

      const [, seasonPart, episodePart] = key.split(':');
      const season = Number(seasonPart);
      const episode = Number(episodePart);
      const watchedAt = typeof value === 'string' ? value : '';

      if (!Number.isFinite(season) || !Number.isFinite(episode) || !watchedAt) {
        continue;
      }

      if (!latest || watchedAt > latest.watchedAt) {
        latest = { season, episode, watchedAt };
      }
    }

    return latest;
  }, [isTvShow, tmdbId, watchedEpisodes]);
  const resumeTarget = useMemo(() => {
    if (!isTvShow) {
      return null;
    }

    const lastSourceMeta = getLastSourceMeta();

    if (
      typeof continueWatchingItem?.season === 'number' &&
      typeof continueWatchingItem?.episode === 'number'
    ) {
      return {
        season: continueWatchingItem.season,
        episode: continueWatchingItem.episode,
      };
    }

    if (
      typeof continueWatchingViewItem?.season === 'number' &&
      typeof continueWatchingViewItem?.episode === 'number'
    ) {
      return {
        season: continueWatchingViewItem.season,
        episode: continueWatchingViewItem.episode,
      };
    }

    if (
      typeof lastSourceMeta.preferredSeason === 'number' &&
      typeof lastSourceMeta.preferredEpisode === 'number'
    ) {
      return {
        season: lastSourceMeta.preferredSeason,
        episode: lastSourceMeta.preferredEpisode,
      };
    }

    if (latestWatchedEpisode) {
      return {
        season: latestWatchedEpisode.season,
        episode: latestWatchedEpisode.episode,
      };
    }

    return null;
  }, [continueWatchingItem, continueWatchingViewItem, isTvShow, latestWatchedEpisode, meta.type, tmdbId]);
  const hasResumeState = !!continueWatchingItem || !!resumeTarget;
  const continueActionLabel = useMemo(() => {
    if (isTvShow && resumeTarget) {
      return `Continue S${resumeTarget.season} E${resumeTarget.episode}`;
    }

    return 'Continue';
  }, [isTvShow, resumeTarget]);

  const handleBack = () => {
    setShowTorrents(false);
    const previousMeta = metaBackStack[metaBackStack.length - 1];
    if (previousMeta) {
      setMetaBackStack((stack) => stack.slice(0, -1));
      useStore.setState({ selectedMeta: previousMeta, view: 'meta' });
      return;
    }

    setSelectedMeta(null);
  };

  const getCurrentMetaSnapshot = (): MetaDetailsType => ({
    ...meta,
    ...details,
    id: meta.id,
    type: meta.type,
    name: details?.name || meta.name,
    poster: details?.poster || meta.poster,
    background: details?.background || meta.background,
    year: details?.year || meta.year,
    imdbId: details?.imdbId || meta.imdbId,
    rating: details?.tmdbRating ?? details?.rating ?? meta.rating
  });

  const navigateToMetaFromCurrent = (nextMeta: MetaDetailsType) => {
    setMetaBackStack((stack) => [...stack, getCurrentMetaSnapshot()]);
    useStore.setState({ selectedMeta: nextMeta, view: 'meta' });
  };

  const [episodesBySeason, setEpisodesBySeason] = useState<Record<number, EpisodeDetail[]>>({});

  const visibleSeasons = useMemo(
    () => seasons.filter((season) => season.season_number > 0),
    [seasons]
  );

  const getPreferredEpisodeForSeason = (season: Season, episodes: EpisodeDetail[]) => {
    const nextUnwatched = episodes.find((episode) => !isEpisodeWatched(episode.episode_number, season.season_number));
    return nextUnwatched || episodes[0] || null;
  };

  const handleSeasonSelect = async (season: Season) => {
    setSelectedSeason(season);
    setShowTorrents(false);
    setTorrents([]);
    setVisibleTorrentCount(TORRENT_PAGE_SIZE);
    setSelectedIndexer('all');

    let episodes = episodesBySeason[season.season_number];
    if (!episodes) {
      episodes = await getTmdbEpisodes(parseInt(tmdbId, 10), season.season_number);
      setEpisodesBySeason((prev) => ({ ...prev, [season.season_number]: episodes }));
    }

    setSelectedEpisode((prev) => {
      if (prev && prev.season_number === season.season_number) {
        return prev;
      }

      return getPreferredEpisodeForSeason(season, episodes);
    });
  };

  const handleEpisodeClick = (episode: EpisodeDetail, season: Season) => {
    setSelectedEpisode(episode);
    setSelectedSeason(season);
    setShowTorrents(false);
    setTorrents([]);
    setVisibleTorrentCount(TORRENT_PAGE_SIZE);
    setSelectedIndexer('all');
  };

  const handleActorClick = async (member: CastMember) => {
    const requestId = ++actorRequestIdRef.current;
    setSelectedActor(member);
    setActorCredits([]);
    setActorCreditsError(null);
    setActorCreditFilter('all');
    setActorCreditsLoading(true);

    try {
      const credits = await getTmdbPersonCredits(member.id);
      if (requestId !== actorRequestIdRef.current) return;
      setActorCredits(credits);
      if (credits.length === 0) {
        setActorCreditsError(`No movie or TV credits found for ${member.name}.`);
      }
    } catch (error) {
      if (requestId !== actorRequestIdRef.current) return;
      console.error('Failed to load actor credits:', error);
      setActorCreditsError(`Could not load credits for ${member.name}.`);
    } finally {
      if (requestId === actorRequestIdRef.current) {
        setActorCreditsLoading(false);
      }
    }
  };

  const handleActorCreditClick = (credit: TmdbPersonCreditPreview) => {
    navigateToMetaFromCurrent({
      ...credit,
      type: credit.type
    });
  };

  const isEpisodeWatched = (episodeNumber: number, seasonNumber: number) => {
    return !!watchedEpisodes[`${tmdbId}:${seasonNumber}:${episodeNumber}`];
  };

  const toggleEpisodeWatched = (e: React.MouseEvent, episode: EpisodeDetail) => {
    e.stopPropagation();
    if (isEpisodeWatched(episode.episode_number, episode.season_number)) {
      markEpisodeUnwatched(tmdbId, episode.season_number, episode.episode_number);
      if (traktConnected) {
        pushEpisodeUnwatchedToTrakt(tmdbId, episode.season_number, episode.episode_number);
      }
    } else {
      markEpisodeWatched(tmdbId, episode.season_number, episode.episode_number);
      if (traktConnected) {
        pushEpisodeWatchedToTrakt(tmdbId, episode.season_number, episode.episode_number);
      }
    }
  };

  const handleMarkSeasonWatched = async (e: React.MouseEvent, season: Season) => {
    e.stopPropagation();
    let episodes = episodesBySeason[season.season_number];
    if (!episodes) {
      episodes = await getTmdbEpisodes(parseInt(tmdbId), season.season_number);
      setEpisodesBySeason(prev => ({ ...prev, [season.season_number]: episodes }));
    }
    const episodeNumbers = episodes.map(ep => ep.episode_number);
    const allWatched = episodeNumbers.every(ep => isEpisodeWatched(ep, season.season_number));

    if (allWatched) {
      // Unmark all
      const { markSeasonUnwatched } = useStore.getState();
      markSeasonUnwatched(tmdbId, season.season_number, episodeNumbers);
      if (traktConnected) {
        await Promise.all(episodeNumbers.map((episodeNumber) =>
          pushEpisodeUnwatchedToTrakt(tmdbId, season.season_number, episodeNumber)
        ));
      }
    } else {
      // Mark all watched
      markSeasonWatched(tmdbId, season.season_number, episodeNumbers);
      if (traktConnected) {
        pushSeasonWatchedToTrakt(tmdbId, season.season_number, episodeNumbers);
      }
    }
  };

  const getSeasonWatchedCount = (seasonNumber: number): number => {
    let count = 0;
    for (const key of Object.keys(watchedEpisodes)) {
      if (key.startsWith(`${tmdbId}:${seasonNumber}:`)) count++;
    }
    return count;
  };

  const formatRelativeTime = (dateStr: string): string => {
    const now = Date.now();
    const date = new Date(dateStr).getTime();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    if (weeks < 5) return `${weeks}w ago`;
    return `${months}mo ago`;
  };

  const lastWatchedDisplay = useMemo(() => {
    if (isTvShow) {
      let latest: string | null = null;
      for (const [key, value] of Object.entries(watchedEpisodes)) {
        if (key.startsWith(`${tmdbId}:`)) {
          const ts = typeof value === 'string' ? value : null;
          if (ts && (!latest || ts > latest)) latest = ts;
        }
      }
      return latest ? formatRelativeTime(latest) : null;
    } else {
      const watchedMeta = watched.find(w => w.id === meta.id);
      return watchedMeta?.watchedAt ? formatRelativeTime(watchedMeta.watchedAt) : null;
    }
  }, [watchedEpisodes, watched, tmdbId, isTvShow, meta.id]);

  const getQualityValue = (quality: string): number => {
    if (quality === '4K') return 4;
    if (quality === '1080p') return 3;
    if (quality === '720p') return 2;
    if (quality === '480p') return 1;
    return 0;
  };

  const indexerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const torrent of torrents) {
      const indexer = torrent.indexer || 'Unknown';
      counts.set(indexer, (counts.get(indexer) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [torrents]);

  const scopedTorrents = useMemo(() => {
    if (selectedIndexer === 'all') {
      return torrents;
    }

    return torrents.filter((torrent) => (torrent.indexer || 'Unknown') === selectedIndexer);
  }, [torrents, selectedIndexer]);

  const displayTorrents = useMemo(
    () => (hideDuplicates ? deduplicateResults(scopedTorrents) : scopedTorrents),
    [hideDuplicates, scopedTorrents]
  );

  const sortedTorrents = React.useMemo(() => {
    return [...displayTorrents].sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'seeds') {
        comparison = a.seeds - b.seeds;
      } else if (sortBy === 'size') {
        comparison = a.size - b.size;
      } else if (sortBy === 'quality') {
        comparison = getQualityValue(a.quality) - getQualityValue(b.quality);
        if (comparison === 0) comparison = a.size - b.size;
        if (comparison === 0) comparison = a.peers - b.peers;
      }
      return sortOrder === 'desc' ? -comparison : comparison;
    });
  }, [displayTorrents, sortBy, sortOrder]);

  const visibleTorrents = useMemo(
    () => sortedTorrents.slice(0, visibleTorrentCount),
    [sortedTorrents, visibleTorrentCount]
  );
  const hasMoreTorrents = visibleTorrents.length < sortedTorrents.length;
  const torrentCountLabel = selectedIndexer !== 'all'
    ? hideDuplicates && scopedTorrents.length !== sortedTorrents.length
      ? `${sortedTorrents.length} of ${scopedTorrents.length}`
      : `${sortedTorrents.length}`
    : hideDuplicates && torrents.length !== displayTorrents.length
      ? `${displayTorrents.length} of ${torrents.length}`
      : `${displayTorrents.length}`;

  const isInWatchlist = watchlist.some((m) => m.id === meta.id);
  const isMarkedWatched = watched.some((m) => m.id === meta.id);

  const showRecommendationsSection =
    recommendationsLoading || recommendations.length > 0 || recommendationDebugState === 'empty' || recommendationDebugState === 'error';

  const getSentimentWeight = (item: { comment_ids?: number[] | null }) => item.comment_ids?.length ?? 0;
  const goodSentiments = useMemo(
    () =>
      [...(sentiments?.good ?? [])]
        .sort((a, b) => getSentimentWeight(b) - getSentimentWeight(a) || a.sentiment.localeCompare(b.sentiment))
        .slice(0, 4),
    [sentiments?.good]
  );
  const badSentiments = useMemo(
    () =>
      [...(sentiments?.bad ?? [])]
        .sort((a, b) => getSentimentWeight(b) - getSentimentWeight(a) || a.sentiment.localeCompare(b.sentiment))
        .slice(0, 4),
    [sentiments?.bad]
  );
  const showSentimentSection =
    sentimentsLoading || goodSentiments.length > 0 || badSentiments.length > 0;

  const detailTitle = details?.name || meta.name;
  const releaseYear = useMemo(() => {
    if (details?.releaseDate) {
      const year = new Date(details.releaseDate).getFullYear();
      return Number.isNaN(year) ? details.year : String(year);
    }

    return details?.year ? String(details.year) : null;
  }, [details?.releaseDate, details?.year]);

  const releaseDisplay = details?.releaseDate ? formatReleaseDate(details.releaseDate) : releaseYear;

  const heroMetaItems = useMemo(
    () =>
      [
        releaseDisplay,
        details?.runtime,
        details?.genre?.[0],
        lastWatchedDisplay ? `Last watched ${lastWatchedDisplay}` : null
      ].filter(Boolean) as string[],
    [details?.genre, details?.runtime, lastWatchedDisplay, releaseDisplay]
  );

  const activeSearchLabel = useMemo(() => {
    if (!isTvShow) {
      return releaseYear ? `${detailTitle} ${releaseYear}` : detailTitle;
    }

    if (selectedEpisode) {
      return `${detailTitle} S${selectedEpisode.season_number.toString().padStart(2, '0')}E${selectedEpisode.episode_number.toString().padStart(2, '0')}`;
    }

    return `${detailTitle} Next episode`;
  }, [detailTitle, isTvShow, releaseYear, selectedEpisode]);
  const availableSearchAddons = useMemo(() => {
    const imdbId = details?.imdbId || meta.imdbId || '';
    if (!/^tt\d+$/i.test(imdbId)) return [];

    const contentId = isTvShow
      ? selectedEpisode
        ? `${imdbId}:${selectedEpisode.season_number}:${selectedEpisode.episode_number}`
        : ''
      : imdbId;
    if (!contentId) return [];

    return getEnabledStreamAddons(isTvShow ? 'series' : 'movie', contentId);
  }, [details?.imdbId, isTvShow, meta.imdbId, selectedEpisode]);
  const activeSeason = selectedSeason ?? visibleSeasons[0] ?? null;
  const activeSeasonEpisodes = activeSeason ? episodesBySeason[activeSeason.season_number] || [] : [];
  const activeSeasonWatchedCount = activeSeason ? getSeasonWatchedCount(activeSeason.season_number) : 0;
  const isActiveSeasonFullyWatched = !!activeSeason && activeSeasonWatchedCount > 0 && activeSeasonWatchedCount >= activeSeason.episode_count;

  const handleLoadMoreRecommendations = async () => {
    if (recommendationsLoadingMore || !recommendationsHasMore) return;

    const tmdbIdNum = parseInt(tmdbId, 10);
    if (Number.isNaN(tmdbIdNum) || !hasTraktCredentials()) return;

    const requestId = recommendationRequestIdRef.current;
    const nextPage = recommendationPage + 1;
    setRecommendationsLoadingMore(true);

    try {
      const traktType = meta.type === 'movie' ? 'movie' : 'show';
      const result = await getRelatedRecommendations(traktType, tmdbIdNum, nextPage);
      if (requestId !== recommendationRequestIdRef.current) return;

      setRecommendations((current) => {
        const existingIds = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => item.id !== meta.id && !existingIds.has(item.id))];
      });
      setRecommendationPage(nextPage);
      setRecommendationsHasMore(result.hasMore);
    } catch (error) {
      console.error('Failed to load more recommendations:', error);
    } finally {
      if (requestId === recommendationRequestIdRef.current) {
        setRecommendationsLoadingMore(false);
      }
    }
  };

  const renderRecommendationsSection = () => (
    <section className="meta-recommendations">
      <div className="meta-recommendations-header">
        <div>
          <span className="meta-label">Recommendations</span>
          <h2>If you like {details?.name || meta.name}, you might like these too</h2>
        </div>
      </div>

      {recommendationsLoading ? (
        <div className="torrents-loading">
          <div className="loading-spinner" />
          <span>Finding recommendations...</span>
        </div>
      ) : recommendations.length === 0 ? (
        <div className="torrents-empty">
          {recommendationDebugState === 'empty'
            ? 'No related recommendations matched for this title.'
            : recommendationDebugState === 'error'
              ? 'Recommendations could not be loaded.'
              : 'No recommendations loaded yet.'}
        </div>
      ) : (
        <div className="meta-recommendations-grid">
          {recommendations.map((item) => {
            const isRecommendationInWatchlist = watchlist.some((entry) => entry.id === item.id);

            return (
              <div
                key={item.id}
                className="meta-recommendation-card board-item"
              >
                <div
                  className="meta-recommendation-poster board-item-poster"
                  onClick={() => handleRecommendationClick(item)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleRecommendationClick(item);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  {item.poster ? (
                    <img src={item.poster} alt={item.name} loading="lazy" decoding="async" />
                  ) : (
                    <div className="board-item-placeholder" />
                  )}
                  <XrelQualityBadge item={item} />
                  <div className="board-item-actions">
                    <button
                      type="button"
                      className={`board-item-action ${isRecommendationInWatchlist ? 'active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRecommendationWatchlistToggle(item);
                      }}
                      title={isRecommendationInWatchlist ? 'Remove from Watchlist' : 'Add to Watchlist'}
                    >
                      <FiHeart />
                    </button>
                  </div>
                  {item.rating !== undefined && item.rating > 0 && (
                    <div className="poster-rating-badge">★ {item.rating.toFixed(1)}</div>
                  )}
                </div>
                <span className="meta-recommendation-title board-item-title">{item.name}</span>
                {item.releaseDate && (
                  <span className="meta-recommendation-date board-item-year">{formatReleaseDate(item.releaseDate)}</span>
                )}
              </div>
            );
          })}
          {recommendationsHasMore && (
            <button
              type="button"
              className="meta-recommendations-load-more"
              onClick={() => void handleLoadMoreRecommendations()}
              disabled={recommendationsLoadingMore}
            >
              {recommendationsLoadingMore ? 'Loading...' : <>Load More <FiChevronRight /></>}
            </button>
          )}
        </div>
      )}
    </section>
  );

  useEffect(() => {
    localStorage.setItem('streamee-sort', JSON.stringify({ sortBy, sortOrder }));
  }, [sortBy, sortOrder]);

  useEffect(() => {
    localStorage.setItem('streamee-hide-duplicates', String(hideDuplicates));
  }, [hideDuplicates]);

  useEffect(() => {
    const castRow = castRowRef.current;
    if (!castRow) return;

    const updateVisibleCastCount = () => {
      const columns = Math.min(
        CAST_MAX_COLUMNS,
        Math.max(
          1,
          Math.floor((castRow.clientWidth + CAST_CARD_GAP) / (CAST_CARD_MIN_WIDTH + CAST_CARD_GAP))
        )
      );
      setVisibleCastCount(columns);
    };

    updateVisibleCastCount();
    const observer = new ResizeObserver(updateVisibleCastCount);
    observer.observe(castRow);
    return () => observer.disconnect();
  }, [details?.cast?.length]);

  useLayoutEffect(() => {
    setDetails(meta);
  }, [meta.id]);

  useEffect(() => {
    const container = document.querySelector('.main-content');
    if (!(container instanceof HTMLElement)) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({ top: 0, behavior: 'auto' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [meta.id]);

  useEffect(() => {
    if (!details?.background) return;
    const image = new Image();
    image.fetchPriority = 'high';
    image.decoding = 'async';
    image.src = details.background;
  }, [details?.background]);

  useEffect(() => {
    const requestId = ++metaRequestIdRef.current;
    let secondaryTimer: number | undefined;
    const performanceTrace = createPerformanceTrace(`MetaDetails ${meta.id}`);
    const initialPaintFrame = window.requestAnimationFrame(() => {
      if (requestId === metaRequestIdRef.current) performanceTrace.mark('shell painted');
    });
    const isCurrentRequest = () => requestId === metaRequestIdRef.current;
    const scheduleSecondaryMetadata = () => {
      secondaryTimer = window.setTimeout(() => {
        if (isCurrentRequest()) setSecondaryMetadataReady(true);
      }, 150);
    };

    const fetchDetails = async () => {
      const shouldLoadWatchProviders = availableSearchAddons.length === 0;
      setDetails(meta);
      setSecondaryMetadataReady(false);
      setTrailerSources([]);
      setActiveTrailerIndex(0);
      setTrailerError(null);
      setShowTrailer(false);
      setLogoUrl(null);
      setShowTorrents(false);
      setTorrents([]);
      setWatchProviders([]);
      setWatchProvidersLoading(shouldLoadWatchProviders);
      setSelectedIndexer('all');
      setSeasons([]);
      setSeasonsLoading(meta.type === 'series');
      setEpisodesBySeason({});
      setSelectedEpisode(null);
      setSelectedSeason(null);
      setRecommendations([]);
      setRecommendationPage(1);
      setRecommendationsHasMore(false);
      setRecommendationsLoadingMore(false);
      recommendationRequestIdRef.current += 1;
      setRecommendationDebugState('idle');
      setSentiments(null);
      setSentimentsLoading(false);
      setShowAllCast(false);
      setCastBatchCount(1);
      actorRequestIdRef.current += 1;
      setSelectedActor(null);
      setActorCredits([]);
      setActorCreditsLoading(false);
      setActorCreditsError(null);
      setActorCreditFilter('all');
      try {
        const type = meta.type;
        const tmdbIdNum = parseInt(tmdbId, 10);
        const initialResumeTarget = resumeTarget;
        const secondaryTasks: Array<Promise<unknown>> = [];

        const data = await getTmdbTitleBundle(type, tmdbIdNum, shouldLoadWatchProviders, watchRegion);
        if (!isCurrentRequest()) return;
        performanceTrace.mark('primary metadata ready');

        if (data?.meta) {
          setWatchProviders(data.watchProviders);
          setDetails({ ...meta, ...data.meta, id: meta.id, type: meta.type });
          useStore.setState((state) => ({
            selectedMeta: state.selectedMeta?.id === meta.id
              ? {
                  ...state.selectedMeta,
                  ...data.meta,
                  rating: data.meta.tmdbRating ?? state.selectedMeta.rating
                }
              : state.selectedMeta
          }));

          setLogoUrl(data.logoUrl);
          setTrailerSources(data.tmdbTrailerSources);

          if (data.meta.imdbId) {
            secondaryTasks.push(getOmdbRating(data.meta.imdbId).then((imdbRating) => {
              if (isCurrentRequest() && imdbRating) {
                setDetails(prev => prev ? { ...prev, imdbRating } : null);
              }
            }));
          }

          secondaryTasks.push(getTrailerSources(type, tmdbIdNum, data.tmdbTrailerSources).then((nextTrailerSources) => {
            if (isCurrentRequest()) setTrailerSources(nextTrailerSources);
          }));

          if (type === 'series') {
            const seasonsData = data.seasons.length > 0
              ? data.seasons
              : await getTmdbSeasons(tmdbIdNum);
            if (!isCurrentRequest()) return;

            const currentWatched = useStore.getState().watchedEpisodes;
            const watchedCountForSeason = (season: Season) => Object.keys(currentWatched)
              .filter((key) => key.startsWith(`${tmdbId}:${season.season_number}:`))
              .length;
            const preferredSeason = initialResumeTarget
              ? seasonsData.find((season) => season.season_number === initialResumeTarget.season)
              : seasonsData.find((season) => watchedCountForSeason(season) < season.episode_count);

            setSeasons(seasonsData);
            setSelectedSeason(preferredSeason || seasonsData[0] || null);
          }
        }
        setWatchProvidersLoading(false);
        setSeasonsLoading(false);
        scheduleSecondaryMetadata();
        void Promise.allSettled(secondaryTasks).then(() => {
          if (isCurrentRequest()) performanceTrace.finish('secondary metadata ready');
        });
      } catch (error) {
        console.error('Failed to fetch meta details:', error);
        if (isCurrentRequest()) {
          setWatchProvidersLoading(false);
          setSeasonsLoading(false);
          scheduleSecondaryMetadata();
          performanceTrace.finish('primary metadata failed');
        }
      }
    };

    void fetchDetails();
    return () => {
      window.cancelAnimationFrame(initialPaintFrame);
      if (secondaryTimer !== undefined) window.clearTimeout(secondaryTimer);
    };
  // Episode selection changes add-on availability for series. Keeping that
  // derived value out of this dependency list prevents the title reset above
  // from clearing the selected episode and immediately selecting it again.
  }, [meta.id, meta.type, tmdbId, watchRegion]);

  useEffect(() => {
    let cancelled = false;

    const fetchSentiments = async () => {
      const tmdbIdNum = parseInt(tmdbId, 10);
      if (!secondaryMetadataReady || !details?.name || Number.isNaN(tmdbIdNum) || !hasTraktCredentials()) {
        setSentiments(null);
        setSentimentsLoading(false);
        return;
      }

      setSentimentsLoading(true);

      try {
        const traktType = meta.type === 'movie' ? 'movie' : 'show';
        const data = await getTraktSentiments(traktType, tmdbIdNum);
        if (!cancelled) {
          setSentiments(data);
        }
      } catch (error) {
        console.error('Failed to fetch Trakt sentiments:', error);
        if (!cancelled) {
          setSentiments(null);
        }
      } finally {
        if (!cancelled) {
          setSentimentsLoading(false);
        }
      }
    };

    fetchSentiments();

    return () => {
      cancelled = true;
    };
  }, [details?.name, meta.type, secondaryMetadataReady, tmdbId]);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++recommendationRequestIdRef.current;

    const fetchRecommendations = async () => {
      if (!secondaryMetadataReady || !details?.name) {
        setRecommendations([]);
        setRecommendationPage(1);
        setRecommendationsHasMore(false);
        setRecommendationDebugState('idle');
        return;
      }

      const tmdbIdNum = parseInt(tmdbId, 10);
      const traktAvailable = hasTraktCredentials();
      console.log('[MetaDetails][Recommendations] Starting fetch', {
        title: details.name,
        type: meta.type,
        hasTraktCredentials: traktAvailable
      });
      setRecommendationDebugState('loading');
      setRecommendationsLoading(true);
      setRecommendationsLoadingMore(false);
      setRecommendationPage(1);
      setRecommendationsHasMore(false);

      try {
        const traktType = meta.type === 'movie' ? 'movie' : 'show';
        let items: MetaPreview[] = [];
        let hasMore = false;

        if (traktAvailable && !Number.isNaN(tmdbIdNum)) {
          const result = await getRelatedRecommendations(traktType, tmdbIdNum, 1);
          items = result.items;
          hasMore = result.hasMore;
          console.log('[MetaDetails][Recommendations] Trakt related items', {
            requestedTitle: details.name,
            totalMatched: items.length,
            matchedTitles: items.map((item) => item.name)
          });
        }

        if (!cancelled && requestId === recommendationRequestIdRef.current) {
          const filteredItems = items.filter((item) => item.id !== meta.id);
          console.log('[MetaDetails][Recommendations] After self-filter', {
            requestedTitle: details.name,
            before: items.length,
            after: filteredItems.length,
            titles: filteredItems.map((item) => item.name)
          });
          setRecommendations(filteredItems);
          setRecommendationsHasMore(hasMore);
          const filteredCount = filteredItems.length;
          if (filteredCount > 0) {
            setRecommendationDebugState('ready');
          } else {
            setRecommendationDebugState('empty');
          }
        }
      } catch (error) {
        console.error('Failed to fetch recommendations:', error);
        console.error('[MetaDetails][Recommendations] Fetch failed', {
          title: details.name,
          type: meta.type,
          error
        });
        if (!cancelled && requestId === recommendationRequestIdRef.current) {
          setRecommendations([]);
          setRecommendationsHasMore(false);
          setRecommendationDebugState('error');
        }
      } finally {
        if (!cancelled && requestId === recommendationRequestIdRef.current) {
          setRecommendationsLoading(false);
        }
      }
    };

    fetchRecommendations();

    return () => {
      cancelled = true;
    };
  }, [details?.name, meta.id, meta.type, secondaryMetadataReady, tmdbId]);

  useEffect(() => {
    if (!activeSeason || episodesBySeason[activeSeason.season_number]) {
      return;
    }

    let cancelled = false;

    const loadEpisodes = async () => {
      const episodes = await getTmdbEpisodes(parseInt(tmdbId, 10), activeSeason.season_number);
      if (cancelled) {
        return;
      }

      setEpisodesBySeason((prev) => ({ ...prev, [activeSeason.season_number]: episodes }));
      setSelectedEpisode((prev) => {
        if (prev && prev.season_number === activeSeason.season_number) {
          return prev;
        }

        if (resumeTarget?.season === activeSeason.season_number) {
          const resumeEpisode = episodes.find(
            (episode) => episode.episode_number === resumeTarget.episode
          );
          if (resumeEpisode) return resumeEpisode;
        }

        return getPreferredEpisodeForSeason(activeSeason, episodes);
      });
    };

    void loadEpisodes();

    return () => {
      cancelled = true;
    };
  }, [activeSeason, episodesBySeason, resumeTarget, tmdbId]);

  const openTrailerSource = useCallback((source: TrailerSource) => {
    if (source.embedUrl) {
      setTrailerError(null);
      setShowTrailer(true);
      return;
    }

    setShowTrailer(false);
    void window.electronAPI.openExternal(source.url);
  }, []);

  const handleTrailerUnavailable = useCallback((message: string) => {
    const nextIndex = trailerSources.findIndex((source, index) => index > activeTrailerIndex && source.url);
    if (nextIndex >= 0) {
      const nextSource = trailerSources[nextIndex];
      setActiveTrailerIndex(nextIndex);
      setTrailerError(message);
      openTrailerSource(nextSource);
      return;
    }

    setTrailerError('This trailer is not available here. Try opening it externally.');
  }, [activeTrailerIndex, openTrailerSource, trailerSources]);

  useEffect(() => {
    if (!showTrailer || !trailer?.embedUrl || trailer.provider !== 'YouTube') {
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      return;
    }

    let cancelled = false;

    loadYouTubeIframeApi().then((youtubeApi) => {
      if (cancelled) return;

      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = new youtubeApi.Player('trailer-youtube-player', {
        videoId: trailer.key,
        playerVars: {
          autoplay: 1,
          rel: 0,
          origin: window.location.origin
        },
        events: {
          onError: (event) => {
            const blockedErrorCodes = new Set([5, 100, 101, 150]);
            if (blockedErrorCodes.has(event.data)) {
              handleTrailerUnavailable('That YouTube embed is blocked. Trying another trailer source...');
            }
          }
        }
      });
    });

    return () => {
      cancelled = true;
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
    };
  }, [handleTrailerUnavailable, showTrailer, trailer]);

  useEffect(() => {
    if (secondaryMetadataReady && details) {
      const isTvShow = meta.type === 'series';
      if (isTvShow && !selectedEpisode) {
        return;
      }
      if (availableSearchAddons.length === 0) {
        torrentSearchAbortRef.current?.abort();
        setTorrents([]);
        setTorrentsError(null);
        setTorrentsLoading(false);
        setShowTorrents(true);
        return;
      }
      if (!showTorrents || torrents.length === 0) {
        handleSearchTorrents();
      }
    }
  }, [availableSearchAddons.length, details, secondaryMetadataReady, selectedEpisode, selectedSeason]);

  useEffect(() => () => {
    torrentSearchAbortRef.current?.abort();
  }, []);

  const handleSearchTorrents = async (onlyAddonInstallationId?: string) => {
    torrentSearchAbortRef.current?.abort();
    const searchController = new AbortController();
    torrentSearchAbortRef.current = searchController;
    const searchId = ++torrentSearchIdRef.current;
    const isCurrentSearch = () => torrentSearchIdRef.current === searchId && !searchController.signal.aborted;
    setTorrentsError(null);
    setTorrentsLoading(true);
    setSearchingAddonInstallationId(onlyAddonInstallationId || null);
    setShowTorrents(true);
    setVisibleTorrentCount(TORRENT_PAGE_SIZE);
    setSelectedIndexer('all');
    
    console.log('Searching for:', activeSearchLabel);
    
    try {
      const outcome = await searchEnabledSourceProviders({
        imdbId: details?.imdbId || meta.imdbId,
        isTvShow,
        season: selectedEpisode?.season_number ?? selectedSeason?.season_number,
        episode: selectedEpisode?.episode_number,
        onlyAddonInstallationId,
        signal: searchController.signal,
        onProgress: (progressiveOutcome) => {
          if (!isCurrentSearch()) return;
          setTorrents(progressiveOutcome.results);
        },
      });
      if (!isCurrentSearch()) return;

      const results = outcome.results;
      setTorrents(results);
      setTorrentsLoading(false);

      if (outcome.failedAddons.length > 0) {
        console.warn('[SourceSearch] Add-on fallbacks used after failures:', outcome.failedAddons);
      }
      if (results.length === 0) {
        setTorrentsError(isTvShow
          ? 'No streams found for this episode.'
          : 'No streams found for this title.');
        return;
      }

      console.log('Search results:', results.length, 'add-ons attempted:', outcome.attemptedAddons);
    } catch (error) {
      if (!isCurrentSearch()) return;
      console.error('Search failed:', error);
      setTorrentsError(error instanceof Error ? error.message : String(error));
      setTorrentsLoading(false);
    } finally {
      if (torrentSearchAbortRef.current === searchController) {
        torrentSearchAbortRef.current = null;
        setSearchingAddonInstallationId(null);
      }
    }
  };

  const handleStream = (
    torrent: TorrentResult,
    playbackTarget?: EpisodeTarget | null,
    resumeProgress?: number,
    resumePlaybackTime?: number,
    resumeDuration?: number,
    resumeSourceFilename?: string,
    startOver = false,
    sourceType: 'webtorrent' | 'qbittorrent' | 'addon' = 'webtorrent'
  ) => {
    const preferredSeason = isTvShow
      ? playbackTarget?.season ?? selectedSeason?.season_number
      : undefined;
    const preferredEpisode = isTvShow
      ? playbackTarget?.episode ?? selectedEpisode?.episode_number
      : undefined;

    useStore.setState((state) => ({
      selectedMeta: state.selectedMeta?.id === meta.id
        ? {
            ...state.selectedMeta,
            ...details,
            rating: details?.tmdbRating ?? details?.rating ?? state.selectedMeta.rating
          }
        : state.selectedMeta
    }));

    const sourceUrl = torrent.streamUrl || torrent.magnetUri;
    setSelectedStream({
      url: sourceUrl,
      title: torrent.title,
      torrent,
      sourceType,
      preferredSeason,
      preferredEpisode,
      resumeProgress,
      resumePlaybackTime,
      resumeDuration,
      resumeSourceFilename,
      startOver,
    });

    const directStreamProvider = torrent.directStreamProvider || 'addon';
    const directStreamIdentity = torrent.addonInstallationId || directStreamProvider;
    const sourceReference = sourceType === 'addon'
      ? `${directStreamIdentity}:${details?.imdbId || meta.imdbId || ''}:${preferredSeason ?? 0}:${preferredEpisode ?? 0}`
      : sourceUrl;
    rememberLastSource(sourceReference, {
      sourceType,
      preferredSeason,
      preferredEpisode,
      sourceFilename: torrent.streamFilename || resumeSourceFilename,
      ...(sourceType === 'addon'
        ? {
            addonImdbId: details?.imdbId || meta.imdbId,
            ...(torrent.addonInstallationId ? {} : { directStreamProvider }),
            addonInfoHash: torrent.infoHash || undefined,
            addonFileIndex: torrent.sourceFileIndex,
            addonIndexer: torrent.indexer,
            addonSize: torrent.size,
            addonQuality: torrent.quality,
          }
        : {}),
    });
  };

  const handleSendAndAutoplay = (torrent: TorrentResult) => {
    markTorrentActionPressed(torrent, 'send-and-autoplay');
    useStore.setState((state) => ({
      selectedMeta: state.selectedMeta?.id === meta.id
        ? {
            ...state.selectedMeta,
            ...details,
            rating: details?.tmdbRating ?? details?.rating ?? state.selectedMeta.rating
          }
        : state.selectedMeta
    }));

    setSelectedStream({
      url: torrent.magnetUri,
      title: torrent.title,
      torrent,
      sourceType: 'qbittorrent',
      preferredSeason: isTvShow ? selectedSeason?.season_number : undefined,
      preferredEpisode: isTvShow ? selectedEpisode?.episode_number : undefined,
    });

    rememberLastSource(torrent.magnetUri, {
      sourceType: 'qbittorrent',
      preferredSeason: isTvShow ? selectedSeason?.season_number : undefined,
      preferredEpisode: isTvShow ? selectedEpisode?.episode_number : undefined,
    });
  };

  const playLocalFiles = (
    files: LocalVideoFile[],
    sourceKind: 'files' | 'folder',
    playbackTarget?: EpisodeTarget | null,
    resumeProgress?: number,
    resumePlaybackTime?: number,
    resumeDuration?: number,
    resumeSourceFilename?: string,
    startOver = false
  ) => {
    const localFiles = sortLocalFiles(files);
    if (localFiles.length === 0) {
      setLocalSourceError('No video files were found in that local source.');
      return;
    }

    const preferredSeason = isTvShow
      ? playbackTarget?.season ?? selectedSeason?.season_number
      : undefined;
    const preferredEpisode = isTvShow
      ? playbackTarget?.episode ?? selectedEpisode?.episode_number
      : undefined;
    const sourceUrl = localFiles[0].path;
    const sourceTitle = localFiles.length > 1
      ? `${details?.name || meta.name} (${localFiles.length} local files)`
      : localFiles[0].name;
    const fakeTorrent: TorrentResult = {
      id: `local-${sourceUrl}`,
      title: sourceTitle,
      infoHash: '',
      magnetUri: sourceUrl,
      seeds: 0,
      peers: 0,
      size: localFiles.reduce((total, file) => total + file.size, 0),
      quality: 'unknown',
      indexer: 'Local',
    };

    useStore.setState((state) => ({
      selectedMeta: state.selectedMeta?.id === meta.id
        ? {
            ...state.selectedMeta,
            ...details,
            rating: details?.tmdbRating ?? details?.rating ?? state.selectedMeta.rating
          }
        : state.selectedMeta
    }));

    setLocalSourceError(null);
    setShowLocalSourceMenu(false);
    setSelectedStream({
      url: sourceUrl,
      title: sourceTitle,
      torrent: fakeTorrent,
      sourceType: 'local',
      preferredSeason,
      preferredEpisode,
      resumeProgress,
      resumePlaybackTime,
      resumeDuration,
      resumeSourceFilename,
      startOver,
      localFiles,
      localSourceKind: sourceKind,
    });

    rememberLastSource(sourceUrl, {
      sourceType: 'local',
      preferredSeason,
      preferredEpisode,
      sourceFilename: resumeSourceFilename,
      localFiles,
      localSourceKind: sourceKind,
    });
  };

  const handlePlayLocal = async (sourceKind: 'files' | 'folder') => {
    try {
      const files = sourceKind === 'folder'
        ? await window.electronAPI.selectLocalVideoFolder()
        : await window.electronAPI.selectLocalVideoFiles();
      if (!files) {
        return;
      }

      playLocalFiles(files, sourceKind);
    } catch (error) {
      console.error('Failed to select local source:', error);
      setLocalSourceError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSendToQbittorrent = async (torrent: TorrentResult) => {
    markTorrentActionPressed(torrent, 'send-to-qbittorrent');
    await window.electronAPI.sendToQbittorrent(torrent.magnetUri, torrent.infoHash || undefined);
  };

  const isMagnetSource = (torrent: TorrentResult) => torrent.magnetUri.startsWith('magnet:?');
  const isDirectStreamSource = (torrent: TorrentResult) =>
    !!(torrent.directStreamProvider || torrent.addonInstallationId)
    && !!(torrent.streamHandle || torrent.streamUrl);
  const getDirectStreamProviderLabel = (torrent: TorrentResult) => {
    if (torrent.addonName) return torrent.addonName;
    return 'configured add-on';
  };
  const handlePrimaryPlay = (torrent: TorrentResult) => {
    markTorrentActionPressed(torrent, 'stream');
    if (isDirectStreamSource(torrent)) {
      handleStream(torrent, null, undefined, undefined, undefined, undefined, false, 'addon');
      return;
    }
    const fallbackSource = isMagnetSource(torrent) ? 'webtorrent' : 'qbittorrent';
    handleStream(
      torrent,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      fallbackSource,
    );
  };
  const getPrimaryPlayTitle = (torrent: TorrentResult) => {
    if (isDirectStreamSource(torrent)) {
      return `Stream with ${getDirectStreamProviderLabel(torrent)}`;
    }
    return isMagnetSource(torrent)
        ? 'Stream in Streamee'
        : 'Stream with external playback service';
  };
  const getExternalSourceUrl = (torrent: TorrentResult) =>
    isMagnetSource(torrent) ? `vlc://${torrent.magnetUri}` : torrent.magnetUri;
  const getExternalSourceTitle = (torrent: TorrentResult) =>
    isMagnetSource(torrent) ? 'Open source in VLC' : 'Open source externally';
  const getSendSourceTitle = (torrent: TorrentResult) =>
    isMagnetSource(torrent) ? 'Send to external playback service' : 'Save source file';
  const getSendAndStreamTitle = (torrent: TorrentResult) =>
    isMagnetSource(torrent)
      ? 'Prepare externally and autoplay in Streamee'
      : 'Save source file and autoplay in Streamee';

  const getLastSource = (): string | null => {
    const lastSources = JSON.parse(localStorage.getItem('streamee-last-sources') || '{}');
    const key = getLastSourceKey();
    const lastSource = lastSources[key] || null;
    if (lastSource) return lastSource;

    const magnets = JSON.parse(localStorage.getItem('streamee-last-magnets') || '{}');
    const legacyMapValue = magnets[key] || null;
    if (legacyMapValue) {
      lastSources[key] = legacyMapValue;
      localStorage.setItem('streamee-last-sources', JSON.stringify(lastSources));
      return legacyMapValue;
    }

    // Legacy migration: check old per-item key
    const legacyKey = `streamee-last-magnet-${meta.type}-${tmdbId}`;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy) {
      lastSources[key] = legacy;
      localStorage.setItem('streamee-last-sources', JSON.stringify(lastSources));
      localStorage.removeItem(legacyKey);
      return legacy;
    }
    return null;
  };

  const handleContinue = async (forceStartOver = false) => {
    const continueRequestId = ++continueRequestIdRef.current;
    const lastSource = getLastSource();
    if (lastSource) {
      const lastSourceMeta = getLastSourceMeta(lastSource);
      const shouldUseLocal = lastSourceMeta.sourceType === 'local';
      const shouldUseAddon = lastSourceMeta.sourceType === 'addon';
      const shouldUseQbittorrent =
        lastSourceMeta.sourceType === 'qbittorrent' || (!shouldUseLocal && !shouldUseAddon && !lastSource.startsWith('magnet:?'));
      const continueEpisodeTarget =
        typeof continueWatchingItem?.season === 'number' &&
        typeof continueWatchingItem?.episode === 'number'
          ? {
              season: continueWatchingItem.season,
              episode: continueWatchingItem.episode,
            }
          : null;
      const viewEpisodeTarget =
        typeof continueWatchingViewItem?.season === 'number' &&
        typeof continueWatchingViewItem?.episode === 'number'
          ? {
              season: continueWatchingViewItem.season,
              episode: continueWatchingViewItem.episode,
            }
          : null;
      const storedEpisodeTarget =
        typeof lastSourceMeta.preferredSeason === 'number' &&
        typeof lastSourceMeta.preferredEpisode === 'number'
          ? {
              season: lastSourceMeta.preferredSeason,
              episode: lastSourceMeta.preferredEpisode,
            }
          : null;
      const lastKnownSeason =
        continueEpisodeTarget?.season ??
        viewEpisodeTarget?.season ??
        resumeTarget?.season ??
        storedEpisodeTarget?.season ??
        selectedSeason?.season_number;
      const startOverTarget = isTvShow && forceStartOver
        ? {
            season: lastKnownSeason ?? 1,
            episode: 1,
          }
        : null;
      const hasResumeTarget = !!continueEpisodeTarget || !!viewEpisodeTarget || !!storedEpisodeTarget || !!resumeTarget;
      const shouldStartFromBeginning = forceStartOver || (!continueWatchingItem && !hasResumeTarget);
      const playbackTarget = isTvShow
        ? startOverTarget ?? continueEpisodeTarget ?? viewEpisodeTarget ?? resumeTarget ?? storedEpisodeTarget
        : null;
      const resumeProgress =
        !shouldStartFromBeginning
          ? typeof continueWatchingItem?.progress === 'number' && continueWatchingItem.progress > 0
            ? continueWatchingItem.progress
            : typeof continueWatchingViewItem?.progress === 'number' && continueWatchingViewItem.progress > 0
              ? continueWatchingViewItem.progress
              : typeof lastSourceMeta.progress === 'number' && lastSourceMeta.progress > 0
                ? lastSourceMeta.progress
              : undefined
          : undefined;
      const resumePlaybackTime =
        !shouldStartFromBeginning
          ? typeof continueWatchingItem?.playbackTime === 'number' && continueWatchingItem.playbackTime > 0
            ? continueWatchingItem.playbackTime
            : typeof continueWatchingViewItem?.playbackTime === 'number' && continueWatchingViewItem.playbackTime > 0
              ? continueWatchingViewItem.playbackTime
              : typeof lastSourceMeta.playbackTime === 'number' && lastSourceMeta.playbackTime > 0
                ? lastSourceMeta.playbackTime
              : undefined
          : undefined;
      const resumeDuration =
        !shouldStartFromBeginning
          ? typeof continueWatchingItem?.duration === 'number' && continueWatchingItem.duration > 0
            ? continueWatchingItem.duration
            : typeof continueWatchingViewItem?.duration === 'number' && continueWatchingViewItem.duration > 0
              ? continueWatchingViewItem.duration
              : typeof lastSourceMeta.duration === 'number' && lastSourceMeta.duration > 0
                ? lastSourceMeta.duration
              : undefined
          : undefined;
      const resumeSourceFilename = !shouldStartFromBeginning
        ? continueWatchingItem?.sourceFilename ?? continueWatchingViewItem?.sourceFilename ?? lastSourceMeta.sourceFilename
        : undefined;

      if (shouldStartFromBeginning) {
        const updated = useStore.getState().continueWatching.filter(
          (c) => c.metaId !== meta.id && c.metaId !== continueWatchingMetaId
        );
        useStore.getState().setContinueWatching(updated);
        if (isMarkedWatched) {
          removeFromWatched(meta.id);
          if (traktConnected) {
            void pushUnwatchedToTrakt(meta);
          }
        }
      }

      if (shouldUseAddon) {
        try {
          const imdbId = lastSourceMeta.addonImdbId || details?.imdbId || meta.imdbId || '';
          const outcome = await searchEnabledSourceProviders({
            imdbId,
            isTvShow,
            season: playbackTarget?.season,
            episode: playbackTarget?.episode,
          });
          const results = outcome.results;
          const currentState = useStore.getState();
          if (
            continueRequestId !== continueRequestIdRef.current
            || currentState.selectedMeta?.id !== meta.id
            || currentState.view !== 'meta'
          ) {
            return;
          }
          const resolvedTorrent = selectAddonResumeResult(results, {
            infoHash: lastSourceMeta.addonInfoHash,
            fileIndex: lastSourceMeta.addonFileIndex,
            filename: lastSourceMeta.sourceFilename,
            size: lastSourceMeta.addonSize,
            indexer: lastSourceMeta.addonIndexer,
            quality: lastSourceMeta.addonQuality,
          });
          if (!resolvedTorrent) {
            throw new Error('No enabled source provider returned a playable stream for this title.');
          }
          const resumedSourceType = resolvedTorrent.streamHandle
            ? 'addon'
            : resolvedTorrent.magnetUri.startsWith('magnet:?')
                ? 'webtorrent'
                : 'qbittorrent';
          handleStream(
            resolvedTorrent,
            playbackTarget,
            resumeProgress,
            resumePlaybackTime,
            resumeDuration,
            resolvedTorrent.streamFilename || resumeSourceFilename,
            shouldStartFromBeginning,
            resumedSourceType,
          );
        } catch (error) {
          setShowTorrents(true);
          setTorrentsError(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      
      const fakeTorrent: TorrentResult = {
        id: 'continue',
        title: details?.name || meta.name || 'Unknown',
        infoHash: '',
        magnetUri: lastSource,
        seeds: 0,
        peers: 0,
        size: 0,
        quality: 'unknown',
        indexer: 'Last used',
      };

      if (shouldUseLocal) {
        const localFiles = sortLocalFiles(lastSourceMeta.localFiles || []);
        if (localFiles.length === 0) {
          setLocalSourceError('The last local source is no longer available. Choose Play Local again.');
          return;
        }

        playLocalFiles(
          localFiles,
          lastSourceMeta.localSourceKind || 'files',
          playbackTarget,
          resumeProgress,
          resumePlaybackTime,
          resumeDuration,
          resumeSourceFilename,
          shouldStartFromBeginning
        );
        return;
      }

      if (shouldUseQbittorrent) {
        useStore.setState((state) => ({
          selectedMeta: state.selectedMeta?.id === meta.id
            ? {
                ...state.selectedMeta,
                ...details,
                rating: details?.tmdbRating ?? details?.rating ?? state.selectedMeta.rating
              }
            : state.selectedMeta
        }));

        setSelectedStream({
          url: fakeTorrent.magnetUri,
          title: fakeTorrent.title,
          torrent: fakeTorrent,
          sourceType: 'qbittorrent',
          preferredSeason: playbackTarget?.season,
          preferredEpisode: playbackTarget?.episode,
          resumeProgress,
          resumePlaybackTime,
          resumeDuration,
          resumeSourceFilename,
          startOver: shouldStartFromBeginning,
        });
        return;
      }

      handleStream(
        fakeTorrent,
        playbackTarget,
        resumeProgress,
        resumePlaybackTime,
        resumeDuration,
        resumeSourceFilename,
        shouldStartFromBeginning,
        'webtorrent'
      );
    }
  };

  const handleToggleWatchlist = () => {
    if (isInWatchlist) {
      removeFromWatchlist(meta.id);
      if (traktConnected) {
        pushWatchlistToTrakt(meta, 'remove').catch(console.error);
      }
    } else {
      const watchlistMeta = {
        id: meta.id,
        type: meta.type,
        name: details?.name || meta.name,
        poster: details?.poster || meta.poster,
        background: details?.background || meta.background,
        year: details?.year || meta.year,
        imdbId: details?.imdbId || meta.imdbId,
        rating: details?.tmdbRating ?? meta.rating,
      };
      addToWatchlist(watchlistMeta);
      if (traktConnected) {
        pushWatchlistToTrakt(watchlistMeta, 'add').catch(console.error);
      }
    }
  };

  const handleToggleWatched = async () => {
    const watchedMeta = {
      id: meta.id,
      type: meta.type,
      name: details?.name || meta.name,
      poster: details?.poster || meta.poster,
      background: details?.background || meta.background,
      year: details?.year || meta.year,
      imdbId: details?.imdbId || meta.imdbId,
      rating: details?.tmdbRating ?? meta.rating,
      watchedAt: new Date().toISOString()
    };

    if (isMarkedWatched) {
      removeFromWatched(meta.id);
      if (traktConnected) {
        await pushUnwatchedToTrakt(meta);
      }
      return;
    }

    useStore.getState().addToWatched(watchedMeta);
    if (traktConnected) {
      await pushWatchedToTrakt(watchedMeta);
    }
  };

  const handleRecommendationClick = (item: MetaPreview) => {
    navigateToMetaFromCurrent({
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster,
      background: item.background,
      year: item.year,
      imdbId: item.imdbId,
      rating: item.rating
    });
  };

  const handleRecommendationWatchlistToggle = (item: MetaPreview) => {
    const isRecommendationInWatchlist = watchlist.some((entry) => entry.id === item.id);
    if (isRecommendationInWatchlist) {
      removeFromWatchlist(item.id);
      if (traktConnected) {
        pushWatchlistToTrakt(item, 'remove').catch(console.error);
      }
      return;
    }

    const watchlistMeta = {
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster,
      background: item.background,
      year: item.year,
      imdbId: item.imdbId,
      rating: item.rating
    };
    addToWatchlist(watchlistMeta);
    if (traktConnected) {
      pushWatchlistToTrakt(watchlistMeta, 'add').catch(console.error);
    }
  };

  const formatSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  };

  const displayedCastCount = Math.min(
    details?.cast?.length ?? 0,
    visibleCastCount * castBatchCount
  );
  const addonSearchActions = availableSearchAddons.length > 0 ? (
    <div className="source-provider-search-actions" aria-label="Search with a specific add-on">
      <span className="source-provider-search-label">Search With</span>
      {availableSearchAddons.map((addon) => (
        <button
          key={addon.installationId}
          type="button"
          className="source-provider-search-btn"
          onClick={() => void handleSearchTorrents(addon.installationId)}
          disabled={torrentsLoading}
          aria-busy={searchingAddonInstallationId === addon.installationId}
          aria-label={`Search with ${addon.manifest.name}`}
          title={`Search only with ${addon.manifest.name}`}
        >
          {addon.manifest.name}
        </button>
      ))}
    </div>
  ) : null;
  const displayedWatchProviders = watchProviders.slice(0, WATCH_PROVIDER_DISPLAY_LIMIT);
  const officialWatchUrl = `https://www.themoviedb.org/${isTvShow ? 'tv' : 'movie'}/${tmdbId}/watch?locale=${watchRegion}`;
  const officialWatchFallback = watchProvidersLoading ? (
    <div className="torrents-loading">
      <div className="loading-spinner" />
      <span>Finding streaming options in {watchRegion}...</span>
    </div>
  ) : displayedWatchProviders.length === 0 ? (
    <div className="torrents-empty">No streaming options are currently listed for {watchRegion}.</div>
  ) : (
    <>
      <div className="torrents-list">
        {displayedWatchProviders.map((provider) => (
          <div key={provider.id} className="torrent-item">
            <div className="watch-provider-summary">
              {provider.logoUrl && <img src={provider.logoUrl} alt="" className="watch-provider-logo" />}
              <div className="torrent-item-info">
                <span className="torrent-item-title" title={provider.name}>{provider.name}</span>
                <span className="torrent-item-meta">
                  <span className="stat-item">{provider.availability.join(' / ')}</span>
                  <span className="stat-divider">&bull;</span>
                  <span className="stat-item">Available in {watchRegion}</span>
                </span>
              </div>
            </div>
            <div className="torrent-item-actions">
              <button
                type="button"
                className="torrent-action-btn play"
                onClick={() => void window.electronAPI.openExternal(officialWatchUrl)}
                title={`View ${provider.name} availability on TMDB`}
              >
                <FiExternalLink /> View
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="watch-provider-attribution"
        onClick={() => void window.electronAPI.openExternal('https://www.justwatch.com/')}
      >
        Availability by JustWatch
      </button>
    </>
  );
  const sourceCountLabel = availableSearchAddons.length === 0
    ? displayedWatchProviders.length
    : torrentCountLabel;

  return (
    <div className="meta-details">
      {details?.background && (
        <div className="meta-backdrop" style={{ backgroundImage: `url(${details.background})` }} />
      )}
      <div className="meta-backdrop-overlay" />
      
      <button className="meta-back" onClick={handleBack}>
        <FiArrowLeft /> Back
      </button>

      <div className="meta-content">
        <section className="meta-hero">
          <div className="meta-left">
            <div className="meta-poster">
              {details?.poster && <img src={details.poster} alt={details.name} decoding="async" />}
              <XrelQualityBadge
                item={{
                  id: meta.id,
                  type: meta.type,
                  name: details?.name ?? meta.name,
                  year: details?.year ?? meta.year,
                  imdbId: details?.imdbId ?? meta.imdbId,
                  originalName: meta.originalName,
                  aliases: meta.aliases,
                }}
              />
            </div>

            <div className="meta-info">
              <div className="meta-summary">
                {logoUrl ? (
                  <img src={logoUrl} alt={details?.name} className="meta-title-logo" decoding="async" />
                ) : (
                  <h1 className="meta-title">{detailTitle}</h1>
                )}

                <div className="meta-facts">
                  <div className="meta-meta">
                    {heroMetaItems.map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>

                  {(details?.tmdbRating !== undefined || details?.imdbId) && (
                    <div className="meta-ratings">
                      {details?.tmdbRating !== undefined && (
                        <div
                          className="rating-badge tmdb"
                          onClick={() => window.electronAPI.openExternal(`https://www.themoviedb.org/${meta.type === 'movie' ? 'movie' : 'tv'}/${meta.id.split(':')[1]}`)}
                          style={{ cursor: 'pointer' }}
                        >
                          <img src={new URL('../../assets/tmdb-logo.svg', import.meta.url).href} alt="TMDB" className="rating-logo" />
                          <span className="rating-value">{Math.round(details.tmdbRating * 10)}%</span>
                        </div>
                      )}
                      {details?.imdbId && (
                        <div className="rating-badge imdb" onClick={() => window.electronAPI.openExternal(`https://www.imdb.com/title/${details.imdbId}/`)} style={{ cursor: 'pointer' }}>
                          <img src={new URL('../../assets/imdb-logo.svg', import.meta.url).href} alt="IMDb" className="rating-logo imdb-logo" />
                          <span className="rating-value">{details.imdbRating ? `${details.imdbRating.toFixed(1)}` : 'Open'}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {details?.description && (
                  <p className="meta-description">{details.description}</p>
                )}
              </div>

              {showSentimentSection && (
                <div className="meta-sentiment-section">
                  {sentimentsLoading ? (
                    <div className="meta-sentiment-loading">
                      <div className="loading-spinner" />
                      <span>Reading Trakt sentiment...</span>
                    </div>
                  ) : (
                    <div className="meta-sentiment-grid">
                      {goodSentiments.length > 0 && (
                        <div className="meta-sentiment-column good">
                          <span className="meta-sentiment-title"><FiThumbsUp /> Pros</span>
                          <div className="meta-sentiment-tags">
                            {goodSentiments.map((item) => (
                              <span key={`good-${item.sentiment}`} className="meta-sentiment-tag">
                                {item.sentiment}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {badSentiments.length > 0 && (
                        <div className="meta-sentiment-column bad">
                          <span className="meta-sentiment-title"><FiThumbsDown /> Cons</span>
                          <div className="meta-sentiment-tags">
                            {badSentiments.map((item) => (
                              <span key={`bad-${item.sentiment}`} className="meta-sentiment-tag">
                                {item.sentiment}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="meta-action-groups">
                {(getLastSource() || hasResumeState) && (
                  <div className="meta-actions meta-actions-resume">
                    {getLastSource() ? (
                      <>
                        <button className="meta-btn meta-btn-continue" onClick={() => handleContinue(false)}>
                          <FiPlay /> {hasResumeState ? continueActionLabel : 'Replay'}
                        </button>
                        {hasResumeState && (
                          <button className="meta-btn" onClick={() => handleContinue(true)}>
                            <FiRefreshCw /> Replay
                          </button>
                        )}
                      </>
                    ) : (
                      <button className="meta-btn meta-btn-continue" onClick={() => void handleSearchTorrents()}>
                        <FiPlay /> {continueActionLabel}
                      </button>
                    )}
                  </div>
                )}

                <div className="meta-actions-shelf">
                  <div className="meta-actions meta-actions-primary">
                    <div className="meta-local-play">
                      <button
                        className="meta-btn"
                        type="button"
                        onClick={() => setShowLocalSourceMenu((current) => !current)}
                      >
                        <FiFolder /> Play Local
                      </button>
                      {showLocalSourceMenu && (
                        <div className="meta-local-menu">
                          <button type="button" onClick={() => void handlePlayLocal('files')}>
                            <FiFile /> Video Files
                          </button>
                          <button type="button" onClick={() => void handlePlayLocal('folder')}>
                            <FiFolder /> Folder
                          </button>
                        </div>
                      )}
                    </div>
                    {trailer && (
                      <button
                        className="meta-btn"
                        onClick={() => {
                          if (showTrailer) setShowTrailer(false);
                          else openTrailerSource(trailer);
                        }}
                      >
                        <FiFilm /> {showTrailer ? 'Close Trailer' : 'Watch Trailer'}
                      </button>
                    )}
                  </div>

                  <div className="meta-actions meta-actions-library">
                    <button
                      className={`meta-btn ${isInWatchlist ? 'meta-btn-watched' : ''}`}
                      onClick={handleToggleWatchlist}
                    >
                      {isInWatchlist ? <FiCheck /> : <FiHeart />}
                      {isInWatchlist ? 'In Watchlist' : 'Add to Watchlist'}
                    </button>
                    <button
                      className={`meta-btn ${isMarkedWatched ? 'meta-btn-watched' : ''}`}
                      onClick={() => { void handleToggleWatched(); }}
                    >
                      <FiCheck />
                      {isMarkedWatched ? 'Remove From History' : 'Mark Watched'}
                    </button>
                  </div>
                </div>
              </div>

              {localSourceError && (
                <div className="meta-local-error">{localSourceError}</div>
              )}

              {details?.director && details.director.length > 0 && (
                <div className="meta-detail-row">
                  <span className="meta-label">Director</span>
                  <span>{details.director.join(', ')}</span>
                </div>
              )}

            </div>

            {details?.cast && details.cast.length > 0 && (
              <div className="meta-cast-section">
                <div className="meta-section-heading">
                  <span className="meta-label">Cast</span>
                  {details.cast.length > visibleCastCount && (
                    <button
                      type="button"
                      className="meta-inline-action"
                      onClick={() => {
                        if (showAllCast) {
                          setShowAllCast(false);
                          setCastBatchCount(1);
                        } else {
                          setShowAllCast(true);
                          setCastBatchCount(2);
                        }
                      }}
                    >
                      {showAllCast ? 'Show Less' : 'Show All'}
                    </button>
                  )}
                </div>
                <div
                  ref={castRowRef}
                  className={`meta-cast-row ${showAllCast ? 'expanded' : ''}`}
                  style={{ '--cast-columns': visibleCastCount } as React.CSSProperties}
                >
                  {details.cast
                    .slice(0, displayedCastCount)
                    .map((member) => (
                      <button
                        key={member.id}
                        type="button"
                        className={`meta-cast-card ${selectedActor?.id === member.id ? 'active' : ''}`}
                        onClick={() => void handleActorClick(member)}
                        aria-label={`Show credits for ${member.name}`}
                      >
                        <div className="meta-cast-photo">
                          {member.profile ? (
                            <img src={member.profile} alt={member.name} loading="lazy" decoding="async" />
                          ) : (
                            <div className="meta-cast-photo-placeholder">{member.name.charAt(0)}</div>
                          )}
                        </div>
                        <div className="meta-cast-copy">
                          <span className="meta-cast-name">{member.name}</span>
                          {member.character && <span className="meta-cast-character">{member.character}</span>}
                          {member.episodeCount !== undefined && (
                            <span className="meta-cast-character">
                              {member.episodeCount} {member.episodeCount === 1 ? 'episode' : 'episodes'}
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                </div>
                {showAllCast && displayedCastCount < details.cast.length && (
                  <button
                    type="button"
                    className="meta-cast-load-more"
                    onClick={() => setCastBatchCount((count) => count + 2)}
                  >
                    Load More <FiChevronRight />
                  </button>
                )}
              </div>
            )}
        </div>
      </section>

      {selectedActor && (
        <section className="meta-actor-section">
          <div className="meta-actor-header">
            <div className="meta-actor-identity">
              <div className="meta-actor-photo">
                {selectedActor.profile ? (
                  <img src={selectedActor.profile} alt={selectedActor.name} decoding="async" />
                ) : (
                  <div className="meta-cast-photo-placeholder">{selectedActor.name.charAt(0)}</div>
                )}
              </div>
              <div>
                <p className="meta-section-kicker">Actor Credits</p>
                <h2>{selectedActor.name}</h2>
                <span>{actorCredits.length} titles</span>
              </div>
            </div>

            <div className="meta-actor-actions">
              <div className="meta-actor-tabs" aria-label="Filter actor credits">
                <button
                  type="button"
                  className={actorCreditFilter === 'all' ? 'active' : ''}
                  onClick={() => setActorCreditFilter('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  className={actorCreditFilter === 'movie' ? 'active' : ''}
                  onClick={() => setActorCreditFilter('movie')}
                >
                  <FiFilm /> Movies {actorMovieCount}
                </button>
                <button
                  type="button"
                  className={actorCreditFilter === 'series' ? 'active' : ''}
                  onClick={() => setActorCreditFilter('series')}
                >
                  <FiTv /> TV {actorSeriesCount}
                </button>
              </div>
              <button
                type="button"
                className="meta-inline-action"
                onClick={() => {
                  actorRequestIdRef.current += 1;
                  setSelectedActor(null);
                  setActorCreditsLoading(false);
                }}
              >
                Close
              </button>
            </div>
          </div>

          {actorCreditsLoading ? (
            <div className="meta-actor-state">
              <div className="loading-spinner" />
              <span>Loading credits...</span>
            </div>
          ) : actorCreditsError ? (
            <div className="meta-actor-state error">{actorCreditsError}</div>
          ) : (
            <div className="meta-actor-grid">
              {filteredActorCredits.map((credit) => (
                <article key={credit.id} className="meta-actor-credit">
                  <button
                    type="button"
                    className="meta-actor-credit-trigger"
                    onClick={() => handleActorCreditClick(credit)}
                    aria-label={`Open details for ${credit.name}`}
                  >
                    <div className="meta-actor-credit-poster">
                      {credit.poster ? (
                        <img src={credit.poster} alt={credit.name} loading="lazy" decoding="async" />
                      ) : (
                        <div className="meta-actor-credit-placeholder" />
                      )}
                      {credit.rating !== undefined && credit.rating > 0 && (
                        <div className="poster-rating-badge">&#9733; {credit.rating.toFixed(1)}</div>
                      )}
                    </div>
                    <span className="meta-actor-credit-title">{credit.name}</span>
                    <span className="meta-actor-credit-meta">
                      {credit.type === 'movie' ? 'Movie' : 'TV'}{credit.year ? ` - ${credit.year}` : ''}
                    </span>
                    {credit.character && (
                      <span className="meta-actor-credit-character">{credit.character}</span>
                    )}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="meta-workspace">
          {!isTvShow && showTorrents && (
            <div className="meta-torrents">
              <div className="torrents-header">
                <div className="torrents-heading">
                  <h2 className="torrents-title">Sources ({sourceCountLabel})</h2>
                </div>
                <div className="torrents-toolbar">
                  {addonSearchActions}
                  {availableSearchAddons.length > 0 && <div className="torrents-sort">
                    <label className="dedup-toggle" title="Hide duplicate sources returned by add-ons">
                      <input
                        type="checkbox"
                        checked={hideDuplicates}
                        onChange={(e) => setHideDuplicates(e.target.checked)}
                      />
                      <span>Hide duplicates</span>
                    </label>
                    <span>Sort by:</span>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as SortBy)}
                      className="sort-select"
                    >
                      <option value="seeds">Availability</option>
                      <option value="size">Size</option>
                      <option value="quality">Quality</option>
                    </select>
                    <select
                      value={selectedIndexer}
                      onChange={(e) => {
                        setSelectedIndexer(e.target.value);
                        setVisibleTorrentCount(TORRENT_PAGE_SIZE);
                      }}
                      className="sort-select"
                      title="Filter by source"
                    >
                      <option value="all">All Sources</option>
                      {indexerCounts.map(([indexer, count]) => (
                        <option key={indexer} value={indexer}>
                          {indexer} ({count})
                        </option>
                      ))}
                    </select>
                    <button
                      className="sort-order-btn"
                      onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
                    >
                      {sortOrder === 'desc' ? <FiArrowDown /> : <FiArrowUp />}
                    </button>
                  </div>}
                </div>
              </div>
              {availableSearchAddons.length === 0 ? officialWatchFallback : torrentsLoading && torrents.length === 0 ? (
                <div className="torrents-loading">
                  <div className="loading-spinner" />
                  <span>Searching...</span>
                </div>
              ) : torrentsError ? (
                <div className="torrents-empty">{torrentsError}</div>
              ) : torrents.length === 0 ? (
                <div className="torrents-empty">No sources found</div>
              ) : (
                <div className="torrents-list">
                  {visibleTorrents.map((torrent) => (
                    <div key={torrent.id} className="torrent-item">
                      <div className="torrent-item-info">
                        <span className="torrent-item-title" title={torrent.title}>{torrent.title}</span>
                        <span className="torrent-item-meta">
                          <span className="indexer-name">{torrent.indexer}</span>
                          {torrent.quality !== 'unknown' && (
                            <span className={`quality-badge quality-${torrent.quality}`}>{torrent.quality}</span>
                          )}
                          {isDirectStreamSource(torrent) ? (
                            <span className="cached-badge">Add-on</span>
                          ) : torrent.cached ? (
                            <span className="cached-badge">Cached</span>
                          ) : null}
                          <span className="stat-divider">&bull;</span>
                          <span className="stat-item">{formatSize(torrent.size)}</span>
                          {!isDirectStreamSource(torrent) && (
                            <>
                              <span className="stat-divider">&bull;</span>
                              <span className="stat-item stat-seeds" title="Availability">Availability {torrent.seeds}</span>
                              <span className="stat-divider">&bull;</span>
                              <span className="stat-item stat-peers" title="Active connections">Connections {torrent.peers}</span>
                            </>
                          )}
                        </span>
                      </div>
                      <div className="torrent-item-actions">
                        <button
                          className="torrent-action-btn play"
                          onClick={() => {
                            setOpenTorrentMenuId(null);
                            handlePrimaryPlay(torrent);
                          }}
                          title={getPrimaryPlayTitle(torrent)}
                        >
                          <FiPlay /> Play
                        </button>
                        {!isDirectStreamSource(torrent) && <div className="torrent-more-menu-wrap">
                          <button
                            className="torrent-action-btn more"
                            type="button"
                            aria-expanded={openTorrentMenuId === torrent.id}
                            aria-label={`More actions for ${torrent.title}`}
                            onClick={() => setOpenTorrentMenuId((current) => current === torrent.id ? null : torrent.id)}
                          >
                            More <FiMoreHorizontal />
                          </button>
                          {openTorrentMenuId === torrent.id && (
                            <div className="torrent-more-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenTorrentMenuId(null);
                                  markTorrentActionPressed(torrent, 'open-external');
                                  window.electronAPI.openExternal(getExternalSourceUrl(torrent));
                                }}
                              >
                                <FiExternalLink /> {getExternalSourceTitle(torrent)}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className={wasTorrentActionPressed(torrent, 'send-to-qbittorrent') ? 'pressed' : ''}
                                onClick={() => {
                                  setOpenTorrentMenuId(null);
                                  void handleSendToQbittorrent(torrent).catch((error) => {
                                    console.error('Failed to send source to the external playback service:', error);
                                  });
                                }}
                              >
                                <FiDownload /> {getSendSourceTitle(torrent)}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenTorrentMenuId(null);
                                  handleSendAndAutoplay(torrent);
                                }}
                              >
                                <FiFilm /> {getSendAndStreamTitle(torrent)}
                              </button>
                            </div>
                          )}
                        </div>}
                      </div>
                    </div>
                  ))}
                  {hasMoreTorrents && (
                    <button
                      type="button"
                      className="meta-btn"
                      onClick={() => setVisibleTorrentCount((current) => current + TORRENT_PAGE_SIZE)}
                    >
                      Load More Sources ({sortedTorrents.length - visibleTorrents.length} remaining)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {isTvShow && (
            <div className="meta-tv-stack">
              <div className="meta-tv-panel">
                <div className="meta-seasons-section">
                  <div className="seasons-header">
                    <h3>Seasons</h3>
                  </div>

                  {seasonsLoading ? (
                    <div className="seasons-loading">
                      <div className="loading-spinner" />
                    </div>
                  ) : !activeSeason ? (
                    <div className="torrents-empty">No seasons available.</div>
                  ) : (
                    <div className="seasons-browser">
                      <div className="season-selector" role="tablist" aria-label="Seasons">
                        {visibleSeasons.map((season) => {
                          const watchedCount = getSeasonWatchedCount(season.season_number);
                          const isFullyWatched = watchedCount > 0 && watchedCount >= season.episode_count;
                          const isActive = activeSeason.season_number === season.season_number;

                          return (
                            <button
                              key={season.season_number}
                              type="button"
                              className={`season-tab ${isActive ? 'active' : ''} ${isFullyWatched ? 'fully-watched' : ''}`}
                              onClick={() => {
                                void handleSeasonSelect(season);
                              }}
                              role="tab"
                              aria-selected={isActive}
                              title={season.name}
                            >
                              <span className="season-tab-index">S{season.season_number}</span>
                            </button>
                          );
                        })}
                      </div>

                      <div className="season-detail">
                        <div className="season-detail-header">
                          <div className="season-summary">
                            <div className="season-copy">
                              <span className={`season-name ${isActiveSeasonFullyWatched ? 'complete' : ''}`}>{activeSeason.name}</span>
                              <XrelQualityBadge
                                item={{
                                  id: meta.id,
                                  type: meta.type,
                                  name: details?.name ?? meta.name,
                                  year: details?.year ?? meta.year,
                                  imdbId: details?.imdbId ?? meta.imdbId,
                                  originalName: meta.originalName,
                                  aliases: meta.aliases,
                                }}
                                season={activeSeason.season_number}
                                variant="inline"
                              />
                              <span className="season-subtitle">
                                {activeSeason.episode_count} episodes
                                {activeSeasonWatchedCount > 0 ? ` | ${activeSeasonWatchedCount} watched` : ''}
                              </span>
                            </div>
                          </div>
                          <div className="season-actions-bar">
                            <span className={`season-watched-count ${isActiveSeasonFullyWatched ? 'complete' : ''}`}>
                              {activeSeasonWatchedCount}/{activeSeason.episode_count}
                            </span>
                            <button
                              className={`season-watched-btn ${isActiveSeasonFullyWatched ? 'fully-watched' : ''}`}
                              onClick={(e) => handleMarkSeasonWatched(e, activeSeason)}
                              title={isActiveSeasonFullyWatched ? 'Mark season as unwatched' : 'Mark all episodes as watched'}
                            >
                              <FiCheck /> {isActiveSeasonFullyWatched ? 'Watched' : 'Watch'}
                            </button>
                          </div>
                        </div>

                        <div className="episodes-list">
                          {activeSeasonEpisodes.length === 0 ? (
                            <div className="torrents-empty">Loading episodes...</div>
                          ) : (
                            activeSeasonEpisodes.map((episode) => (
                              <div
                                key={episode.id}
                                className={`episode-item ${selectedEpisode?.id === episode.id ? 'selected' : ''}`}
                                onClick={() => handleEpisodeClick(episode, activeSeason)}
                                title={`Search: "${details?.name} S${activeSeason.season_number.toString().padStart(2, '0')}E${episode.episode_number.toString().padStart(2, '0')}"`}
                              >
                                <span className="episode-number">E{episode.episode_number}</span>
                                <div className="episode-copy">
                                  <span className="episode-title">
                                    {episode.name}
                                    <XrelQualityBadge
                                      item={{
                                        id: meta.id,
                                        type: meta.type,
                                        name: details?.name ?? meta.name,
                                        year: details?.year ?? meta.year,
                                        imdbId: details?.imdbId ?? meta.imdbId,
                                        originalName: meta.originalName,
                                        aliases: meta.aliases,
                                      }}
                                      season={activeSeason.season_number}
                                      episode={episode.episode_number}
                                      variant="inline"
                                    />
                                  </span>
                                  {episode.air_date && <span className="episode-air-date">{episode.air_date}</span>}
                                </div>
                                <button
                                  className="episode-watched-btn"
                                  onClick={(e) => toggleEpisodeWatched(e, episode)}
                                  title={isEpisodeWatched(episode.episode_number, activeSeason.season_number) ? 'Mark as unwatched' : 'Mark as watched'}
                                >
                                  {isEpisodeWatched(episode.episode_number, activeSeason.season_number) ? (
                                    <FiCheck style={{ color: '#22c55e' }} />
                                  ) : (
                                    <FiCircle style={{ color: '#6b7280' }} />
                                  )}
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {showTorrents && (
                  <div className="meta-torrents">
                    <div className="torrents-header">
                      <div className="torrents-heading">
                        <h2 className="torrents-title">Sources ({sourceCountLabel})</h2>
                        <span className="search-info">{activeSearchLabel}</span>
                      </div>
                      <div className="torrents-toolbar">
                        {addonSearchActions}
                        {availableSearchAddons.length > 0 && <div className="torrents-sort">
                          <label className="dedup-toggle" title="Hide duplicate sources returned by add-ons">
                            <input
                              type="checkbox"
                              checked={hideDuplicates}
                              onChange={(e) => setHideDuplicates(e.target.checked)}
                            />
                            <span>Hide duplicates</span>
                          </label>
                          <span>Sort by:</span>
                          <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value as SortBy)}
                            className="sort-select"
                          >
                            <option value="seeds">Availability</option>
                            <option value="size">Size</option>
                            <option value="quality">Quality</option>
                          </select>
                          <select
                            value={selectedIndexer}
                            onChange={(e) => {
                              setSelectedIndexer(e.target.value);
                              setVisibleTorrentCount(TORRENT_PAGE_SIZE);
                            }}
                            className="sort-select"
                            title="Filter by source"
                          >
                            <option value="all">All Sources</option>
                            {indexerCounts.map(([indexer, count]) => (
                              <option key={indexer} value={indexer}>
                                {indexer} ({count})
                              </option>
                            ))}
                          </select>
                          <button
                            className="sort-order-btn"
                            onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
                          >
                            {sortOrder === 'desc' ? <FiArrowDown /> : <FiArrowUp />}
                          </button>
                        </div>}
                      </div>
                    </div>
                    {availableSearchAddons.length === 0 ? officialWatchFallback : torrentsLoading && torrents.length === 0 ? (
                      <div className="torrents-loading">
                        <div className="loading-spinner" />
                        <span>Searching...</span>
                      </div>
                    ) : torrentsError ? (
                      <div className="torrents-empty">{torrentsError}</div>
                    ) : torrents.length === 0 ? (
                      <div className="torrents-empty">No sources found</div>
                    ) : (
                      <div className="torrents-list">
                        {visibleTorrents.map((torrent) => (
                          <div key={torrent.id} className="torrent-item">
                            <div className="torrent-item-info">
                              <span className="torrent-item-title" title={torrent.title}>{torrent.title}</span>
                              <span className="torrent-item-meta">
                                <span className="indexer-name">{torrent.indexer}</span>
                                {torrent.quality !== 'unknown' && (
                                  <span className={`quality-badge quality-${torrent.quality}`}>{torrent.quality}</span>
                                )}
                                {isDirectStreamSource(torrent) ? (
                                  <span className="cached-badge">Add-on</span>
                                ) : torrent.cached ? (
                                  <span className="cached-badge">Cached</span>
                                ) : null}
                                <span className="stat-divider">&bull;</span>
                                <span className="stat-item">{formatSize(torrent.size)}</span>
                                {!isDirectStreamSource(torrent) && (
                                  <>
                                    <span className="stat-divider">&bull;</span>
                                    <span className="stat-item stat-seeds" title="Availability">Availability {torrent.seeds}</span>
                                    <span className="stat-divider">&bull;</span>
                                    <span className="stat-item stat-peers" title="Active connections">Connections {torrent.peers}</span>
                                  </>
                                )}
                              </span>
                            </div>
                            <div className="torrent-item-actions">
                              <button
                                className="torrent-action-btn play"
                                onClick={() => {
                                  setOpenTorrentMenuId(null);
                                  handlePrimaryPlay(torrent);
                                }}
                                title={getPrimaryPlayTitle(torrent)}
                              >
                                <FiPlay /> Play
                              </button>
                              {!isDirectStreamSource(torrent) && <div className="torrent-more-menu-wrap">
                                <button
                                  className="torrent-action-btn more"
                                  type="button"
                                  aria-expanded={openTorrentMenuId === torrent.id}
                                  aria-label={`More actions for ${torrent.title}`}
                                  onClick={() => setOpenTorrentMenuId((current) => current === torrent.id ? null : torrent.id)}
                                >
                                  More <FiMoreHorizontal />
                                </button>
                                {openTorrentMenuId === torrent.id && (
                                  <div className="torrent-more-menu" role="menu">
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setOpenTorrentMenuId(null);
                                        markTorrentActionPressed(torrent, 'open-external');
                                        window.electronAPI.openExternal(getExternalSourceUrl(torrent));
                                      }}
                                    >
                                      <FiExternalLink /> {getExternalSourceTitle(torrent)}
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className={wasTorrentActionPressed(torrent, 'send-to-qbittorrent') ? 'pressed' : ''}
                                      onClick={() => {
                                        setOpenTorrentMenuId(null);
                                        void handleSendToQbittorrent(torrent).catch((error) => {
                                          console.error('Failed to send source to the external playback service:', error);
                                        });
                                      }}
                                    >
                                      <FiDownload /> {getSendSourceTitle(torrent)}
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setOpenTorrentMenuId(null);
                                        handleSendAndAutoplay(torrent);
                                      }}
                                    >
                                      <FiFilm /> {getSendAndStreamTitle(torrent)}
                                    </button>
                                  </div>
                                )}
                              </div>}
                            </div>
                          </div>
                        ))}
                        {hasMoreTorrents && (
                          <button
                            type="button"
                            className="meta-btn"
                            onClick={() => setVisibleTorrentCount((current) => current + TORRENT_PAGE_SIZE)}
                          >
                            Load More Sources ({sortedTorrents.length - visibleTorrents.length} remaining)
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {showRecommendationsSection && renderRecommendationsSection()}
            </div>
          )}

          {!isTvShow && showRecommendationsSection && renderRecommendationsSection()}
        </div>
      </div>

      {showTrailer && trailer?.embedUrl && (
        <div className="trailer-modal-overlay" onClick={() => setShowTrailer(false)}>
          <div className="trailer-modal" onClick={(e) => e.stopPropagation()}>
            <button className="trailer-modal-close" onClick={() => setShowTrailer(false)}>X</button>
            {trailer.provider === 'YouTube' ? (
              <div id="trailer-youtube-player" className="trailer-youtube-player" />
            ) : (
              <iframe
                width="100%"
                height="100%"
                src={trailer.embedUrl}
                title={trailer.title ?? 'Trailer'}
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            )}
            {trailerError && (
              <div className="trailer-modal-status">
                <span>{trailerError}</span>
                <button type="button" onClick={() => void window.electronAPI.openExternal(trailer.url)}>
                  Open externally
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MetaDetails;
