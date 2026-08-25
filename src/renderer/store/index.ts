import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

const AUDIO_NORMALIZER_PRESETS = new Set(['light', 'medium', 'strong', 'custom']);

function normalizeAudioNormalizerPreset(preset: unknown): string {
  if (typeof preset === 'string' && AUDIO_NORMALIZER_PRESETS.has(preset)) {
    return preset;
  }

  return 'medium';
}

const deduplicatedRendererStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  removeItem: (name) => localStorage.removeItem(name),
  setItem: (name, value) => {
    if (localStorage.getItem(name) !== value) {
      localStorage.setItem(name, value);
    }
  },
};

export interface MetaPreview {
  id: string;
  type: 'movie' | 'series';
  name: string;
  originalName?: string;
  aliases?: string[];
  poster?: string;
  background?: string;
  year?: string;
  releaseDate?: string;
  imdbId?: string;
  watchedAt?: string;
  listedAt?: string;
  rating?: number;
  genreIds?: number[];
  originalLanguage?: string;
  continueSource?: 'resume' | 'up-next';
  continueProgress?: number;
  continuePausedAt?: string;
  continueSeason?: number;
  continueEpisode?: number;
  continueEpisodeId?: string;
}

export interface DiscoverTraktList {
  id: number;
  name: string;
  description?: string;
  likes: number;
  itemCount: number;
  owner: string;
  previewPosters: string[];
  previewsLoaded: boolean;
}

export interface DiscoverListState {
  cacheKey: string;
  lists: DiscoverTraktList[];
  selectedList: DiscoverTraktList | null;
  items: MetaPreview[];
  total: number;
  complete: boolean;
  resumePage: number;
  itemFilter: 'all' | 'movie' | 'series';
  genre: number | null;
  year: number | null;
  language: string | null;
  minRating: number;
  maxRating: number;
  watchFilter: 'all' | 'watched' | 'unwatched';
  sort: 'list' | 'rating' | 'title' | 'release';
}

export interface CastMember {
  id: number;
  name: string;
  character?: string;
  profile?: string;
  episodeCount?: number;
}

export interface MetaDetails extends MetaPreview {
  description?: string;
  runtime?: string;
  genre?: string[];
  director?: string[];
  cast?: CastMember[];
  episodes?: Episode[];
  tmdbRating?: number;
  imdbRating?: number;
  imdbId?: string;
  releaseDate?: string;
}

export interface Episode {
  id: string;
  title: string;
  season: number;
  episode: number;
  thumbnail?: string;
}

export interface TorrentResult {
  id: string;
  title: string;
  infoHash: string;
  magnetUri: string;
  size: number;
  seeds: number;
  peers: number;
  quality: '4K' | '1080p' | '720p' | '480p' | 'unknown';
  codec?: string;
  indexer: string;
  cached?: boolean;
  cacheProvider?: 'addon';
  sourceProvider?: 'addon';
  directStreamProvider?: 'addon';
  streamUrl?: string;
  streamHandle?: string;
  streamFilename?: string;
  sourceFileIndex?: number;
  addonInstallationId?: string;
  addonId?: string;
  addonName?: string;
}

export interface LocalVideoFile {
  name: string;
  path: string;
  size: number;
}

interface Stream {
  url: string;
  title: string;
  torrent: TorrentResult;
  sourceType?: 'webtorrent' | 'qbittorrent' | 'addon' | 'local';
  preferredSeason?: number;
  preferredEpisode?: number;
  resumeProgress?: number;
  resumePlaybackTime?: number;
  resumeDuration?: number;
  resumeSourceFilename?: string;
  startOver?: boolean;
  routeSwitchMessage?: string;
  localFiles?: LocalVideoFile[];
  localSourceKind?: 'files' | 'folder';
}

export interface ContinueWatchingItem {
  metaId: string;
  type: 'movie' | 'series';
  title: string;
  poster: string;
  progress: number;
  playbackTime?: number;
  duration?: number;
  sourceFilename?: string;
  rating?: number;
  pausedAt?: string;
  episodeId?: string;
  season?: number;
  episode?: number;
}

export interface ContinueWatchingViewItem extends ContinueWatchingItem {
  source: 'resume' | 'up-next';
}

