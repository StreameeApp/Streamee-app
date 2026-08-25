import React, { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { MetaPreview, useStore } from './store';
import Board from './features/board/Board';
import Search from './features/search/Search';
import Catalog from './features/catalog/Catalog';
import MetaDetails from './features/meta/MetaDetails';
import Player from './features/player/Player';
import Watchlist from './features/watchlist/Watchlist';
import Settings from './features/settings/Settings';
import Calendar from './features/trakt/Calendar';
import History from './features/history/History';
import Statistics from './features/statistics/Statistics';
import AudioNormalizer from './features/audio-normalizer/AudioNormalizer';
import Sidebar from './components/Sidebar';
import { checkTraktConnection, pushEpisodeWatchedToTrakt, pushWatchedToTrakt, autoSyncOnStart } from './services/trakt-sync';
import { extractEpisodeNumber } from './services/torrent-utils';
import {
  endPlaybackSession,
  flushStatistics,
  recordMediaCompleted,
  recordPlaybackSample,
  recordTransferredBytes,
} from './services/statistics';
import { openAudioNormalizerWindow } from './services/audio-normalizer-window';
import { checkForUpdates } from './services/updater';
import './styles/app.css';

type ActiveEpisodeInfo = { season: number; episode: number; title: string };
type PlayerProgressPayload = {
  percent_pos?: number | null;
  playback_time?: number | null;
  duration?: number | null;
  filename?: string | null;
  playlist_pos?: number | null;
};

const PLAYBACK_SNAPSHOT_INTERVAL_MS = 20_000;
const DISCORD_PRESENCE_UPDATE_INTERVAL_MS = 30_000;

let currentPlayingMeta: {
  type: 'movie' | 'show';
  tmdbId: number;
  name?: string;
  poster?: string;
  imdbId?: string;
  season?: number;
  episode?: number;
} | null = null;
let lastProcessed80Percent: string | null = null;
let currentProgressBaseline: { key: string; percent: number } | null = null;
let lastPlaybackSnapshotSave: { key: string; savedAt: number } | null = null;
let lastDiscordPresenceUpdate: { signature: string; updatedAt: number } | null = null;
let lastDiscordPresencePlayback: {
  paused: boolean;
  playbackTime: number | null;
  duration: number | null;
} = {
  paused: false,
  playbackTime: null,
  duration: null,
};

const getPlayingMetaId = () => {
  if (!currentPlayingMeta) return null;
  return `${currentPlayingMeta.type === 'show' ? 'tv' : 'movie'}:${currentPlayingMeta.tmdbId}`;
};

const readDiscordPresenceEnabled = () => {
  try {
    const stored = localStorage.getItem('streamee-settings');
    if (!stored) return false;
    return !!JSON.parse(stored).discordPresenceEnabled;
  } catch (error) {
    console.warn('[Discord Presence] Failed to read settings:', error);
    return false;
  }
};

const formatEpisodeCode = (episodeInfo: ActiveEpisodeInfo) =>
  `S${episodeInfo.season.toString().padStart(2, '0')}E${episodeInfo.episode.toString().padStart(2, '0')}`;

const buildImdbTitleUrl = (imdbId?: string | null) => {
  const normalized = typeof imdbId === 'string' ? imdbId.trim() : '';
  return /^tt\d+$/.test(normalized)
    ? `https://www.imdb.com/title/${normalized}/`
    : null;
};

const validPlaybackNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const syncDiscordPresence = async (
  paused: boolean,
  event?: PlayerProgressPayload,
  force = false
) => {
  const enabled = readDiscordPresenceEnabled();
  if (!enabled || !currentPlayingMeta) {
    lastDiscordPresenceUpdate = null;
    await window.electronAPI.discordPresence.clear().catch(() => {});
    return;
  }

  const store = useStore.getState();
  const activeEpisodeInfo = getActiveEpisodeInfo(store, event);
  if (currentPlayingMeta.type === 'show' && !activeEpisodeInfo) {
    return;
  }

  const title = currentPlayingMeta.name || `TMDB ${currentPlayingMeta.tmdbId}`;
  const posterUrl = currentPlayingMeta.poster?.trim() || null;
  const subtitle = currentPlayingMeta.type === 'show' && activeEpisodeInfo
    ? formatEpisodeCode(activeEpisodeInfo)
    : null;
  const eventPlaybackTime = validPlaybackNumber(event?.playback_time);
  const eventDuration = validPlaybackNumber(event?.duration);
  const playbackTime = eventPlaybackTime ?? lastDiscordPresencePlayback.playbackTime;
  const duration = eventDuration && eventDuration > 0
    ? eventDuration
    : lastDiscordPresencePlayback.duration;
  lastDiscordPresencePlayback = {
    paused,
    playbackTime,
    duration,
  };
  const timeBucket = playbackTime === null ? 'none' : Math.floor(playbackTime / 30).toString();
  const durationBucket = duration === null ? 'no-duration' : Math.floor(duration).toString();
  const signature = [
    title,
    subtitle ?? '',
    posterUrl ?? '',
    paused ? 'paused' : 'playing',
    timeBucket,
    durationBucket,
  ].join('|');
  const now = Date.now();

  if (
    !force &&
    lastDiscordPresenceUpdate?.signature === signature &&
    now - lastDiscordPresenceUpdate.updatedAt < DISCORD_PRESENCE_UPDATE_INTERVAL_MS
  ) {
    return;
  }

  lastDiscordPresenceUpdate = { signature, updatedAt: now };
  await window.electronAPI.discordPresence.update({
    enabled,
    title,
    subtitle,
    paused,
    playback_time: playbackTime,
    duration,
    imdb_url: buildImdbTitleUrl(currentPlayingMeta.imdbId),
    poster_url: posterUrl,
  }).catch((error) => {
    console.warn('[Discord Presence] Update failed:', error);
  });
};

const clearDiscordPresence = async () => {
  lastDiscordPresenceUpdate = null;
  lastDiscordPresencePlayback = {
    paused: false,
    playbackTime: null,
    duration: null,
  };
  await window.electronAPI.discordPresence.clear().catch(() => {});
};

const persistCurrentSourceResumeSnapshot = (
  progress: number,
  activeEpisodeInfo: ActiveEpisodeInfo | null,
  playbackTime?: number,
  duration?: number,
  sourceFilename?: string
) => {
  if (!currentPlayingMeta) {
    return;
  }

  const key = `${currentPlayingMeta.type === 'show' ? 'series' : 'movie'}-${currentPlayingMeta.tmdbId}`;
  try {
    const storedMeta = JSON.parse(localStorage.getItem('streamee-last-source-meta') || '{}');
    const existing = storedMeta[key] || {};
    storedMeta[key] = {
      ...existing,
      ...(activeEpisodeInfo
        ? {
            preferredSeason: activeEpisodeInfo.season,
            preferredEpisode: activeEpisodeInfo.episode,
          }
        : {}),
      progress,
      ...(typeof playbackTime === 'number' ? { playbackTime } : {}),
      ...(typeof duration === 'number' ? { duration } : {}),
      ...(sourceFilename ? { sourceFilename } : {}),
    };
    localStorage.setItem('streamee-last-source-meta', JSON.stringify(storedMeta));
  } catch (error) {
    console.warn('[Resume Save] Failed to persist source resume snapshot:', error);
  }
};

const getPathBaseName = (path: string): string => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

const normalizeSourceIdentity = (value?: string | null) =>
  value ? value.replace(/\\/g, '/').toLowerCase() : '';

const getPlaybackIdentityIndexFromEvent = (
  store: ReturnType<typeof useStore.getState>,
  event?: PlayerProgressPayload
): number | null => {
  const items = store.playbackIdentityItems;
  if (items.length === 0) {
    return null;
  }

  const hasSnapshot = hasPlaybackSnapshot(event);
  const playlistIndex =
    typeof event?.playlist_pos === 'number' &&
    event.playlist_pos >= 0 &&
    event.playlist_pos < items.length
      ? event.playlist_pos
      : null;

  const filename = event?.filename || '';
  if (filename && hasSnapshot) {
    const normalizedFilename = normalizeSourceIdentity(filename);
    const baseName = normalizeSourceIdentity(getPathBaseName(filename));
    const filenameIndex = items.findIndex((item) => {
      const title = normalizeSourceIdentity(item.title);
      const sourceKey = normalizeSourceIdentity(item.sourceKey);
      const streamUrl = normalizeSourceIdentity(item.streamUrl);

      return (
        title === baseName ||
        title === normalizedFilename ||
        (!!streamUrl && (streamUrl === normalizedFilename || streamUrl.endsWith(`/${baseName}`))) ||
        (!!sourceKey && (sourceKey === normalizedFilename || normalizedFilename.includes(sourceKey)))
      );
    });

    if (filenameIndex !== -1) {
      return filenameIndex;
    }
  }

  if (playlistIndex !== null) {
    return playlistIndex;
  }

  if (filename) {
    const normalizedFilename = normalizeSourceIdentity(filename);
    const baseName = normalizeSourceIdentity(getPathBaseName(filename));
    const filenameIndex = items.findIndex((item) => {
      const title = normalizeSourceIdentity(item.title);
      const sourceKey = normalizeSourceIdentity(item.sourceKey);
      const streamUrl = normalizeSourceIdentity(item.streamUrl);

      return (
        title === baseName ||
        title === normalizedFilename ||
        (!!streamUrl && (streamUrl === normalizedFilename || streamUrl.endsWith(`/${baseName}`))) ||
        (!!sourceKey && (sourceKey === normalizedFilename || normalizedFilename.includes(sourceKey)))
      );
    });

    if (filenameIndex !== -1) {
      return filenameIndex;
    }
  }

  return store.playbackIdentityCurrentIndex >= 0 && store.playbackIdentityCurrentIndex < items.length
    ? store.playbackIdentityCurrentIndex
    : null;
};

const getPlaylistIndexFromPlayerEvent = (
  store: ReturnType<typeof useStore.getState>,
  event?: PlayerProgressPayload
): number | null => {
  if (!store.playlistActive || !event) {
    return null;
  }

  const files = store.playlistFiles;
  if (files.length === 0) {
    return null;
  }

  let filenameIndex = -1;
  const filename = event.filename || '';
  if (filename) {
    const baseName = getPathBaseName(filename);
    const normalizedFilename = filename.replace(/\\/g, '/');
    filenameIndex = files.findIndex((file) => {
      if (file.name === baseName || file.name === filename) {
        return true;
      }

      if (file.streamUrl && (file.streamUrl === filename || file.streamUrl.replace(/\\/g, '/') === normalizedFilename)) {
        return true;
      }

      return normalizedFilename.includes(`/stream/${file.index}`);
    });
  }

  const playlistIndex =
    typeof event.playlist_pos === 'number' &&
    event.playlist_pos >= 0 &&
    event.playlist_pos < files.length
      ? event.playlist_pos
      : null;

  if (filenameIndex !== -1 && playlistIndex !== null && filenameIndex !== playlistIndex) {
    const hasPlaybackSnapshot =
      typeof event.percent_pos === 'number' ||
      typeof event.playback_time === 'number' ||
      typeof event.duration === 'number';
    const hasFilenameEvidence = !!filename;

    console.warn(
      `[Progress] Playlist event filename disagrees with position; using ${
        hasPlaybackSnapshot || hasFilenameEvidence ? 'filename' : 'playlist position'
      }:`,
      {
      filename,
      filenameIndex,
      playlistIndex,
      }
    );

    return hasPlaybackSnapshot || (hasFilenameEvidence && playlistIndex === null)
      ? filenameIndex
      : playlistIndex;
  }

  if (playlistIndex !== null) {
    return playlistIndex;
  }

  if (filenameIndex !== -1) {
    return filenameIndex;
  }

  return null;
};

const hasPlaybackSnapshot = (event?: PlayerProgressPayload) =>
  !!event &&
  (
    typeof event.percent_pos === 'number' ||
    typeof event.playback_time === 'number' ||
    typeof event.duration === 'number'
  );

const getEpisodeInfoFromEventFilename = (
  event: PlayerProgressPayload | undefined,
  preferredSeason: number
): ActiveEpisodeInfo | null => {
  if (!event?.filename) {
    return null;
  }

  const title = getPathBaseName(event.filename);
  const episodeInfo = extractEpisodeNumber(title, preferredSeason);
  return episodeInfo
    ? {
        season: episodeInfo.season,
        episode: episodeInfo.episode,
        title,
      }
    : null;
};

const getActiveEpisodeInfo = (
  store: ReturnType<typeof useStore.getState>,
  event?: PlayerProgressPayload
): ActiveEpisodeInfo | null => {
  if (!currentPlayingMeta || currentPlayingMeta.type !== 'show') {
    return null;
  }

  const identityIndex = getPlaybackIdentityIndexFromEvent(store, event);
  const identity = identityIndex !== null ? store.playbackIdentityItems[identityIndex] : null;
  if (typeof identity?.season === 'number' && typeof identity.episode === 'number') {
    return {
      season: identity.season,
      episode: identity.episode,
      title: identity.title,
    };
  }

  if (hasPlaybackSnapshot(event)) {
    const filenameEpisodeInfo = getEpisodeInfoFromEventFilename(
      event,
      currentPlayingMeta.season ?? 1
    );
    if (filenameEpisodeInfo) {
      return filenameEpisodeInfo;
    }
  }

  if (store.playlistActive && event) {
    const playlistIndex = getPlaylistIndexFromPlayerEvent(store, event);
    if (playlistIndex === null) {
      return getEpisodeInfoFromEventFilename(event, currentPlayingMeta.season ?? 1);
    }

    const file = store.playlistFiles[playlistIndex];
    const episodeInfo = file ? extractEpisodeNumber(file.name, currentPlayingMeta.season ?? 1) : null;
    return episodeInfo
      ? {
          season: episodeInfo.season,
          episode: episodeInfo.episode,
          title: file.name,
        }
      : null;
  }

  if (event?.filename) {
    const episodeInfo = extractEpisodeNumber(
      getPathBaseName(event.filename),
      currentPlayingMeta.season ?? 1
    );
    if (episodeInfo) {
      return {
        season: episodeInfo.season,
        episode: episodeInfo.episode,
        title: getPathBaseName(event.filename),
      };
    }
  }

  return store.playlistEpisodeInfo ?? (
    currentPlayingMeta.season !== undefined && currentPlayingMeta.episode !== undefined
      ? {
          season: currentPlayingMeta.season,
          episode: currentPlayingMeta.episode,
          title: currentPlayingMeta.name || `TMDB ${currentPlayingMeta.tmdbId}`
        }
      : null
  );
};

const syncCurrentPlayingEpisode = (episodeInfo: ActiveEpisodeInfo | null) => {
  if (!currentPlayingMeta || currentPlayingMeta.type !== 'show' || !episodeInfo) {
    return;
  }

  currentPlayingMeta = {
    ...currentPlayingMeta,
    season: episodeInfo.season,
    episode: episodeInfo.episode,
  };
};

const upsertContinueWatchingProgress = (
  store: ReturnType<typeof useStore.getState>,
  progress: number,
  episodeInfo?: ActiveEpisodeInfo | null,
  event?: PlayerProgressPayload,
  forceSave = false
) => {
  if (!currentPlayingMeta || progress <= 0) {
    return;
  }

  const metaId = getPlayingMetaId();
  if (!metaId) return;

  const activeMeta = store.selectedMeta;
  const existingItem = store.continueWatching.find(c => c.metaId === metaId);
  const isWatched = store.watched.some(w => w.id === metaId);
  const existingWatched = store.watched.find(w => w.id === metaId);
  const existingWatchlist = store.watchlist.find(w => w.id === metaId);
  const rating = existingItem?.rating ?? activeMeta?.rating ?? activeMeta?.tmdbRating ?? existingWatched?.rating ?? existingWatchlist?.rating;
  const activeEpisodeInfo = episodeInfo !== undefined ? episodeInfo : getActiveEpisodeInfo(store);
  syncCurrentPlayingEpisode(activeEpisodeInfo);

  if (currentPlayingMeta.type === 'show' && !activeEpisodeInfo) {
    console.warn('[Resume Save] Skipping show progress without a verified episode identity:', {
      metaId,
      progress,
    });
    return;
  }

  if (currentPlayingMeta.type === 'show') {
    console.log(
      `%c[Resume Save]%c metaId=${metaId}, progress=${progress.toFixed(2)}, activeEpisode=${
        activeEpisodeInfo ? `S${activeEpisodeInfo.season}E${activeEpisodeInfo.episode}` : 'none'
      }, playlistEpisode=${
        store.playlistEpisodeInfo
          ? `S${store.playlistEpisodeInfo.season}E${store.playlistEpisodeInfo.episode}`
          : 'none'
      }, currentPlayingMeta=${
        currentPlayingMeta.season !== undefined && currentPlayingMeta.episode !== undefined
          ? `S${currentPlayingMeta.season}E${currentPlayingMeta.episode}`
          : 'none'
      }`,
      'color: #f59e0b; font-weight: bold',
      'color: inherit'
    );
  }

  const snapshotKey = activeEpisodeInfo && metaId
    ? `${metaId}:${activeEpisodeInfo.season}:${activeEpisodeInfo.episode}`
    : metaId;
  const now = Date.now();
  if (
    !forceSave &&
    lastPlaybackSnapshotSave?.key === snapshotKey &&
    now - lastPlaybackSnapshotSave.savedAt < PLAYBACK_SNAPSHOT_INTERVAL_MS
  ) {
    return;
  }
  lastPlaybackSnapshotSave = { key: snapshotKey, savedAt: now };

  const playbackTime =
    typeof event?.playback_time === 'number' && event.playback_time >= 0
      ? event.playback_time
      : undefined;
  const duration =
    typeof event?.duration === 'number' && event.duration > 0
      ? event.duration
      : undefined;
  const sourceFilename = event?.filename || activeEpisodeInfo?.title;
  const snapshotDetails = {
    ...(activeEpisodeInfo ? {
      season: activeEpisodeInfo.season,
      episode: activeEpisodeInfo.episode,
      episodeId: `${activeEpisodeInfo.season}:${activeEpisodeInfo.episode}`,
    } : {}),
    title: currentPlayingMeta.name || existingItem?.title,
    playbackTime,
    duration,
    sourceFilename
  };
  persistCurrentSourceResumeSnapshot(
    progress,
    activeEpisodeInfo,
    playbackTime,
    duration,
    sourceFilename
  );

  if (existingItem) {
    if (!isWatched || activeEpisodeInfo) {
      store.updateContinueWatchingProgress(metaId, progress, snapshotDetails);
    }
  } else if (!isWatched || activeEpisodeInfo) {
    const type = currentPlayingMeta.type === 'show' ? 'series' : 'movie';
    const title = currentPlayingMeta.name || `TMDB ${currentPlayingMeta.tmdbId}`;
    const poster = currentPlayingMeta.poster || '';
    store.addToContinueWatching({
      metaId,
      type,
      title,
      poster,
      progress,
      rating,
      pausedAt: new Date().toISOString(),
      playbackTime,
      duration,
      sourceFilename,
      season: activeEpisodeInfo?.season,
      episode: activeEpisodeInfo?.episode,
      episodeId: activeEpisodeInfo ? `${activeEpisodeInfo.season}:${activeEpisodeInfo.episode}` : undefined
    });
  }
};

export function flushCurrentPlayingProgress(progressOverride?: number, event?: PlayerProgressPayload) {
  const store = useStore.getState();
  const progress =
    typeof progressOverride === 'number'
      ? progressOverride
      : typeof event?.percent_pos === 'number'
        ? event.percent_pos
        : store.playerProgress;
  if (!currentPlayingMeta || progress <= 0) {
    return;
  }

  const activeEpisodeInfo = getActiveEpisodeInfo(store, event);
  if (activeEpisodeInfo?.title) {
    store.setCurrentPlayingTitle(activeEpisodeInfo.title);
  }
  upsertContinueWatchingProgress(store, progress, activeEpisodeInfo, event, true);
}

export function setCurrentPlayingMeta(meta: {
  type: 'movie' | 'series';
  tmdbId: number;
  name?: string;
  poster?: string;
  imdbId?: string;
  season?: number;
  episode?: number;
} | null) {
  currentPlayingMeta = meta ? {
    type: meta.type === 'series' ? 'show' : 'movie',
    tmdbId: meta.tmdbId,
    name: meta.name,
    poster: meta.poster,
    imdbId: meta.imdbId,
    season: meta.season,
    episode: meta.episode
  } : null;
  lastProcessed80Percent = null;
  currentProgressBaseline = null;
  lastPlaybackSnapshotSave = null;
  lastDiscordPresenceUpdate = null;
  lastDiscordPresencePlayback = {
    paused: false,
    playbackTime: null,
    duration: null,
  };
}

const App: React.FC = () => {
  const PLAYER_CLOSE_GRACE_MS = 750;
  const PLAYER_CLOSE_CHECK_ATTEMPTS = 3;
  const PLAYER_CLOSE_CHECK_INTERVAL_MS = 250;
  const { view, selectedMeta, setView, setTraktConnected, setDownloadStats, resetDownloadStats } = useStore(useShallow((state) => ({
    view: state.view,
    selectedMeta: state.selectedMeta,
    setView: state.setView,
    setTraktConnected: state.setTraktConnected,
    setDownloadStats: state.setDownloadStats,
    resetDownloadStats: state.resetDownloadStats,
  })));
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable = !!target?.closest('[contenteditable="true"]') || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
      if (isEditable) return;

      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void openAudioNormalizerWindow().catch((error) => {
          console.error('[AudioNormalizer] Failed to open telemetry window:', error);
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    let isDisposed = false;
    const unlisteners: Array<() => void> = [];
    let audioNormalizerTelemetryUnlisten: (() => void) | null = null;
    let statisticsTransferUnlisten: (() => void) | null = null;
    let torrentProgressUnlisten: (() => void) | null = null;
    let closeTimeout: NodeJS.Timeout | null = null;
    let traktSyncTimeout: number | null = null;

    const initApp = async () => {
      void checkForUpdates();

      const connected = await checkTraktConnection();
      if (!isDisposed) {
        setTraktConnected(connected);
      }
      if (connected && !isDisposed) {
        traktSyncTimeout = window.setTimeout(() => {
          if (!isDisposed) {
            autoSyncOnStart().catch(console.error);
          }
        }, 1500);
      }

      const discordPresenceSetting = await window.electronAPI.settings.getSetting('discordPresenceEnabled');
      const discordPresenceEnabled = discordPresenceSetting === 'true' || readDiscordPresenceEnabled();
      await window.electronAPI.discordPresence.setEnabled(discordPresenceEnabled).catch(() => {});
    };

    const setupPlayerEvents = async () => {
      unlisteners.push(await window.electronAPI.playerEvents.onPlay(async (data) => {
        if (isDisposed) return;
        await syncDiscordPresence(false, data, true);
      }));

      unlisteners.push(await window.electronAPI.playerEvents.onPause(async (data) => {
        if (isDisposed) return;
        await syncDiscordPresence(true, data, true);
        flushCurrentPlayingProgress(undefined, data);
        flushStatistics();
      }));

      unlisteners.push(await window.electronAPI.playerEvents.onStop(async (data) => {
        if (isDisposed) return;
        await clearDiscordPresence();
        flushCurrentPlayingProgress(undefined, data);
        endPlaybackSession();
      }));

      unlisteners.push(await window.electronAPI.playerEvents.onProgress(async (data) => {
        if (isDisposed) return;

        const store = useStore.getState();
        const percentPos = typeof data.percent_pos === 'number' ? data.percent_pos : 0;
        const activeEpisodeInfo = getActiveEpisodeInfo(store, data);

        if (currentPlayingMeta?.type === 'show' && !activeEpisodeInfo) {
          return;
        }

        store.setPlayerProgress(percentPos);
        const identityIndex = getPlaybackIdentityIndexFromEvent(store, data);
        if (identityIndex !== null) {
          store.setPlaybackIdentityCurrentIndex(identityIndex);
        }
        if (store.playlistActive) {
          const playlistIndex = getPlaylistIndexFromPlayerEvent(store, data);
          if (playlistIndex !== null) {
            store.setPlaylistCurrentIndex(playlistIndex);
          }
        }
        if (activeEpisodeInfo?.title) {
          syncCurrentPlayingEpisode(activeEpisodeInfo);
          // Progress snapshots are a continuous recovery path when the one-shot
          // playlist transition event arrives before the renderer queue is ready.
          store.setCurrentPlayingTitle(activeEpisodeInfo.title);
          store.setPlaylistEpisodeInfo({
            season: activeEpisodeInfo.season,
            episode: activeEpisodeInfo.episode,
            title: activeEpisodeInfo.title,
          });
        }
        
        if (currentPlayingMeta && percentPos > 0) {
          await syncDiscordPresence(lastDiscordPresencePlayback.paused, data);

          const metaId = getPlayingMetaId();
          if (!metaId) {
            return;
          }
          const episodeKey = activeEpisodeInfo && metaId
            ? `${metaId}:${activeEpisodeInfo.season}:${activeEpisodeInfo.episode}`
            : metaId;
          if (typeof data.playback_time === 'number') {
            recordPlaybackSample({
              mediaKey: episodeKey,
              mediaType: currentPlayingMeta.type === 'show' ? 'series' : 'movie',
              playbackTime: data.playback_time,
            });
          }

          // Zustand setters are synchronous, but `store` is the snapshot from the
          // start of this callback. Re-read it so resume/sidebar diagnostics cannot
          // trail the active episode by one playlist item.
          upsertContinueWatchingProgress(useStore.getState(), percentPos, activeEpisodeInfo, data);

          const activeMeta = store.selectedMeta;
          const existingWatched = store.watched.find(w => w.id === metaId);
          const existingWatchlist = store.watchlist.find(w => w.id === metaId);
          const rating = activeMeta?.rating ?? activeMeta?.tmdbRating ?? existingWatched?.rating ?? existingWatchlist?.rating;
          const year = activeMeta?.year ?? existingWatched?.year ?? existingWatchlist?.year;

          if (!currentProgressBaseline || currentProgressBaseline.key !== episodeKey) {
            currentProgressBaseline = {
              key: episodeKey,
              percent: percentPos
            };
          }
          
          const baselinePercent = currentProgressBaseline?.key === episodeKey
            ? currentProgressBaseline.percent
            : percentPos;
          const watchedThreshold = Math.min(100, Math.max(80, baselinePercent + 2));
          const hasMeaningfulProgressBeyondBaseline =
            percentPos >= 99.5 || percentPos >= watchedThreshold;

          if (hasMeaningfulProgressBeyondBaseline) {
            if (lastProcessed80Percent === episodeKey) {
              return;
            }
            lastProcessed80Percent = episodeKey;
            
            const watchedAt = new Date().toISOString();
            if (currentPlayingMeta.type === 'show' && activeEpisodeInfo && metaId) {
              const tmdbId = currentPlayingMeta.tmdbId.toString();
              const alreadyWatchedEpisode = !!store.watchedEpisodes[`${tmdbId}:${activeEpisodeInfo.season}:${activeEpisodeInfo.episode}`];
              console.log(`%c[Progress]%c Episode progress >= 80%: watched=${alreadyWatchedEpisode}, metaId=${metaId}, S${activeEpisodeInfo.season}E${activeEpisodeInfo.episode}`, 'color: #10b981; font-weight: bold', 'color: inherit');

              if (!alreadyWatchedEpisode) {
                store.markEpisodeWatched(tmdbId, activeEpisodeInfo.season, activeEpisodeInfo.episode, watchedAt);
                recordMediaCompleted('series');
                if (store.traktConnected) {
                  await pushEpisodeWatchedToTrakt(tmdbId, activeEpisodeInfo.season, activeEpisodeInfo.episode, watchedAt);
                }
              }
            } else if (currentPlayingMeta.type === 'movie' && metaId && !store.watched.some(w => w.id === metaId)) {
              const title = store.continueWatching.find(c => c.metaId === metaId)?.title || currentPlayingMeta.name || `TMDB ${currentPlayingMeta.tmdbId}`;
              const poster = store.continueWatching.find(c => c.metaId === metaId)?.poster || currentPlayingMeta.poster || '';

              console.log(`%c[Progress]%c Adding to watched: ${title}`, 'color: #10b981; font-weight: bold', 'color: inherit');
              const watchedMeta: MetaPreview = {
                id: metaId,
                type: 'movie',
                name: title,
                poster,
                year,
                rating,
                watchedAt
              };
              store.addToWatched(watchedMeta);
              recordMediaCompleted('movie');
              if (store.traktConnected) {
                await pushWatchedToTrakt(watchedMeta);
              }
            }
            
            if (currentPlayingMeta.type === 'movie' && metaId) {
              console.log(`%c[Progress]%c Removing from continueWatching: ${metaId}, current count=${store.continueWatching.length}`, 'color: #10b981; font-weight: bold', 'color: inherit');
              const updated = store.continueWatching.filter(c => c.metaId !== metaId);
              console.log(`%c[Progress]%c After filter: count=${updated.length}`, 'color: #10b981; font-weight: bold', 'color: inherit');
              store.setContinueWatching(updated);
            }
          }
        }
        
      }));

      unlisteners.push(await window.electronAPI.playerEvents.onPlaylistChanged(async (data) => {
        if (isDisposed) return;

        console.log('%c[Playlist]%c Atomic MPV transition received', 'color: #ff6b35; font-weight: bold', 'color: inherit', {
          playlistPos: data.playlist_pos,
          filename: data.filename,
          mediaTitle: data.media_title,
        });
        const store = useStore.getState();
        const activeEpisodeInfo = getActiveEpisodeInfo(store, data);
        if (!activeEpisodeInfo) {
          return;
        }

        syncCurrentPlayingEpisode(activeEpisodeInfo);
        await syncDiscordPresence(false, data, true);
      }));

      unlisteners.push(await window.electronAPI.playerEvents.onClosed(async (data) => {
        if (isDisposed) return;
        if (useStore.getState().playbackTransitionActive) {
          console.log('%c[Smart Next]%c Ignoring MPV close during playback transition', 'color: #ff6b35; font-weight: bold', 'color: inherit');
          return;
        }

        console.log('%c[Player]%c Player closed', 'color: #a78bfa; font-weight: bold', 'color: inherit');
         
        if (closeTimeout) {
          clearTimeout(closeTimeout);
        }

        closeTimeout = setTimeout(() => {
          void (async () => {
            if (isDisposed) return;

            for (let attempt = 0; attempt < PLAYER_CLOSE_CHECK_ATTEMPTS; attempt++) {
              try {
                const info = await window.electronAPI.getPlayerInfo();
                if (isDisposed) return;

                if (info?.connected) {
                  console.log('%c[Player]%c Close cancelled after liveness check', 'color: #a78bfa; font-weight: bold', 'color: inherit');
                  closeTimeout = null;
                  return;
                }
              } catch (_error) {
              }

              if (attempt < PLAYER_CLOSE_CHECK_ATTEMPTS - 1) {
                await new Promise((resolve) => setTimeout(resolve, PLAYER_CLOSE_CHECK_INTERVAL_MS));
              }
            }

            const store = useStore.getState();
            const hasMoreEpisodes = store.playlistActive && store.playlistCurrentIndex < store.playlistTotalFiles - 1;
            
            if (hasMoreEpisodes) {
              console.log('%c[Playlist]%c Player closed during playlist, will return to meta when all episodes done', 'color: #ff6b35; font-weight: bold', 'color: inherit');
            }
            
            flushCurrentPlayingProgress(undefined, data);
            endPlaybackSession();
            await clearDiscordPresence();
            await window.electronAPI.torrent.remove();
            resetDownloadStats();
            if (!isDisposed) {
              setView('meta');
            }
            closeTimeout = null;
          })();
        }, PLAYER_CLOSE_GRACE_MS);
      }));

      unlisteners.push(await window.electronAPI.playerEvents.onReconnected(async () => {
        if (isDisposed) return;

        console.log('%c[Player]%c Player reconnected, cancelling stop', 'color: #a78bfa; font-weight: bold', 'color: inherit');
        if (closeTimeout) {
          clearTimeout(closeTimeout);
          closeTimeout = null;
        }
      }));
    };

    const setupTorrentProgress = async () => {
      torrentProgressUnlisten = await window.electronAPI.torrent.onProgress(async (progress) => {
        if (isDisposed) return;

        recordTransferredBytes(progress.received_delta || 0, 'webtorrent');
        const store = useStore.getState();
        setDownloadStats({
          status: progress.status === 'downloading' ? 'downloading'
            : progress.status === 'seeding' ? 'seeding'
              : progress.status === 'done' ? 'complete'
                : 'idle',
          downloaded: progress.downloaded,
          total: progress.total,
          downloadSpeed: progress.download_speed,
          peers: {
            connected: progress.connected_peers ?? progress.peers,
            seeders: progress.seeders,
            leechers: progress.leechers,
          },
          trackerPeers: {
            total: progress.tracker_peers ?? (progress.seeders + progress.leechers),
            seeders: progress.seeders,
            leechers: progress.leechers,
          },
          progress: progress.progress,
          torrentName: store.selectedStream?.torrent.title || '',
          pieces: { ready: progress.downloaded_pieces || 0, total: progress.pieces || 0 },
          bitfield: progress.bitfield || [],
        });
      });
    };

    initApp();
    setupPlayerEvents();
    setupTorrentProgress();

    window.electronAPI.remoteControlEvents.onUseWhisper(async () => {
      if (isDisposed) return;
      const forceUseWhisper = useStore.getState().retryWhisperAction;
      if (!forceUseWhisper) {
        console.warn('[WhisperLive] Phone remote requested Whisper before the playback pipeline was ready');
        return;
      }
      try {
        await forceUseWhisper();
      } catch (error) {
        console.error('[WhisperLive] Phone remote force-use request failed:', error);
      }
    }).then((unlisten) => {
      unlisteners.push(unlisten);
    }).catch((error) => {
      console.error('[Remote] Failed to subscribe to Whisper requests:', error);
    });

    window.electronAPI.statisticsEvents.onTransfer((payload) => {
      if (isDisposed) return;
      recordTransferredBytes(payload.bytes, payload.source_type);
    }).then((unlisten) => {
      statisticsTransferUnlisten = unlisten;
    }).catch((error) => {
      console.error('[Statistics] Failed to subscribe to transfer telemetry:', error);
    });

    window.electronAPI.audioNormalizer.onTelemetry((payload) => {
      if (isDisposed) return;
      const store = useStore.getState();
      store.setAudioNormalizerConnected(!!payload.connected);
      store.setAudioNormalizerActive(
        store.audioNormalizerEnabled
          && !!payload.connected
          && !payload.manual_mode
          && !payload.is_gated
          && !['no_data', 'disconnected', 'settling'].includes(payload.reason),
      );
      store.setAudioNormalizerReason(payload.reason || 'no_data');
    }).then((unlisten) => {
      audioNormalizerTelemetryUnlisten = unlisten;
    }).catch((error) => {
      console.error('[AudioNormalizer] Failed to subscribe to telemetry:', error);
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      isDisposed = true;
      audioNormalizerTelemetryUnlisten?.();
      statisticsTransferUnlisten?.();
      torrentProgressUnlisten?.();
      endPlaybackSession();
      if (closeTimeout) {
        clearTimeout(closeTimeout);
      }
      if (traktSyncTimeout !== null) {
        window.clearTimeout(traktSyncTimeout);
      }
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [resetDownloadStats, setDownloadStats, setTraktConnected, setView]);

  const renderContent = () => {
    switch (view) {
      case 'board':
        return <Board />;
      case 'search':
        return <Search />;
      case 'catalog':
        return <Catalog />;
      case 'watchlist':
        return <Watchlist />;
      case 'history':
        return <History />;
      case 'statistics':
        return <Statistics />;
      case 'calendar':
        return <Calendar />;
      case 'settings':
        return <Settings />;
      case 'audio-normalizer':
        return <AudioNormalizer />;
      case 'meta':
        return selectedMeta ? <MetaDetails meta={selectedMeta} /> : <Board />;
      case 'player':
        return <Player />;
      default:
        return <Board />;
    }
  };

  return (
    <div className={`app app-view-${view}`}>
      <Sidebar currentView={view} onNavigate={setView} />
      <main className="main-content">
        <div className="main-content-inner">
          {renderContent()}
        </div>
      </main>
    </div>
  );
};

export default App;