const normalizeContinueMetaId = (metaId: string, type?: ContinueWatchingItem['type']) => {
  const match = metaId.match(/^(tv|series|movie):(\d+)$/);
  if (!match) {
    return metaId;
  }

  const [, prefix, tmdbId] = match;
  if (prefix === 'movie' || type === 'movie') {
    return `movie:${tmdbId}`;
  }

  return `tv:${tmdbId}`;
};

const isSameContinueMetaId = (
  left: string,
  right: string,
  leftType?: ContinueWatchingItem['type'],
  rightType?: ContinueWatchingItem['type']
) => normalizeContinueMetaId(left, leftType) === normalizeContinueMetaId(right, rightType);

const normalizeContinueWatchingItem = (item: ContinueWatchingItem): ContinueWatchingItem => ({
  ...item,
  metaId: normalizeContinueMetaId(item.metaId, item.type),
});

const getPausedAtTime = (item: ContinueWatchingItem) => {
  const time = item.pausedAt ? Date.parse(item.pausedAt) : 0;
  return Number.isFinite(time) ? time : 0;
};

const normalizeContinueWatchingItems = (items?: ContinueWatchingItem[]) => {
  const byMetaId = new Map<string, ContinueWatchingItem>();

  for (const item of items || []) {
    const normalized = normalizeContinueWatchingItem(item);
    const existing = byMetaId.get(normalized.metaId);
    if (!existing || getPausedAtTime(normalized) >= getPausedAtTime(existing)) {
      byMetaId.set(normalized.metaId, normalized);
    }
  }

  return Array.from(byMetaId.values()).sort((a, b) => getPausedAtTime(b) - getPausedAtTime(a));
};

export interface PlaybackIdentityItem {
  queueIndex: number;
  title: string;
  sourceKey?: string;
  streamUrl?: string | null;
  season?: number;
  episode?: number;
}

interface PlaylistFile {
  name: string;
  index: number;
  ready: boolean;
  streamUrl: string | null;
  season?: number;
  episode?: number;
}

export interface PendingTraktHistoryAction {
  action: 'add' | 'remove';
  mediaType: 'movie' | 'show';
  metaId: string;
  season?: number;
  episode?: number;
  watchedAt?: string;
  queuedAt: string;
}

export interface PendingTraktWatchlistAction {
  action: 'add' | 'remove';
  mediaType: 'movie' | 'show';
  metaId: string;
  queuedAt: string;
}

interface CatalogInfo {
  id: string;
  title: string;
  type: 'movie' | 'series';
  source: 'tmdb' | 'trakt' | 'continue';
  hideWatchedToggle?: boolean;
}

interface DownloadStats {
  status: 'idle' | 'downloading' | 'seeding' | 'complete' | 'error';
  downloaded: number;
  total: number;
  downloadSpeed: number;
  peers: { connected: number; seeders: number; leechers: number };
  trackerPeers?: { total: number; seeders: number; leechers: number };
  progress: number;
  torrentName: string;
  pieces: { ready: number; total: number };
  bitfield: number[];
}

interface SubtitleAssistState {
  status: 'idle' | 'pending' | 'connecting' | 'downloading' | 'waiting' | 'extracting' | 'transcribing' | 'finalizing' | 'ready' | 'generated' | 'embedded' | 'disabled' | 'error';
  message: string;
  progress: number;
}

interface AppState {
  view: 'board' | 'search' | 'watchlist' | 'settings' | 'meta' | 'player' | 'catalog' | 'calendar' | 'history' | 'statistics' | 'audio-normalizer';
  previousView: AppState['view'] | null;
  selectedMeta: MetaDetails | null;
  selectedCatalog: CatalogInfo | null;
  selectedStream: Stream | null;
  addonTransferSessionId: string | null;
  continueWatching: ContinueWatchingItem[];
  continueWatchingView: ContinueWatchingViewItem[];
  watchlist: MetaPreview[];
  watched: MetaPreview[];
  searchQuery: string;
  searchResults: TorrentResult[];
  isSearching: boolean;
  isLoading: boolean;
  traktConnected: boolean;
  traktToken: string | null;
  traktLastSync: number | null;
  boardScrollPosition: number;
  catalogScrollPosition: number;
  catalogItems: MetaPreview[];
  catalogPage: number;
  catalogCacheKey: string;
  discoverScrollPosition: number;
  discoverItems: MetaPreview[];
  discoverPage: number;
  discoverCacheKey: string;
  discoverFilter: 'all' | 'movie' | 'tv' | 'actor' | 'list';
  discoverMode: 'search' | 'browse';
  discoverGenre: number | null;
  discoverYear: number | null;
  discoverLanguage: string | null;
  discoverMinRating: number;
  discoverMaxRating: number;
  discoverSearchQuery: string;
  discoverListState: DiscoverListState;
  watchlistScrollPosition: number;
  watchlistPage: number;
  historyScrollPosition: number;
  historyPage: number;
  calendarScrollPosition: number;
  downloadStats: DownloadStats;
  subtitleAssist: SubtitleAssistState;
  whisperProcessedSeconds: number | null;
  watchedEpisodes: Record<string, string | boolean>;
  pendingTraktHistory: PendingTraktHistoryAction[];
  pendingTraktWatchlist: PendingTraktWatchlistAction[];

  playlistActive: boolean;
  playlistTorrentHash: string | null;
  playlistFiles: PlaylistFile[];
  playlistCurrentIndex: number;
  playlistTotalFiles: number;
  playlistIsBuffering: boolean;
  playlistEpisodeInfo: { season: number; episode: number; title: string } | null;
  playbackIdentityItems: PlaybackIdentityItem[];
  playbackIdentityCurrentIndex: number;
  playerProgress: number;
  currentPlayingTitle: string | null;
  playbackTransitionActive: boolean;
  
  setView: (view: AppState['view']) => void;
  setSelectedMeta: (meta: MetaDetails | null, fromView?: AppState['view']) => void;
  openCatalogMeta: (meta: MetaDetails, scrollPosition: number) => void;
  setSelectedCatalog: (catalog: CatalogInfo | null) => void;
  setSelectedStream: (stream: Stream | null) => void;
  setAddonTransferSessionId: (sessionId: string | null) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: TorrentResult[]) => void;
  setIsSearching: (isSearching: boolean) => void;
  setIsLoading: (isLoading: boolean) => void;
  setBoardScrollPosition: (position: number) => void;
  setCatalogScrollPosition: (position: number) => void;
  setCatalogItems: (items: MetaPreview[]) => void;
  setCatalogPage: (page: number) => void;
  setCatalogCacheKey: (cacheKey: string) => void;
  setDiscoverScrollPosition: (position: number) => void;
  setDiscoverItems: (items: MetaPreview[]) => void;
  setDiscoverPage: (page: number) => void;
  setDiscoverCacheKey: (cacheKey: string) => void;
  setDiscoverFilter: (filter: 'all' | 'movie' | 'tv' | 'actor' | 'list') => void;
  setDiscoverMode: (mode: 'search' | 'browse') => void;
  setDiscoverGenre: (genre: number | null) => void;
  setDiscoverYear: (year: number | null) => void;
  setDiscoverLanguage: (language: string | null) => void;
  setDiscoverRatingRange: (min: number, max: number) => void;
  setDiscoverSearchQuery: (query: string) => void;
  updateDiscoverListState: (
    update: Partial<DiscoverListState> | ((state: DiscoverListState) => Partial<DiscoverListState>)
  ) => void;
  resetDiscoverListState: (cacheKey?: string) => void;
  setWatchlistScrollPosition: (position: number) => void;
  setWatchlistPage: (page: number) => void;
  setHistoryScrollPosition: (position: number) => void;
  setHistoryPage: (page: number) => void;
  setCalendarScrollPosition: (position: number) => void;
  addToWatchlist: (meta: MetaPreview) => void;
  setWatchlist: (items: MetaPreview[]) => void;
  removeFromWatchlist: (metaId: string) => void;
  addToWatched: (meta: MetaPreview) => void;
  setWatched: (items: MetaPreview[]) => void;
  removeFromWatched: (metaId: string) => void;
  addToContinueWatching: (item: ContinueWatchingItem) => void;
  removeFromContinueWatching: (metaId: string) => void;
  updateContinueWatchingProgress: (
    metaId: string,
    progress: number,
    details?: Partial<
      Pick<
        ContinueWatchingItem,
        'season' | 'episode' | 'episodeId' | 'title' | 'poster' | 'type' | 'rating' | 'playbackTime' | 'duration' | 'sourceFilename'
      >
    >
  ) => void;
  setContinueWatching: (items: ContinueWatchingItem[]) => void;
  setContinueWatchingView: (items: ContinueWatchingViewItem[]) => void;
  setTraktConnected: (connected: boolean) => void;
  setTraktToken: (token: string | null) => void;
  setTraktLastSync: (timestamp: number) => void;
  setDownloadStats: (stats: Partial<DownloadStats>) => void;
  resetDownloadStats: () => void;
  setSubtitleAssist: (state: Partial<SubtitleAssistState>) => void;
  clearSubtitleAssist: () => void;
  setWhisperProcessedSeconds: (seconds: number | null) => void;
  markEpisodeWatched: (tmdbId: string, season: number, episode: number, watchedAt?: string) => void;
  setWatchedEpisodes: (episodes: Record<string, string | boolean>) => void;
  markEpisodeUnwatched: (tmdbId: string, season: number, episode: number) => void;
  markSeasonWatched: (tmdbId: string, seasonNumber: number, episodes: number[], watchedAt?: string) => void;
  markSeasonUnwatched: (tmdbId: string, seasonNumber: number, episodes: number[]) => void;
  isEpisodeWatched: (tmdbId: string, season: number, episode: number) => boolean;
  queuePendingTraktHistory: (action: Omit<PendingTraktHistoryAction, 'queuedAt'> & { queuedAt?: string }) => void;
  removePendingTraktHistory: (action: PendingTraktHistoryAction) => void;
  clearPendingTraktHistory: () => void;
  queuePendingTraktWatchlist: (action: Omit<PendingTraktWatchlistAction, 'queuedAt'> & { queuedAt?: string }) => void;
  removePendingTraktWatchlist: (action: PendingTraktWatchlistAction) => void;
  clearPendingTraktWatchlist: () => void;
  
  setPlaylistActive: (active: boolean) => void;
  setPlaylistTorrentHash: (hash: string | null) => void;
  setPlaylistFiles: (files: PlaylistFile[]) => void;
  setPlaylistCurrentIndex: (index: number) => void;
  setPlaylistTotalFiles: (total: number) => void;
  setPlaylistIsBuffering: (buffering: boolean) => void;
  setPlaylistEpisodeInfo: (info: { season: number; episode: number; title: string } | null) => void;
  setPlaybackIdentityItems: (items: PlaybackIdentityItem[]) => void;
  setPlaybackIdentityCurrentIndex: (index: number) => void;
  clearPlaybackIdentity: () => void;
  setPlayerProgress: (progress: number) => void;
  setCurrentPlayingTitle: (title: string | null) => void;
  setPlaybackTransitionActive: (active: boolean) => void;

  audioNormalizerEnabled: boolean;
  audioNormalizerPreset: string;
  audioNormalizerActive: boolean;
  audioNormalizerConnected: boolean;
  audioNormalizerReason: string;
  retryWhisperAction: (() => Promise<void>) | null;
  retryAudioNormalizerAction: (() => Promise<void>) | null;
  setAudioNormalizerEnabled: (enabled: boolean) => void;
  setAudioNormalizerPreset: (preset: string) => void;
  setAudioNormalizerActive: (active: boolean) => void;
  setAudioNormalizerConnected: (connected: boolean) => void;
  setAudioNormalizerReason: (reason: string) => void;
  setRetryWhisperAction: (action: (() => Promise<void>) | null) => void;
  setRetryAudioNormalizerAction: (action: (() => Promise<void>) | null) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set, get): AppState => ({
      view: 'board',
      previousView: null,
      selectedMeta: null,
      selectedCatalog: null,
      selectedStream: null,
      addonTransferSessionId: null,
      continueWatching: [],
      continueWatchingView: [],
      watchlist: [],
      watched: [],
      searchQuery: '',
      searchResults: [],
      isSearching: false,
      isLoading: false,
      traktConnected: false,
      traktToken: null,
      traktLastSync: null,
      boardScrollPosition: 0,
      catalogScrollPosition: 0,
      catalogItems: [],
      catalogPage: 1,
      catalogCacheKey: '',
      discoverScrollPosition: 0,
      discoverItems: [],
      discoverPage: 1,
      discoverCacheKey: '',
      discoverFilter: 'all',
      discoverMode: 'browse',
      discoverGenre: null,
      discoverYear: null,
      discoverLanguage: null,
      discoverMinRating: 0,
      discoverMaxRating: 10,
      discoverSearchQuery: '',
      discoverListState: {
        cacheKey: '',
        lists: [],
        selectedList: null,
        items: [],
        total: 0,
        complete: true,
        resumePage: 1,
        itemFilter: 'all',
        genre: null,
        year: null,
        language: null,
        minRating: 0,
        maxRating: 10,
        watchFilter: 'all',
        sort: 'list',
      },
      watchlistScrollPosition: 0,
      watchlistPage: 1,
      historyScrollPosition: 0,
      historyPage: 1,
      calendarScrollPosition: 0,
      downloadStats: {
        status: 'idle',
        downloaded: 0,
        total: 0,
        downloadSpeed: 0,
        peers: { connected: 0, seeders: 0, leechers: 0 },
        progress: 0,
        torrentName: '',
        pieces: { ready: 0, total: 0 },
        bitfield: []
      },
      subtitleAssist: {
        status: 'idle',
        message: 'Subtitles disabled',
        progress: 0
      },
      whisperProcessedSeconds: null,
      watchedEpisodes: {},
      pendingTraktHistory: [],
      pendingTraktWatchlist: [],
      playlistActive: false,
      playlistTorrentHash: null,
      playlistFiles: [],
      playlistCurrentIndex: 0,
      playlistTotalFiles: 0,
      playlistIsBuffering: false,
      playlistEpisodeInfo: null,
      playbackIdentityItems: [],
      playbackIdentityCurrentIndex: 0,
      playerProgress: 0,
      currentPlayingTitle: null,
      playbackTransitionActive: false,

      setView: (view) => set((state) => {
        let resets = {};
        
        // Reset scroll/page state when leaving a tab
        if (state.view === 'catalog' && view !== 'catalog' && view !== 'meta') {
          resets = { ...resets, catalogScrollPosition: 0, catalogPage: 1 };
        }
        if (state.view === 'search' && view !== 'search' && view !== 'meta') {
          resets = { ...resets, discoverScrollPosition: 0, discoverPage: 1 };
        }
        if (state.view === 'watchlist' && view !== 'watchlist' && view !== 'meta') {
          resets = { ...resets, watchlistScrollPosition: 0, watchlistPage: 1 };
        }
        if (state.view === 'history' && view !== 'history' && view !== 'meta') {
          resets = { ...resets, historyScrollPosition: 0, historyPage: 1 };
        }
        
        return { ...resets, view, previousView: state.view };
      }),
      setSelectedMeta: (selectedMeta, fromView) => set((state) => ({ 
        selectedMeta, 
        view: selectedMeta ? 'meta' : (state.previousView || fromView || 'board'),
        previousView: selectedMeta ? (fromView || state.view) : null
      })),
      openCatalogMeta: (selectedMeta, catalogScrollPosition) => set({
        selectedMeta,
        catalogScrollPosition,
        view: 'meta',
        previousView: 'catalog'
      }),
      setSelectedCatalog: (selectedCatalog) => set((state) => ({ 
        selectedCatalog, 
        view: selectedCatalog ? 'catalog' : 'board',
        previousView: selectedCatalog ? state.view : null,
        ...(!selectedCatalog ? { catalogScrollPosition: 0, catalogPage: 1 } : {})
      })),
      setSelectedStream: (selectedStream) => set({ selectedStream, view: selectedStream ? 'player' : 'meta' }),
      setAddonTransferSessionId: (addonTransferSessionId) => set({ addonTransferSessionId }),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setSearchResults: (searchResults) => set({ searchResults }),
      setIsSearching: (isSearching) => set({ isSearching }),
      setIsLoading: (isLoading) => set({ isLoading }),
      setBoardScrollPosition: (boardScrollPosition) => set({ boardScrollPosition }),
      setCatalogScrollPosition: (catalogScrollPosition) => set({ catalogScrollPosition }),
      setCatalogItems: (catalogItems) => set({ catalogItems }),
      setCatalogPage: (catalogPage) => set({ catalogPage }),
      setCatalogCacheKey: (catalogCacheKey) => set({ catalogCacheKey }),
      setDiscoverScrollPosition: (discoverScrollPosition) => set({ discoverScrollPosition }),
      setDiscoverItems: (discoverItems) => set({ discoverItems }),
      setDiscoverPage: (discoverPage) => set({ discoverPage }),
      setDiscoverCacheKey: (discoverCacheKey) => set({ discoverCacheKey }),
      setDiscoverFilter: (discoverFilter) => set({ discoverFilter }),
      setDiscoverMode: (discoverMode) => set({ discoverMode }),
      setDiscoverGenre: (discoverGenre) => set({ discoverGenre }),
      setDiscoverYear: (discoverYear) => set({ discoverYear }),
      setDiscoverLanguage: (discoverLanguage) => set({ discoverLanguage }),
      setDiscoverRatingRange: (min: number, max: number) => set({ discoverMinRating: min, discoverMaxRating: max }),
      setDiscoverSearchQuery: (discoverSearchQuery) => set({ discoverSearchQuery }),
      updateDiscoverListState: (update) => set((state) => ({
        discoverListState: {
          ...state.discoverListState,
          ...(typeof update === 'function' ? update(state.discoverListState) : update),
        },
      })),
      resetDiscoverListState: (cacheKey = '') => set({
        discoverListState: {
          cacheKey,
          lists: [],
          selectedList: null,
          items: [],
          total: 0,
          complete: true,
          resumePage: 1,
          itemFilter: 'all',
          genre: null,
          year: null,
          language: null,
          minRating: 0,
          maxRating: 10,
          watchFilter: 'all',
          sort: 'list',
        },
      }),
      setWatchlistScrollPosition: (watchlistScrollPosition) => set({ watchlistScrollPosition }),
      setWatchlistPage: (watchlistPage) => set({ watchlistPage }),
      setHistoryScrollPosition: (historyScrollPosition) => set({ historyScrollPosition }),
      setHistoryPage: (historyPage) => set({ historyPage }),
      setCalendarScrollPosition: (calendarScrollPosition) => set({ calendarScrollPosition }),

      addToWatchlist: (meta) => set((state) => {
        const existing = state.watchlist.find((m) => m.id === meta.id);
        if (existing) {
          return {
            watchlist: state.watchlist.map(m =>
              m.id === meta.id
                ? {
                    ...m,
                    ...meta,
                    listedAt: meta.listedAt ?? m.listedAt
                  }
                : m
            )
          };
        }
        return { watchlist: [{ ...meta, listedAt: meta.listedAt ?? new Date().toISOString() }, ...state.watchlist] };
      }),

      removeFromWatchlist: (metaId) => set((state) => ({
        watchlist: state.watchlist.filter((m) => m.id !== metaId)
      })),

      setWatchlist: (watchlist) => set({ watchlist }),

      addToWatched: (meta) => set((state) => {
        const existing = state.watched.find((m) => m.id === meta.id);
        if (existing) {
          return {
            watched: state.watched.map(m =>
              m.id === meta.id
                ? {
                    ...m,
                    ...meta,
                    watchedAt: meta.watchedAt ?? m.watchedAt
                  }
                : m
            )
          };
        }
        return { watched: [...state.watched, meta] };
      }),

      removeFromWatched: (metaId) => set((state) => ({
        watched: state.watched.filter((m) => m.id !== metaId)
      })),

      setWatched: (watched) => set({ watched }),

      addToContinueWatching: (item) => set((state) => {
        const normalizedItem = normalizeContinueWatchingItem(item);
        const filtered = state.continueWatching.filter(
          (i) => !isSameContinueMetaId(i.metaId, normalizedItem.metaId, i.type, normalizedItem.type)
        );
        return { continueWatching: [normalizedItem, ...filtered] };
      }),

      removeFromContinueWatching: (metaId) => set((state) => ({
        continueWatching: state.continueWatching.filter((i) => !isSameContinueMetaId(i.metaId, metaId, i.type)),
        continueWatchingView: state.continueWatchingView.filter((i) => !isSameContinueMetaId(i.metaId, metaId, i.type))
      })),

      updateContinueWatchingProgress: (metaId, progress, details) => set((state) => ({
        continueWatching: state.continueWatching.map((item) =>
          isSameContinueMetaId(item.metaId, metaId, item.type, details?.type)
            ? {
                ...item,
                ...details,
                metaId: normalizeContinueMetaId(metaId, details?.type ?? item.type),
                progress,
                pausedAt: new Date().toISOString()
              }
            : item
        )
      })),

      setContinueWatching: (items) => set({ continueWatching: normalizeContinueWatchingItems(items) }),
      setContinueWatchingView: (items) => set({ continueWatchingView: items }),


      setTraktConnected: (traktConnected) => set({ traktConnected }),
      setTraktToken: (traktToken) => set({ traktToken }),
      setTraktLastSync: (traktLastSync) => set({ traktLastSync }),
      setDownloadStats: (stats) => set((state) => ({ 
        downloadStats: { ...state.downloadStats, ...stats } 
      })),
      resetDownloadStats: () => set({
        downloadStats: {
          status: 'idle',
          downloaded: 0,
          total: 0,
          downloadSpeed: 0,
          peers: { connected: 0, seeders: 0, leechers: 0 },
          progress: 0,
          torrentName: '',
          pieces: { ready: 0, total: 0 },
          bitfield: []
        }
      }),
      setSubtitleAssist: (state) => set((current) => ({
        subtitleAssist: {
          ...current.subtitleAssist,
          ...state
        }
      })),
      clearSubtitleAssist: () => set({
        subtitleAssist: {
          status: 'idle',
          message: 'Subtitles disabled',
          progress: 0
        }
      }),
      setWhisperProcessedSeconds: (whisperProcessedSeconds: number | null) => set({ whisperProcessedSeconds }),

      markEpisodeWatched: (tmdbId: string, season: number, episode: number, watchedAt?: string) => set((state) => ({
        watchedEpisodes: {
          ...state.watchedEpisodes,
          [`${tmdbId}:${season}:${episode}`]: watchedAt || new Date().toISOString()
        }
      })),

      setWatchedEpisodes: (watchedEpisodes) => set({ watchedEpisodes }),

      markEpisodeUnwatched: (tmdbId: string, season: number, episode: number) => set((state) => {
        const key = `${tmdbId}:${season}:${episode}`;
        const newWatched = { ...state.watchedEpisodes };
        delete newWatched[key];
        return { watchedEpisodes: newWatched };
      }),

      markSeasonWatched: (tmdbId: string, seasonNumber: number, episodes: number[], watchedAt?: string) => set((state) => {
        const timestamp = watchedAt || new Date().toISOString();
        const newWatched = { ...state.watchedEpisodes };
        for (const ep of episodes) {
          newWatched[`${tmdbId}:${seasonNumber}:${ep}`] = timestamp;
        }
        return { watchedEpisodes: newWatched };
      }),

      markSeasonUnwatched: (tmdbId: string, seasonNumber: number, episodes: number[]) => set((state) => {
        const newWatched = { ...state.watchedEpisodes };
        for (const ep of episodes) {
          delete newWatched[`${tmdbId}:${seasonNumber}:${ep}`];
        }
        return { watchedEpisodes: newWatched };
      }),

      isEpisodeWatched: (tmdbId: string, season: number, episode: number) => !!get().watchedEpisodes[`${tmdbId}:${season}:${episode}`],

      queuePendingTraktHistory: (action: Omit<PendingTraktHistoryAction, 'queuedAt'> & { queuedAt?: string }) => set((state) => {
        const queuedAt = action.queuedAt ?? new Date().toISOString();
        const nextAction: PendingTraktHistoryAction = { ...action, queuedAt };
        const filtered = state.pendingTraktHistory.filter((item) =>
          !(
            item.mediaType === nextAction.mediaType &&
            item.metaId === nextAction.metaId &&
            item.season === nextAction.season &&
            item.episode === nextAction.episode
          )
        );
        return { pendingTraktHistory: [...filtered, nextAction] };
      }),

      removePendingTraktHistory: (action: PendingTraktHistoryAction) => set((state) => ({
        pendingTraktHistory: state.pendingTraktHistory.filter((item) =>
          !(
            item.action === action.action &&
            item.mediaType === action.mediaType &&
            item.metaId === action.metaId &&
            item.season === action.season &&
            item.episode === action.episode
          )
        )
      })),

      clearPendingTraktHistory: () => set({ pendingTraktHistory: [] }),

      queuePendingTraktWatchlist: (action: Omit<PendingTraktWatchlistAction, 'queuedAt'> & { queuedAt?: string }) => set((state) => {
        const queuedAt = action.queuedAt ?? new Date().toISOString();
        const nextAction: PendingTraktWatchlistAction = { ...action, queuedAt };
        const filtered = state.pendingTraktWatchlist.filter((item) =>
          !(item.mediaType === nextAction.mediaType && item.metaId === nextAction.metaId)
        );
        return { pendingTraktWatchlist: [...filtered, nextAction] };
      }),

      removePendingTraktWatchlist: (action: PendingTraktWatchlistAction) => set((state) => ({
        pendingTraktWatchlist: state.pendingTraktWatchlist.filter((item) =>
          !(item.action === action.action && item.mediaType === action.mediaType && item.metaId === action.metaId)
        )
      })),

      clearPendingTraktWatchlist: () => set({ pendingTraktWatchlist: [] }),
      
      setPlaylistActive: (active: boolean) => set({ playlistActive: active }),
      setPlaylistTorrentHash: (hash: string | null) => set({ playlistTorrentHash: hash }),
      setPlaylistFiles: (files: PlaylistFile[]) => set({ playlistFiles: files }),
      setPlaylistCurrentIndex: (index: number) => set({ playlistCurrentIndex: index }),
      setPlaylistTotalFiles: (total: number) => set({ playlistTotalFiles: total }),
      setPlaylistIsBuffering: (buffering: boolean) => set({ playlistIsBuffering: buffering }),
      setPlaylistEpisodeInfo: (info: { season: number; episode: number; title: string } | null) => set({ playlistEpisodeInfo: info }),
      setPlaybackIdentityItems: (items: PlaybackIdentityItem[]) => set({ playbackIdentityItems: items, playbackIdentityCurrentIndex: 0 }),
      setPlaybackIdentityCurrentIndex: (index: number) => set({ playbackIdentityCurrentIndex: index }),
      clearPlaybackIdentity: () => set({ playbackIdentityItems: [], playbackIdentityCurrentIndex: 0 }),
      setPlayerProgress: (progress: number) => set({ playerProgress: progress }),
      setCurrentPlayingTitle: (title: string | null) => set({ currentPlayingTitle: title }),
      setPlaybackTransitionActive: (playbackTransitionActive: boolean) => set({ playbackTransitionActive }),

      audioNormalizerEnabled: false,
      audioNormalizerPreset: 'medium',
      audioNormalizerActive: false,
      audioNormalizerConnected: false,
      audioNormalizerReason: 'no_data',
      retryWhisperAction: null,
      retryAudioNormalizerAction: null,
      setAudioNormalizerEnabled: (enabled: boolean) => {
        if (get().audioNormalizerEnabled !== enabled) set({ audioNormalizerEnabled: enabled });
      },
      setAudioNormalizerPreset: (preset: string) => {
        const audioNormalizerPreset = normalizeAudioNormalizerPreset(preset);
        if (get().audioNormalizerPreset !== audioNormalizerPreset) set({ audioNormalizerPreset });
      },
      setAudioNormalizerActive: (audioNormalizerActive: boolean) => {
        if (get().audioNormalizerActive !== audioNormalizerActive) set({ audioNormalizerActive });
      },
      setAudioNormalizerConnected: (audioNormalizerConnected: boolean) => {
        if (get().audioNormalizerConnected !== audioNormalizerConnected) set({ audioNormalizerConnected });
      },
      setAudioNormalizerReason: (audioNormalizerReason: string) => {
        if (get().audioNormalizerReason !== audioNormalizerReason) set({ audioNormalizerReason });
      },
      setRetryWhisperAction: (retryWhisperAction) => set({ retryWhisperAction }),
      setRetryAudioNormalizerAction: (retryAudioNormalizerAction) => set({ retryAudioNormalizerAction }),
    }),
    {
      name: 'streamee-storage',
      version: 3,
      storage: createJSONStorage(() => deduplicatedRendererStorage),
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState as AppState;
        }

        const nextState = persistedState as Partial<AppState> & { audioNormalizerPreset?: unknown };
        return {
          ...nextState,
          audioNormalizerPreset: normalizeAudioNormalizerPreset(nextState.audioNormalizerPreset),
          continueWatching: normalizeContinueWatchingItems(nextState.continueWatching),
          continueWatchingView: Array.isArray(nextState.continueWatchingView) ? nextState.continueWatchingView : [],
        } as AppState;
      },
      partialize: (state) => ({
        watchlist: state.watchlist,
        watched: state.watched,
        continueWatching: state.continueWatching,
        continueWatchingView: state.continueWatchingView,
        traktConnected: state.traktConnected,
        traktToken: state.traktToken,
        traktLastSync: state.traktLastSync,
        watchedEpisodes: state.watchedEpisodes,
        pendingTraktHistory: state.pendingTraktHistory,
        pendingTraktWatchlist: state.pendingTraktWatchlist,
        audioNormalizerEnabled: state.audioNormalizerEnabled,
        audioNormalizerPreset: state.audioNormalizerPreset
      })
    }
  )
);
