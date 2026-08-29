import React, { useRef, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FiArrowLeft, FiActivity, FiChevronDown, FiChevronUp, FiFileText } from 'react-icons/fi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useStore, LocalVideoFile, PlaybackIdentityItem, TorrentResult } from '../../store';
import { flushCurrentPlayingProgress, setCurrentPlayingMeta } from '../../App';
import { sortEpisodes, extractEpisodeNumber, filterVideoFiles } from '../../services/torrent-utils';
import { cleanupPlaylist } from '../../services/playlist-manager';
import { getTmdbEpisodes, getTmdbSeasons } from '../../services/tmdb';
import { searchEnabledSourceProviders } from '../../services/source-search';
import { searchInstalledStreamAddons } from '../../services/addon-source-search';
import { loadInstalledAddons } from '../../services/installed-addons';
import { selectDirectStartupReplacement } from '../../services/direct-startup-failover';
import { buildDirectStreamCacheIdentity } from '../../services/stream-cache-identity';
import {
  rankSmartNextCandidates,
  rememberCompletedSmartNextRequest,
  shouldAutoloadSmartNext,
  shouldExecuteSmartNextRequest,
  shouldReuseSmartNextPreparation,
  smartNextRequestKey,
  SMART_NEXT_AUTOLOAD_TRIGGER_RATIO,
  type RankedSmartNextCandidate,
  type SmartNextRequestIdentity,
} from '../../services/smart-next';
import {
  fetchIntroDbSegments,
  getIntroDbPlaybackSettings,
  hasWatchedIntroDbSegmentOnce,
  introSegmentSourceLabel,
  rememberWatchedIntroDbSegmentOnce,
  shouldAutoSkipIntroDbSegment,
  validateIntroDbSegment,
} from '../../services/introdb';
import type { IntroDbSegment, IntroDbSegments, IntroSkipperDetectionResult, PlayerChapterSegments, PlayerPlaylistChangedPayload, PreparedQbittorrentStreamResult, StreamLaunchResult, StreamPlaylistItem, SubtitleProgressEvent, SubtitleSegment, TorrentStartupState } from '../../services/tauri';
import './Player.css';

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const isPieceDone = (bitfield: number[], index: number): boolean => {
  if (!bitfield || bitfield.length === 0) return false;
  const byteIndex = Math.floor(index / 8);
  if (byteIndex >= bitfield.length) return false;
  const bit = 7 - (index % 8);
  return ((bitfield[byteIndex] >> bit) & 1) === 1;
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type SubtitleStatus = 'disabled' | 'embedded' | 'pending' | 'connecting' | 'waiting' | 'transcribing' | 'generated' | 'error';
type PlayerTrack = { id: number; type: string; title: string; lang: string; codec?: string; selected: boolean; hearing_impaired?: boolean };
type SubtitlePreferences = {
  autoFallback: boolean;
  alwaysUseWhisper: boolean;
  preferredLanguage: string;
  preferSrt: boolean;
  preferSdh: boolean;
};
type MpvLaunchSettings = {
  upscaler: string;
  seekPreviewEnabled: boolean;
  forceStereoEnabled: boolean;
  rtxHdrEnabled: boolean;
  hdrContrastBoostEnabled: boolean;
  autoHdrEnabled: boolean;
  cacheWholeFileEnabled: boolean;
  preferredSubtitleLanguage: string;
  preferredAudioLanguage: string;
  preferSdhSubtitles: boolean;
};
type WhisperSourceType = 'webtorrent' | 'qbittorrent' | 'addon' | 'local';
type WhisperVideoFile = { name: string; index?: number; size: number; localPath?: string };
type WhisperMediaSource = {
  videoFile: WhisperVideoFile;
  streamUrl: string;
  sourceType: WhisperSourceType;
};

type SmartNextTarget = { season: number; episode: number };
type SmartNextPreparedMatch = {
  target: SmartNextTarget;
  episodeLabel: string;
  best: RankedSmartNextCandidate;
  warmup?: SmartNextWarmupHandoff;
  warmupFailure?: string;
};
type SmartNextWarmupHandoff = {
  sourceUrl: string;
  sourceType: 'addon' | 'qbittorrent';
  prepared: PreparedQbittorrentStreamResult;
  addonSessionId?: string;
};
type SmartNextPreparationEntry = {
  key: string;
  expiresAt: number;
  promise: Promise<SmartNextPreparedMatch>;
  result: SmartNextPreparedMatch | null;
  warmupPromise: Promise<void> | null;
};
type SmartNextPerformanceTrace = {
  id: string;
  startedAt: number;
  preparationStartedAt?: number;
  nextEpisodeResolvedAt?: number;
  sourceSearchStartedAt?: number;
  sourceSelectedAt?: number;
  warmupStartedAt?: number;
  warmupReadyAt?: number;
  transitionRequestedAt?: number;
  handoffSelectedAt?: number;
  playbackLaunchStartedAt?: number;
  mpvPlayAt?: number;
  episode?: string;
  sourceType?: string;
  warmupReady?: boolean;
  cachedBytes?: number;
  totalBytes?: number;
};

const SMART_NEXT_PREPARATION_TTL_MS = 15 * 60 * 1_000;
const LOCAL_INTRO_REFERENCE_WATCH_MARGIN_SECONDS = 2;
const LOCAL_INTRO_FAILURE_RETRY_MS = 10_000;
const LOCAL_INTRO_MAX_FAILURE_RETRIES = 30;
const LOCAL_INTRO_SLOW_RETRY_MS = 60_000;
const SEGMENT_ACTION_RETRY_MS = 1_000;
const OUTRO_SMART_NEXT_RETRY_MS = 15_000;
const localIntroPlaybackMax = new Map<string, number>();

const isAiredEpisode = (airDate: string | null): boolean => {
  if (!airDate) return false;
  const timestamp = new Date(`${airDate}T00:00:00`).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return timestamp <= endOfToday.getTime();
};

const findNextAiredEpisode = async (
  tmdbId: number,
  current: SmartNextTarget,
): Promise<SmartNextTarget | null> => {
  const seasons = (await getTmdbSeasons(tmdbId))
    .filter((season) => season.season_number >= current.season)
    .sort((a, b) => a.season_number - b.season_number);

  for (const season of seasons) {
    const episodes = (await getTmdbEpisodes(tmdbId, season.season_number))
      .filter((episode) => isAiredEpisode(episode.air_date))
      .filter((episode) =>
        season.season_number > current.season || episode.episode_number > current.episode
      )
      .sort((a, b) => a.episode_number - b.episode_number);
    if (episodes[0]) {
      return {
        season: season.season_number,
        episode: episodes[0].episode_number,
      };
    }
  }

  return null;
};

const formatSmartNextEpisode = (target: SmartNextTarget): string =>
  `S${target.season.toString().padStart(2, '0')}E${target.episode.toString().padStart(2, '0')}`;

const RETRYABLE_MEDIA_MARKER = 'RETRYABLE_MEDIA_NOT_READY';
const RETRYABLE_SESSION_MARKER = 'RETRYABLE_SUBTITLE_SESSION_RESTART';
const WHISPER_LOOKAHEAD_SECONDS = 10.0;
const WHISPER_MAX_SESSION_RETRIES = 4;
const WHISPER_SEEK_RESTART_DELAY_MS = 250;

const isRetryableSubtitleError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(RETRYABLE_MEDIA_MARKER) || message.includes(RETRYABLE_SESSION_MARKER);
};

const isMediaWaitRetryableError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(RETRYABLE_MEDIA_MARKER);
};

const isLiveWhisperSubtitleTrack = (track: PlayerTrack): boolean => {
  const title = (track.title || '').trim().toLowerCase();
  return title === 'streamee-live.srt' || title.includes('streamee-live');
};

const resolvePreferredMediaLanguage = (preference: unknown, originalLanguage?: string): string => {
  if (preference === 'original') {
    return originalLanguage?.trim().toLowerCase() || 'en';
  }

  return typeof preference === 'string' && preference.trim()
    ? preference.trim().toLowerCase()
    : 'en';
};

const readSubtitlePreferences = (originalLanguage?: string): SubtitlePreferences => {
  try {
    const stored = localStorage.getItem('streamee-settings');
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        autoFallback: !!parsed.subtitleAutoFallback,
        alwaysUseWhisper: !!parsed.subtitleAlwaysUseWhisper,
        preferredLanguage: resolvePreferredMediaLanguage(parsed.preferredSubtitleLanguage, originalLanguage),
        preferSrt: !!parsed.preferSrtSubtitles,
        preferSdh: !!parsed.preferSdhSubtitles,
      };
    }
  } catch (error) {
    console.error('%c[Subtitles]%c Failed to read subtitle settings:', 'color: #4ade80; font-weight: bold', 'color: inherit', error);
  }

  return {
    autoFallback: true,
    alwaysUseWhisper: false,
    preferredLanguage: 'en',
    preferSrt: false,
    preferSdh: false,
  };
};

const getMpvLaunchSettings = async (originalLanguage?: string): Promise<MpvLaunchSettings> => {
  const [
    mpvUpscaler,
    mpvSeekPreviewEnabled,
    mpvForceStereoEnabled,
    mpvRtxHdrEnabled,
    mpvHdrContrastBoostEnabled,
    mpvAutoHdrEnabled,
    mpvCacheWholeFileEnabled,
    preferredSubtitleLanguage,
    preferredAudioLanguage,
    preferSdhSubtitles,
  ] = await Promise.all([
    window.electronAPI.settings.getSetting('mpvUpscaler'),
    window.electronAPI.settings.getSetting('mpvSeekPreviewEnabled'),
    window.electronAPI.settings.getSetting('mpvForceStereoEnabled'),
    window.electronAPI.settings.getSetting('mpvRtxHdrEnabled'),
    window.electronAPI.settings.getSetting('mpvHdrContrastBoostEnabled'),
    window.electronAPI.settings.getSetting('mpvAutoHdrEnabled'),
    window.electronAPI.settings.getSetting('mpvCacheWholeFileEnabled'),
    window.electronAPI.settings.getSetting('preferredSubtitleLanguage'),
    window.electronAPI.settings.getSetting('preferredAudioLanguage'),
    window.electronAPI.settings.getSetting('preferSdhSubtitles'),
  ]);

  return {
    upscaler: mpvUpscaler ?? 'rtx-vsr',
    seekPreviewEnabled: mpvSeekPreviewEnabled === 'true',
    forceStereoEnabled: mpvForceStereoEnabled !== 'false',
    rtxHdrEnabled: mpvRtxHdrEnabled === 'true',
    hdrContrastBoostEnabled: mpvHdrContrastBoostEnabled === 'true',
    autoHdrEnabled: mpvAutoHdrEnabled === 'true',
    cacheWholeFileEnabled: mpvCacheWholeFileEnabled === 'true',
    preferredSubtitleLanguage: resolvePreferredMediaLanguage(preferredSubtitleLanguage, originalLanguage),
    preferredAudioLanguage: resolvePreferredMediaLanguage(preferredAudioLanguage, originalLanguage),
    preferSdhSubtitles: preferSdhSubtitles === 'true',
  };
};

const getSubtitleLanguageAliases = (language: string): string[] => {
  switch (language.toLowerCase()) {
    case 'ms': return ['ms', 'may', 'msa', 'malay'];
    case 'id': return ['id', 'ind', 'indonesian'];
    case 'zh': return ['zh', 'chi', 'zho', 'chinese'];
    case 'ja': return ['ja', 'jpn', 'japanese'];
    case 'ko': return ['ko', 'kor', 'korean'];
    case 'es': return ['es', 'spa', 'spanish'];
    case 'fr': return ['fr', 'fre', 'fra', 'french'];
    case 'de': return ['de', 'ger', 'deu', 'german'];
    case 'pt': return ['pt', 'por', 'portuguese'];
    case 'it': return ['it', 'ita', 'italian'];
    case 'th': return ['th', 'tha', 'thai'];
    case 'vi': return ['vi', 'vie', 'vietnamese'];
    default: return ['en', 'eng', 'english'];
  }
};

const isSdhSubtitleTrack = (track: PlayerTrack): boolean => {
  const title = (track.title || '').toLowerCase();
  return !!track.hearing_impaired || /\b(sdh|cc|hi|hearing impaired|hard[- ]of[- ]hearing|deaf)\b/.test(title);
};

const isSrtSubtitleTrack = (track: PlayerTrack): boolean => {
  const codec = (track.codec || '').trim().toLowerCase();
  return codec === 'subrip' || codec === 'srt' || /\.srt(?:$|[\s()[\]])/i.test(track.title || '');
};

const matchesPreferredSubtitleLanguage = (track: PlayerTrack, language: string): boolean => {
  const aliases = getSubtitleLanguageAliases(language);
  const lang = (track.lang || '').trim().toLowerCase();
  const title = (track.title || '').toLowerCase();

  return aliases.some((alias) => {
    if (lang === alias || lang.startsWith(`${alias}-`)) {
      return true;
    }

    return alias.length > 2 && title.includes(alias);
  });
};

const selectPreferredSubtitleTrack = (
  subtitleTracks: PlayerTrack[],
  prefs: Pick<SubtitlePreferences, 'preferredLanguage' | 'preferSrt' | 'preferSdh'>
): PlayerTrack => {
  const languageMatches = subtitleTracks.filter((track) =>
    matchesPreferredSubtitleLanguage(track, prefs.preferredLanguage)
  );
  const candidates = languageMatches.length > 0 ? languageMatches : subtitleTracks;
  const sdhMatches = candidates.filter(isSdhSubtitleTrack);
  const nonSdhMatches = candidates.filter((track) => !isSdhSubtitleTrack(track));
  const srtSdhMatches = sdhMatches.filter(isSrtSubtitleTrack);
  const regularSrtMatches = nonSdhMatches.filter(isSrtSubtitleTrack);

  if (prefs.preferSrt && prefs.preferSdh) {
    return srtSdhMatches[0]
      || regularSrtMatches[0]
      || sdhMatches[0]
      || nonSdhMatches[0]
      || candidates.find((track) => track.selected)
      || candidates[0]
      || subtitleTracks[0];
  }

  if (prefs.preferSrt) {
    return regularSrtMatches[0]
      || nonSdhMatches[0]
      || candidates.find((track) => track.selected)
      || candidates[0]
      || subtitleTracks[0];
  }

  const preferredSdhGroup = prefs.preferSdh ? sdhMatches : nonSdhMatches;

  return preferredSdhGroup[0]
    || candidates.find((track) => track.selected)
    || candidates[0]
    || subtitleTracks[0];
};

const getPathBaseName = (path: string): string => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

const getMediaDisplayName = (source: string): string => {
  try {
    const parsed = new URL(source);
    const filename = parsed.searchParams.get('filename');
    if (filename?.trim()) {
      return getPathBaseName(filename.trim());
    }

    const pathnameBase = getPathBaseName(decodeURIComponent(parsed.pathname));
    if (pathnameBase) {
      return pathnameBase;
    }
  } catch {
    // Local Windows paths are not URLs.
  }

  return getPathBaseName(source);
};

const sortLocalVideoFiles = (files: LocalVideoFile[]) => {
  const remaining = [...files];
  return sortEpisodes(files.map((file) => file.name))
    .map((name) => {
      const index = remaining.findIndex((file) => file.name === name);
      return index === -1 ? null : remaining.splice(index, 1)[0];
    })
    .filter((file): file is LocalVideoFile => Boolean(file));
};

const normalizeSourceIdentity = (value?: string | null) =>
  value ? value.replace(/\\/g, '/').toLowerCase() : '';

const sourceFilenameMatches = (
  file: { name: string; path?: string; localPath?: string },
  sourceFilename?: string
) => {
  const source = normalizeSourceIdentity(sourceFilename);
  if (!source) {
    return false;
  }

  const sourceBase = normalizeSourceIdentity(getPathBaseName(source));
  const fileName = normalizeSourceIdentity(file.name);
  const filePath = normalizeSourceIdentity(file.path || file.localPath);

  return (
    fileName === sourceBase ||
    fileName === source ||
    (!!filePath && (filePath === source || filePath.endsWith(`/${sourceBase}`)))
  );
};

const selectVideoFileForResumeTarget = <T extends { name: string; path?: string; localPath?: string }>(
  files: T[],
  targetSeason?: number,
  targetEpisode?: number,
  preferredSeason = 1,
  sourceFilename?: string
): T | undefined => {
  const sourceMatch = files.find((file) => sourceFilenameMatches(file, sourceFilename));
  if (sourceMatch) {
    return sourceMatch;
  }

  if (targetSeason && targetEpisode) {
    const parsedMatch = files.find((file) => {
      const episodeInfo = extractEpisodeNumber(file.name, targetSeason);
      return episodeInfo?.season === targetSeason && episodeInfo.episode === targetEpisode;
    });
    if (parsedMatch) {
      return parsedMatch;
    }

    const targetIndex = targetEpisode - 1;
    if (targetSeason === preferredSeason && targetIndex >= 0 && targetIndex < files.length) {
      return files[targetIndex];
    }
  }

  return undefined;
};

const buildPlaybackIdentityItems = <T extends { name: string; index?: number; path?: string; localPath?: string; streamUrl?: string | null; season?: number; episode?: number }>(
  files: T[],
  preferredSeason = 1,
  firstTargetSeason?: number,
  firstTargetEpisode?: number
): PlaybackIdentityItem[] => {
  return files.map((file, queueIndex) => {
    const parsed = extractEpisodeNumber(file.name, preferredSeason);
    const ordinalEpisode =
      firstTargetSeason === preferredSeason && typeof firstTargetEpisode === 'number'
        ? firstTargetEpisode + queueIndex
        : undefined;
    const season = file.season
      ?? parsed?.season
      ?? (queueIndex === 0 ? firstTargetSeason : firstTargetSeason ?? preferredSeason);
    const episode = file.episode
      ?? parsed?.episode
      ?? (queueIndex === 0 ? firstTargetEpisode : ordinalEpisode);

    return {
      queueIndex,
      title: file.name,
      sourceKey: file.path ?? file.localPath ?? (typeof file.index === 'number' ? `/stream/${file.index}` : file.name),
      streamUrl: file.streamUrl ?? file.path ?? file.localPath ?? null,
      season,
      episode,
    };
  });
};

const setPlaybackIdentityForFiles = <T extends { name: string; index?: number; path?: string; localPath?: string; streamUrl?: string | null; season?: number; episode?: number }>(
  store: ReturnType<typeof useStore.getState>,
  files: T[],
  preferredSeason?: number,
  targetSeason?: number,
  targetEpisode?: number
) => {
  store.setPlaybackIdentityItems(buildPlaybackIdentityItems(files, preferredSeason ?? targetSeason ?? 1, targetSeason, targetEpisode));
};

const getStoredResumeSourceMeta = (
  selectedMeta: { id: string; type: 'movie' | 'series' } | null | undefined
): { preferredSeason?: number; preferredEpisode?: number; sourceFilename?: string } | null => {
  if (!selectedMeta) {
    return null;
  }

  const tmdbId = selectedMeta.id.split(':')[1];
  if (!tmdbId) {
    return null;
  }

  try {
    const storedMeta = JSON.parse(localStorage.getItem('streamee-last-source-meta') || '{}');
    const sourceMeta = storedMeta[`${selectedMeta.type}-${tmdbId}`];
    if (!sourceMeta || typeof sourceMeta !== 'object') {
      return null;
    }

    return sourceMeta;
  } catch (error) {
    console.warn('[Resume] Failed to read stored source resume metadata:', error);
    return null;
  }
};

type EpisodeResumeSource = {
  season?: number;
  episode?: number;
  sourceFilename?: string;
};

const hasEpisodeTarget = (
  source: EpisodeResumeSource | null | undefined,
): source is EpisodeResumeSource & { season: number; episode: number } =>
  typeof source?.season === 'number' && typeof source.episode === 'number';

const resolvePlaybackTarget = (
  selectedStream: {
    preferredSeason?: number;
    preferredEpisode?: number;
    resumeSourceFilename?: string;
  },
  continueWatchingItem: EpisodeResumeSource | null | undefined,
  storedResumeSourceMeta: { preferredSeason?: number; preferredEpisode?: number; sourceFilename?: string } | null,
) => {
  const selectedTarget: EpisodeResumeSource = {
    season: selectedStream.preferredSeason,
    episode: selectedStream.preferredEpisode,
    sourceFilename: selectedStream.resumeSourceFilename,
  };
  const storedTarget: EpisodeResumeSource | null = storedResumeSourceMeta
    ? {
        season: storedResumeSourceMeta.preferredSeason,
        episode: storedResumeSourceMeta.preferredEpisode,
        sourceFilename: storedResumeSourceMeta.sourceFilename,
      }
    : null;
  const hasExplicitSelection =
    typeof selectedTarget.season === 'number' || typeof selectedTarget.episode === 'number';

  if (hasExplicitSelection) {
    const hasSelectedEpisode = hasEpisodeTarget(selectedTarget);
    const matchingResumeSource = hasSelectedEpisode
      ? [continueWatchingItem, storedTarget].find((source) =>
          hasEpisodeTarget(source) &&
          source?.season === selectedTarget.season &&
          source.episode === selectedTarget.episode
        )
      : null;

    return {
      targetSeason: selectedTarget.season,
      targetEpisode: hasSelectedEpisode ? selectedTarget.episode : undefined,
      // A season-only pack selection must not inherit an episode filename from
      // another season. Only reuse resume identity for the exact same episode.
      resumeSourceFilename: hasSelectedEpisode
        ? selectedTarget.sourceFilename ?? matchingResumeSource?.sourceFilename
        : undefined,
    };
  }

  if (hasEpisodeTarget(continueWatchingItem)) {
    return {
      targetSeason: continueWatchingItem.season,
      targetEpisode: continueWatchingItem.episode,
      resumeSourceFilename: selectedTarget.sourceFilename ?? continueWatchingItem.sourceFilename,
    };
  }

  if (hasEpisodeTarget(storedTarget)) {
    return {
      targetSeason: storedTarget.season,
      targetEpisode: storedTarget.episode,
      resumeSourceFilename: selectedTarget.sourceFilename ?? storedTarget.sourceFilename,
    };
  }

  return {
    targetSeason: undefined,
    targetEpisode: undefined,
    resumeSourceFilename:
      selectedTarget.sourceFilename ??
      continueWatchingItem?.sourceFilename ??
      storedTarget?.sourceFilename,
  };
};

const getResumeStartPosition = (
  continueWatchingItem: { progress?: number; playbackTime?: number; duration?: number; season?: number; episode?: number } | null | undefined,
  targetSeason?: number,
  targetEpisode?: number
): number | undefined => {
  if (!continueWatchingItem) {
    return undefined;
  }

  const hasSavedEpisode = typeof continueWatchingItem.season === 'number' && typeof continueWatchingItem.episode === 'number';
  const hasTargetEpisode = typeof targetSeason === 'number' && typeof targetEpisode === 'number';

  if (typeof targetSeason === 'number' && typeof targetEpisode !== 'number') {
    return undefined;
  }

  if (hasTargetEpisode && !hasSavedEpisode) {
    return undefined;
  }

  if (
    hasSavedEpisode &&
    hasTargetEpisode &&
    (continueWatchingItem.season !== targetSeason || continueWatchingItem.episode !== targetEpisode)
  ) {
    return undefined;
  }

  if (
    typeof continueWatchingItem.playbackTime === 'number' &&
    continueWatchingItem.playbackTime > 0 &&
    typeof continueWatchingItem.duration === 'number' &&
    continueWatchingItem.duration > 0
  ) {
    return Math.min(99, Math.max(0, (continueWatchingItem.playbackTime / continueWatchingItem.duration) * 100));
  }

  if (typeof continueWatchingItem.progress === 'number' && continueWatchingItem.progress > 0) {
    return continueWatchingItem.progress;
  }

  return undefined;
};

const getStreamResumeItem = (
  selectedStream: {
    resumeProgress?: number;
    resumePlaybackTime?: number;
    resumeDuration?: number;
    preferredSeason?: number;
    preferredEpisode?: number;
    startOver?: boolean;
  },
  continueWatchingItem: { progress?: number; playbackTime?: number; duration?: number; season?: number; episode?: number } | null | undefined
) => {
  if (selectedStream.startOver) {
    return null;
  }

  if (
    (typeof selectedStream.resumeProgress !== 'number' || selectedStream.resumeProgress <= 0) &&
    (typeof selectedStream.resumePlaybackTime !== 'number' || selectedStream.resumePlaybackTime <= 0)
  ) {
    return continueWatchingItem;
  }

  return {
    ...continueWatchingItem,
    progress: selectedStream.resumeProgress ?? continueWatchingItem?.progress,
    playbackTime: selectedStream.resumePlaybackTime ?? continueWatchingItem?.playbackTime,
    duration: selectedStream.resumeDuration ?? continueWatchingItem?.duration,
    season: selectedStream.preferredSeason ?? continueWatchingItem?.season,
    episode: selectedStream.preferredEpisode ?? continueWatchingItem?.episode,
  };
};

interface TorrentStats {
  status: string;
  timeConnected: number;
  downloadSpeed: number;
  uploadSpeed: number;
  downloadedTotal: number;
  uploadedTotal: number;
  total: number;
  progress: number;
  remainingTime: number;
  pieces: { ready: number; total: number };
  peers: { connected: number; seeders: number; leechers: number };
  trackerPeers: { total: number; seeders: number; leechers: number };
  file: { name: string; size: number } | null;
  streamUrl: string | null;
  peerList: Array<{
    ip: string;
    protocol: string;
    downloadSpeed: number;
    uploadSpeed: number;
  }>;
  trackers: Array<{
    url: string;
    status: string;
    peers: number;
  }>;
}

const MPV_OFFSET_X = 317;
const MPV_OFFSET_Y = 44;
const MPV_WIDTH_TRIM = 332;
const MPV_HEIGHT_TRIM = 58;
const DEFAULT_SVP_EXECUTABLE_PATH = 'C:\\Program Files (x86)\\SVP 4\\SVPManager.exe';

interface MpvDebugBounds {
  appX: number;
  appY: number;
  appWidth: number;
  appHeight: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface MpvActualBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

const getMpvDebugBounds = async (appWin = getCurrentWindow()): Promise<MpvDebugBounds> => {
  const pos = await appWin.outerPosition();
  const size = await appWin.outerSize();

  return {
    appX: pos.x,
    appY: pos.y,
    appWidth: size.width,
    appHeight: size.height,
    offsetX: MPV_OFFSET_X,
    offsetY: MPV_OFFSET_Y,
    width: size.width - MPV_WIDTH_TRIM,
    height: size.height - MPV_HEIGHT_TRIM,
  };
};

const Player: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<number>(0);
  const continueWatchingRef = useRef(useStore.getState().continueWatching);
  const initInProgress = useRef(false);
  const torrentStartedRef = useRef(false);
  const streamOpenedRef = useRef(false);
  const playerObservingStarted = useRef(false);
  const activeStartupSessionRef = useRef<number | null>(null);
  const playbackLaunchIdRef = useRef(0);
  const directStartupFailoverRef = useRef<{ mediaKey: string; retryNonce: number; attempted: boolean }>({
    mediaKey: '',
    retryNonce: -1,
    attempted: false,
  });
  const mediaTitleTimeoutsRef = useRef<number[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [startupState, setStartupState] = useState<TorrentStartupState | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupNonce, setStartupNonce] = useState(0);
  const [showDebug, setShowDebug] = useState(false);
  const showDebugRef = useRef(showDebug);
  showDebugRef.current = showDebug;
  const [showPeerList, setShowPeerList] = useState(false);
  const [showTrackerList, setShowTrackerList] = useState(false);
  const [subtitleStatus, setSubtitleStatus] = useState<SubtitleStatus>('disabled');
  const [subtitleMessage, setSubtitleMessage] = useState<string>('Subtitles disabled');

  const [stats, setStats] = useState<TorrentStats>({
    status: 'Idle',
    timeConnected: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    downloadedTotal: 0,
    uploadedTotal: 0,
    total: 0,
    progress: 0,
    remainingTime: 0,
    pieces: { ready: 0, total: 0 },
    peers: { connected: 0, seeders: 0, leechers: 0 },
    trackerPeers: { total: 0, seeders: 0, leechers: 0 },
    file: null,
    streamUrl: null,
    peerList: [],
    trackers: []
  });

  const [mpvPid, setMpvPid] = useState<number | null>(null);
  const mpvPidRef = useRef<number | null>(null);
  const [pieceBitfield, setPieceBitfield] = useState<number[]>([]);
  const [showDetailedPieces, setShowDetailedPieces] = useState(false);
  const [mpvDebugBounds, setMpvDebugBounds] = useState<MpvDebugBounds | null>(null);
  const [mpvActualBounds, setMpvActualBounds] = useState<MpvActualBounds | null>(null);
  const pieceCanvasRef = useRef<HTMLCanvasElement>(null);
  const subtitleJobRef = useRef(0);
  const restartSubtitlePipelineRef = useRef<null | (() => Promise<void>)>(null);
  const activeWhisperSessionIdRef = useRef(0);
  const whisperSeekRestartTimeoutRef = useRef<number | null>(null);
  const qbitRetryTimeoutRef = useRef<number | null>(null);
  const whisperSeekRestartTokenRef = useRef(0);
  const lastKnownPlaybackTimeRef = useRef(0);
  const lastKnownAtRef = useRef(0);
  const playbackPausedRef = useRef(false);
  const lastSvpPlaylistPosRef = useRef<number | null>(null);
  const svpRestartInProgressRef = useRef(false);
  const smartNextActiveRequestRef = useRef<string | null>(null);
  const smartNextCompletedRequestsRef = useRef<Set<string>>(new Set());
  const smartNextPreparationRef = useRef<SmartNextPreparationEntry | null>(null);
  const smartNextWarmupHandoffRef = useRef<SmartNextWarmupHandoff | null>(null);
  const smartNextPerformanceRef = useRef<SmartNextPerformanceTrace | null>(null);
  const smartNextTransitionRef = useRef(false);
  const smartNextWindowRestoreRef = useRef<{
    fullscreen: boolean | null;
    previousMpvPid: number;
    attempts: number;
  } | null>(null);
  const smartNextWindowRestoreInFlightRef = useRef(false);
  const introSkipperCurrentUrlRef = useRef<string | null>(null);
  const segmentDetectionHandlerRef = useRef<null | ((
    filename: string,
    playbackTime: number,
    duration: number,
    playlistPos?: number,
  ) => Promise<void>)>(null);
  const resolvedLocalIntroSegmentsRef = useRef<Map<string, IntroDbSegment>>(new Map());
  const resolvedLocalOutroSegmentsRef = useRef<Map<string, IntroDbSegment>>(new Map());
  const localSegmentAudioGenerationRef = useRef(0);
  const smartNextPendingPersistenceRef = useRef<{
    sourceUrl: string;
    torrent: TorrentResult;
    sourceType: 'webtorrent' | 'qbittorrent' | 'addon';
    target: SmartNextTarget;
  } | null>(null);

  const {
    selectedStream,
    selectedMeta,
    audioNormalizerEnabled,
    setSelectedStream,
    setDownloadStats,
    resetDownloadStats,
    continueWatching,
    setSubtitleAssist,
    clearSubtitleAssist,
    setAudioNormalizerActive,
    setAudioNormalizerConnected,
    setAudioNormalizerReason,
    setWhisperProcessedSeconds,
    setRetryWhisperAction,
    setRetryAudioNormalizerAction,
  } = useStore(useShallow((state) => ({
    selectedStream: state.selectedStream,
    selectedMeta: state.selectedMeta,
    audioNormalizerEnabled: state.audioNormalizerEnabled,
    setSelectedStream: state.setSelectedStream,
    setDownloadStats: state.setDownloadStats,
    resetDownloadStats: state.resetDownloadStats,
    continueWatching: state.continueWatching,
    setSubtitleAssist: state.setSubtitleAssist,
    clearSubtitleAssist: state.clearSubtitleAssist,
    setAudioNormalizerActive: state.setAudioNormalizerActive,
    setAudioNormalizerConnected: state.setAudioNormalizerConnected,
    setAudioNormalizerReason: state.setAudioNormalizerReason,
    setWhisperProcessedSeconds: state.setWhisperProcessedSeconds,
    setRetryWhisperAction: state.setRetryWhisperAction,
    setRetryAudioNormalizerAction: state.setRetryAudioNormalizerAction,
  })));

  const clearMediaTitleRetries = () => {
    mediaTitleTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    mediaTitleTimeoutsRef.current = [];
  };

  const clearQbitRetry = () => {
    if (qbitRetryTimeoutRef.current != null) {
      window.clearTimeout(qbitRetryTimeoutRef.current);
      qbitRetryTimeoutRef.current = null;
    }
  };

  const scheduleQbitRetry = (message: string) => {
    clearQbitRetry();
    setMpvPid(null);
    mpvPidRef.current = null;
    setStartupError(message);
    setStartupState({
      session_id: 0,
      attempt: 0,
      phase: 'retrying_qbittorrent',
      message: `${message} Retrying in 3 seconds...`,
    });
    setIsLoading(true);
    qbitRetryTimeoutRef.current = window.setTimeout(() => {
      qbitRetryTimeoutRef.current = null;
      setStartupNonce((current) => current + 1);
    }, 3000);
  };

  useEffect(() => {
    mpvPidRef.current = mpvPid;
  }, [mpvPid]);

  const syncPlaylistTitle = (title: string) => {
    if (!title) return;
    clearMediaTitleRetries();

    [0, 150, 500, 1200].forEach((delayMs) => {
      const timeoutId = window.setTimeout(() => {
        void window.electronAPI.player.setMediaTitle(title);
      }, delayMs);
      mediaTitleTimeoutsRef.current.push(timeoutId);
    });
  };

  const getSvpExecutablePath = async () => {
    const path = await window.electronAPI.settings.getSetting('svpExecutablePath');
    return path || DEFAULT_SVP_EXECUTABLE_PATH;
  };

  const restartSvpAfterPlaybackChange = async (reason: string) => {
    if (svpRestartInProgressRef.current) {
      return;
    }

    const autoRestart = await window.electronAPI.settings.getSetting('svpAutoRestartOnPlaylistChange');
    if (autoRestart !== 'true') {
      return;
    }

    svpRestartInProgressRef.current = true;
    try {
      await window.electronAPI.restartSvp(await getSvpExecutablePath());
      console.log(`[SVP] Restarted SVP after ${reason}`);
    } catch (error) {
      console.warn(`[SVP] Failed to restart SVP after ${reason}:`, error);
    } finally {
      svpRestartInProgressRef.current = false;
    }
  };

  const stopSvpAfterMpvClose = async () => {
    const autoClose = await window.electronAPI.settings.getSetting('svpAutoCloseOnMpvClose');
    if (autoClose !== 'true') {
      return;
    }

    try {
      await window.electronAPI.stopSvp(await getSvpExecutablePath());
    } catch (error) {
      console.warn('[SVP] Failed to stop SVP after MPV close:', error);
    }
  };

  useEffect(() => {
    continueWatchingRef.current = continueWatching;
  }, [continueWatching]);

  const exitToMetaDetails = () => {
    setSelectedStream(null);
    setAudioNormalizerActive(false);
    setAudioNormalizerConnected(false);
    setAudioNormalizerReason('no_data');
    setRetryWhisperAction(null);
    setRetryAudioNormalizerAction(null);
    cleanupPlaylist();
  };

  const waitForSubtitleTracks = async (
    disposedRef: { current: boolean },
    attempts = 20
  ): Promise<{ tracks: PlayerTrack[]; settled: boolean }> => {
    let lastTracks: PlayerTrack[] = [];
    let nonSubtitleTrackAttempts = 0;

    for (let attempt = 0; attempt < attempts && !disposedRef.current; attempt++) {
      try {
        const tracks = await window.electronAPI.player.getTracks() as PlayerTrack[];
        lastTracks = tracks;

        if (tracks.some((track) => track.type === 'sub' && !isLiveWhisperSubtitleTrack(track))) {
          return { tracks, settled: true };
        }

        if (tracks.some((track) => track.type === 'audio')) {
          nonSubtitleTrackAttempts += 1;
          // Once MPV is consistently reporting real media tracks but still no
          // subtitle track, it's safe to treat this title as subtitle-free.
          if (nonSubtitleTrackAttempts >= 3) {
            return { tracks, settled: true };
          }
        } else {
          nonSubtitleTrackAttempts = 0;
        }
      } catch (error) {
        console.error('%c[Subtitles]%c Failed to query MPV tracks:', 'color: #4ade80; font-weight: bold', 'color: inherit', error);
      }

      await wait(500);
    }

    return { tracks: lastTracks, settled: false };
  };

  const waitForMoreMedia = async (
    fileIndex: number,
    disposedRef: { current: boolean },
    previousDownloaded: number,
    timeoutMs = 15000
  ): Promise<{ downloaded: number; total: number; complete: boolean }> => {
    const started = Date.now();

    while (!disposedRef.current && Date.now() - started < timeoutMs) {
      try {
        const progress = await window.electronAPI.torrent.getFileProgress(fileIndex);
        if (progress) {
          const complete = progress.total > 0 && progress.downloaded >= progress.total;
          if (progress.downloaded > previousDownloaded || complete) {
            return {
              downloaded: progress.downloaded,
              total: progress.total,
              complete,
            };
          }
        }
      } catch (error) {
      }

      await wait(1500);
    }

    return {
      downloaded: previousDownloaded,
      total: 0,
      complete: false,
    };
  };

  const getWhisperStartSeconds = async () => {
    const fallbackPlaybackTime = !playbackPausedRef.current && lastKnownAtRef.current > 0
      ? lastKnownPlaybackTimeRef.current + (Date.now() - lastKnownAtRef.current) / 1000
      : lastKnownPlaybackTimeRef.current;

    try {
      const playerInfo = await window.electronAPI.getPlayerInfo();
      const playbackTime = typeof playerInfo?.playback_time === 'number'
        ? playerInfo.playback_time
        : fallbackPlaybackTime;

      return Math.max(0, playbackTime + WHISPER_LOOKAHEAD_SECONDS);
    } catch (error) {
      console.warn('[WhisperLive] Failed to read exact player time for start offset, using fallback estimate:', error);
      return Math.max(0, fallbackPlaybackTime + WHISPER_LOOKAHEAD_SECONDS);
    }
  };

  const getSelectedWhisperLanguage = async (): Promise<string | undefined> => {
    try {
      const tracks = await window.electronAPI.player.getTracks() as PlayerTrack[];
      const language = tracks
        .find((track) => track.type === 'audio' && track.selected)
        ?.lang
        ?.trim();
      return language || undefined;
    } catch (error) {
      console.warn('[WhisperLive] Could not read selected audio-track language; using automatic detection:', error);
      return undefined;
    }
  };

  const transcribeWithWhisperLive = async (
    videoFile: WhisperVideoFile,
    streamUrl: string,
    disposedRef: { current: boolean },
    jobId: number,
    initialStartSeconds?: number,
    sourceType: WhisperSourceType = 'webtorrent',
  ): Promise<void> => {
    const fileIndex = typeof videoFile.index === 'number' ? videoFile.index : null;
    const localPath = videoFile.localPath ?? (fileIndex != null
      ? await window.electronAPI.torrent.getFilePath(videoFile.name).catch(() => null)
      : null);
    const initialProgress = fileIndex != null
      ? await window.electronAPI.torrent.getFileProgress(fileIndex).catch(() => null)
      : null;
    const preferredSource = localPath || streamUrl;
    if (!preferredSource) {
      throw new Error('No transcription source available');
    }

    const getResumeSeconds = getWhisperStartSeconds;
    const loggedSource = sourceType === 'addon' ? '[Remote stream URL redacted]' : preferredSource;
    const loggedLocalPath = sourceType === 'addon' && localPath ? '[Remote stream URL redacted]' : localPath;
    const loggedStreamUrl = sourceType === 'addon' ? '[Remote stream URL redacted]' : streamUrl;
    let sessionRetryAttempts = 0;
    let mediaRetryAttempts = 0;

    let startSeconds = typeof initialStartSeconds === 'number'
      ? initialStartSeconds
      : await getWhisperStartSeconds();

    console.log('[WhisperLive] Starting transcription:', {
      preferredSource: loggedSource,
      localPath: loggedLocalPath,
      streamUrl: loggedStreamUrl,
      title: videoFile.name,
      startSeconds,
      fileProgress: initialProgress,
    });

    const isCancelled = () => disposedRef.current || jobId !== subtitleJobRef.current;
    while (!isCancelled()) {
      try {
        await window.electronAPI.subtitles.transcribeWithWhisperLive(
          preferredSource,
          videoFile.name,
          await getSelectedWhisperLanguage(),
          jobId,
          startSeconds,
        );
        if (isCancelled()) {
          throw new Error('Subtitle transcription was cancelled');
        }
        return;
      } catch (error) {
        if (!isRetryableSubtitleError(error)) {
          throw error;
        }

        if (!isMediaWaitRetryableError(error)) {
          sessionRetryAttempts += 1;
          startSeconds = await getResumeSeconds();
          console.warn('[WhisperLive] Session restart requested, restarting Whisper runtime and retrying:', {
            startSeconds,
            sessionRetryAttempts,
            localPath: loggedLocalPath,
            error,
          });
          setSubtitleStatus('connecting');
          setSubtitleMessage(`Restarting WhisperLive session (${sessionRetryAttempts}/${WHISPER_MAX_SESSION_RETRIES})...`);
          setSubtitleAssist({
            status: 'connecting',
            message: `Restarting WhisperLive session (${sessionRetryAttempts}/${WHISPER_MAX_SESSION_RETRIES})...`,
            progress: 15,
          });
          setWhisperProcessedSeconds(startSeconds);
          try {
            await window.electronAPI.subtitles.stopServer();
          } catch (stopError) {
            console.warn('[WhisperLive] Failed to stop Whisper runtime before retry:', stopError);
          }
          if (sessionRetryAttempts >= WHISPER_MAX_SESSION_RETRIES) {
            const message = `Whisper restart failed after ${WHISPER_MAX_SESSION_RETRIES} attempts`;
            setSubtitleStatus('error');
            setSubtitleMessage(message);
            setSubtitleAssist({
              status: 'error',
              message,
              progress: 0,
            });
            throw new Error(message);
          }
          await wait(500 + (sessionRetryAttempts - 1) * 250);
          continue;
        }

        if (fileIndex == null) {
          mediaRetryAttempts += 1;
          const isRemoteSource = sourceType === 'addon';
          const shouldBoundMediaRetries = sourceType !== 'qbittorrent';
          const waitingMessage = sourceType === 'addon'
            ? `Retrying remote subtitle stream (${mediaRetryAttempts}/${WHISPER_MAX_SESSION_RETRIES})...`
            : sourceType === 'qbittorrent'
              ? 'Waiting for the external playback service to prepare more media...'
              : `Retrying subtitle stream (${mediaRetryAttempts}/${WHISPER_MAX_SESSION_RETRIES})...`;
          startSeconds = await getResumeSeconds();
          setSubtitleStatus('waiting');
          setSubtitleMessage(waitingMessage);
          setSubtitleAssist({
            status: 'waiting',
            message: waitingMessage,
            progress: 0,
          });
          setWhisperProcessedSeconds(startSeconds);
          if (shouldBoundMediaRetries && mediaRetryAttempts >= WHISPER_MAX_SESSION_RETRIES) {
            const label = sourceType === 'addon'
              ? 'Remote subtitle stream'
              : 'Subtitle stream';
            throw new Error(`${label} failed after ${WHISPER_MAX_SESSION_RETRIES} attempts`);
          }
          await wait(isRemoteSource ? 1250 + (mediaRetryAttempts - 1) * 500 : 5000);
          continue;
        }

        const progress = await window.electronAPI.torrent.getFileProgress(fileIndex);
        const downloaded = progress?.downloaded ?? 0;
        const total = progress?.total ?? 0;
        const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        const waitingMessage = 'Waiting for more media before retrying...';
        startSeconds = await getResumeSeconds();

        console.warn('[WhisperLive] Retryable error, waiting for more media:', {
          downloaded,
          total,
          percent,
          ready: progress?.ready,
          startSeconds,
          localPath,
          error,
        });
        setSubtitleStatus('waiting');
        setSubtitleMessage(`${waitingMessage}${percent > 0 ? ` (${percent}%)` : ''}`);
        setSubtitleAssist({
          status: 'waiting',
          message: waitingMessage,
          progress: percent,
        });
        setWhisperProcessedSeconds(startSeconds);

        const next = await waitForMoreMedia(fileIndex, disposedRef, downloaded);
        if (isCancelled()) {
          throw new Error('Subtitle transcription was cancelled');
        }

        console.log('[WhisperLive] Media wait result:', {
          previousDownloaded: downloaded,
          nextDownloaded: next.downloaded,
          nextTotal: next.total,
          nextComplete: next.complete,
          startSeconds,
          localPath,
        });

        // If the file is now complete, retry with the local path.
        if (next.complete && localPath) {
          console.log('[WhisperLive] Retrying completed local file from offset:', {
            localPath,
            title: videoFile.name,
            startSeconds,
            progress: next,
          });
          await window.electronAPI.subtitles.transcribeWithWhisperLive(
            localPath,
            videoFile.name,
            await getSelectedWhisperLanguage(),
            jobId,
            startSeconds,
          );
          return;
        }
      }
    }

    throw new Error('Subtitle transcription was cancelled');
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') {
        setShowDebug(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!mpvPid) return;

    let unlistenMove: (() => void) | undefined;
    let unlistenResize: (() => void) | undefined;

    const setupWindowTracking = async () => {
      const appWin = getCurrentWindow();

      unlistenMove = await appWin.onMoved(async ({ payload: newPos }) => {
        if (mpvPid) {
          const size = await appWin.outerSize();
          const bounds = {
            appX: newPos.x,
            appY: newPos.y,
            appWidth: size.width,
            appHeight: size.height,
            offsetX: MPV_OFFSET_X,
            offsetY: MPV_OFFSET_Y,
            width: size.width - MPV_WIDTH_TRIM,
            height: size.height - MPV_HEIGHT_TRIM,
          };
          const mpvX = newPos.x + bounds.offsetX;
          const mpvY = newPos.y + bounds.offsetY;
          setMpvDebugBounds(bounds);
          try {
            await window.electronAPI.moveMpvWindow(mpvPid, mpvX, mpvY, bounds.width, bounds.height);
          } catch (e) {
            console.error('%c[Stream]%c Failed to move MPV window:', 'color: #4ade80; font-weight: bold', 'color: inherit', e);
          }
        }
      });

      unlistenResize = await appWin.onResized(async ({ payload: _newSize }) => {
        if (mpvPid) {
          const bounds = await getMpvDebugBounds(appWin);
          const mpvX = bounds.appX + bounds.offsetX;
          const mpvY = bounds.appY + bounds.offsetY;
          setMpvDebugBounds(bounds);
          try {
            await window.electronAPI.moveMpvWindow(mpvPid, mpvX, mpvY, bounds.width, bounds.height);
          } catch (e) {
            console.error('%c[Stream]%c Failed to move MPV window:', 'color: #4ade80; font-weight: bold', 'color: inherit', e);
          }
        }
      });
    };

    setupWindowTracking();

    return () => {
      unlistenMove?.();
      unlistenResize?.();
    };
  }, [mpvPid]);

  useEffect(() => {
    let disposed = false;

    const refreshMpvDebugBounds = async () => {
      try {
        const appWin = getCurrentWindow();
        const bounds = await getMpvDebugBounds(appWin);
        if (!disposed) {
          setMpvDebugBounds(bounds);
        }

        if (mpvPid) {
          const [x, y, width, height] = await window.electronAPI.getMpvWindowPos();
          if (!disposed) {
            setMpvActualBounds({
              x,
              y,
              width,
              height,
              offsetX: x - bounds.appX,
              offsetY: y - bounds.appY,
            });
          }
        } else if (!disposed) {
          setMpvActualBounds(null);
        }
      } catch (error) {
        if (!disposed) {
          setMpvActualBounds(null);
        }
        console.error('%c[Stream]%c Failed to read app/MPV window bounds for MPV debug:', 'color: #4ade80; font-weight: bold', 'color: inherit', error);
      }
    };

    if (showDebug) {
      refreshMpvDebugBounds();
    }

    const intervalId = showDebug ? window.setInterval(refreshMpvDebugBounds, 500) : null;

    return () => {
      disposed = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [showDebug, mpvPid]);

  useEffect(() => {
    if (!pieceCanvasRef.current || !showDetailedPieces || pieceBitfield.length === 0) return;
    
    const canvas = pieceCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const totalPieces = stats.pieces.total;
    const cols = Math.ceil(Math.sqrt(totalPieces));
    const rows = Math.ceil(totalPieces / cols);
    const cellSize = Math.max(2, Math.floor(300 / cols));
    
    canvas.width = cols * cellSize;
    canvas.height = rows * cellSize;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    for (let i = 0; i < totalPieces; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const done = isPieceDone(pieceBitfield, i);
      ctx.fillStyle = done ? '#22c55e' : '#374151';
      ctx.fillRect(col * cellSize, row * cellSize, cellSize - 1, cellSize - 1);
    }
  }, [pieceBitfield, showDetailedPieces, stats.pieces.total]);

  useEffect(() => {
    let disposed = false;
    let progressUnlisten: (() => void) | null = null;
    let playlistChangedUnlisten: (() => void) | null = null;
    let recoveryInProgress = false;
    let recoveryLogged = false;
    let lastProgressEventAt = Date.now();
    let guardedFilename: string | null = null;
    let transitionGuardUntil = 0;
    let transitionFallbackAt = 0;
    let transitionAwaitingProgress = false;
    let transitionGuardLogged = false;

    const samePlaybackIdentity = (left: string | null, right: string) => {
      if (!left) return false;
      const normalizedLeft = normalizeSourceIdentity(left);
      const normalizedRight = normalizeSourceIdentity(right);
      return normalizedLeft && normalizedRight
        ? normalizedLeft === normalizedRight
        : left === right;
    };

    const armTransitionGuard = (filename: string) => {
      if (!filename || samePlaybackIdentity(guardedFilename, filename)) return;
      guardedFilename = filename;
      transitionGuardUntil = Date.now() + 60_000;
      transitionFallbackAt = Date.now() + 2_000;
      transitionAwaitingProgress = true;
      transitionGuardLogged = false;
      recoveryLogged = false;
    };

    const runSegmentDetection = (
      filename: string,
      playbackTime: number,
      duration: number,
      playlistPos?: number,
    ) => {
      const handler = segmentDetectionHandlerRef.current;
      if (handler) {
        void handler(filename, playbackTime, duration, playlistPos);
      }
    };

    void window.electronAPI.playerEvents.onProgress((data) => {
      if (disposed) return;
      if (
        transitionAwaitingProgress
        && guardedFilename
        && !samePlaybackIdentity(guardedFilename, data.filename)
      ) {
        console.debug('[Segment Detection] Ignoring stale progress during episode transition', {
          expectedFilename: guardedFilename,
          receivedFilename: data.filename,
        });
        return;
      }
      if (!samePlaybackIdentity(guardedFilename, data.filename)) {
        armTransitionGuard(data.filename);
      }
      lastProgressEventAt = Date.now();
      recoveryLogged = false;
      runSegmentDetection(data.filename, data.playback_time, data.duration, data.playlist_pos);
      if (samePlaybackIdentity(guardedFilename, data.filename)) {
        transitionAwaitingProgress = false;
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        progressUnlisten = unlisten;
      }
    }).catch((error) => {
      console.debug('[Segment Detection] Stable progress listener unavailable', error);
    });

    void window.electronAPI.playerEvents.onPlaylistChanged((data) => {
      if (disposed) return;
      void window.electronAPI.getPlayerInfo()
        .then((playerInfo) => {
          if (
            disposed
            || !playerInfo.connected
            || typeof playerInfo.filename !== 'string'
          ) {
            return;
          }
          if (!samePlaybackIdentity(data.filename, playerInfo.filename)) {
            console.debug('[Segment Detection] Ignoring stale playlist identity event', {
              eventFilename: data.filename,
              currentFilename: playerInfo.filename,
            });
            return;
          }
          armTransitionGuard(data.filename);
        })
        .catch((error) => {
          console.debug('[Segment Detection] Playlist identity confirmation unavailable', error);
        });
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        playlistChangedUnlisten = unlisten;
      }
    }).catch((error) => {
      console.debug('[Segment Detection] Stable playlist listener unavailable', error);
    });

    const recoveryInterval = window.setInterval(() => {
      const now = Date.now();
      const transitionFallbackDue = transitionAwaitingProgress
        && now >= transitionFallbackAt
        && now < transitionGuardUntil;
      const progressEventsStalled = now - lastProgressEventAt >= 5_000;
      if (
        disposed
        || recoveryInProgress
        || (!transitionFallbackDue && !progressEventsStalled)
      ) {
        return;
      }

      recoveryInProgress = true;
      void window.electronAPI.getPlayerInfo()
        .then((playerInfo) => {
          if (
            disposed
            || !playerInfo.connected
            || typeof playerInfo.filename !== 'string'
            || typeof playerInfo.playback_time !== 'number'
            || typeof playerInfo.duration !== 'number'
          ) {
            return;
          }
          if (
            transitionFallbackDue
            && guardedFilename
            && !samePlaybackIdentity(guardedFilename, playerInfo.filename)
          ) {
            return;
          }
          if (transitionFallbackDue && !transitionGuardLogged) {
            transitionGuardLogged = true;
            console.warn('[Segment Detection] Episode transition retry guard using MPV state', {
              filename: playerInfo.filename,
            });
          } else if (progressEventsStalled && !recoveryLogged) {
            recoveryLogged = true;
            console.warn('[Segment Detection] Progress events stalled; using stable MPV state recovery checks');
          }
          runSegmentDetection(
            playerInfo.filename,
            playerInfo.playback_time,
            playerInfo.duration,
            playerInfo.playlist_pos ?? undefined,
          );
          if (transitionFallbackDue) {
            transitionAwaitingProgress = false;
          }
        })
        .catch((error) => {
          console.debug('[Segment Detection] MPV state recovery check unavailable', error);
        })
        .finally(() => {
          recoveryInProgress = false;
        });
    }, 2_000);

    return () => {
      disposed = true;
      progressUnlisten?.();
      playlistChangedUnlisten?.();
      window.clearInterval(recoveryInterval);
    };
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    let startupStateUnlisten: (() => void) | null = null;
    let readyUnlisten: (() => void) | null = null;
    let progressUnlisten: (() => void) | null = null;
    let subtitleProgressUnlisten: (() => void) | null = null;
    let subtitleSegmentUnlisten: (() => void) | null = null;
    let addonStreamErrorUnlisten: (() => void) | null = null;
    let playerProgressUnlisten: (() => void) | null = null;
    let playerPauseUnlisten: (() => void) | null = null;
    let playerPlayUnlisten: (() => void) | null = null;
    let playerStopUnlisten: (() => void) | null = null;
    let playerSeekUnlisten: (() => void) | null = null;
    let playerPlaylistChangedUnlisten: (() => void) | null = null;
    let playerSmartNextUnlisten: (() => void) | null = null;
    let playerAudioTrackChangedUnlisten: (() => void) | null = null;
    let playerClosedUnlisten: (() => void) | null = null;
    let playerEofUnlisten: (() => void) | null = null;
    let playerReconnectedUnlisten: (() => void) | null = null;
    let playerHdrRestartUnlisten: (() => void) | null = null;
    let restartSubtitlePipeline: (() => Promise<void>) | null = null;
    let disposed = false;
    const disposedRef = { current: false };
    let prelaunchedMpvPid: number | null = null;
    let prelaunchMpvPromise: Promise<number | null> | null = null;
    let prelaunchedMpvLoaded = false;
    let addonProxySessionId: string | null = null;
    let addonMpvPid: number | null = null;
    let addonLoadRequested = false;
    let addonPlaybackStarted = false;
    let addonFailureHandled = false;
    let smartNextAvailabilitySynced = false;
    let smartNextBackgroundPreparationStarted = false;
    let introDbLookupKey: string | null = null;
    let introDbLookupPromise: Promise<IntroDbSegments | null> | null = null;
    let chapterLookupKey: string | null = null;
    let chapterLookupPromise: Promise<PlayerChapterSegments | null> | null = null;
    type IntroSkipperLookupState = {
      promise: Promise<IntroSkipperDetectionResult | null> | null;
      retryTimer: number | null;
      failureRetries: number;
      generation: number;
      analysisPart?: 1 | 2;
    };
    type SegmentDetectionSnapshot = {
      filename: string;
      playbackTime: number;
      duration: number;
      playlistPos?: number;
    };
    type SegmentDetectionRun = {
      running: boolean;
      pending: SegmentDetectionSnapshot | null;
    };
    const introSkipperLookups = new Map<string, IntroSkipperLookupState>();
    const introSkipperOutroLookups = new Map<string, IntroSkipperLookupState>();
    // Keep completed detections across playback-effect restarts. Remote-source and
    // player state updates can recreate this effect while a fingerprint job is
    // finishing; episode/release-scoped keys keep retained results safe.
    const resolvedLocalIntroSegments = resolvedLocalIntroSegmentsRef.current;
    const resolvedLocalOutroSegments = resolvedLocalOutroSegmentsRef.current;
    const segmentDetectionRuns = new Map<string, SegmentDetectionRun>();
    let introSkipperGeneration = 0;
    let introSkipperOutroGeneration = 0;
    let introDbActionInProgress = false;
    let ownedSegmentDetectionHandler: typeof segmentDetectionHandlerRef.current = null;
    const introDbObservedSegments = new Set<string>();
    const introDbProcessedSegments = new Set<string>();
    const introDbActionRetryAfter = new Map<string, number>();
    const outroSmartNextRetryAfter = new Map<string, number>();
    const segmentDetectionLoggedKeys = new Set<string>();
    const segmentDecisionLoggedKeys = new Set<string>();
    type SegmentBoundaryTimerState = {
      timerId: number;
      generation: number;
      segmentKey: string;
      filename: string;
      dueAt: number;
    };
    let segmentBoundaryGeneration = 0;
    let segmentBoundaryTimer: SegmentBoundaryTimerState | null = null;

    if (!selectedStream) {
      return;
    }

    const cancelSegmentBoundaryTimer = (reason: string) => {
      segmentBoundaryGeneration += 1;
      if (!segmentBoundaryTimer) return;
      window.clearTimeout(segmentBoundaryTimer.timerId);
      console.debug('[Episode Segments] Segment boundary timer cancelled', {
        reason,
        segmentKey: segmentBoundaryTimer.segmentKey,
      });
      segmentBoundaryTimer = null;
    };
    const scheduleSegmentBoundaryCheck = (
      segmentKey: string,
      filename: string,
      playlistPos: number | undefined,
      playbackTime: number,
      segmentStart: number,
    ) => {
      if (
        disposed
        || playbackPausedRef.current
        || !Number.isFinite(playbackTime)
        || !Number.isFinite(segmentStart)
        || playbackTime >= segmentStart
      ) {
        return;
      }
      const delayMs = Math.max(1_000, Math.round((segmentStart - playbackTime) * 1_000) + 100);
      const dueAt = Date.now() + delayMs;
      if (
        segmentBoundaryTimer?.segmentKey === segmentKey
        && Math.abs(segmentBoundaryTimer.dueAt - dueAt) < 1_500
      ) {
        return;
      }
      cancelSegmentBoundaryTimer('rearmed');
      const generation = segmentBoundaryGeneration;
      const timerId = window.setTimeout(() => {
        if (
          disposed
          || generation !== segmentBoundaryGeneration
          || segmentBoundaryTimer?.generation !== generation
        ) {
          return;
        }
        segmentBoundaryTimer = null;
        void window.electronAPI.getPlayerInfo()
          .then((playerInfo) => {
            if (
              disposed
              || generation !== segmentBoundaryGeneration
              || !playerInfo.connected
              || typeof playerInfo.filename !== 'string'
              || typeof playerInfo.playback_time !== 'number'
              || typeof playerInfo.duration !== 'number'
              || normalizeSourceIdentity(playerInfo.filename) !== normalizeSourceIdentity(filename)
            ) {
              return;
            }
            console.debug('[Episode Segments] Segment boundary timer fired', {
              segmentKey,
              playbackTime: playerInfo.playback_time,
            });
            void segmentDetectionHandlerRef.current?.(
              playerInfo.filename,
              playerInfo.playback_time,
              playerInfo.duration,
              playerInfo.playlist_pos ?? playlistPos,
            );
          })
          .catch((error) => {
            console.debug('[Episode Segments] Segment boundary timer could not read MPV state', error);
          });
      }, delayMs);
      segmentBoundaryTimer = {
        timerId,
        generation,
        segmentKey,
        filename,
        dueAt,
      };
      console.debug('[Episode Segments] Segment boundary timer armed', {
        segmentKey,
        playbackTime,
        segmentStart,
        delayMs,
      });
    };

    introSkipperCurrentUrlRef.current = null;

    if (initInProgress.current) {
      console.warn('[Stream] Recovering stale playback initialization guard for the newly selected stream');
    }

    // These guards belong to one selected stream. A Smart Next state swap keeps
    // the Player mounted, so explicitly reset them for the new launch effect.
    streamOpenedRef.current = false;
    torrentStartedRef.current = false;
    initInProgress.current = true;
    const playbackLaunchId = ++playbackLaunchIdRef.current;
    lastSvpPlaylistPosRef.current = null;
    const directFailoverMediaKey = [
      selectedMeta?.id || '',
      selectedStream.preferredSeason ?? 0,
      selectedStream.preferredEpisode ?? 0,
    ].join(':');
    if (
      directStartupFailoverRef.current.mediaKey !== directFailoverMediaKey
      || directStartupFailoverRef.current.retryNonce !== startupNonce
    ) {
      directStartupFailoverRef.current = {
        mediaKey: directFailoverMediaKey,
        retryNonce: startupNonce,
        attempted: false,
      };
    }

    const handleAddonStartupFailure = async (message: string) => {
      if (disposed || addonFailureHandled || addonPlaybackStarted) return;
      addonFailureHandled = true;
      smartNextTransitionRef.current = false;
      useStore.getState().setPlaybackTransitionActive(false);
      addonLoadRequested = false;
      streamOpenedRef.current = false;

      const failedSessionId = addonProxySessionId;
      addonProxySessionId = null;
      if (failedSessionId && useStore.getState().addonTransferSessionId === failedSessionId) {
        useStore.getState().setAddonTransferSessionId(null);
      }

      const failedPid = addonMpvPid ?? mpvPidRef.current;
      addonMpvPid = null;
      setMpvPid(null);
      mpvPidRef.current = null;
      if (failedPid != null) {
        await window.electronAPI.stopMpvProcess(failedPid).catch(() => {});
      }
      if (failedSessionId) {
        await window.electronAPI.releaseAddonStream(failedSessionId).catch(() => {});
      }

      const currentAddonInstallationId = selectedStream.torrent.addonInstallationId;
      const imdbId = selectedMeta?.imdbId;
      if (
        currentAddonInstallationId
        && imdbId
        && !directStartupFailoverRef.current.attempted
      ) {
        directStartupFailoverRef.current.attempted = true;
        setStartupState({
          session_id: 0,
          attempt: 0,
          phase: 'waiting_for_addon',
          message: 'The first add-on failed. Looking for one backup add-on…',
        });
        setStartupError(null);
        setIsLoading(true);
        try {
          const outcome = await searchInstalledStreamAddons({
            imdbId,
            mediaType: selectedMeta.type === 'series' ? 'series' : 'movie',
            season: selectedStream.preferredSeason,
            episode: selectedStream.preferredEpisode,
            skipInstallationIds: [currentAddonInstallationId],
          });
          if (disposed || playbackLaunchIdRef.current !== playbackLaunchId) return;
          const replacement = selectDirectStartupReplacement(selectedStream.torrent, outcome.results);
          if (replacement) {
            const routeLabel = replacement.addonName || replacement.indexer || 'backup add-on';
            console.info('[Add-on Stream] Switching failed startup route', {
              fromInstallationId: currentAddonInstallationId,
              toInstallationId: replacement.addonInstallationId,
              exactRelease: replacement.infoHash?.toLowerCase() === selectedStream.torrent.infoHash?.toLowerCase()
                && replacement.sourceFileIndex === selectedStream.torrent.sourceFileIndex,
            });
            useStore.getState().setSelectedStream({
              ...selectedStream,
              url: replacement.magnetUri,
              title: replacement.title,
              torrent: replacement,
              sourceType: replacement.streamHandle ? 'addon' : 'webtorrent',
              routeSwitchMessage: `Switched to ${routeLabel} after the first add-on failed.`,
            });
            return;
          }
        } catch (failoverError) {
          console.warn('[Add-on Stream] Backup add-on search failed', {
            message: failoverError instanceof Error ? failoverError.message : 'Unknown error',
          });
        }
      }
      setStartupState({
        session_id: 0,
        attempt: 0,
        phase: 'failed',
        message,
      });
      setStartupError(message);
      setIsLoading(false);
    };

    const startPlayback = async () => {
      const isCurrentPlaybackLaunch = () => !disposed && playbackLaunchIdRef.current === playbackLaunchId;
      const beginSmartNextPerformance = (reason: 'autoload' | 'manual') => {
        const now = Date.now();
        const trace: SmartNextPerformanceTrace = {
          id: `${playbackLaunchId}-${now}`,
          startedAt: now,
          preparationStartedAt: now,
        };
        smartNextPerformanceRef.current = trace;
        console.log('[Smart Next Performance] Started', {
          traceId: trace.id,
          reason,
        });
        return trace;
      };
      const logSmartNextPerformance = (
        stage: string,
        details: Record<string, unknown> = {},
      ) => {
        const trace = smartNextPerformanceRef.current;
        if (!trace) return;
        console.log('[Smart Next Performance]', {
          traceId: trace.id,
          stage,
          elapsedMs: Date.now() - trace.startedAt,
          ...details,
        });
      };
      const smartNextAvailable = selectedMeta?.type === 'series' && selectedStream.sourceType !== 'local';
      const smartNextAutoloadEnabled = await window.electronAPI.settings
        .getSetting('smartNextAutoloadEnabled')
        .then((value) => value === 'true')
        .catch((error) => {
          console.warn('[Smart Next Autoload] Could not read setting; autoload disabled for this playback:', error);
          return false;
        });
      console.log('[Smart Next Autoload] Playback policy loaded', {
        enabled: smartNextAutoloadEnabled,
        available: smartNextAvailable,
        triggerPercent: SMART_NEXT_AUTOLOAD_TRIGGER_RATIO * 100,
      });
      const pendingWarmupHandoff = smartNextWarmupHandoffRef.current;
      const adoptedWarmup = pendingWarmupHandoff
        && pendingWarmupHandoff.sourceUrl === selectedStream.url
        && pendingWarmupHandoff.sourceType === selectedStream.sourceType
          ? pendingWarmupHandoff
          : null;
      if (adoptedWarmup) {
        if (adoptedWarmup.sourceType === 'addon') {
          await window.electronAPI.activateSmartNextStream(adoptedWarmup.prepared.file_url);
        }
        smartNextWarmupHandoffRef.current = null;
        console.log('[Smart Next Autoload] Prepared opening adopted by playback', {
          sourceType: adoptedWarmup.sourceType,
          cachedBytes: adoptedWarmup.prepared.ready_bytes,
          totalBytes: adoptedWarmup.prepared.total_bytes,
        });
        logSmartNextPerformance('warmup-adopted', {
          sourceType: adoptedWarmup.sourceType,
          cachedBytes: adoptedWarmup.prepared.ready_bytes,
          totalBytes: adoptedWarmup.prepared.total_bytes,
        });
      }
      if (smartNextTransitionRef.current && smartNextPerformanceRef.current) {
        const trace = smartNextPerformanceRef.current;
        trace.playbackLaunchStartedAt = Date.now();
        logSmartNextPerformance('next-playback-launch-started', {
          sourceType: selectedStream.sourceType,
          launchDelayMs: trace.playbackLaunchStartedAt - (trace.handoffSelectedAt ?? trace.startedAt),
          warmupReady: trace.warmupReady ?? false,
        });
      }
      const syncSmartNextAvailability = () => {
        if (smartNextAvailabilitySynced) return;
        void window.electronAPI.player.setSmartNextAvailable(smartNextAvailable)
          .then(() => {
            smartNextAvailabilitySynced = true;
          })
          .catch(() => {});
      };
      const showSmartNextMessage = (message: string, durationMs = 3000) => {
        void window.electronAPI.player.showMessage(message, durationMs).catch(() => {});
      };
      const setSmartNextTransitionActive = (active: boolean) => {
        smartNextTransitionRef.current = active;
        useStore.getState().setPlaybackTransitionActive(active);
      };
      const restoreSmartNextWindowState = () => {
        const pending = smartNextWindowRestoreRef.current;
        const currentMpvPid = mpvPidRef.current;
        if (
          !pending
          || currentMpvPid == null
          || currentMpvPid === pending.previousMpvPid
          || smartNextWindowRestoreInFlightRef.current
        ) {
          return;
        }

        pending.attempts += 1;
        smartNextWindowRestoreInFlightRef.current = true;
        void window.electronAPI.player.restoreSmartNextWindowState(
          currentMpvPid,
          pending.fullscreen,
        )
          .then(() => {
            if (smartNextWindowRestoreRef.current === pending) {
              smartNextWindowRestoreRef.current = null;
            }
            console.log('[Smart Next] Restored MPV window state', {
              fullscreen: pending.fullscreen,
              mpvPid: currentMpvPid,
            });
          })
          .catch((error) => {
            console.warn('[Smart Next] Could not restore MPV window state:', error);
            if (pending.attempts >= 3 && smartNextWindowRestoreRef.current === pending) {
              smartNextWindowRestoreRef.current = null;
            }
          })
          .finally(() => {
            smartNextWindowRestoreInFlightRef.current = false;
          });
      };
      const setCurrentMpvPid = (pid: number | null) => {
        if (!isCurrentPlaybackLaunch()) {
          return false;
        }
        setMpvPid(pid);
        mpvPidRef.current = pid;
        if (pid != null) {
          restoreSmartNextWindowState();
        }
        return true;
      };
      const persistSmartNextSource = (
        torrent: TorrentResult,
        sourceType: 'webtorrent' | 'qbittorrent' | 'addon',
        target: SmartNextTarget,
      ) => {
        if (!selectedMeta || selectedMeta.type !== 'series') return;
        const tmdbId = selectedMeta.id.split(':')[1];
        if (!tmdbId) return;

        try {
          const key = `series-${tmdbId}`;
          const lastSources = JSON.parse(localStorage.getItem('streamee-last-sources') || '{}');
          const lastSourceMeta = JSON.parse(localStorage.getItem('streamee-last-source-meta') || '{}');
          const sourceReference = sourceType === 'addon'
            ? `${torrent.addonInstallationId || 'addon'}:${selectedMeta.imdbId || ''}:${target.season}:${target.episode}`
            : torrent.streamUrl || torrent.magnetUri;
          lastSources[key] = sourceReference;
          lastSourceMeta[key] = {
            sourceType,
            sourceUrl: sourceReference,
            preferredSeason: target.season,
            preferredEpisode: target.episode,
            sourceFilename: torrent.streamFilename || torrent.title,
            ...(sourceType === 'addon'
              ? {
                  addonInstallationId: torrent.addonInstallationId,
                  addonId: torrent.addonId,
                  addonName: torrent.addonName,
                  addonImdbId: selectedMeta.imdbId,
                  addonInfoHash: torrent.infoHash || undefined,
                  addonFileIndex: torrent.sourceFileIndex,
                  addonIndexer: torrent.indexer,
                  addonSize: torrent.size,
                  addonQuality: torrent.quality,
                }
              : {}),
          };
          localStorage.setItem('streamee-last-sources', JSON.stringify(lastSources));
          localStorage.setItem('streamee-last-source-meta', JSON.stringify(lastSourceMeta));
        } catch (error) {
          console.warn('[Smart Next] Failed to persist the selected source:', error);
        }
      };
      const commitPendingSmartNextPersistence = (): boolean => {
        const pending = smartNextPendingPersistenceRef.current;
        if (
          !pending
          || pending.sourceUrl !== selectedStream.url
          || pending.sourceType !== selectedStream.sourceType
        ) {
          return false;
        }
        persistSmartNextSource(pending.torrent, pending.sourceType, pending.target);
        smartNextPendingPersistenceRef.current = null;
        void restartSvpAfterPlaybackChange('Smart Next transition');
        return true;
      };
      const resolveSmartNextCurrentEpisode = (filename: string): SmartNextTarget => {
        const preferredSeason = selectedStream.preferredSeason ?? 1;
        const currentEpisode = extractEpisodeNumber(filename, preferredSeason)
          || extractEpisodeNumber(selectedStream.torrent.streamFilename || selectedStream.title, preferredSeason)
          || (
            typeof selectedStream.preferredSeason === 'number'
            && typeof selectedStream.preferredEpisode === 'number'
              ? { season: selectedStream.preferredSeason, episode: selectedStream.preferredEpisode }
              : null
          );
        if (!currentEpisode) {
          throw new Error('Could not identify the currently playing episode.');
        }
        return currentEpisode;
      };
      const getOrCreateSmartNextPreparation = (filename: string): SmartNextPreparationEntry => {
        if (!selectedMeta || selectedMeta.type !== 'series') {
          throw new Error('Smart Next is only available for TV episodes.');
        }

        const currentEpisode = resolveSmartNextCurrentEpisode(filename);
        const tmdbId = Number(selectedMeta.id.split(':')[1]);
        if (!Number.isFinite(tmdbId)) {
          throw new Error('Could not identify this show in TMDB.');
        }

        const configuredAddons = loadInstalledAddons()
          .filter((addon) => addon.enabled)
          .map((addon) => addon.installationId)
          .join(',');
        const preparationKey = [
          tmdbId,
          currentEpisode.season,
          currentEpisode.episode,
          configuredAddons,
          selectedStream.torrent.id || selectedStream.url,
        ].join(':');
        const existing = smartNextPreparationRef.current;
        if (
          existing
          && shouldReuseSmartNextPreparation(
            existing.key,
            preparationKey,
            existing.expiresAt,
            !!existing.result?.warmup,
          )
        ) {
          return existing;
        }

        let entry: SmartNextPreparationEntry;
        const promise = (async (): Promise<SmartNextPreparedMatch> => {
          const target = await findNextAiredEpisode(tmdbId, currentEpisode);
          const trace = smartNextPerformanceRef.current;
          if (trace) {
            trace.nextEpisodeResolvedAt = Date.now();
            logSmartNextPerformance('next-episode-resolved', {
              season: target?.season ?? null,
              episode: target?.episode ?? null,
              resolveNextEpisodeMs: trace.nextEpisodeResolvedAt - (trace.preparationStartedAt ?? trace.startedAt),
            });
          }
          if (!isCurrentPlaybackLaunch()) {
            throw new Error('Smart Next preparation was cancelled.');
          }
          if (!target) {
            throw new Error('No later aired episode is available yet.');
          }

          const episodeLabel = formatSmartNextEpisode(target);
          if (trace) {
            trace.episode = episodeLabel;
            trace.sourceSearchStartedAt = Date.now();
          }
          const outcome = await searchEnabledSourceProviders({
            imdbId: selectedMeta.imdbId,
            isTvShow: true,
            season: target.season,
            episode: target.episode,
          });
          const candidates = outcome.results;

          if (!isCurrentPlaybackLaunch()) {
            throw new Error('Smart Next preparation was cancelled.');
          }
          const best = rankSmartNextCandidates(selectedStream.torrent, candidates)[0];
          if (!best) {
            throw new Error(`No playable source was found for ${episodeLabel}.`);
          }
          if (trace) {
            trace.sourceSelectedAt = Date.now();
            trace.sourceType = best.result.directStreamProvider || best.result.sourceProvider || best.result.indexer;
            logSmartNextPerformance('source-selected', {
              episode: episodeLabel,
              provider: trace.sourceType,
              candidateCount: candidates.length,
              sourceSearchMs: trace.sourceSelectedAt - (trace.sourceSearchStartedAt ?? trace.startedAt),
              preparationMs: trace.sourceSelectedAt - (trace.preparationStartedAt ?? trace.startedAt),
            });
          }
          return { target, episodeLabel, best };
        })();

        entry = {
          key: preparationKey,
          expiresAt: Date.now() + SMART_NEXT_PREPARATION_TTL_MS,
          promise,
          result: null,
          warmupPromise: null,
        };
        smartNextPreparationRef.current = entry;
        void promise
          .then((result) => {
            if (smartNextPreparationRef.current === entry) {
              entry.result = result;
            }
          })
          .catch(() => {
            if (smartNextPreparationRef.current === entry) {
              smartNextPreparationRef.current = null;
            }
          });
        return entry;
      };
      const warmPreparedSmartNext = async (prepared: SmartNextPreparedMatch) => {
        const candidate = prepared.best.result;
        const sourceUrl = candidate.streamUrl || candidate.magnetUri;
        const trace = smartNextPerformanceRef.current;
        if (trace) {
          trace.warmupStartedAt = Date.now();
          trace.episode = prepared.episodeLabel;
          logSmartNextPerformance('warmup-started', {
            episode: prepared.episodeLabel,
            provider: candidate.directStreamProvider || candidate.sourceProvider || candidate.indexer,
          });
        }
        let addonSessionId: string | undefined;
        let preparedQbitHash: string | undefined;
        try {
          let handoff: SmartNextWarmupHandoff | null = null;
          if (candidate.streamHandle || (candidate.streamUrl && /^https?:\/\//i.test(candidate.streamUrl))) {
            const displayName = candidate.streamFilename || candidate.title;
            const directCacheIdentity = buildDirectStreamCacheIdentity(candidate);
            const monitoredStream = candidate.streamHandle
              ? await window.electronAPI.prepareDirectStreamHandle(
                  candidate.streamHandle,
                  candidate.size,
                  displayName,
                  candidate.addonInstallationId,
                  candidate.addonName,
                  directCacheIdentity,
                  false,
                  false,
                )
              : await window.electronAPI.prepareAddonStreamUrl(
                  candidate.streamUrl!,
                  candidate.size,
                  displayName,
                  candidate.addonInstallationId,
                  candidate.addonName,
                  directCacheIdentity,
                  false,
                  false,
                );
            addonSessionId = monitoredStream.session_id;
            if (!isCurrentPlaybackLaunch()) {
              await window.electronAPI.releaseAddonStream(monitoredStream.session_id).catch(() => {});
              return;
            }
            const warmup = await window.electronAPI.warmSmartNextStream(monitoredStream.url);
            handoff = {
              sourceUrl,
              sourceType: 'addon',
              addonSessionId: monitoredStream.session_id,
              prepared: {
                file_url: monitoredStream.url,
                file_name: displayName,
                ready_bytes: warmup.cached_bytes,
                total_bytes: warmup.total_bytes,
                playlist_file_urls: [],
                playlist_files: [],
                torrent_hash: candidate.infoHash || '',
                downloaded_bytes: warmup.cached_bytes,
              },
            };
          } else {
            if (candidate.magnetUri.startsWith('magnet:?')) {
              const sameActiveQbitTorrent = selectedStream.sourceType === 'qbittorrent'
                && !!candidate.infoHash
                && candidate.infoHash.toLowerCase() === selectedStream.torrent.infoHash.toLowerCase();
              if (sameActiveQbitTorrent) {
                console.info('[Smart Next Autoload] External playback warmup skipped', {
                  episode: prepared.episodeLabel,
              reason: 'candidate-is-active-playback-source',
                });
                return;
              }
              const preparedStream = await window.electronAPI.prepareSmartNextQbittorrent(
                candidate.magnetUri,
                candidate.infoHash,
                prepared.target.season,
                prepared.target.episode,
                candidate.streamFilename || candidate.title,
              );
              preparedQbitHash = preparedStream.torrent_hash;
              if (!isCurrentPlaybackLaunch()) {
                await window.electronAPI.pauseSmartNextQbittorrent(preparedStream.torrent_hash).catch(() => {});
                return;
              }
              handoff = {
                sourceUrl,
                sourceType: 'qbittorrent',
                prepared: preparedStream,
              };
            }
          }

          if (!handoff) {
            logSmartNextPerformance('warmup-unavailable', {
              episode: prepared.episodeLabel,
              provider: candidate.sourceProvider || candidate.indexer,
              reason: 'playable-source-reference-required',
            });
            console.info('[Smart Next Autoload] No non-disruptive warmup path for selected source', {
              episode: prepared.episodeLabel,
              provider: candidate.sourceProvider || candidate.indexer,
              reason: 'playable-source-reference-required',
            });
            return;
          }
          if (!isCurrentPlaybackLaunch()) {
            if (handoff.addonSessionId) {
              await window.electronAPI.releaseAddonStream(handoff.addonSessionId).catch(() => {});
            }
            return;
          }
          prepared.warmup = handoff;
          if (trace) {
            trace.warmupReadyAt = Date.now();
            trace.sourceType = handoff.sourceType;
            trace.cachedBytes = handoff.prepared.ready_bytes;
            trace.totalBytes = handoff.prepared.total_bytes;
            trace.warmupReady = true;
            logSmartNextPerformance('warmup-ready', {
              episode: prepared.episodeLabel,
              sourceType: handoff.sourceType,
              warmupMs: trace.warmupReadyAt - (trace.warmupStartedAt ?? trace.startedAt),
              cachedBytes: handoff.prepared.ready_bytes,
              totalBytes: handoff.prepared.total_bytes,
            });
          }
          console.log('[Smart Next Autoload] Warmup ready for handoff', {
            episode: prepared.episodeLabel,
            sourceType: handoff.sourceType,
            cachedBytes: handoff.prepared.ready_bytes,
            totalBytes: handoff.prepared.total_bytes,
          });
        } catch (error) {
          if (addonSessionId) {
            await window.electronAPI.releaseAddonStream(addonSessionId).catch(() => {});
          }
          if (preparedQbitHash) {
            await window.electronAPI.pauseSmartNextQbittorrent(preparedQbitHash).catch(() => {});
          }
          if (isCurrentPlaybackLaunch()) {
            const message = error instanceof Error ? error.message : String(error);
            prepared.warmupFailure = message;
            logSmartNextPerformance('warmup-failed', {
              episode: prepared.episodeLabel,
              warmupMs: Date.now() - (trace?.warmupStartedAt ?? trace?.startedAt ?? Date.now()),
              message,
            });
            console.warn('[Smart Next Autoload] Warmup failed; metadata preparation remains usable:', error);
          }
        }
      };
      const maybePrepareSmartNextInBackground = (
        filename: string,
        playbackTime: number | null | undefined,
        duration: number | null | undefined,
      ) => {
        if (
          smartNextBackgroundPreparationStarted
          || !smartNextAutoloadEnabled
          || !smartNextAvailable
          || smartNextTransitionRef.current
          || typeof playbackTime !== 'number'
          || typeof duration !== 'number'
          || duration <= 0
        ) {
          return;
        }

        const store = useStore.getState();
        if (store.playlistActive && store.playlistCurrentIndex < store.playlistFiles.length - 1) {
          smartNextBackgroundPreparationStarted = true;
          return;
        }

        const playbackRatio = playbackTime / duration;
        if (!shouldAutoloadSmartNext(true, playbackTime, duration)) {
          return;
        }

        smartNextBackgroundPreparationStarted = true;
        try {
          const trace = beginSmartNextPerformance('autoload');
          const preparation = getOrCreateSmartNextPreparation(filename);
          console.log('[Smart Next Autoload] Triggered', {
            playbackPercent: Math.round(playbackRatio * 1000) / 10,
            playbackTime,
            duration,
          });
          logSmartNextPerformance('autoload-triggered', {
            playbackPercent: Math.round(playbackRatio * 1000) / 10,
            triggerDelayMs: Date.now() - trace.startedAt,
          });
          void preparation.promise
            .then((prepared) => {
              if (isCurrentPlaybackLaunch()) {
                console.log('[Smart Next Autoload] Source preparation ready', {
                  episode: prepared.episodeLabel,
                  title: prepared.best.result.title,
                  provider: prepared.best.result.directStreamProvider
                    || prepared.best.result.sourceProvider
                    || prepared.best.result.indexer,
                });
                preparation.warmupPromise ??= warmPreparedSmartNext(prepared);
              }
            })
            .catch((error) => {
              if (isCurrentPlaybackLaunch()) {
                logSmartNextPerformance('source-preparation-failed', {
                  message: error instanceof Error ? error.message : String(error),
                });
                console.warn('[Smart Next Autoload] Source preparation failed:', error);
              }
            });
        } catch (error) {
          console.warn('[Smart Next Autoload] Trigger skipped:', error);
        }
      };
      const handleSmartNextRequest = async (
        filename: string,
        allowUnwarmedFallback = false,
      ) => {
        if (!isCurrentPlaybackLaunch()) return false;

        try {
          const store = useStore.getState();
          if (store.playlistActive && store.playlistCurrentIndex < store.playlistFiles.length - 1) {
            await window.electronAPI.player.playlistNext();
            return true;
          }
          const trace = smartNextPerformanceRef.current ?? beginSmartNextPerformance('manual');
          trace.transitionRequestedAt = Date.now();
          logSmartNextPerformance('transition-requested', {
            sourcePreparationReady: !!smartNextPreparationRef.current?.result,
          });
          const preparation = getOrCreateSmartNextPreparation(filename);
          if (!preparation.result) {
            showSmartNextMessage('Preparing next episode...', 5000);
          }
          const prepared = await preparation.promise;
          await preparation.warmupPromise;
          const { target, episodeLabel, best } = prepared;
          if (!isCurrentPlaybackLaunch()) return false;
          const preparedWarmup = prepared.warmup;
          if (!allowUnwarmedFallback && smartNextAutoloadEnabled && prepared.warmupFailure) {
            logSmartNextPerformance('transition-kept-current-playback', {
              episode: episodeLabel,
              reason: 'autoload-warmup-failed',
              message: prepared.warmupFailure,
            });
            console.warn('[Smart Next Autoload] Keeping current playback because next-episode warmup failed', {
              episode: episodeLabel,
              message: prepared.warmupFailure,
            });
            showSmartNextMessage('Next episode is not ready yet; continuing current episode.', 5000);
            return false;
          }
          if (!preparedWarmup) {
            void window.electronAPI.cancelSmartNextWarmup().catch(() => {});
          }

          const tmdbId = Number(selectedMeta?.id.split(':')[1]);
          if (!selectedMeta || selectedMeta.type !== 'series' || !Number.isFinite(tmdbId)) {
            throw new Error('Could not identify this show in TMDB.');
          }

          const nextSourceType: 'webtorrent' | 'qbittorrent' | 'addon' =
            preparedWarmup?.sourceType
            || (best.result.sourceProvider === 'addon' && !!best.result.streamUrl
              ? 'addon'
              : selectedStream.sourceType === 'qbittorrent'
                  ? 'qbittorrent'
                  : best.result.magnetUri.startsWith('magnet:?')
                    ? 'webtorrent'
                    : 'qbittorrent');
          const sourceUrl = best.result.streamUrl || best.result.magnetUri;
          const matchSummary = best.matchedTraits.slice(0, 3).join(', ');

          flushCurrentPlayingProgress();
          showSmartNextMessage(
            `Next ${episodeLabel}: ${matchSummary || best.result.quality}`,
            4000,
          );

          setSmartNextTransitionActive(true);
          const livePlayer = await window.electronAPI.getPlayerInfo().catch((error) => {
            console.warn('[Smart Next] Could not read the current MPV window state:', error);
            return null;
          });
          let currentMpvPid = mpvPidRef.current ?? livePlayer?.mpv_pid ?? null;
          if (livePlayer?.connected && currentMpvPid == null) {
            throw new Error('Could not identify the active MPV process.');
          }
          if (currentMpvPid != null) {
            smartNextWindowRestoreRef.current = {
              fullscreen: livePlayer?.fullscreen ?? null,
              previousMpvPid: currentMpvPid,
              attempts: 0,
            };
            await window.electronAPI.stopMpvProcess(currentMpvPid);
          }
          if (!isCurrentPlaybackLaunch()) {
            setSmartNextTransitionActive(false);
            return false;
          }

          setCurrentPlayingMeta({
            type: 'series',
            tmdbId,
            name: selectedMeta.name,
            poster: selectedMeta.poster,
            imdbId: selectedMeta.imdbId,
            season: target.season,
            episode: target.episode,
          });
          useStore.getState().setCurrentPlayingTitle(best.result.streamFilename || best.result.title);
          smartNextPendingPersistenceRef.current = {
            sourceUrl,
            torrent: best.result,
            sourceType: nextSourceType,
            target,
          };
          smartNextWarmupHandoffRef.current = preparedWarmup || null;
          trace.handoffSelectedAt = Date.now();
          trace.sourceType = nextSourceType;
          trace.warmupReady = !!preparedWarmup;
          trace.cachedBytes = preparedWarmup?.prepared.ready_bytes ?? 0;
          trace.totalBytes = preparedWarmup?.prepared.total_bytes;
          logSmartNextPerformance('handoff-selected', {
            episode: episodeLabel,
            sourceType: nextSourceType,
            warmupReady: !!preparedWarmup,
            cachedBytes: trace.cachedBytes,
            sourceWaitMs: trace.handoffSelectedAt - trace.transitionRequestedAt,
          });
          console.log('[Smart Next Autoload] Transition handoff selected', {
            episode: episodeLabel,
            sourceType: nextSourceType,
            warmupReady: !!preparedWarmup,
            cachedBytes: preparedWarmup?.prepared.ready_bytes ?? 0,
          });
          setSelectedStream({
            url: sourceUrl,
            title: best.result.title,
            torrent: best.result,
            sourceType: nextSourceType,
            preferredSeason: target.season,
            preferredEpisode: target.episode,
            resumeSourceFilename: best.result.streamFilename || best.result.title,
            startOver: true,
          });
          return true;
        } catch (error) {
          logSmartNextPerformance('transition-failed', {
            message: error instanceof Error ? error.message : String(error),
          });
          setSmartNextTransitionActive(false);
          smartNextWindowRestoreRef.current = null;
          const message = error instanceof Error ? error.message : String(error);
          console.error('[Smart Next] Failed:', error);
          showSmartNextMessage(`Smart Next: ${message}`, 5000);
          return false;
        }
      };
      const resolvePlaybackQueueIndex = (
        filename: string,
        playlistPos?: number,
      ): number | null => {
        const store = useStore.getState();
        const normalizedFilename = normalizeSourceIdentity(filename);
        const normalizedBaseName = normalizeSourceIdentity(getPathBaseName(filename));
        const identityIndex = store.playbackIdentityItems.findIndex((identity) => {
          const title = normalizeSourceIdentity(identity.title);
          const sourceKey = normalizeSourceIdentity(identity.sourceKey);
          const streamUrl = normalizeSourceIdentity(identity.streamUrl);
          return title === normalizedFilename
            || title === normalizedBaseName
            || sourceKey === normalizedFilename
            || sourceKey === normalizedBaseName
            || (!!streamUrl && streamUrl === normalizedFilename);
        });
        if (identityIndex !== -1) return identityIndex;

        const playlistIndex = store.playlistFiles.findIndex((file) => {
          const name = normalizeSourceIdentity(file.name);
          const streamUrl = normalizeSourceIdentity(file.streamUrl);
          return name === normalizedFilename
            || name === normalizedBaseName
            || (!!streamUrl && streamUrl === normalizedFilename)
            || (!!normalizedFilename && normalizedFilename.includes(`/stream/${file.index}`));
        });
        if (playlistIndex !== -1) return playlistIndex;
        return typeof playlistPos === 'number'
          && playlistPos >= 0
          && playlistPos < Math.max(store.playbackIdentityItems.length, store.playlistFiles.length)
            ? playlistPos
            : null;
      };
      const resolveIntroDbEpisode = (
        filename: string,
        playlistPos?: number,
      ): SmartNextTarget | null => {
        const store = useStore.getState();
        const queueIndex = resolvePlaybackQueueIndex(filename, playlistPos);
        const identity = queueIndex != null ? store.playbackIdentityItems[queueIndex] : null;
        if (typeof identity?.season === 'number' && typeof identity.episode === 'number') {
          return { season: identity.season, episode: identity.episode };
        }
        const playlistFile = queueIndex != null ? store.playlistFiles[queueIndex] : null;
        if (typeof playlistFile?.season === 'number' && typeof playlistFile.episode === 'number') {
          return {
            season: playlistFile.season,
            episode: playlistFile.episode,
          };
        }

        const parsedEpisode = extractEpisodeNumber(filename, selectedStream.preferredSeason ?? 1);
        if (parsedEpisode) return parsedEpisode;
        if (store.playlistActive) return null;
        return (
          typeof selectedStream.preferredSeason === 'number'
          && typeof selectedStream.preferredEpisode === 'number'
            ? {
                season: selectedStream.preferredSeason,
                episode: selectedStream.preferredEpisode,
              }
            : null
        );
      };
      const getIntroDbSegmentsForEpisode = async (
        imdbId: string | null,
        tmdbId: number,
        episode: SmartNextTarget,
        duration: number,
      ): Promise<{ key: string; segments: IntroDbSegments | null }> => {
        const key = `${tmdbId}:${imdbId?.toLowerCase() || ''}:${episode.season}:${episode.episode}:${Math.round(duration * 1_000)}`;
        if (introDbLookupKey !== key || !introDbLookupPromise) {
          introDbLookupKey = key;
          console.debug('[Segment Detection][Remote] Lookup started', {
            tmdbId,
            season: episode.season,
            episode: episode.episode,
            duration,
          });
          introDbLookupPromise = fetchIntroDbSegments(
            imdbId,
            tmdbId,
            episode.season,
            episode.episode,
            duration,
          )
            .then((segments) => {
              console.debug('[Segment Detection][Remote] Lookup complete', {
                season: episode.season,
                episode: episode.episode,
                intro: segments?.intro?.source ?? null,
                recap: segments?.recap?.source ?? null,
                outro: segments?.outro?.source ?? null,
              });
              return segments;
            })
            .catch((error) => {
              console.debug('[Segment Detection][Remote] Lookup unavailable', error);
              return null;
            });
        }

        const segments = await introDbLookupPromise;
        return { key, segments };
      };
      const resolveCurrentIntroSkipperSource = (
        filename: string,
        playlistPos?: number,
      ): string | null => {
        const store = useStore.getState();
        const queueIndex = resolvePlaybackQueueIndex(filename, playlistPos);
        if (queueIndex != null) {
          const queueUrl = store.playbackIdentityItems[queueIndex]?.streamUrl
            || store.playlistFiles[queueIndex]?.streamUrl;
          if (queueUrl) return queueUrl;
        }
        return store.playlistActive ? null : introSkipperCurrentUrlRef.current;
      };
      const getChapterSegments = async (
        episodeKey: string,
        duration: number,
      ): Promise<PlayerChapterSegments | null> => {
        const key = `${episodeKey}:${Math.round(duration * 1_000)}`;
        if (chapterLookupKey !== key || !chapterLookupPromise) {
          chapterLookupKey = key;
          console.debug('[Segment Detection][Local] Chapter scan started');
          chapterLookupPromise = window.electronAPI.introDb.detectChapters(duration)
            .then((segments) => {
              console.debug('[Segment Detection][Local] Chapter scan complete', {
                chapterCount: segments.chapter_count,
                intro: !!segments.intro,
                recap: !!segments.recap,
                outro: !!segments.outro,
              });
              return segments;
            })
            .catch((error) => {
              console.debug('[Segment Detection][Local] Chapter scan unavailable', error);
              return null;
            });
        }
        return chapterLookupPromise;
      };
      const getIntroSkipperSegment = async (
        episodeKey: string,
        localIntroCacheKey: string,
        sourceIdentity: string,
        seriesKey: string,
        episode: SmartNextTarget,
        filename: string,
        duration: number,
        playlistPos?: number,
      ): Promise<IntroSkipperDetectionResult | null> => {
        const currentUrl = resolveCurrentIntroSkipperSource(filename, playlistPos);
        if (!currentUrl) {
          console.debug('[Segment Detection][Local] Rolling fingerprint skipped: current stream URL unavailable');
          return null;
        }

        const key = `${episodeKey}:${Math.round(duration * 1_000)}:${currentUrl}`;
        let state = introSkipperLookups.get(key);
        if (!state) {
          state = {
            promise: null,
            retryTimer: null,
            failureRetries: 0,
            generation: introSkipperGeneration,
            analysisPart: 1,
          };
          introSkipperLookups.set(key, state);
        }
        if (!state.promise) {
          const lookupState = state;
          const lookupGeneration = lookupState.generation;
          const persistentAudioGeneration = localSegmentAudioGenerationRef.current;
          const scheduleRetry = (delayMs: number) => {
            if (lookupState.retryTimer != null) {
              window.clearTimeout(lookupState.retryTimer);
            }
            lookupState.retryTimer = window.setTimeout(() => {
              lookupState.retryTimer = null;
              if (
                disposed
                || lookupGeneration !== introSkipperGeneration
                || introSkipperLookups.get(key) !== lookupState
                || introDbLookupKey !== episodeKey
              ) {
                return;
              }
              lookupState.promise = null;
              void window.electronAPI.getPlayerInfo()
                .then((playerInfo) => {
                  if (
                    disposed
                    || lookupGeneration !== introSkipperGeneration
                    || introSkipperLookups.get(key) !== lookupState
                    || !playerInfo.connected
                    || typeof playerInfo.filename !== 'string'
                    || typeof playerInfo.playback_time !== 'number'
                    || typeof playerInfo.duration !== 'number'
                  ) {
                    return;
                  }
                  void segmentDetectionHandlerRef.current?.(
                    playerInfo.filename,
                    playerInfo.playback_time,
                    playerInfo.duration,
                    playerInfo.playlist_pos ?? undefined,
                  );
                })
                .catch((error) => {
                  console.debug('[Segment Detection][Local] Event retry could not read MPV state', error);
                });
            }, delayMs);
          };

          console.debug('[Segment Detection][Local] Rolling fingerprint buffer check', {
            season: episode.season,
            episode: episode.episode,
            part: lookupState.analysisPart ?? 1,
          });
          lookupState.promise = window.electronAPI.introDb.detectLocalIntro(
            seriesKey,
            sourceIdentity,
            episode.season,
            episode.episode,
            currentUrl,
            duration,
            lookupState.analysisPart ?? 1,
          )
            .then(async (result) => {
              if (
                lookupState.analysisPart !== 1
                || (result.status !== 'learned' && result.status !== 'no-match')
                || disposed
                || lookupGeneration !== introSkipperGeneration
                || introSkipperLookups.get(key) !== lookupState
              ) {
                return result;
              }
              lookupState.analysisPart = 2;
              console.debug('[Segment Detection][Local] Rolling fingerprint Part 2 started', {
                season: episode.season,
                episode: episode.episode,
              });
              return window.electronAPI.introDb.detectLocalIntro(
                seriesKey,
                sourceIdentity,
                episode.season,
                episode.episode,
                currentUrl,
                duration,
                2,
              );
            })
            .then((result) => {
              const persistentSegment = validateIntroDbSegment(
                'intro',
                result.segment,
                duration,
              );
              if (
                lookupGeneration === introSkipperGeneration
                && persistentAudioGeneration === localSegmentAudioGenerationRef.current
                && persistentSegment?.source === 'intro-skipper'
              ) {
                // Store the backend result even if this particular effect was
                // replaced while detection was running. Audio-track changes
                // still invalidate it through introSkipperGeneration.
                resolvedLocalIntroSegments.set(localIntroCacheKey, persistentSegment);
              }
              if (
                disposed
                || lookupGeneration !== introSkipperGeneration
                || introSkipperLookups.get(key) !== lookupState
              ) {
                return null;
              }
              lookupState.failureRetries = 0;
              if (
                result.status === 'waiting-for-buffer'
                || result.status === 'waiting-for-local-cache'
              ) {
                scheduleRetry(10_000);
                console.debug('[Segment Detection][Local] Rolling fingerprint waiting', {
                  status: result.status,
                  bufferedSeconds: result.buffered_seconds,
                  requiredBufferSeconds: result.required_buffer_seconds,
                  season: episode.season,
                  episode: episode.episode,
                  part: lookupState.analysisPart ?? 1,
                });
                return result;
              }
              if (lookupState.retryTimer != null) {
                window.clearTimeout(lookupState.retryTimer);
                lookupState.retryTimer = null;
              }
              console.debug('[Segment Detection][Local] Rolling fingerprint complete', {
                status: result.status,
                referenceEpisode: result.reference_episode,
                cachedEpisodeCount: result.cached_episode_count,
                bufferedSeconds: result.buffered_seconds,
                requiredBufferSeconds: result.required_buffer_seconds,
                part: lookupState.analysisPart ?? 1,
                segment: result.segment
                  ? { start: result.segment.start_sec, end: result.segment.end_sec }
                  : null,
              });
              return result;
            })
            .catch((error) => {
              if (
                disposed
                || lookupGeneration !== introSkipperGeneration
                || introSkipperLookups.get(key) !== lookupState
              ) {
                return null;
              }
              lookupState.failureRetries = Math.min(
                lookupState.failureRetries + 1,
                LOCAL_INTRO_MAX_FAILURE_RETRIES + 1,
              );
              const usingFastRetry = lookupState.failureRetries <= LOCAL_INTRO_MAX_FAILURE_RETRIES;
              scheduleRetry(usingFastRetry ? LOCAL_INTRO_FAILURE_RETRY_MS : LOCAL_INTRO_SLOW_RETRY_MS);
              console.warn(
                usingFastRetry
                  ? '[Segment Detection][Local] Rolling fingerprint unavailable; retry scheduled'
                  : '[Segment Detection][Local] Rolling fingerprint unavailable; continuing with slow retries',
                {
                  error,
                  retry: lookupState.failureRetries,
                  maxRetries: LOCAL_INTRO_MAX_FAILURE_RETRIES,
                },
              );
              return null;
            });
        }
        return state.promise;
      };
      const getIntroSkipperOutroSegment = async (
        episodeKey: string,
        localOutroCacheKey: string,
        sourceIdentity: string,
        seriesKey: string,
        episode: SmartNextTarget,
        filename: string,
        duration: number,
        playlistPos?: number,
      ): Promise<IntroSkipperDetectionResult | null> => {
        const currentUrl = resolveCurrentIntroSkipperSource(filename, playlistPos);
        if (!currentUrl) {
          console.debug('[Segment Detection][Local][Outro] Tail fingerprint skipped: current stream URL unavailable');
          return null;
        }

        const key = `${episodeKey}:${Math.round(duration * 1_000)}:${currentUrl}`;
        let state = introSkipperOutroLookups.get(key);
        if (!state) {
          state = {
            promise: null,
            retryTimer: null,
            failureRetries: 0,
            generation: introSkipperOutroGeneration,
          };
          introSkipperOutroLookups.set(key, state);
        }
        if (!state.promise) {
          const lookupState = state;
          const lookupGeneration = lookupState.generation;
          const persistentAudioGeneration = localSegmentAudioGenerationRef.current;
          const scheduleRetry = (delayMs: number) => {
            if (lookupState.retryTimer != null) {
              window.clearTimeout(lookupState.retryTimer);
            }
            lookupState.retryTimer = window.setTimeout(() => {
              lookupState.retryTimer = null;
              if (
                disposed
                || lookupGeneration !== introSkipperOutroGeneration
                || introSkipperOutroLookups.get(key) !== lookupState
                || introDbLookupKey !== episodeKey
              ) {
                return;
              }
              lookupState.promise = null;
              void window.electronAPI.getPlayerInfo()
                .then((playerInfo) => {
                  if (
                    disposed
                    || lookupGeneration !== introSkipperOutroGeneration
                    || introSkipperOutroLookups.get(key) !== lookupState
                    || !playerInfo.connected
                    || typeof playerInfo.filename !== 'string'
                    || typeof playerInfo.playback_time !== 'number'
                    || typeof playerInfo.duration !== 'number'
                  ) {
                    return;
                  }
                  void segmentDetectionHandlerRef.current?.(
                    playerInfo.filename,
                    playerInfo.playback_time,
                    playerInfo.duration,
                    playerInfo.playlist_pos ?? undefined,
                  );
                })
                .catch((error) => {
                  console.debug('[Segment Detection][Local][Outro] Event retry could not read MPV state', error);
                });
            }, delayMs);
          };

          console.debug('[Segment Detection][Local][Outro] Tail cache check', {
            season: episode.season,
            episode: episode.episode,
          });
          lookupState.promise = window.electronAPI.introDb.detectLocalOutro(
            seriesKey,
            sourceIdentity,
            episode.season,
            episode.episode,
            currentUrl,
            duration,
          )
            .then((result) => {
              const persistentSegment = validateIntroDbSegment(
                'outro',
                result.segment,
                duration,
              );
              if (
                lookupGeneration === introSkipperOutroGeneration
                && persistentAudioGeneration === localSegmentAudioGenerationRef.current
                && persistentSegment?.source === 'intro-skipper-outro'
              ) {
                // As with intros, retain a completed tail result even if the
                // playback effect was replaced while fingerprinting finished.
                resolvedLocalOutroSegments.set(localOutroCacheKey, persistentSegment);
              }
              if (
                disposed
                || lookupGeneration !== introSkipperOutroGeneration
                || introSkipperOutroLookups.get(key) !== lookupState
              ) {
                return null;
              }
              lookupState.failureRetries = 0;
              if (result.status === 'waiting-for-tail-cache') {
                scheduleRetry(LOCAL_INTRO_FAILURE_RETRY_MS);
                console.debug('[Segment Detection][Local][Outro] Tail fingerprint waiting', {
                  bufferedSeconds: result.buffered_seconds,
                  requiredBufferSeconds: result.required_buffer_seconds,
                  season: episode.season,
                  episode: episode.episode,
                });
                return result;
              }
              if (lookupState.retryTimer != null) {
                window.clearTimeout(lookupState.retryTimer);
                lookupState.retryTimer = null;
              }
              console.debug('[Segment Detection][Local][Outro] Tail fingerprint complete', {
                status: result.status,
                referenceEpisode: result.reference_episode,
                cachedEpisodeCount: result.cached_episode_count,
                bufferedSeconds: result.buffered_seconds,
                requiredBufferSeconds: result.required_buffer_seconds,
                segment: result.segment
                  ? { start: result.segment.start_sec, end: result.segment.end_sec }
                  : null,
              });
              return result;
            })
            .catch((error) => {
              if (
                disposed
                || lookupGeneration !== introSkipperOutroGeneration
                || introSkipperOutroLookups.get(key) !== lookupState
              ) {
                return null;
              }
              lookupState.failureRetries = Math.min(
                lookupState.failureRetries + 1,
                LOCAL_INTRO_MAX_FAILURE_RETRIES + 1,
              );
              const usingFastRetry = lookupState.failureRetries <= LOCAL_INTRO_MAX_FAILURE_RETRIES;
              scheduleRetry(usingFastRetry ? LOCAL_INTRO_FAILURE_RETRY_MS : LOCAL_INTRO_SLOW_RETRY_MS);
              console.warn(
                usingFastRetry
                  ? '[Segment Detection][Local][Outro] Tail fingerprint unavailable; retry scheduled'
                  : '[Segment Detection][Local][Outro] Tail fingerprint unavailable; continuing with slow retries',
                {
                  error,
                  retry: lookupState.failureRetries,
                  maxRetries: LOCAL_INTRO_MAX_FAILURE_RETRIES,
                },
              );
              return null;
            });
        }
        return state.promise;
      };
      const handleIntroDbProgressOnce = async (
        filename: string,
        playbackTime: number,
        duration: number,
        playlistPos?: number,
      ) => {
        if (
          disposed
          || introDbActionInProgress
          || selectedMeta?.type !== 'series'
          || !Number.isFinite(playbackTime)
          || !Number.isFinite(duration)
          || duration <= 0
        ) {
          return;
        }

        const settings = getIntroDbPlaybackSettings();
        if (
          settings.introMode === 'always-watch'
          && settings.recapMode === 'always-watch'
          && !settings.autoNextAtOutro
        ) {
          return;
        }

        const episode = resolveIntroDbEpisode(filename, playlistPos);
        if (!episode) return;
        const tmdbId = Number(selectedMeta.id.split(':')[1]);
        if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return;
        const seriesWatchKey = selectedMeta.imdbId || selectedMeta.id;
        const localPlaybackKey = `${seriesWatchKey.toLowerCase()}:${episode.season}:${episode.episode}`;
        const localIntroSourceIdentity = normalizeSourceIdentity(
          selectedStream.torrent?.streamFilename
          || selectedStream.resumeSourceFilename
          || selectedStream.title
          || getPathBaseName(filename),
        );
        const localIntroCacheKey = `${localPlaybackKey}:${localIntroSourceIdentity}`;
        const localOutroCacheKey = localIntroCacheKey;
        if (
          segmentBoundaryTimer
          && !segmentBoundaryTimer.segmentKey.startsWith(`${localPlaybackKey}:`)
        ) {
          cancelSegmentBoundaryTimer('episode-changed');
        }
        const previousPlaybackMax = localIntroPlaybackMax.get(localPlaybackKey) ?? 0;
        if (playbackTime > previousPlaybackMax) {
          localIntroPlaybackMax.set(localPlaybackKey, playbackTime);
        }

        // A completed local fingerprint is sufficient to make the playback
        // decision. Do this before the async remote/chapter lookup chain so a
        // pause, resume, seek, or recovered progress event inside the intro
        // cannot be delayed or lost behind another detector run.
        const fastLocalIntro = validateIntroDbSegment(
          'intro',
          resolvedLocalIntroSegments.get(localIntroCacheKey) ?? null,
          duration,
        );
        const fastLocalIntroKey = `${localPlaybackKey}:intro`;
        if (
          fastLocalIntro
          && playbackTime >= fastLocalIntro.start_sec
          && playbackTime < fastLocalIntro.end_sec - 0.25
          && !introDbProcessedSegments.has(fastLocalIntroKey)
          && (introDbActionRetryAfter.get(fastLocalIntroKey) ?? 0) <= Date.now()
          && shouldAutoSkipIntroDbSegment(settings.introMode, seriesWatchKey, 'intro')
        ) {
          cancelSegmentBoundaryTimer('cached-local-intro-entered');
          introDbActionInProgress = true;
          try {
            const seekTarget = Math.min(duration, fastLocalIntro.end_sec);
            console.log('[Episode Segments] Cached local intro seek requested', {
              playbackTime,
              start: fastLocalIntro.start_sec,
              end: fastLocalIntro.end_sec,
            });
            await window.electronAPI.player.seekTime(seekTarget, filename);
            introDbProcessedSegments.add(fastLocalIntroKey);
            introDbActionRetryAfter.delete(fastLocalIntroKey);
            console.log('[Episode Segments] Cached local intro seek completed', {
              from: playbackTime,
              to: seekTarget,
            });
            void window.electronAPI.player.showMessage(
              `Intro skipped · ${introSegmentSourceLabel(fastLocalIntro)}`,
              2500,
            ).catch((error) => {
              console.debug('[Episode Segments] Failed to show intro skip message:', error);
            });
          } catch (error) {
            introDbActionRetryAfter.set(fastLocalIntroKey, Date.now() + SEGMENT_ACTION_RETRY_MS);
            console.warn('[Episode Segments] Failed to apply cached local intro seek:', error);
          } finally {
            introDbActionInProgress = false;
          }
          return;
        }

        const fastLocalOutro = settings.autoNextAtOutro
          ? validateIntroDbSegment(
              'outro',
              resolvedLocalOutroSegments.get(localOutroCacheKey) ?? null,
              duration,
            )
          : null;
        const fastLocalOutroKey = `${localPlaybackKey}:outro`;
        if (
          fastLocalOutro
          && playbackTime >= fastLocalOutro.start_sec
          && playbackTime < fastLocalOutro.end_sec
          && !introDbProcessedSegments.has(fastLocalOutroKey)
          && (outroSmartNextRetryAfter.get(fastLocalOutroKey) ?? 0) <= Date.now()
        ) {
          introDbActionInProgress = true;
          try {
            console.log('[Episode Segments] Cached local outro Smart Next requested', {
              playbackTime,
              start: fastLocalOutro.start_sec,
              end: fastLocalOutro.end_sec,
            });
            const advanced = await handleSmartNextRequest(filename);
            if (advanced) {
              introDbProcessedSegments.add(fastLocalOutroKey);
              outroSmartNextRetryAfter.delete(fastLocalOutroKey);
              console.log('[Episode Segments] Cached local outro Smart Next completed');
            } else {
              outroSmartNextRetryAfter.set(
                fastLocalOutroKey,
                Date.now() + OUTRO_SMART_NEXT_RETRY_MS,
              );
              console.debug('[Episode Segments] Cached local outro Smart Next deferred');
            }
          } finally {
            introDbActionInProgress = false;
          }
          return;
        }

        const { key: episodeKey, segments } = await getIntroDbSegmentsForEpisode(
          selectedMeta.imdbId || null,
          tmdbId,
          episode,
          duration,
        );
        if (disposed || introDbLookupKey !== episodeKey) return;
        for (const [lookupKey, lookup] of introSkipperLookups) {
          if (lookupKey.startsWith(`${episodeKey}:`)) continue;
          if (lookup.retryTimer != null) {
            window.clearTimeout(lookup.retryTimer);
          }
          introSkipperLookups.delete(lookupKey);
        }
        for (const [lookupKey, lookup] of introSkipperOutroLookups) {
          if (lookupKey.startsWith(`${episodeKey}:`)) continue;
          if (lookup.retryTimer != null) {
            window.clearTimeout(lookup.retryTimer);
          }
          introSkipperOutroLookups.delete(lookupKey);
        }
        for (const cachedEpisodeKey of resolvedLocalIntroSegments.keys()) {
          if (cachedEpisodeKey !== localIntroCacheKey) {
            resolvedLocalIntroSegments.delete(cachedEpisodeKey);
          }
        }
        for (const cachedEpisodeKey of resolvedLocalOutroSegments.keys()) {
          if (cachedEpisodeKey !== localOutroCacheKey) {
            resolvedLocalOutroSegments.delete(cachedEpisodeKey);
          }
        }

        let resolvedIntro = validateIntroDbSegment('intro', segments?.intro ?? null, duration);
        let resolvedRecap = validateIntroDbSegment('recap', segments?.recap ?? null, duration);
        let resolvedOutro = validateIntroDbSegment('outro', segments?.outro ?? null, duration);
        let localDetectionAttempted = false;
        let localDetectionPending = false;
        const needsLocalChapterScan = settings.introSkipperEnabled && (
          (settings.introMode !== 'always-watch' && !resolvedIntro)
          || (settings.recapMode !== 'always-watch' && !resolvedRecap)
          || (settings.autoNextAtOutro && !resolvedOutro)
        );
        if (needsLocalChapterScan) {
          localDetectionAttempted = true;
          console.debug('[Segment Detection] Remote data incomplete; local chapter scan started', {
            season: episode.season,
            episode: episode.episode,
            missingIntro: settings.introMode !== 'always-watch' && !resolvedIntro,
            missingRecap: settings.recapMode !== 'always-watch' && !resolvedRecap,
            missingOutro: settings.autoNextAtOutro && !resolvedOutro,
          });
          const chapters = await getChapterSegments(episodeKey, duration);
          if (disposed || introDbLookupKey !== episodeKey) return;
          resolvedIntro ||= validateIntroDbSegment('intro', chapters?.intro ?? null, duration);
          resolvedRecap ||= validateIntroDbSegment('recap', chapters?.recap ?? null, duration);
          resolvedOutro ||= validateIntroDbSegment('outro', chapters?.outro ?? null, duration);
        }

        if (!resolvedIntro) {
          const cachedLocalIntro = validateIntroDbSegment(
            'intro',
            resolvedLocalIntroSegments.get(localIntroCacheKey) ?? null,
            duration,
          );
          if (cachedLocalIntro) {
            resolvedIntro = cachedLocalIntro;
            const cacheLogKey = `${localPlaybackKey}:intro:resolved-cache`;
            if (!segmentDecisionLoggedKeys.has(cacheLogKey)) {
              segmentDecisionLoggedKeys.add(cacheLogKey);
              console.debug('[Episode Segments] Reused episode-scoped local intro result', {
                start: cachedLocalIntro.start_sec,
                end: cachedLocalIntro.end_sec,
                source: cachedLocalIntro.source,
              });
            }
          }
        }

        const rememberLocalReferenceWatch = (
          localResult: IntroSkipperDetectionResult | null,
          localIntro: IntroDbSegment | null,
        ) => {
          if (
            !localIntro
            || settings.introMode !== 'watch-once'
            || hasWatchedIntroDbSegmentOnce(seriesWatchKey, 'intro')
            || typeof localResult?.reference_episode !== 'number'
            || typeof localResult.reference_end_sec !== 'number'
          ) {
            return;
          }
          const referencePlaybackKey = `${seriesWatchKey.toLowerCase()}:${episode.season}:${localResult.reference_episode}`;
          const referencePlaybackMax = localIntroPlaybackMax.get(referencePlaybackKey) ?? 0;
          if (
            referencePlaybackMax
            < localResult.reference_end_sec + LOCAL_INTRO_REFERENCE_WATCH_MARGIN_SECONDS
          ) {
            return;
          }
          rememberWatchedIntroDbSegmentOnce(seriesWatchKey, 'intro');
          console.log('[Episode Segments] Local reference intro was already watched; enabling Watch once skip', {
            referenceEpisode: localResult.reference_episode,
            observedThrough: referencePlaybackMax,
            referenceEnd: localResult.reference_end_sec,
          });
        };
        const keepResolvedEarlySegmentResponsive = ([
          [settings.recapMode, resolvedRecap],
          [settings.introMode, resolvedIntro],
        ] as const).some(([mode, segment]) => (
          mode !== 'always-watch'
          && segment != null
          && playbackTime < segment.end_sec - 0.25
        ));

        if (
          !resolvedIntro
          && settings.introSkipperEnabled
          && settings.introMode !== 'always-watch'
        ) {
          localDetectionAttempted = true;
          const localIntroPromise = getIntroSkipperSegment(
            episodeKey,
            localIntroCacheKey,
            localIntroSourceIdentity,
            seriesWatchKey,
            episode,
            filename,
            duration,
            playlistPos,
          );
          if (keepResolvedEarlySegmentResponsive) {
            localDetectionPending = true;
            void localIntroPromise.then((localResult) => {
              if (disposed || introDbLookupKey !== episodeKey) return;
              const localIntro = validateIntroDbSegment('intro', localResult?.segment ?? null, duration);
              rememberLocalReferenceWatch(localResult, localIntro);
            });
          } else {
            const localResult = await localIntroPromise;
            if (disposed || introDbLookupKey !== episodeKey) return;
            localDetectionPending = localResult?.status === 'waiting-for-buffer'
              || localResult?.status === 'waiting-for-local-cache';
            resolvedIntro = validateIntroDbSegment('intro', localResult?.segment ?? null, duration);
            if (resolvedIntro?.source === 'intro-skipper') {
              resolvedLocalIntroSegments.set(localIntroCacheKey, resolvedIntro);
            }
            rememberLocalReferenceWatch(localResult, resolvedIntro);
          }
        }

        if (!resolvedOutro) {
          resolvedOutro = validateIntroDbSegment(
            'outro',
            resolvedLocalOutroSegments.get(localOutroCacheKey) ?? null,
            duration,
          );
        }

        if (
          !resolvedOutro
          && settings.introSkipperEnabled
          && settings.autoNextAtOutro
        ) {
          localDetectionAttempted = true;
          const localOutroPromise = getIntroSkipperOutroSegment(
            episodeKey,
            localOutroCacheKey,
            localIntroSourceIdentity,
            seriesWatchKey,
            episode,
            filename,
            duration,
            playlistPos,
          );
          if (keepResolvedEarlySegmentResponsive) {
            localDetectionPending = true;
            void localOutroPromise;
          } else {
            const localOutroResult = await localOutroPromise;
            if (disposed || introDbLookupKey !== episodeKey) return;
            localDetectionPending = localDetectionPending
              || localOutroResult?.status === 'waiting-for-tail-cache';
            resolvedOutro = validateIntroDbSegment(
              'outro',
              localOutroResult?.segment ?? null,
              duration,
            );
            if (resolvedOutro?.source === 'intro-skipper-outro') {
              resolvedLocalOutroSegments.set(localOutroCacheKey, resolvedOutro);
            }
          }
        }

        if (!localDetectionPending && !segmentDetectionLoggedKeys.has(episodeKey)) {
          segmentDetectionLoggedKeys.add(episodeKey);
          console.debug('[Segment Detection] Resolution complete', {
            season: episode.season,
            episode: episode.episode,
            remoteAttempted: true,
            localAttempted: localDetectionAttempted,
            selected: {
              intro: resolvedIntro?.source ?? null,
              recap: resolvedRecap?.source ?? null,
              outro: resolvedOutro?.source ?? null,
            },
          });
        }

        const earlySegments = ([
          ['recap', settings.recapMode, resolvedRecap],
          ['intro', settings.introMode, resolvedIntro],
        ] as const)
          .map(([type, mode, segment]) => ({
            type,
            mode,
            segment: validateIntroDbSegment(type, segment, duration),
          }))
          .filter((entry) => entry.segment !== null)
          .sort((left, right) => left.segment!.start_sec - right.segment!.start_sec);

        for (const { type, mode, segment } of earlySegments) {
          if (!segment) continue;
          const segmentKey = `${localPlaybackKey}:${type}`;
          const insideSegment = playbackTime >= segment.start_sec && playbackTime < segment.end_sec - 0.25;
          const logDecisionOnce = (reason: string, details: Record<string, unknown> = {}) => {
            const decisionKey = `${segmentKey}:${reason}`;
            if (segmentDecisionLoggedKeys.has(decisionKey)) return;
            segmentDecisionLoggedKeys.add(decisionKey);
            console.log('[Episode Segments] Skip decision', {
              type,
              reason,
              mode,
              playbackTime,
              start: segment.start_sec,
              end: segment.end_sec,
              source: segment.source,
              ...details,
            });
          };
          if (introDbProcessedSegments.has(segmentKey)) {
            if (insideSegment) logDecisionOnce('already-processed');
            continue;
          }
          const retryAfter = introDbActionRetryAfter.get(segmentKey) ?? 0;
          if (retryAfter > Date.now()) {
            if (insideSegment) logDecisionOnce('retry-backoff', { retryAfter });
            continue;
          }

          const shouldAutoSkip = shouldAutoSkipIntroDbSegment(mode, seriesWatchKey, type);
          if (insideSegment && shouldAutoSkip) {
            if (introDbActionInProgress) {
              logDecisionOnce('another-action-in-progress');
              return;
            }
            logDecisionOnce('seek-requested');
            cancelSegmentBoundaryTimer('segment-entered');
            introDbActionInProgress = true;
            try {
              const sourceLabel = introSegmentSourceLabel(segment);
              await window.electronAPI.player.seekTime(
                Math.min(duration, segment.end_sec),
                filename,
              );
              introDbProcessedSegments.add(segmentKey);
              introDbActionRetryAfter.delete(segmentKey);
              console.log('[Episode Segments] Skip seek completed', {
                type,
                from: playbackTime,
                to: Math.min(duration, segment.end_sec),
                source: segment.source,
              });
              void window.electronAPI.player.showMessage(
                `${type === 'intro' ? 'Intro' : 'Recap'} skipped · ${sourceLabel}`,
                2500,
              ).catch((error) => {
                console.debug(`[Episode Segments] Failed to show ${type} skip message:`, error);
              });
            } catch (error) {
              introDbActionRetryAfter.set(segmentKey, Date.now() + SEGMENT_ACTION_RETRY_MS);
              console.warn(`[Episode Segments] Failed to skip ${type}:`, error);
            } finally {
              introDbActionInProgress = false;
            }
            return;
          }

          if (insideSegment && !shouldAutoSkip) {
            logDecisionOnce('mode-does-not-skip');
          } else if (playbackTime >= segment.end_sec && !introDbObservedSegments.has(segmentKey)) {
            logDecisionOnce('segment-window-passed-without-action');
          }

          if (mode === 'watch-once' && !hasWatchedIntroDbSegmentOnce(seriesWatchKey, type)) {
            if (insideSegment) {
              introDbObservedSegments.add(segmentKey);
            } else if (playbackTime >= segment.end_sec && introDbObservedSegments.has(segmentKey)) {
              rememberWatchedIntroDbSegmentOnce(seriesWatchKey, type);
              introDbProcessedSegments.add(segmentKey);
              console.log(`[Episode Segments] Remembered watched ${type} for this series session`);
            }
          }
        }

        const nextAutomaticSegment = earlySegments.find(({ type, mode, segment }) => {
          if (!segment || playbackTime >= segment.start_sec) return false;
          const segmentKey = `${localPlaybackKey}:${type}`;
          return !introDbProcessedSegments.has(segmentKey)
            && shouldAutoSkipIntroDbSegment(mode, seriesWatchKey, type);
        });
        if (
          nextAutomaticSegment?.segment
          && !playbackPausedRef.current
        ) {
          scheduleSegmentBoundaryCheck(
            `${localPlaybackKey}:${nextAutomaticSegment.type}`,
            filename,
            playlistPos,
            playbackTime,
            nextAutomaticSegment.segment.start_sec,
          );
        } else if (
          segmentBoundaryTimer?.segmentKey.startsWith(`${localPlaybackKey}:`)
        ) {
          cancelSegmentBoundaryTimer(
            playbackPausedRef.current ? 'playback-paused' : 'no-upcoming-segment',
          );
        }

        if (!settings.autoNextAtOutro) return;
        const outro = resolvedOutro;
        const outroKey = `${localPlaybackKey}:outro`;
        if (
          !outro
          || introDbProcessedSegments.has(outroKey)
          || (outroSmartNextRetryAfter.get(outroKey) ?? 0) > Date.now()
          || playbackTime < outro.start_sec
          || playbackTime >= outro.end_sec
        ) {
          return;
        }

        if (introDbActionInProgress) return;
        introDbActionInProgress = true;
        try {
          const advanced = await handleSmartNextRequest(filename);
          if (advanced) {
            introDbProcessedSegments.add(outroKey);
            outroSmartNextRetryAfter.delete(outroKey);
          } else {
            outroSmartNextRetryAfter.set(outroKey, Date.now() + OUTRO_SMART_NEXT_RETRY_MS);
          }
        } finally {
          introDbActionInProgress = false;
        }
      };
      const maybeHandleIntroDbProgress = async (
        filename: string,
        playbackTime: number,
        duration: number,
        playlistPos?: number,
      ) => {
        const runEpisode = resolveIntroDbEpisode(filename, playlistPos);
        const runKey = runEpisode && selectedMeta?.type === 'series'
          ? `${selectedMeta.id}:${runEpisode.season}:${runEpisode.episode}`
          : normalizeSourceIdentity(filename) || filename.trim();
        if (!runKey) return;

        let run = segmentDetectionRuns.get(runKey);
        if (!run) {
          run = { running: false, pending: null };
          segmentDetectionRuns.set(runKey, run);
        }
        run.pending = { filename, playbackTime, duration, playlistPos };
        if (run.running) return;

        run.running = true;
        try {
          while (!disposed && run.pending) {
            const snapshot = run.pending;
            run.pending = null;
            try {
              await handleIntroDbProgressOnce(
                snapshot.filename,
                snapshot.playbackTime,
                snapshot.duration,
                snapshot.playlistPos,
              );
            } catch (error) {
              console.warn('[Segment Detection] Episode-scoped handler failed', {
                filename: snapshot.filename,
                error,
              });
            }
          }
        } finally {
          run.running = false;
          if (!run.pending && segmentDetectionRuns.get(runKey) === run) {
            segmentDetectionRuns.delete(runKey);
          }
        }
      };
      ownedSegmentDetectionHandler = maybeHandleIntroDbProgress;
      segmentDetectionHandlerRef.current = maybeHandleIntroDbProgress;
      // A resumed MPV session can already be well into the episode before the
      // first observed progress event. Evaluate the live state as soon as the
      // episode-scoped handler is attached so outro detection is not dependent
      // on a later pause, seek, or progress notification.
      void window.electronAPI.getPlayerInfo()
        .then((playerInfo) => {
          if (
            disposed
            || !playerInfo.connected
            || typeof playerInfo.filename !== 'string'
            || typeof playerInfo.playback_time !== 'number'
            || typeof playerInfo.duration !== 'number'
          ) {
            return;
          }
          void maybeHandleIntroDbProgress(
            playerInfo.filename,
            playerInfo.playback_time,
            playerInfo.duration,
            playerInfo.playlist_pos ?? undefined,
          );
        })
        .catch((error) => {
          console.debug('[Segment Detection] Initial MPV state check unavailable', error);
        });
      const acknowledgeSmartNextRequest = async (request: SmartNextRequestIdentity) => {
        try {
          const acknowledged = await window.electronAPI.player.ackSmartNextRequest(
            request.request_id,
            request.mpv_pid,
          );
          if (!acknowledged) {
            console.debug('[Smart Next] Request was already cleared before acknowledgment:', request);
          }
        } catch (error) {
          console.warn('[Smart Next] Failed to acknowledge completed request; acknowledgment will be retried:', error);
        }
      };
      const consumeSmartNextRequest = async (
        request: SmartNextRequestIdentity,
        filename: string,
      ) => {
        const requestKey = smartNextRequestKey(request);
        if (smartNextCompletedRequestsRef.current.has(requestKey)) {
          await acknowledgeSmartNextRequest(request);
          return;
        }
        if (!isCurrentPlaybackLaunch() || !shouldExecuteSmartNextRequest(
          smartNextCompletedRequestsRef.current,
          smartNextActiveRequestRef.current,
          request,
        )) {
          return;
        }

        smartNextActiveRequestRef.current = requestKey;
        console.log('[Smart Next] Consuming retained request', { ...request, filename });
        try {
          await handleSmartNextRequest(filename, true);
        } finally {
          rememberCompletedSmartNextRequest(smartNextCompletedRequestsRef.current, requestKey);
          await acknowledgeSmartNextRequest(request);
          if (smartNextActiveRequestRef.current === requestKey) {
            smartNextActiveRequestRef.current = null;
          }
        }
      };
      const recoverPendingSmartNextRequest = async (filename: string) => {
        if (
          smartNextActiveRequestRef.current != null
          || !isCurrentPlaybackLaunch()
        ) {
          return;
        }

        try {
          const request = await window.electronAPI.player.getPendingSmartNextRequest();
          if (request != null && isCurrentPlaybackLaunch()) {
            await consumeSmartNextRequest(request, filename);
          }
        } catch (error) {
          console.warn('[Smart Next] Failed to check for a retained request:', error);
        }
      };

      try {
        if (!isCurrentPlaybackLaunch()) {
          return;
        }
        setCurrentMpvPid(null);
        lastKnownPlaybackTimeRef.current = 0;
        lastKnownAtRef.current = 0;
        playbackPausedRef.current = false;

        const persistResumeEpisode = (episodeInfo: { season: number; episode: number } | null) => {
          if (!selectedMeta || selectedMeta.type !== 'series' || !episodeInfo) {
            return;
          }

          const tmdbId = selectedMeta.id.split(':')[1];
          const key = `${selectedMeta.type}-${tmdbId}`;
          const storedMeta = JSON.parse(localStorage.getItem('streamee-last-source-meta') || '{}');
          const existing = storedMeta[key] || {};
          storedMeta[key] = {
            ...existing,
            sourceType: selectedStream.sourceType || existing.sourceType || 'qbittorrent',
            sourceUrl: selectedStream.sourceType === 'addon'
              ? existing.sourceUrl
              : selectedStream.url || existing.sourceUrl,
            preferredSeason: episodeInfo.season,
            preferredEpisode: episodeInfo.episode,
          };
          localStorage.setItem('streamee-last-source-meta', JSON.stringify(storedMeta));
        };

        const syncCurrentQbitPlaylistFile = (
          store: ReturnType<typeof useStore.getState>,
          event: PlayerPlaylistChangedPayload,
        ): number | null => {
          if (!store.playlistActive) {
            return null;
          }

          const normalizedFilename = normalizeSourceIdentity(event.filename);
          const normalizedBaseName = normalizeSourceIdentity(getPathBaseName(event.filename));
          const normalizedPath = normalizeSourceIdentity(event.path);
          const normalizedMediaTitle = normalizeSourceIdentity(event.media_title);
          const filenameIndex = store.playlistFiles.findIndex((file) => {
            const name = normalizeSourceIdentity(file.name);
            const streamUrl = normalizeSourceIdentity(file.streamUrl);
            return name === normalizedFilename
              || name === normalizedBaseName
              || name === normalizedMediaTitle
              || (!!streamUrl && (streamUrl === normalizedPath || streamUrl === normalizedFilename))
              || (!!normalizedPath && normalizedPath.includes(`/stream/${file.index}`));
          });

          const playlistIndex =
            event.playlist_pos >= 0 &&
            event.playlist_pos < store.playlistFiles.length
              ? event.playlist_pos
              : null;

          if (filenameIndex !== -1 && playlistIndex !== null && filenameIndex !== playlistIndex) {
            console.warn(
              '[Playlist] Atomic MPV identity disagrees with renderer queue; using source identity:',
              {
                playlistPos: event.playlist_pos,
                filename: event.filename,
                mediaTitle: event.media_title,
                filenameIndex,
                playlistIndex,
              }
            );
          }

          const resolvedIndex =
            filenameIndex !== -1
              ? filenameIndex
              : playlistIndex !== null
                ? playlistIndex
                : filenameIndex;

          if (resolvedIndex === null || resolvedIndex === -1) {
            return null;
          }

          const currentFile = store.playlistFiles[resolvedIndex];
          if (!currentFile) {
            return null;
          }

          store.setPlaylistCurrentIndex(resolvedIndex);
          store.setPlaybackIdentityCurrentIndex(resolvedIndex);
          store.setCurrentPlayingTitle(currentFile.name);

          const identity = store.playbackIdentityItems[resolvedIndex];
          const episodeInfo = typeof identity?.season === 'number' && typeof identity.episode === 'number'
            ? { season: identity.season, episode: identity.episode }
            : extractEpisodeNumber(currentFile.name, selectedStream.preferredSeason ?? 1);
          if (episodeInfo) {
            store.setPlaylistEpisodeInfo({
              season: episodeInfo.season,
              episode: episodeInfo.episode,
              title: identity?.title ?? currentFile.name,
            });
            persistResumeEpisode(episodeInfo);
          } else {
            store.setPlaylistEpisodeInfo(null);
          }

          syncPlaylistTitle(currentFile.name);
          console.log('%c[Playlist]%c Active item synchronized', 'color: #ff6b35; font-weight: bold', 'color: inherit', {
            playlistPos: event.playlist_pos,
            resolvedIndex,
            filename: event.filename,
            mediaTitle: event.media_title,
            displayTitle: currentFile.name,
          });
          return resolvedIndex;
        };

        if (audioNormalizerEnabled) {
          console.log('[Normalizer] Ensuring runtime is running for player session');
          try {
            await window.electronAPI.audioNormalizer.setEnabled(true);
          } catch (error) {
            console.warn('[Normalizer] Failed to ensure runtime on player start:', error);
          }
        }

        let restartWhisperPipeline: ((subtitleJobId: number) => Promise<void>) | null = null;
        let currentWhisperSource: WhisperMediaSource | null = null;
        let lastWhisperAudioTrackId: number | null | undefined;
        let whisperAudioTrackChangeToken = 0;

        const stopSubtitleTranscription = async (reason: string, stopServerToo = false) => {
          const currentSessionId = activeWhisperSessionIdRef.current;
          const pendingSeekToken = whisperSeekRestartTokenRef.current;
          subtitleJobRef.current += 1;
          activeWhisperSessionIdRef.current = 0;
          whisperSeekRestartTokenRef.current += 1;
          if (whisperSeekRestartTimeoutRef.current != null) {
            window.clearTimeout(whisperSeekRestartTimeoutRef.current);
            whisperSeekRestartTimeoutRef.current = null;
          }
          setWhisperProcessedSeconds(null);
          console.log('[WhisperLive] Stopping transcription:', {
            reason,
            currentSessionId,
            pendingSeekToken,
            nextJobId: subtitleJobRef.current,
          });
          try {
            await window.electronAPI.subtitles.stopClient();
          } catch (error) {
            console.warn(`[WhisperLive] Failed to stop subtitle client (${reason}):`, error);
          }
          if (stopServerToo) {
            try {
              await window.electronAPI.subtitles.stopServer();
            } catch (error) {
              console.warn(`[WhisperLive] Failed to stop subtitle server (${reason}):`, error);
            }
          }
        };

        const scheduleWhisperSeekRestart = async () => {
          if (whisperSeekRestartTimeoutRef.current != null) {
            console.log('[WhisperLive] Cancelling pending seek restart before scheduling a new one', {
              previousToken: whisperSeekRestartTokenRef.current,
            });
            window.clearTimeout(whisperSeekRestartTimeoutRef.current);
            whisperSeekRestartTimeoutRef.current = null;
          }

          const seekToken = ++whisperSeekRestartTokenRef.current;
          console.log('[WhisperLive] Seek restart scheduled', {
            seekToken,
            currentSessionId: activeWhisperSessionIdRef.current,
            pipelineAvailable: !!restartSubtitlePipeline,
            delayMs: WHISPER_SEEK_RESTART_DELAY_MS,
          });
          whisperSeekRestartTimeoutRef.current = window.setTimeout(async () => {
            console.log('[WhisperLive] Seek restart timer fired', {
              seekToken,
              currentToken: whisperSeekRestartTokenRef.current,
              disposed,
              pipelineAvailable: !!restartSubtitlePipeline,
              activeSessionId: activeWhisperSessionIdRef.current,
            });

            if (disposed || seekToken !== whisperSeekRestartTokenRef.current) {
              console.log('[WhisperLive] Seek restart cancelled before execution', {
                seekToken,
                currentToken: whisperSeekRestartTokenRef.current,
                disposed,
              });
              return;
            }
            if (!restartSubtitlePipeline) {
              console.warn('[WhisperLive] Seek restart skipped because subtitle pipeline is unavailable');
              return;
            }

            try {
              const seekStartSeconds = await getWhisperStartSeconds();
              console.log('[WhisperLive] Seek restart beginning', {
                seekToken,
                seekStartSeconds,
                activeSessionId: activeWhisperSessionIdRef.current,
              });
              setWhisperProcessedSeconds(seekStartSeconds);
              await restartSubtitlePipeline();
              console.log('[WhisperLive] Seek restart completed', {
                seekToken,
                activeSessionId: activeWhisperSessionIdRef.current,
              });
            } catch (error) {
              console.error('[WhisperLive] Failed to restart subtitles after seek:', error);
              const message = error instanceof Error ? error.message : String(error);
              setSubtitleStatus('error');
              setSubtitleMessage(message || 'Subtitle seek restart failed');
              setSubtitleAssist({
                status: 'error',
                message: message || 'Subtitle seek restart failed',
                progress: 0,
              });
            }
          }, WHISPER_SEEK_RESTART_DELAY_MS);
        };

        const forceUseWhisperPipeline = async () => {
          if (!restartWhisperPipeline) {
            console.warn('[WhisperLive] Force-use requested, but the Whisper pipeline is not ready yet (startup may still be in progress)');
            setSubtitleStatus('error');
            setSubtitleMessage('Whisper pipeline not ready — please wait a moment and try again');
            setSubtitleAssist({
              status: 'error',
              message: 'Whisper pipeline not ready — please wait a moment and try again',
              progress: 0,
            });
            return;
          }

          setSubtitleStatus('connecting');
          setSubtitleMessage('Starting Whisper...');
          setSubtitleAssist({
            status: 'connecting',
            message: 'Starting Whisper...',
            progress: 10,
          });

          try {
            console.log('[WhisperLive] Force-use requested', {
              currentSessionId: activeWhisperSessionIdRef.current,
              currentJobId: subtitleJobRef.current,
            });
            await stopSubtitleTranscription('force use');
            await wait(500);
            const nextJobId = ++subtitleJobRef.current;
            activeWhisperSessionIdRef.current = nextJobId;
            console.log('[WhisperLive] Force-use starting new session', {
              nextJobId,
              pipelineAvailable: !!restartWhisperPipeline,
            });
            await startWhisperPipelineWithRecovery(nextJobId);
            console.log('[WhisperLive] Force-use completed', {
              nextJobId,
            });
          } catch (error) {
            console.error('[WhisperLive] Force-use failed:', error);
            const message = error instanceof Error ? error.message : String(error);
            setSubtitleStatus('error');
            setSubtitleMessage(message || 'Could not start Whisper');
            setSubtitleAssist({
              status: 'error',
              message: message || 'Could not start Whisper',
              progress: 0,
            });
            throw error;
          }
        };

        const forceRetryAudioNormalizer = async () => {
          setAudioNormalizerReason('connecting');
          await window.electronAPI.audioNormalizer.resetState();
        };

        const startWhisperPipelineWithRecovery = async (subtitleJobId: number) => {
          let recoveryAttempts = 0;

          while (!disposedRef.current && subtitleJobId === subtitleJobRef.current) {
            try {
              await restartWhisperPipeline!(subtitleJobId);
              return;
            } catch (error) {
              if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                throw error;
              }

              if (!isRetryableSubtitleError(error)) {
                throw error;
              }

              recoveryAttempts += 1;
              const retryStartSeconds = await getWhisperStartSeconds();

              console.warn('[WhisperLive] Whisper pipeline failed, retrying automatically:', {
                subtitleJobId,
                recoveryAttempts,
                retryStartSeconds,
                error,
              });

              setSubtitleStatus('connecting');
              setSubtitleMessage(`Restarting WhisperLive session (${recoveryAttempts}/${WHISPER_MAX_SESSION_RETRIES})...`);
              setSubtitleAssist({
                status: 'connecting',
                message: `Restarting WhisperLive session (${recoveryAttempts}/${WHISPER_MAX_SESSION_RETRIES})...`,
                progress: 15,
              });
              setWhisperProcessedSeconds(retryStartSeconds);

              if (recoveryAttempts >= WHISPER_MAX_SESSION_RETRIES) {
                throw error;
              }

              await wait(500 + (recoveryAttempts - 1) * 250);
            }
          }

          throw new Error('Subtitle transcription was cancelled');
        };

        setRetryWhisperAction(forceUseWhisperPipeline);
        setRetryAudioNormalizerAction(forceRetryAudioNormalizer);

        console.log('%c[Stream]%c Starting remote source...', 'color: #4ade80; font-weight: bold', 'color: inherit');
        console.log('[Whisper] Subtitle pipeline initialized');
        setSubtitleStatus('disabled');
        setSubtitleMessage('Subtitles disabled');
        clearSubtitleAssist();
  
        subtitleProgressUnlisten = await window.electronAPI.subtitles.onProgress((event: SubtitleProgressEvent) => {
          if (disposed) return;
          if (event.session_id !== activeWhisperSessionIdRef.current) return;
          if (event.phase === 'complete' && event.reason === 'session_rollover') {
            console.log('[WhisperLive] Session rollover completed; keeping transcription active:', event.message);
            return;
          }

          const progressPercent = Math.max(0, Math.min(100, Math.round(event.progress * 100)));
          const nextStatus: SubtitleStatus =
            event.phase === 'starting' ? 'pending' :
            event.phase === 'connecting' ? 'connecting' :
            event.phase === 'transcribing' ? 'transcribing' :
            event.phase === 'waiting_for_media' ? 'waiting' :
            event.phase === 'complete' ? 'generated' :
            'pending';
          const nextMessage = event.phase === 'complete'
            ? event.message
            : `${event.message}${progressPercent > 0 ? ` (${progressPercent}%)` : ''}`;

          console.log(`[WhisperLive] ${event.phase}: ${progressPercent}% - ${event.message}`);
          setSubtitleStatus(nextStatus);
          setSubtitleMessage(nextMessage);
          setSubtitleAssist({
            status: nextStatus,
            message: nextMessage,
            progress: progressPercent,
          });
        });

        subtitleSegmentUnlisten = await window.electronAPI.subtitles.onSegment((seg: SubtitleSegment) => {
          if (disposed) return;
          if (seg.session_id !== activeWhisperSessionIdRef.current) return;
          console.log(`%c[WhisperLive]%c [${seg.start.toFixed(2)}-${seg.end.toFixed(2)}] ${seg.text}`, 'color: #a78bfa; font-weight: bold', 'color: inherit');
          setWhisperProcessedSeconds(seg.end);
        });

        addonStreamErrorUnlisten = await window.electronAPI.addonEvents.onStreamError((event) => {
          if (
            disposed
            || addonPlaybackStarted
            || !addonProxySessionId
            || event.session_id !== addonProxySessionId
          ) {
            return;
          }
          void handleAddonStartupFailure(event.message);
        });

        playerProgressUnlisten = await window.electronAPI.playerEvents.onProgress((data) => {
          if (disposed) return;
          // Keep segment detection on the primary playback event path as well
          // as the stable recovery listener. maybeHandleIntroDbProgress
          // coalesces duplicate episode snapshots, so both paths are safe.
          void maybeHandleIntroDbProgress(
            data.filename,
            data.playback_time,
            data.duration,
            data.playlist_pos ?? undefined,
          );
          restoreSmartNextWindowState();
          syncSmartNextAvailability();
          void recoverPendingSmartNextRequest(data.filename);
          maybePrepareSmartNextInBackground(
            data.filename,
            data.playback_time,
            data.duration,
          );
          if (
            typeof data.duration === 'number'
            && data.duration > 0
            && commitPendingSmartNextPersistence()
          ) {
            setSmartNextTransitionActive(false);
          }
          if (data.playback_time != null) {
            lastKnownPlaybackTimeRef.current = data.playback_time;
            lastKnownAtRef.current = Date.now();
          }
          if (
            selectedStream.sourceType === 'addon'
            && addonLoadRequested
            && typeof data.duration === 'number'
            && data.duration > 0
          ) {
            addonPlaybackStarted = true;
            addonLoadRequested = false;
            addonMpvPid = null;
          }
        });

        playerPauseUnlisten = await window.electronAPI.playerEvents.onPause((data) => {
          if (disposed) return;
          cancelSegmentBoundaryTimer('pause-event');
          playbackPausedRef.current = true;
          if (data.playback_time != null) {
            lastKnownPlaybackTimeRef.current = data.playback_time;
          }
          if (
            typeof data.filename === 'string'
            && typeof data.playback_time === 'number'
            && typeof data.duration === 'number'
          ) {
            console.debug('[Episode Segments] Pause triggered segment re-evaluation', {
              playbackTime: data.playback_time,
              duration: data.duration,
            });
            void maybeHandleIntroDbProgress(
              data.filename,
              data.playback_time,
              data.duration,
              data.playlist_pos ?? undefined,
            );
          }
        });

        playerPlayUnlisten = await window.electronAPI.playerEvents.onPlay((data) => {
          if (disposed) return;
          restoreSmartNextWindowState();
          syncSmartNextAvailability();
          if (commitPendingSmartNextPersistence()) {
            const trace = smartNextPerformanceRef.current;
            if (trace) {
              trace.mpvPlayAt = Date.now();
              logSmartNextPerformance('next-playback-started', {
                episode: trace.episode ?? null,
                sourceType: trace.sourceType ?? selectedStream.sourceType,
                totalMs: trace.mpvPlayAt - trace.startedAt,
                transitionMs: trace.transitionRequestedAt
                  ? trace.mpvPlayAt - trace.transitionRequestedAt
                  : null,
                launchMs: trace.playbackLaunchStartedAt
                  ? trace.mpvPlayAt - trace.playbackLaunchStartedAt
                  : null,
                preparationMs: trace.sourceSelectedAt
                  ? trace.sourceSelectedAt - (trace.preparationStartedAt ?? trace.startedAt)
                  : null,
                warmupMs: trace.warmupReadyAt && trace.warmupStartedAt
                  ? trace.warmupReadyAt - trace.warmupStartedAt
                  : null,
                cachedBytes: trace.cachedBytes ?? 0,
                totalBytes: trace.totalBytes ?? null,
              });
              smartNextPerformanceRef.current = null;
            }
            setSmartNextTransitionActive(false);
          }
          cancelSegmentBoundaryTimer('play-event');
          playbackPausedRef.current = false;
          if (data.playback_time != null) {
            lastKnownPlaybackTimeRef.current = data.playback_time;
          }
          lastKnownAtRef.current = Date.now();
          if (
            typeof data.filename === 'string'
            && typeof data.playback_time === 'number'
            && typeof data.duration === 'number'
          ) {
            console.debug('[Episode Segments] Resume triggered segment re-evaluation', {
              playbackTime: data.playback_time,
              duration: data.duration,
              playlistPos: data.playlist_pos ?? null,
            });
            void maybeHandleIntroDbProgress(
              data.filename,
              data.playback_time,
              data.duration,
              data.playlist_pos ?? undefined,
            );
          }

          if (selectedStream.sourceType === 'addon' && !addonPlaybackStarted) {
            addonPlaybackStarted = true;
            addonLoadRequested = false;
            addonMpvPid = null;
          }

        });

        playerStopUnlisten = await window.electronAPI.playerEvents.onStop(() => {
          if (
            disposed
            || selectedStream.sourceType !== 'addon'
            || !addonLoadRequested
            || addonPlaybackStarted
          ) {
            return;
          }
          void handleAddonStartupFailure('The configured source could not open this remote stream. Retry or choose another result.');
        });

        playerPlaylistChangedUnlisten = await window.electronAPI.playerEvents.onPlaylistChanged((data) => {
          if (disposed) return;
          cancelSegmentBoundaryTimer('playlist-changed');
          const store = useStore.getState();
          const resolvedPlaylistIndex = syncCurrentQbitPlaylistFile(store, data);
          if (resolvedPlaylistIndex != null) {
            introSkipperCurrentUrlRef.current = useStore.getState().playlistFiles[resolvedPlaylistIndex]?.streamUrl
              || introSkipperCurrentUrlRef.current;
          }
          const previousPlaylistPos = lastSvpPlaylistPosRef.current;
          const nextPlaylistPos = typeof data.playlist_pos === 'number' ? data.playlist_pos : null;
          if (
            previousPlaylistPos != null &&
            nextPlaylistPos != null &&
            nextPlaylistPos !== previousPlaylistPos
          ) {
            void restartSvpAfterPlaybackChange('playlist change');
          }
          lastSvpPlaylistPosRef.current = nextPlaylistPos;
        });

        playerSmartNextUnlisten = await window.electronAPI.playerEvents.onSmartNextRequested((data) => {
          if (disposed) return;
          void consumeSmartNextRequest(data, data.filename);
        });

        playerAudioTrackChangedUnlisten = await window.electronAPI.playerEvents.onAudioTrackChanged(async ({ track_id }) => {
          if (disposed) return;

          const previousTrackId = lastWhisperAudioTrackId;
          lastWhisperAudioTrackId = track_id;
          if (previousTrackId === undefined || previousTrackId === track_id) {
            return;
          }
          cancelSegmentBoundaryTimer('audio-track-changed');
          localSegmentAudioGenerationRef.current += 1;
          introSkipperGeneration += 1;
          for (const lookup of introSkipperLookups.values()) {
            if (lookup.retryTimer != null) {
              window.clearTimeout(lookup.retryTimer);
            }
          }
          introSkipperLookups.clear();
          resolvedLocalIntroSegments.clear();
          introSkipperOutroGeneration += 1;
          for (const lookup of introSkipperOutroLookups.values()) {
            if (lookup.retryTimer != null) {
              window.clearTimeout(lookup.retryTimer);
            }
          }
          introSkipperOutroLookups.clear();
          resolvedLocalOutroSegments.clear();
          void window.electronAPI.getPlayerInfo()
            .then((playerInfo) => {
              if (
                disposed
                || !playerInfo.connected
                || typeof playerInfo.filename !== 'string'
                || typeof playerInfo.playback_time !== 'number'
                || typeof playerInfo.duration !== 'number'
              ) {
                return;
              }
              void segmentDetectionHandlerRef.current?.(
                playerInfo.filename,
                playerInfo.playback_time,
                playerInfo.duration,
                playerInfo.playlist_pos ?? undefined,
              );
            })
            .catch((error) => {
              console.debug('[Segment Detection][Local] Audio-track event retry unavailable', error);
            });

          if (activeWhisperSessionIdRef.current === 0 || !restartSubtitlePipeline) {
            return;
          }

          const changeToken = ++whisperAudioTrackChangeToken;
          console.log('[WhisperLive] MPV audio track changed, restarting transcription', {
            previousTrackId,
            trackId: track_id,
            changeToken,
          });
          setSubtitleStatus('connecting');
          setSubtitleMessage('Switching Whisper to the selected audio track...');
          setSubtitleAssist({
            status: 'connecting',
            message: 'Switching Whisper to the selected audio track...',
            progress: 20,
          });

          try {
            await stopSubtitleTranscription('audio track changed');
            await wait(WHISPER_SEEK_RESTART_DELAY_MS);
            if (
              disposedRef.current
              || changeToken !== whisperAudioTrackChangeToken
              || !restartSubtitlePipeline
            ) {
              return;
            }

            await restartSubtitlePipeline();
          } catch (error) {
            if (disposedRef.current || changeToken !== whisperAudioTrackChangeToken) {
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            console.error('[WhisperLive] Failed to switch transcription audio track:', error);
            setSubtitleStatus('error');
            setSubtitleMessage(message || 'Whisper could not switch audio tracks');
            setSubtitleAssist({
              status: 'error',
              message: message || 'Whisper could not switch audio tracks',
              progress: 0,
            });
          }
        });

        playerSeekUnlisten = await window.electronAPI.playerEvents.onSeek(async (data) => {
          if (disposed) return;

          cancelSegmentBoundaryTimer('seek-event');
          if (data.playback_time != null) {
            lastKnownPlaybackTimeRef.current = data.playback_time;
          }
          lastKnownAtRef.current = Date.now();
          playbackPausedRef.current = false;

          if (
            typeof data.filename === 'string'
            && typeof data.playback_time === 'number'
            && typeof data.duration === 'number'
          ) {
            console.debug('[Episode Segments] Seek triggered segment re-evaluation', {
              playbackTime: data.playback_time,
              duration: data.duration,
            });
            void maybeHandleIntroDbProgress(
              data.filename,
              data.playback_time,
              data.duration,
              data.playlist_pos ?? undefined,
            );
          }

          console.log('[WhisperLive] Seek detected', {
            playbackTime: data.playback_time,
            playlistPos: data.playlist_pos,
            activeSessionId: activeWhisperSessionIdRef.current,
            currentJobId: subtitleJobRef.current,
            pendingSeekToken: whisperSeekRestartTokenRef.current,
            pipelineAvailable: !!restartSubtitlePipeline,
          });
          setSubtitleStatus('connecting');
          setSubtitleMessage('Repositioning subtitles after seek...');
          setSubtitleAssist({
            status: 'connecting',
            message: 'Repositioning subtitles after seek...',
            progress: 20,
          });

          await stopSubtitleTranscription('seek');
          await scheduleWhisperSeekRestart();
        });

        playerClosedUnlisten = await window.electronAPI.playerEvents.onClosed(async (data) => {
          if (disposed) return;
          if (smartNextTransitionRef.current) {
            console.log('[Smart Next] Ignoring player close during provider-neutral transition:', data);
            return;
          }
          if (mpvPidRef.current == null) {
            console.log('[WhisperLive] Ignoring player closed event before current MPV launch:', data);
            return;
          }
          if (selectedStream.sourceType === 'qbittorrent' && lastKnownPlaybackTimeRef.current < 5) {
            console.log('[WhisperLive] External playback service closed MPV too early; scheduling retry:', data);
            await stopSubtitleTranscription('player closed while waiting for external playback service', true);
            void stopSvpAfterMpvClose();
            scheduleQbitRetry('Waiting for the external playback service to prepare more playable data.');
            return;
          }
          console.log('[WhisperLive] MPV closed, stopping transcription:', data);
          await stopSubtitleTranscription('player closed', true);
          void stopSvpAfterMpvClose();
          setSubtitleStatus('disabled');
          setSubtitleMessage('Subtitles stopped');
          clearSubtitleAssist();
          setRetryWhisperAction(null);
          setRetryAudioNormalizerAction(null);
          setAudioNormalizerActive(false);
          setAudioNormalizerConnected(false);
          setAudioNormalizerReason('no_data');
          exitToMetaDetails();
        });

        playerEofUnlisten = await window.electronAPI.playerEvents.onEof(async (data) => {
          if (disposed) return;
          if (smartNextTransitionRef.current) {
            console.log('[Smart Next] Ignoring player EOF during provider-neutral transition:', data);
            return;
          }
          if (mpvPidRef.current == null) {
            console.log('[WhisperLive] Ignoring player EOF event before current MPV launch:', data);
            return;
          }
          if (selectedStream.sourceType === 'qbittorrent' && lastKnownPlaybackTimeRef.current < 5) {
            console.log('[WhisperLive] External playback service reached EOF too early; scheduling retry:', data);
            await stopSubtitleTranscription('player reached EOF while waiting for external playback service', true);
            scheduleQbitRetry('Waiting for the external playback service to prepare more playable data.');
            return;
          }
          console.log('[WhisperLive] MPV reached EOF, stopping transcription:', data);
          await stopSubtitleTranscription('player eof', true);
          setSubtitleStatus('disabled');
          setSubtitleMessage('Subtitles stopped');
          clearSubtitleAssist();
          setRetryWhisperAction(null);
          setRetryAudioNormalizerAction(null);
          setAudioNormalizerActive(false);
          setAudioNormalizerConnected(false);
          setAudioNormalizerReason('no_data');
          if (!useStore.getState().playlistActive) {
            exitToMetaDetails();
          }
        });

        playerReconnectedUnlisten = await window.electronAPI.playerEvents.onReconnected(() => {
          const store = useStore.getState();
          if (!store.playlistActive) return;
          const currentFile = store.playlistFiles[store.playlistCurrentIndex];
          if (currentFile?.name) {
            syncPlaylistTitle(currentFile.name);
          }
        });

        startupStateUnlisten = await window.electronAPI.torrent.onStartupState((state) => {
          if (disposed) return;
          if (state.session_id !== 0) {
            activeStartupSessionRef.current = state.session_id;
          }
          setStartupState(state);
          if (state.phase === 'failed') {
            setStartupError(state.message);
            setIsLoading(false);
          } else {
            setStartupError(null);
          }
        });

        playerHdrRestartUnlisten = await window.electronAPI.playerEvents.onHdrRestartRequired(async (data) => {
          if (disposed || mpvPidRef.current == null || data.pid !== mpvPidRef.current) {
            return;
          }

          console.log('[HDR] Restarting MPV after Windows HDR change', data);
          setCurrentMpvPid(null);
          await stopSubtitleTranscription('Windows HDR changed', true);
          await window.electronAPI.stopMpvProcess(data.pid).catch((error) => {
            console.warn('[HDR] Failed to stop MPV for HDR restart:', error);
          });

          const currentStore = useStore.getState();
          const currentStream = currentStore.selectedStream;
          if (!currentStream || disposed) {
            return;
          }
          initInProgress.current = false;
          streamOpenedRef.current = false;
          torrentStartedRef.current = false;
          playerObservingStarted.current = false;
          useStore.getState().setSelectedStream({
            ...currentStream,
            startOver: false,
            resumeProgress: data.percent_pos,
            resumePlaybackTime: data.playback_time,
            resumeDuration: data.duration,
            resumeSourceFilename: currentStore.currentPlayingTitle || currentStream.resumeSourceFilename,
          });
        });

        type RendererPlaylistFile = {
          name: string;
          index: number;
          ready: boolean;
          streamUrl: string | null;
          season?: number;
          episode?: number;
        };
        const appendVerifiedMpvPlaylist = async (
          initialFile: RendererPlaylistFile,
          queuedFiles: RendererPlaylistFile[],
          providerLabel: string,
          preferredSeason?: number,
          preferredEpisode?: number,
        ) => {
          let acceptedFiles = [initialFile];

          const publishAcceptedFiles = () => {
            if (!isCurrentPlaybackLaunch()) return;
            const store = useStore.getState();
            const files = acceptedFiles.map((file, index) => ({ ...file, index }));
            const currentIndex = Math.min(store.playlistCurrentIndex, files.length - 1);
            store.setPlaylistFiles(files);
            store.setPlaylistTotalFiles(files.length);
            store.setPlaylistCurrentIndex(currentIndex);
            store.setPlaylistActive(files.length > 1);
            setPlaybackIdentityForFiles(store, files, preferredSeason ?? 1, preferredSeason, preferredEpisode);
            store.setPlaybackIdentityCurrentIndex(currentIndex);

            const currentFile = files[currentIndex];
            const parsedEpisode = currentFile
              ? extractEpisodeNumber(currentFile.name, preferredSeason ?? 1)
              : null;
            const episodeInfo = typeof currentFile?.season === 'number' && typeof currentFile.episode === 'number'
              ? { season: currentFile.season, episode: currentFile.episode }
              : parsedEpisode;
            store.setPlaylistEpisodeInfo(episodeInfo && currentFile
              ? { season: episodeInfo.season, episode: episodeInfo.episode, title: currentFile.name }
              : null);
          };

          publishAcceptedFiles();
          for (const queuedFile of queuedFiles) {
            let appended = false;
            let lastError: unknown = null;
            for (const delayMs of [0, 200, 600, 1200]) {
              if (delayMs > 0) await wait(delayMs);
              if (!isCurrentPlaybackLaunch() || !queuedFile.streamUrl) return;
              try {
                await window.electronAPI.player.playlistAdd(queuedFile.streamUrl, queuedFile.name);
                appended = true;
                break;
              } catch (error) {
                lastError = error;
              }
            }

            if (!appended) {
              console.error(`%c[Playlist]%c Failed to append ${providerLabel} item after retries:`, 'color: #ff6b35; font-weight: bold', 'color: inherit', {
                name: queuedFile.name,
                error: lastError,
              });
              continue;
            }

            acceptedFiles = [...acceptedFiles, { ...queuedFile, index: acceptedFiles.length }];
            publishAcceptedFiles();
          }

          try {
            const mpvPlaylist = await window.electronAPI.player.getPlaylistInfo();
            const mpvNames = mpvPlaylist.map((item) =>
              item?.title || getMediaDisplayName(String(item?.filename || ''))
            );
            if (mpvPlaylist.length >= 1 && mpvPlaylist.length < acceptedFiles.length) {
              console.warn('[Playlist] MPV accepted fewer items than confirmed; trimming renderer queue', {
                provider: providerLabel,
                confirmedCount: acceptedFiles.length,
                mpvCount: mpvPlaylist.length,
                mpvNames,
              });
              acceptedFiles = acceptedFiles.slice(0, mpvPlaylist.length);
              publishAcceptedFiles();
            } else if (mpvPlaylist.length !== acceptedFiles.length) {
              console.warn('[Playlist] MPV and renderer playlist counts disagree', {
                provider: providerLabel,
                rendererCount: acceptedFiles.length,
                mpvCount: mpvPlaylist.length,
                mpvNames,
              });
            }
          } catch (error) {
            console.error('[Playlist] Failed to verify MPV playlist:', error);
          }

          console.log(`%c[Playlist]%c ${providerLabel} playlist verified`, 'color: #ff6b35; font-weight: bold', 'color: inherit', {
            count: acceptedFiles.length,
            files: acceptedFiles.map((file) => file.name),
          });
        };

        if (selectedStream.sourceType === 'local') {
          if (streamOpenedRef.current) {
            return;
          }
          streamOpenedRef.current = true;

          const latestContinueWatching = continueWatchingRef.current;
          const selectedMetaContinueWatchingId = selectedMeta
            ? `${selectedMeta.type === 'series' ? 'tv' : 'movie'}:${selectedMeta.id.split(':')[1]}`
            : null;
          const continueWatchingItem = selectedMeta && !selectedStream.startOver
            ? latestContinueWatching.find(
                (c) => c.metaId === selectedMeta.id || c.metaId === selectedMetaContinueWatchingId
              )
            : null;
          const storedResumeSourceMeta = !selectedStream.startOver
            ? getStoredResumeSourceMeta(selectedMeta)
            : null;
          const { targetSeason, targetEpisode, resumeSourceFilename } = resolvePlaybackTarget(
            selectedStream,
            continueWatchingItem,
            storedResumeSourceMeta,
          );
          const localFiles = sortLocalVideoFiles(
            selectedStream.localFiles?.length
              ? selectedStream.localFiles
              : [{ name: getPathBaseName(selectedStream.url), path: selectedStream.url, size: 0 }]
          );

          let videoFile: LocalVideoFile | undefined;
          videoFile = selectVideoFileForResumeTarget(
            localFiles,
            targetSeason,
            targetEpisode,
            targetSeason ?? 1,
            resumeSourceFilename
          );

          if (!videoFile) {
            videoFile = localFiles[0];
          }

          if (!videoFile) {
            throw new Error('No local video file was selected.');
          }
          const displayFileName = getPathBaseName(videoFile.name);

          const targetPlaylistIndex = Math.max(
            0,
            localFiles.findIndex((file) => file.path === videoFile.path)
          );
          const playlistFiles = localFiles.slice(targetPlaylistIndex);
          const bounds = await getMpvDebugBounds();
          setMpvDebugBounds(bounds);

          const position = {
            x: bounds.appX + bounds.offsetX,
            y: bounds.appY + bounds.offsetY,
            width: bounds.width,
            height: bounds.height,
          };

          const resumeItem = getStreamResumeItem(selectedStream, continueWatchingItem);
          const startPosition = getResumeStartPosition(resumeItem, targetSeason, targetEpisode);
          const mpvLaunchSettings = await getMpvLaunchSettings(selectedMeta?.originalLanguage);

          setStartupState({
            session_id: 0,
            attempt: 0,
            phase: 'opening_local_file',
            message: 'Opening local video...',
          });
          setStartupError(null);

          const launch = await window.electronAPI.prepareAndOpenLocalStream(
            videoFile.path,
            playlistFiles.slice(1).map((file) => file.path),
            position,
            startPosition,
            displayFileName,
            mpvLaunchSettings.upscaler,
            mpvLaunchSettings.seekPreviewEnabled,
            mpvLaunchSettings.forceStereoEnabled,
            mpvLaunchSettings.rtxHdrEnabled,
            mpvLaunchSettings.hdrContrastBoostEnabled,
            mpvLaunchSettings.cacheWholeFileEnabled,
            mpvLaunchSettings.preferredSubtitleLanguage,
            mpvLaunchSettings.preferredAudioLanguage,
            mpvLaunchSettings.preferSdhSubtitles,
          );

          restartWhisperPipeline = async (subtitleJobId: number) => {
            const startSeconds = await getWhisperStartSeconds();
            console.log('[WhisperLive] Launching Whisper transcription session for local media', {
              subtitleJobId,
              startSeconds,
              localPath: launch.file_url,
              videoFile: videoFile.name,
            });
            await transcribeWithWhisperLive(
              { name: videoFile.name, size: videoFile.size, localPath: launch.file_url },
              launch.file_url,
              disposedRef,
              subtitleJobId,
              startSeconds,
              'local',
            );
          };

          if (!setCurrentMpvPid(launch.pid)) {
            await window.electronAPI.stopMpvProcess(launch.pid).catch(() => {});
            return;
          }

          if (!playerObservingStarted.current) {
            playerObservingStarted.current = true;
            window.electronAPI.startPlayerObserving().catch(e =>
              console.error('%c[Stream]%c Failed to start player observing:', 'color: #4ade80; font-weight: bold', 'color: inherit', e)
            );
          }

          if (playlistFiles.length > 1) {
            const rendererFiles = playlistFiles.map((file, index) => ({
              name: getPathBaseName(file.name),
              index,
              ready: true,
              streamUrl: file.path,
            }));
            const firstEpInfo = extractEpisodeNumber(playlistFiles[0].name, targetSeason ?? 1);
            if (firstEpInfo) {
              persistResumeEpisode(firstEpInfo);
            }
            void appendVerifiedMpvPlaylist(
              rendererFiles[0],
              rendererFiles.slice(1),
              'Local',
              targetSeason,
              targetEpisode,
            );
          } else {
            const store = useStore.getState();
            setPlaybackIdentityForFiles(
              store,
              [{ ...playlistFiles[0], name: displayFileName }],
              targetSeason ?? 1,
              targetSeason,
              targetEpisode,
            );
            store.setPlaylistActive(false);
            store.setPlaylistFiles([]);
            store.setPlaylistTotalFiles(0);
            store.setPlaylistCurrentIndex(0);
            const identity = store.playbackIdentityItems[0];
            store.setPlaylistEpisodeInfo(
              typeof identity?.season === 'number' && typeof identity.episode === 'number'
                ? { season: identity.season, episode: identity.episode, title: identity.title }
                : null
            );
          }

          if (selectedMeta) {
            const tmdbId = parseInt(selectedMeta.id.split(':')[1], 10);
            const parsedEpisode = selectedMeta.type === 'series'
              ? extractEpisodeNumber(videoFile.name, targetSeason ?? 1)
              : null;
            setCurrentPlayingMeta({
              type: selectedMeta.type,
              tmdbId,
              name: selectedMeta.name,
              poster: selectedMeta.poster,
              imdbId: selectedMeta.imdbId,
              season: parsedEpisode?.season ?? targetSeason,
              episode: parsedEpisode?.episode ?? targetEpisode,
            });
            const store = useStore.getState();
            store.setCurrentPlayingTitle(displayFileName);
            syncPlaylistTitle(displayFileName);
          }

          setIsLoading(false);
          setStartupError(null);
          resetDownloadStats();
          setStats(prev => ({
            ...prev,
            status: 'local',
            downloadedTotal: launch.total_bytes,
            total: launch.total_bytes,
            progress: 100,
            file: { name: displayFileName, size: launch.total_bytes },
            streamUrl: launch.file_url
          }));

          restartSubtitlePipeline = async () => {
            const subtitleJobId = ++subtitleJobRef.current;
            const subtitlePrefs = readSubtitlePreferences(selectedMeta?.originalLanguage);

            try {
              if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                return;
              }

              if (subtitlePrefs.alwaysUseWhisper) {
                setSubtitleStatus('pending');
                setSubtitleMessage('Starting WhisperLive transcription...');
                setSubtitleAssist({
                  status: 'pending',
                  message: 'Starting WhisperLive transcription...',
                  progress: 0,
                });
                activeWhisperSessionIdRef.current = subtitleJobId;
                setWhisperProcessedSeconds(await getWhisperStartSeconds());
                await startWhisperPipelineWithRecovery(subtitleJobId);
                if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                  return;
                }
                setSubtitleStatus('generated');
                setSubtitleMessage('WhisperLive subtitles ready');
                setSubtitleAssist({
                  status: 'ready',
                  message: 'WhisperLive subtitles ready',
                  progress: 100,
                });
                return;
              }

              const { tracks, settled } = await waitForSubtitleTracks(disposedRef);
              if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                return;
              }

              const subtitleTracks = tracks.filter((track) => track.type === 'sub' && !isLiveWhisperSubtitleTrack(track));
              if (subtitleTracks.length > 0) {
                const selectedTrack = selectPreferredSubtitleTrack(subtitleTracks, subtitlePrefs);
                setSubtitleStatus('embedded');
                setSubtitleMessage(selectedTrack.title ? `Using embedded subtitles: ${selectedTrack.title}` : 'Using embedded subtitles');
                setSubtitleAssist({
                  status: 'embedded',
                  message: selectedTrack.title ? `Using embedded subtitles: ${selectedTrack.title}` : 'Using embedded subtitles',
                  progress: 100,
                });
                if (!selectedTrack.selected) {
                  await window.electronAPI.player.setTrack('sub', selectedTrack.id);
                }
                return;
              }

              if (!settled) {
                setSubtitleStatus('disabled');
                setSubtitleMessage('Waiting for subtitle tracks...');
                setSubtitleAssist({
                  status: 'disabled',
                  message: 'Waiting for subtitle tracks...',
                  progress: 0,
                });
                return;
              }

              if (subtitlePrefs.autoFallback) {
                setSubtitleStatus('pending');
                setSubtitleMessage('Starting WhisperLive transcription...');
                setSubtitleAssist({
                  status: 'pending',
                  message: 'Starting WhisperLive transcription...',
                  progress: 0,
                });
                activeWhisperSessionIdRef.current = subtitleJobId;
                setWhisperProcessedSeconds(await getWhisperStartSeconds());
                await startWhisperPipelineWithRecovery(subtitleJobId);
                if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                  return;
                }
                setSubtitleStatus('generated');
                setSubtitleMessage('WhisperLive subtitles ready');
                setSubtitleAssist({
                  status: 'ready',
                  message: 'WhisperLive subtitles ready',
                  progress: 100,
                });
                return;
              }

              setSubtitleStatus('disabled');
              setSubtitleMessage('No subtitles available');
              setSubtitleAssist({
                status: 'disabled',
                message: 'No subtitles available',
                progress: 0,
              });
            } catch (error) {
              if (!disposedRef.current && subtitleJobId === subtitleJobRef.current) {
                console.error('%c[Subtitles]%c Failed to prepare subtitles:', 'color: #4ade80; font-weight: bold', 'color: inherit', error);
                const message = error instanceof Error ? error.message : String(error);
                setSubtitleStatus('error');
                setSubtitleMessage(message || 'Subtitle fallback failed');
                setSubtitleAssist({
                  status: 'error',
                  message: message || 'Subtitle fallback failed',
                  progress: 0,
                });
              }
            }
          };

          restartSubtitlePipelineRef.current = restartSubtitlePipeline;
          await restartSubtitlePipeline();

          interval = setInterval(() => {
            timeRef.current += 1;
            if (showDebugRef.current) {
              setStats(prev => ({ ...prev, timeConnected: timeRef.current }));
            }
          }, 1000);

          return;
        }

        if (selectedStream.sourceType === 'qbittorrent' || selectedStream.sourceType === 'addon') {
          if (streamOpenedRef.current) {
            return;
          }
          streamOpenedRef.current = true;
          const isAddonStream = selectedStream.sourceType === 'addon';
          const streamProviderLabel = isAddonStream
            ? selectedStream.torrent.addonName || 'Configured add-on'
            : 'External playback service';

          const latestContinueWatching = continueWatchingRef.current;
          const selectedMetaContinueWatchingId = selectedMeta
            ? `${selectedMeta.type === 'series' ? 'tv' : 'movie'}:${selectedMeta.id.split(':')[1]}`
            : null;
          const continueWatchingItem = selectedMeta && !selectedStream.startOver
            ? latestContinueWatching.find(
                (c) => c.metaId === selectedMeta.id || c.metaId === selectedMetaContinueWatchingId
              )
            : null;
          const storedResumeSourceMeta = !selectedStream.startOver
            ? getStoredResumeSourceMeta(selectedMeta)
            : null;
          const { targetSeason, targetEpisode, resumeSourceFilename } = resolvePlaybackTarget(
            selectedStream,
            continueWatchingItem,
            storedResumeSourceMeta,
          );
          const bounds = await getMpvDebugBounds();
          setMpvDebugBounds(bounds);

          const position = {
            x: bounds.appX + bounds.offsetX,
            y: bounds.appY + bounds.offsetY,
            width: bounds.width,
            height: bounds.height,
          };

          const resumeItem = getStreamResumeItem(selectedStream, continueWatchingItem);
          const startPosition = getResumeStartPosition(resumeItem, targetSeason, targetEpisode);
          const mpvLaunchSettings = await getMpvLaunchSettings(selectedMeta?.originalLanguage);

          setStartupState({
            session_id: 0,
            attempt: 0,
            phase: isAddonStream ? 'waiting_for_addon' : 'waiting_for_qbittorrent',
            message: isAddonStream
              ? selectedStream.routeSwitchMessage || `Opening ${streamProviderLabel} stream...`
              : 'Waiting for the external playback service to prepare a playable file...',
          });
          setStartupError(null);

          let launch: StreamLaunchResult | undefined;
          if (isAddonStream) {
            const effectiveStreamHandle = selectedStream.torrent.streamHandle;
            if (!effectiveStreamHandle && !/^https?:\/\//i.test(selectedStream.url)) {
              throw new Error('The selected add-on did not provide a valid direct stream.');
            }
            const addonDisplayName = selectedStream.torrent.streamFilename || selectedStream.title;
            const directStreamSize = selectedStream.torrent.size;
            const directCacheIdentity = buildDirectStreamCacheIdentity(selectedStream.torrent);
            const addonSubtitlePrefs = readSubtitlePreferences(selectedMeta?.originalLanguage);
            const monitoredStream = adoptedWarmup?.sourceType === 'addon'
              && adoptedWarmup.addonSessionId
              ? {
                  url: adoptedWarmup.prepared.file_url,
                  session_id: adoptedWarmup.addonSessionId,
                }
              : effectiveStreamHandle
                ? await window.electronAPI.prepareDirectStreamHandle(
                    effectiveStreamHandle,
                    directStreamSize,
                    addonDisplayName,
                    selectedStream.torrent.addonInstallationId,
                    selectedStream.torrent.addonName,
                    directCacheIdentity,
                    mpvLaunchSettings.cacheWholeFileEnabled,
                    addonSubtitlePrefs.autoFallback || addonSubtitlePrefs.alwaysUseWhisper,
                  )
                : await window.electronAPI.prepareAddonStreamUrl(
                    selectedStream.url,
                    selectedStream.torrent.size,
                    addonDisplayName,
                    selectedStream.torrent.addonInstallationId,
                    selectedStream.torrent.addonName,
                    directCacheIdentity,
                    mpvLaunchSettings.cacheWholeFileEnabled,
                    addonSubtitlePrefs.autoFallback || addonSubtitlePrefs.alwaysUseWhisper,
                  );
            if (!isCurrentPlaybackLaunch()) {
              await window.electronAPI.releaseAddonStream(monitoredStream.session_id).catch(() => {});
              return;
            }
            addonProxySessionId = monitoredStream.session_id;
            useStore.getState().setAddonTransferSessionId(monitoredStream.session_id);
            const prelaunch = await window.electronAPI.prelaunchMpv(
              position,
              addonDisplayName,
              mpvLaunchSettings.upscaler,
              mpvLaunchSettings.seekPreviewEnabled,
              mpvLaunchSettings.forceStereoEnabled,
              mpvLaunchSettings.rtxHdrEnabled,
              mpvLaunchSettings.hdrContrastBoostEnabled,
              mpvLaunchSettings.cacheWholeFileEnabled,
              mpvLaunchSettings.preferredSubtitleLanguage,
              mpvLaunchSettings.preferredAudioLanguage,
              mpvLaunchSettings.preferSdhSubtitles,
            );
            if (!isCurrentPlaybackLaunch()) {
              await window.electronAPI.stopMpvProcess(prelaunch.pid).catch(() => {});
              await window.electronAPI.releaseAddonStream(monitoredStream.session_id).catch(() => {});
              if (useStore.getState().addonTransferSessionId === monitoredStream.session_id) {
                useStore.getState().setAddonTransferSessionId(null);
              }
              addonProxySessionId = null;
              return;
            }
            addonMpvPid = prelaunch.pid;
            try {
              addonLoadRequested = true;
              launch = await window.electronAPI.loadPreparedMpvStream(
                prelaunch.pid,
                monitoredStream.url,
                startPosition,
                adoptedWarmup?.prepared.ready_bytes ?? 0,
                adoptedWarmup?.prepared.total_bytes ?? selectedStream.torrent.size,
                [],
                [],
                addonDisplayName,
              );
              if (addonFailureHandled) {
                return;
              }
            } catch (error) {
              addonLoadRequested = false;
              addonMpvPid = null;
              await window.electronAPI.stopMpvProcess(prelaunch.pid).catch(() => {});
              throw error;
            }
          } else {
            const qbitPreparePromise = adoptedWarmup?.sourceType === 'qbittorrent'
              ? window.electronAPI
                  .resumeSmartNextQbittorrent(adoptedWarmup.prepared.torrent_hash)
                  .then(() => adoptedWarmup.prepared)
              : window.electronAPI.prepareQbittorrentStream(
                  selectedStream.url,
                  selectedStream.torrent.infoHash,
                  targetSeason,
                  targetEpisode,
                  resumeSourceFilename,
                );
            const qbitPrelaunchPromise = mpvLaunchSettings.autoHdrEnabled
              ? Promise.resolve(null)
              : window.electronAPI.prelaunchMpv(
              position,
              selectedStream.title,
              mpvLaunchSettings.upscaler,
              mpvLaunchSettings.seekPreviewEnabled,
              mpvLaunchSettings.forceStereoEnabled,
              mpvLaunchSettings.rtxHdrEnabled,
              mpvLaunchSettings.hdrContrastBoostEnabled,
              mpvLaunchSettings.cacheWholeFileEnabled,
              mpvLaunchSettings.preferredSubtitleLanguage,
              mpvLaunchSettings.preferredAudioLanguage,
              mpvLaunchSettings.preferSdhSubtitles,
            ).then(async (prelaunch) => {
              if (!prelaunch) return null;
              if (!isCurrentPlaybackLaunch()) {
                await window.electronAPI.stopMpvProcess(prelaunch.pid).catch(() => {});
                return null;
              }
              prelaunchedMpvPid = prelaunch.pid;
              setCurrentMpvPid(prelaunch.pid);
              if (!playerObservingStarted.current) {
                playerObservingStarted.current = true;
                window.electronAPI.startPlayerObserving().catch(e =>
                  console.error('%c[Stream]%c Failed to start player observing:', 'color: #4ade80; font-weight: bold', 'color: inherit', e)
                );
              }
              return prelaunch.pid;
            }).catch((error) => {
              console.warn('[External playback service] MPV prelaunch failed; falling back to direct launch:', error);
              prelaunchedMpvPid = null;
              setCurrentMpvPid(null);
              return null;
            });

            const [preparedQbitStream, qbitMpvPid] = await Promise.all([
              qbitPreparePromise,
              qbitPrelaunchPromise,
            ]);

            if (qbitMpvPid != null) {
              try {
                setStartupState({
                  session_id: 0,
                  attempt: 0,
                  phase: 'loading_qbittorrent_file',
                  message: 'Loading the prepared media file in MPV...',
                });
                launch = await window.electronAPI.loadPreparedMpvStream(
                  qbitMpvPid,
                  preparedQbitStream.file_url,
                  startPosition,
                  preparedQbitStream.ready_bytes,
                  preparedQbitStream.total_bytes,
                  preparedQbitStream.playlist_file_urls,
                  preparedQbitStream.playlist_files,
                  preparedQbitStream.file_name,
                );
                prelaunchedMpvLoaded = true;
                prelaunchedMpvPid = null;
              } catch (loadError) {
                console.warn(`[${streamProviderLabel}] Failed to load prepared file into prelaunched MPV, falling back to direct launch:`, loadError);
                await window.electronAPI.stopMpvProcess(qbitMpvPid).catch(() => {});
                prelaunchedMpvPid = null;
                setCurrentMpvPid(null);
              }
            }

            if (!launch) {
              if (!isCurrentPlaybackLaunch()) {
                return;
              }
              launch = await window.electronAPI.prepareAndOpenQbittorrentStream(
                selectedStream.url,
                selectedStream.torrent.infoHash,
                position,
                startPosition,
                selectedStream.title,
                targetSeason,
                targetEpisode,
                resumeSourceFilename,
                mpvLaunchSettings.upscaler,
                mpvLaunchSettings.seekPreviewEnabled,
                mpvLaunchSettings.forceStereoEnabled,
                mpvLaunchSettings.rtxHdrEnabled,
                mpvLaunchSettings.hdrContrastBoostEnabled,
                mpvLaunchSettings.cacheWholeFileEnabled,
                mpvLaunchSettings.preferredSubtitleLanguage,
                mpvLaunchSettings.preferredAudioLanguage,
                mpvLaunchSettings.preferSdhSubtitles,
              );
            }
          }
          if (!launch) {
            throw new Error(`${streamProviderLabel} stream did not launch.`);
          }
          introSkipperCurrentUrlRef.current = launch.file_url;
          const localFileName = isAddonStream
            ? selectedStream.torrent.streamFilename || selectedStream.title
            : getMediaDisplayName(launch.file_url);
          const localVideoFile = {
            name: localFileName,
            size: launch.total_bytes,
            localPath: launch.file_url,
          };
          currentWhisperSource = {
            videoFile: localVideoFile,
            streamUrl: launch.file_url,
            sourceType: isAddonStream ? 'addon' : 'qbittorrent',
          };
          restartWhisperPipeline = async (subtitleJobId: number) => {
            const startSeconds = await getWhisperStartSeconds();
            const whisperSource = currentWhisperSource ?? {
              videoFile: localVideoFile,
              streamUrl: launch.file_url,
              sourceType: isAddonStream ? 'addon' as const : 'qbittorrent' as const,
            };
            console.log(`[WhisperLive] Launching Whisper transcription session for ${streamProviderLabel} media`, {
              subtitleJobId,
              startSeconds,
              localPath: isAddonStream ? '[Remote stream URL redacted]' : whisperSource.streamUrl,
              videoFile: whisperSource.videoFile.name,
            });
            await transcribeWithWhisperLive(
              whisperSource.videoFile,
              whisperSource.streamUrl,
              disposedRef,
              subtitleJobId,
              startSeconds,
              whisperSource.sourceType,
            );
          };
          if (!setCurrentMpvPid(launch.pid)) {
            await window.electronAPI.stopMpvProcess(launch.pid).catch(() => {});
            return;
          }

          if (!playerObservingStarted.current) {
            playerObservingStarted.current = true;
            window.electronAPI.startPlayerObserving().catch(e =>
              console.error('%c[Stream]%c Failed to start player observing:', 'color: #4ade80; font-weight: bold', 'color: inherit', e)
            );
          }

          const canonicalQueuedItems: StreamPlaylistItem[] = launch.playlist_files.length > 0
            ? launch.playlist_files
            : launch.playlist_file_urls.map((url) => ({
                url,
                name: getMediaDisplayName(url),
                size: 0,
                season: null,
                episode: null,
              }));
          const qbitPlaylistFiles = [
            {
              name: localFileName,
              index: 0,
              ready: true,
              streamUrl: launch.file_url,
            },
            ...canonicalQueuedItems.map((item, index) => ({
              name: item.name,
              index: index + 1,
              ready: true,
              streamUrl: item.url,
              season: item.season ?? undefined,
              episode: item.episode ?? undefined,
            })),
          ];
          if (canonicalQueuedItems.length > 0) {
            void appendVerifiedMpvPlaylist(
              qbitPlaylistFiles[0],
              qbitPlaylistFiles.slice(1),
              streamProviderLabel,
              targetSeason,
              targetEpisode,
            );
          } else {
            const store = useStore.getState();
            setPlaybackIdentityForFiles(store, qbitPlaylistFiles, targetSeason ?? 1, targetSeason, targetEpisode);
            store.setPlaylistActive(false);
            store.setPlaylistFiles([]);
            store.setPlaylistTotalFiles(0);
            store.setPlaylistCurrentIndex(0);
            const identity = store.playbackIdentityItems[0];
            store.setPlaylistEpisodeInfo(
              typeof identity?.season === 'number' && typeof identity.episode === 'number'
                ? { season: identity.season, episode: identity.episode, title: identity.title }
                : null
            );

          }

          if (selectedMeta) {
            const tmdbId = parseInt(selectedMeta.id.split(':')[1], 10);
            // For packs, targetEpisode may be undefined — fall back to parsing the filename
            const parsedEpInfo = selectedMeta.type === 'series'
              ? extractEpisodeNumber(localFileName, targetSeason ?? 1)
              : null;
            setCurrentPlayingMeta({
              type: selectedMeta.type,
              tmdbId,
              name: selectedMeta.name,
              poster: selectedMeta.poster,
              imdbId: selectedMeta.imdbId,
              season: parsedEpInfo?.season ?? targetSeason,
              episode: parsedEpInfo?.episode ?? targetEpisode,
            });
            const store = useStore.getState();
            store.setCurrentPlayingTitle(localFileName);
            syncPlaylistTitle(localFileName);
          }

          setIsLoading(false);
          setStartupError(null);
          setStats(prev => ({
            ...prev,
            status: isAddonStream ? 'addon' : 'qbittorrent',
            downloadedTotal: launch.ready_bytes,
            total: launch.total_bytes,
            progress: launch.total_bytes > 0 ? launch.ready_bytes / launch.total_bytes : 0,
            file: { name: localFileName, size: launch.total_bytes },
            streamUrl: isAddonStream ? null : launch.file_url
          }));

          restartSubtitlePipeline = async () => {
            const subtitleJobId = ++subtitleJobRef.current;
            const subtitlePrefs = readSubtitlePreferences(selectedMeta?.originalLanguage);
            console.log('[WhisperLive] restartSubtitlePipeline invoked', {
              subtitleJobId,
              currentSessionId: activeWhisperSessionIdRef.current,
              alwaysUseWhisper: subtitlePrefs.alwaysUseWhisper,
              autoFallback: subtitlePrefs.autoFallback,
              localPath: isAddonStream ? '[Remote stream URL redacted]' : launch.file_url,
            });

            try {
              if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                console.log('[WhisperLive] restartSubtitlePipeline aborted before start', {
                  subtitleJobId,
                  disposed: disposedRef.current,
                  currentJobId: subtitleJobRef.current,
                });
                return;
              }

              if (subtitlePrefs.alwaysUseWhisper) {
                console.log('[WhisperLive] Always-use mode enabled, starting transcription');
                setSubtitleStatus('pending');
                setSubtitleMessage('Starting WhisperLive transcription...');
                setSubtitleAssist({
                  status: 'pending',
                  message: 'Starting WhisperLive transcription...',
                  progress: 0,
                });
                activeWhisperSessionIdRef.current = subtitleJobId;
                setWhisperProcessedSeconds(await getWhisperStartSeconds());
                await startWhisperPipelineWithRecovery(subtitleJobId);
                if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                  return;
                }
                setSubtitleStatus('generated');
                setSubtitleMessage('WhisperLive subtitles ready');
                setSubtitleAssist({
                  status: 'ready',
                  message: 'WhisperLive subtitles ready',
                  progress: 100,
                });
                return;
              }

              const { tracks, settled } = await waitForSubtitleTracks(disposedRef);
              if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                return;
              }

              const subtitleTracks = tracks.filter((track) => track.type === 'sub' && !isLiveWhisperSubtitleTrack(track));
              if (subtitleTracks.length > 0) {
                const selectedTrack = selectPreferredSubtitleTrack(subtitleTracks, subtitlePrefs);
                setSubtitleStatus('embedded');
                setSubtitleMessage(selectedTrack.title ? `Using embedded subtitles: ${selectedTrack.title}` : 'Using embedded subtitles');
                setSubtitleAssist({
                  status: 'embedded',
                  message: selectedTrack.title ? `Using embedded subtitles: ${selectedTrack.title}` : 'Using embedded subtitles',
                  progress: 100,
                });
                if (!selectedTrack.selected) {
                  await window.electronAPI.player.setTrack('sub', selectedTrack.id);
                }
                return;
              }

              if (!settled) {
                setSubtitleStatus('disabled');
                setSubtitleMessage('Waiting for subtitle tracks...');
                setSubtitleAssist({
                  status: 'disabled',
                  message: 'Waiting for subtitle tracks...',
                  progress: 0,
                });
                return;
              }

              if (subtitlePrefs.autoFallback) {
                setSubtitleStatus('pending');
                setSubtitleMessage('Starting WhisperLive transcription...');
                setSubtitleAssist({
                  status: 'pending',
                  message: 'Starting WhisperLive transcription...',
                  progress: 0,
                });
                activeWhisperSessionIdRef.current = subtitleJobId;
                setWhisperProcessedSeconds(await getWhisperStartSeconds());
                await startWhisperPipelineWithRecovery(subtitleJobId);
                if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                  return;
                }
                setSubtitleStatus('generated');
                setSubtitleMessage('WhisperLive subtitles ready');
                setSubtitleAssist({
                  status: 'ready',
                  message: 'WhisperLive subtitles ready',
                  progress: 100,
                });
                return;
              }

              setSubtitleStatus('disabled');
              setSubtitleMessage('No subtitles available');
              setSubtitleAssist({
                status: 'disabled',
                message: 'No subtitles available',
                progress: 0,
              });
            } catch (error) {
              if (!disposedRef.current && subtitleJobId === subtitleJobRef.current) {
                console.error('%c[Subtitles]%c Failed to prepare subtitles:', 'color: #4ade80; font-weight: bold', 'color: inherit', error);
                const message = error instanceof Error ? error.message : String(error);
                setSubtitleStatus('error');
                setSubtitleMessage(message || 'Subtitle fallback failed');
                setSubtitleAssist({
                  status: 'error',
                  message: message || 'Subtitle fallback failed',
                  progress: 0,
                });
              }
            }
          };

          restartSubtitlePipelineRef.current = restartSubtitlePipeline;
          await restartSubtitlePipeline();

          interval = setInterval(() => {
            timeRef.current += 1;
            if (showDebugRef.current) {
              setStats(prev => ({ ...prev, timeConnected: timeRef.current }));
            }
          }, 1000);

          return;
        }

        readyUnlisten = await window.electronAPI.torrent.onReady(async ({ session_id, files }) => {
          if (disposed) return;
          if (activeStartupSessionRef.current && session_id !== activeStartupSessionRef.current) return;
          activeStartupSessionRef.current = session_id;

          const latestContinueWatching = continueWatchingRef.current;
          const selectedMetaContinueWatchingId = selectedMeta
            ? `${selectedMeta.type === 'series' ? 'tv' : 'movie'}:${selectedMeta.id.split(':')[1]}`
            : null;
          const continueWatchingItem = selectedMeta && !selectedStream.startOver
            ? latestContinueWatching.find(
                (c) => c.metaId === selectedMeta.id || c.metaId === selectedMetaContinueWatchingId
              ) 
            : null;
          
          const storedResumeSourceMeta = !selectedStream.startOver
            ? getStoredResumeSourceMeta(selectedMeta)
            : null;
          const { targetSeason, targetEpisode, resumeSourceFilename } = resolvePlaybackTarget(
            selectedStream,
            continueWatchingItem,
            storedResumeSourceMeta,
          );
          
          const videoFiles = files.filter(f => /\.(mp4|mkv|avi|mov|webm)$/i.test(f.name));
          const sortedVideoFileNames = sortEpisodes(filterVideoFiles(videoFiles.map(f => f.name)));
          const sortedVideoFiles = sortedVideoFileNames
            .map((name) => videoFiles.find((file) => file.name === name))
            .filter((file): file is typeof videoFiles[number] => Boolean(file));

          let videoFile;
          videoFile = selectVideoFileForResumeTarget(
            sortedVideoFiles,
            targetSeason,
            targetEpisode,
            targetSeason ?? 1,
            resumeSourceFilename
          );
          if (!videoFile && targetSeason && targetEpisode) {
            videoFile = sortedVideoFiles.find(f => f.name.toLowerCase().includes(`season ${targetSeason}`) && f.name.toLowerCase().includes(`episode ${targetEpisode}`));
          }
          
          if (!videoFile) {
            videoFile = sortedVideoFiles.length > 1
              ? sortedVideoFiles[0]
              : videoFiles.sort((a, b) => b.size - a.size)[0];
          }

          if (!videoFile) {
            console.error('%c[Stream]%c No playable video file found in the remote source', 'color: #4ade80; font-weight: bold', 'color: inherit');
            setIsLoading(false);
            return;
          }
          const displayFileName = getPathBaseName(videoFile.name);

          const isPlaylist = videoFiles.length > 1;
          
          console.log(`%c[Playlist]%c Files found: ${files.length}, Video files: ${videoFiles.length}, Is playlist: ${isPlaylist}`, 'color: #ff6b35; font-weight: bold', 'color: inherit');

          if (streamOpenedRef.current) {
            return;
          }
          streamOpenedRef.current = true;

          try {
            const getPlaylistStreamUrl = async (index: number) => {
              return window.electronAPI.torrent.getStreamUrl(index);
            };

            let playlistFiles: { name: string; index: number }[] = [];
            if (isPlaylist) {
              const allPlaylistFiles = sortedVideoFileNames.map(name => {
                const f = files.find(file => file.name === name);
                return { name: f?.name ?? name, index: f?.index ?? 0 };
              });
              const targetPlaylistIndex = Math.max(
                0,
                allPlaylistFiles.findIndex((file) => file.name === videoFile.name)
              );
              playlistFiles = allPlaylistFiles.slice(targetPlaylistIndex);

              console.log(`%c[Playlist]%c Sorted episodes:`, 'color: #ff6b35; font-weight: bold', 'color: inherit', sortedVideoFileNames);
              console.log(`%c[Playlist]%c Started playlist with ${playlistFiles.length} queued episodes from index ${targetPlaylistIndex}`, 'color: #ff6b35; font-weight: bold', 'color: inherit');
              
              const currentEp = extractEpisodeNumber(videoFile.name, targetSeason ?? 1);
              if (currentEp) {
                console.log(`%c[Playlist]%c Starting at episode ${currentEp.season}x${currentEp.episode} (playlist index 0)`, 'color: #ff6b35; font-weight: bold', 'color: inherit');
              }
            } else {
              console.log(`%c[Stream]%c Single file mode: ${videoFile.name}`, 'color: #4ade80; font-weight: bold', 'color: inherit');
            }

            {
              const store = useStore.getState();
              if (!isPlaylist) {
                setPlaybackIdentityForFiles(
                  store,
                  [{ name: displayFileName, index: videoFile.index ?? 0 }],
                  targetSeason ?? 1,
                  targetSeason,
                  targetEpisode,
                );
                const identity = store.playbackIdentityItems[0];
                store.setPlaylistEpisodeInfo(
                  typeof identity?.season === 'number' && typeof identity.episode === 'number'
                    ? { season: identity.season, episode: identity.episode, title: identity.title }
                    : null
                );
              }
            }

            const bounds = await getMpvDebugBounds();
            setMpvDebugBounds(bounds);

            const position = {
              x: bounds.appX + bounds.offsetX,
              y: bounds.appY + bounds.offsetY,
              width: bounds.width,
              height: bounds.height
            };

            const resumeItem = getStreamResumeItem(selectedStream, continueWatchingItem);
            const startPosition = getResumeStartPosition(resumeItem, targetSeason, targetEpisode);
            const mpvLaunchSettings = await getMpvLaunchSettings(selectedMeta?.originalLanguage);
            let launch;
            let existingMpvPid = prelaunchedMpvPid ?? mpvPidRef.current;
            if (existingMpvPid == null && prelaunchMpvPromise) {
              existingMpvPid = await prelaunchMpvPromise;
            }
            if (existingMpvPid != null) {
              try {
                launch = await window.electronAPI.prepareAndLoadStream(
                  videoFile.index ?? 0,
                  existingMpvPid,
                  startPosition,
                  displayFileName,
                  mpvLaunchSettings.cacheWholeFileEnabled,
                );
                if (prelaunchedMpvPid === existingMpvPid) {
                  prelaunchedMpvLoaded = true;
                  prelaunchedMpvPid = null;
                }
              } catch (loadError) {
                console.warn('[Stream] Failed to load stream into prelaunched MPV, falling back to direct launch:', loadError);
                prelaunchedMpvPid = null;
                await window.electronAPI.stopMpvProcess(existingMpvPid).catch(() => {});
                setCurrentMpvPid(null);
              }
            }

            if (!launch) {
              if (!isCurrentPlaybackLaunch()) {
                return;
              }
              launch = await window.electronAPI.prepareAndOpenStream(
                videoFile.index ?? 0,
                position,
                startPosition,
                displayFileName,
                mpvLaunchSettings.upscaler,
                mpvLaunchSettings.seekPreviewEnabled,
                mpvLaunchSettings.forceStereoEnabled,
                mpvLaunchSettings.rtxHdrEnabled,
                mpvLaunchSettings.hdrContrastBoostEnabled,
                mpvLaunchSettings.cacheWholeFileEnabled,
                mpvLaunchSettings.preferredSubtitleLanguage,
                mpvLaunchSettings.preferredAudioLanguage,
                mpvLaunchSettings.preferSdhSubtitles,
              );
            }
            introSkipperCurrentUrlRef.current = launch.file_url;
            restartWhisperPipeline = async (subtitleJobId: number) => {
              const startSeconds = await getWhisperStartSeconds();
              const whisperUrl = await window.electronAPI.torrent.getWhisperStreamUrl(videoFile.index ?? 0).catch(() => null);
              console.log('[WhisperLive] Launching Whisper transcription session', {
                subtitleJobId,
                startSeconds,
                whisperUrl,
                videoFile: videoFile.name,
              });
              if (!whisperUrl) {
                throw new Error('Could not obtain Whisper stream URL');
              }
              await transcribeWithWhisperLive(videoFile, whisperUrl, disposedRef, subtitleJobId, startSeconds, 'webtorrent');
            };
            if (activeStartupSessionRef.current && launch.session_id !== activeStartupSessionRef.current) {
              return;
            }
            activeStartupSessionRef.current = launch.session_id;
            if (!setCurrentMpvPid(launch.pid)) {
              await window.electronAPI.stopMpvProcess(launch.pid).catch(() => {});
              return;
            }

            if (!playerObservingStarted.current) {
              playerObservingStarted.current = true;
              window.electronAPI.startPlayerObserving().catch(e => 
                console.error('%c[Stream]%c Failed to start player observing:', 'color: #4ade80; font-weight: bold', 'color: inherit', e)
              );
            }

            if (isPlaylist) {
              const rendererFiles = await Promise.all(playlistFiles.map(async (file, index) => ({
                name: getPathBaseName(file.name),
                index,
                ready: true,
                streamUrl: index === 0 ? launch.file_url : await getPlaylistStreamUrl(file.index),
              })));
              void appendVerifiedMpvPlaylist(
                rendererFiles[0],
                rendererFiles.slice(1),
                'Remote source',
                targetSeason,
                targetEpisode,
              );
            }

            if (selectedMeta) {
              const tmdbId = parseInt(selectedMeta.id.split(':')[1], 10);
              const parsedEpisode = selectedMeta.type === 'series'
                ? extractEpisodeNumber(videoFile.name, targetSeason ?? 1)
                : null;
              setCurrentPlayingMeta({
                type: selectedMeta.type,
                tmdbId,
                name: selectedMeta.name,
                poster: selectedMeta.poster,
                imdbId: selectedMeta.imdbId,
                season: parsedEpisode?.season ?? targetSeason,
                episode: parsedEpisode?.episode ?? targetEpisode
              });
              const store = useStore.getState();
              store.setCurrentPlayingTitle(displayFileName);
              syncPlaylistTitle(displayFileName);
            }

            torrentStartedRef.current = true;
            setIsLoading(false);
            setStartupError(null);
            setStats(prev => ({
              ...prev,
              file: { name: displayFileName, size: videoFile.size },
              streamUrl: launch.file_url
            }));

            restartSubtitlePipeline = async () => {
              const subtitleJobId = ++subtitleJobRef.current;
              const subtitlePrefs = readSubtitlePreferences(selectedMeta?.originalLanguage);
              console.log('[WhisperLive] restartSubtitlePipeline invoked', {
                subtitleJobId,
                currentSessionId: activeWhisperSessionIdRef.current,
                alwaysUseWhisper: subtitlePrefs.alwaysUseWhisper,
                autoFallback: subtitlePrefs.autoFallback,
              });

              try {
                if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                  console.log('[WhisperLive] restartSubtitlePipeline aborted before start', {
                    subtitleJobId,
                    disposed: disposedRef.current,
                    currentJobId: subtitleJobRef.current,
                  });
                  return;
                }

                if (subtitlePrefs.alwaysUseWhisper) {
                  console.log('[WhisperLive] Always-use mode enabled, starting transcription');
                  setSubtitleStatus('pending');
                  setSubtitleMessage('Starting WhisperLive transcription...');
                  setSubtitleAssist({
                    status: 'pending',
                    message: 'Starting WhisperLive transcription...',
                    progress: 0,
                  });
                  activeWhisperSessionIdRef.current = subtitleJobId;
                  setWhisperProcessedSeconds(await getWhisperStartSeconds());
                  await startWhisperPipelineWithRecovery(subtitleJobId);
                  if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                    console.log('[WhisperLive] Always-use transcription cancelled after launch', {
                      subtitleJobId,
                      disposed: disposedRef.current,
                      currentJobId: subtitleJobRef.current,
                    });
                    return;
                  }
                  console.log('[WhisperLive] Transcription completed');
                  setSubtitleStatus('generated');
                  setSubtitleMessage('WhisperLive subtitles ready');
                  setSubtitleAssist({
                    status: 'ready',
                    message: 'WhisperLive subtitles ready',
                    progress: 100,
                  });
                  return;
                }

                const { tracks, settled } = await waitForSubtitleTracks(disposedRef);
                if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                  return;
                }

                const subtitleTracks = tracks.filter((track) => track.type === 'sub' && !isLiveWhisperSubtitleTrack(track));
                if (subtitleTracks.length > 0) {
                  const selectedTrack = selectPreferredSubtitleTrack(subtitleTracks, subtitlePrefs);
                  console.log('[Whisper] Embedded subtitles detected:', subtitleTracks);
                  setSubtitleStatus('embedded');
                  setSubtitleMessage(selectedTrack.title ? `Using embedded subtitles: ${selectedTrack.title}` : 'Using embedded subtitles');
                  setSubtitleAssist({
                    status: 'embedded',
                    message: selectedTrack.title ? `Using embedded subtitles: ${selectedTrack.title}` : 'Using embedded subtitles',
                    progress: 100,
                  });
                  if (!selectedTrack.selected) {
                    await window.electronAPI.player.setTrack('sub', selectedTrack.id);
                  }
                  return;
                }

                if (!settled) {
                  console.warn('[WhisperLive] MPV tracks never settled, skipping auto transcription to avoid false fallback:', tracks);
                  setSubtitleStatus('disabled');
                  setSubtitleMessage('Waiting for subtitle tracks...');
                  setSubtitleAssist({
                    status: 'disabled',
                    message: 'Waiting for subtitle tracks...',
                    progress: 0,
                  });
                  return;
                }

                if (subtitlePrefs.autoFallback) {
                  console.log('[WhisperLive] No embedded subtitles found, starting transcription fallback');
                  setSubtitleStatus('pending');
                  setSubtitleMessage('Starting WhisperLive transcription...');
                  setSubtitleAssist({
                    status: 'pending',
                    message: 'Starting WhisperLive transcription...',
                    progress: 0,
                  });
                  activeWhisperSessionIdRef.current = subtitleJobId;
                  setWhisperProcessedSeconds(await getWhisperStartSeconds());
                  await startWhisperPipelineWithRecovery(subtitleJobId);
                  if (disposedRef.current || subtitleJobId !== subtitleJobRef.current) {
                    console.log('[WhisperLive] Fallback transcription cancelled after launch', {
                      subtitleJobId,
                      disposed: disposedRef.current,
                      currentJobId: subtitleJobRef.current,
                    });
                    return;
                  }
                  console.log('[WhisperLive] Transcription completed');
                  setSubtitleStatus('generated');
                  setSubtitleMessage('WhisperLive subtitles ready');
                  setSubtitleAssist({
                    status: 'ready',
                    message: 'WhisperLive subtitles ready',
                    progress: 100,
                  });
                  return;
                }

                console.log('[Whisper] No subtitles available and fallback disabled');
                setSubtitleStatus('disabled');
                setSubtitleMessage('No subtitles available');
                setSubtitleAssist({
                  status: 'disabled',
                  message: 'No subtitles available',
                  progress: 0,
                });
              } catch (error) {
                if (!disposedRef.current && subtitleJobId === subtitleJobRef.current) {
                  console.error('%c[Subtitles]%c Failed to prepare subtitles:', 'color: #4ade80; font-weight: bold', 'color: inherit', error);
                  const message = error instanceof Error ? error.message : String(error);
                  setSubtitleStatus('error');
                  setSubtitleMessage(message || 'Subtitle fallback failed');
                  setSubtitleAssist({
                    status: 'error',
                    message: message || 'Subtitle fallback failed',
                    progress: 0,
                  });
                }
              }
            };

            restartSubtitlePipelineRef.current = restartSubtitlePipeline;
            await restartSubtitlePipeline();
          } catch (e) {
            console.error('%c[Stream]%c Failed to prepare or launch stream:', 'color: #4ade80; font-weight: bold', 'color: inherit', e);
            setStartupError(e instanceof Error ? e.message : String(e));
            setIsLoading(false);
            streamOpenedRef.current = false;
          }
        });

        progressUnlisten = await window.electronAPI.torrent.onProgress((progress) => {
          if (disposed) return;
          if (activeStartupSessionRef.current && progress.session_id !== activeStartupSessionRef.current) return;
          activeStartupSessionRef.current = progress.session_id;

          const remaining = progress.download_speed > 0
            ? (progress.total - progress.downloaded) / progress.download_speed
            : 0;

          if (showDebugRef.current) {
            setStats(prev => ({
              ...prev,
              status: progress.status,
              timeConnected: timeRef.current,
              downloadedTotal: progress.downloaded,
              total: progress.total,
              downloadSpeed: progress.download_speed,
              progress: progress.progress,
              remainingTime: Math.ceil(remaining),
              pieces: { ready: progress.downloaded_pieces || 0, total: progress.pieces || 0 },
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
            }));
            setPieceBitfield(progress.bitfield || []);
          }
          
      setDownloadStats({
        status: progress.status === 'downloading' ? 'downloading' :
               progress.status === 'seeding' ? 'seeding' :
                   progress.status === 'done' ? 'complete' : 'idle',
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
            torrentName: selectedStream?.torrent.title || '',
            pieces: { ready: progress.downloaded_pieces || 0, total: progress.pieces || 0 },
            bitfield: progress.bitfield || []
          });
        });

        setStartupState({
          session_id: 0,
          attempt: 0,
          phase: 'starting_sidecar',
          message: 'Starting remote source session...',
        });
        setStartupError(null);

        if (!selectedStream.sourceType || selectedStream.sourceType === 'webtorrent') {
          prelaunchMpvPromise = (async () => {
            const bounds = await getMpvDebugBounds();
            setMpvDebugBounds(bounds);

            const position = {
              x: bounds.appX + bounds.offsetX,
              y: bounds.appY + bounds.offsetY,
              width: bounds.width,
              height: bounds.height,
            };

            const mpvLaunchSettings = await getMpvLaunchSettings(selectedMeta?.originalLanguage);
            if (mpvLaunchSettings.autoHdrEnabled) {
              return null;
            }

            const prelaunch = await window.electronAPI.prelaunchMpv(
              position,
              selectedStream.title,
              mpvLaunchSettings.upscaler,
              mpvLaunchSettings.seekPreviewEnabled,
              mpvLaunchSettings.forceStereoEnabled,
              mpvLaunchSettings.rtxHdrEnabled,
              mpvLaunchSettings.hdrContrastBoostEnabled,
              mpvLaunchSettings.cacheWholeFileEnabled,
              mpvLaunchSettings.preferredSubtitleLanguage,
              mpvLaunchSettings.preferredAudioLanguage,
              mpvLaunchSettings.preferSdhSubtitles,
            );

            if (!isCurrentPlaybackLaunch()) {
              await window.electronAPI.stopMpvProcess(prelaunch.pid).catch(() => {});
              return null;
            }

            prelaunchedMpvPid = prelaunch.pid;
            setCurrentMpvPid(prelaunch.pid);
            return prelaunch.pid;
          })().catch((error) => {
            console.warn('[Stream] MPV prelaunch failed, falling back to launch-on-ready:', error);
            prelaunchedMpvPid = null;
            setCurrentMpvPid(null);
            return null;
          });
        }

        await window.electronAPI.torrent.add(selectedStream.url, selectedStream.torrent.size);

        interval = setInterval(() => {
          timeRef.current += 1;
          if (showDebugRef.current) {
            setStats(prev => ({ ...prev, timeConnected: timeRef.current }));
          }
        }, 1000);

      } catch (e) {
        setSmartNextTransitionActive(false);
        console.error('%c[Stream]%c Failed to start remote source:', 'color: #4ade80; font-weight: bold', 'color: inherit', e);
        initInProgress.current = false;
        streamOpenedRef.current = false;
        const message = e instanceof Error ? e.message : String(e);
        if (selectedStream.sourceType === 'addon') {
          if (!addonFailureHandled) {
            await handleAddonStartupFailure(message);
          }
          return;
        }
        if (addonProxySessionId) {
          const failedSessionId = addonProxySessionId;
          addonProxySessionId = null;
          if (useStore.getState().addonTransferSessionId === failedSessionId) {
            useStore.getState().setAddonTransferSessionId(null);
          }
          await window.electronAPI.releaseAddonStream(failedSessionId).catch(() => {});
        }
        if (prelaunchedMpvPid != null && !prelaunchedMpvLoaded) {
          await window.electronAPI.stopMpvProcess(prelaunchedMpvPid).catch(() => {});
          prelaunchedMpvPid = null;
          setCurrentMpvPid(null);
        } else if (prelaunchMpvPromise) {
          void prelaunchMpvPromise.then(async (pid) => {
            if (pid != null && !prelaunchedMpvLoaded) {
              await window.electronAPI.stopMpvProcess(pid).catch(() => {});
            }
          });
        }
        if (!isCurrentPlaybackLaunch()) {
          return;
        }
        if (selectedStream.sourceType === 'qbittorrent') {
          scheduleQbitRetry(message || 'Waiting for the external playback service to become ready.');
          return;
        }
        setStartupError(message);
        setIsLoading(false);
      }
    };

    startPlayback();

    return () => {
      disposed = true;
      disposedRef.current = true;
      const streamStillSelected = !!useStore.getState().selectedStream;
      const pendingSmartNextWarmup = smartNextPreparationRef.current?.result?.warmup;
      const preserveSmartNextWarmup = smartNextTransitionRef.current
        && smartNextWarmupHandoffRef.current === pendingSmartNextWarmup;
      if (!preserveSmartNextWarmup) {
        void window.electronAPI.cancelSmartNextWarmup().catch(() => {});
        if (pendingSmartNextWarmup?.addonSessionId) {
          void window.electronAPI
            .releaseAddonStream(pendingSmartNextWarmup.addonSessionId)
            .catch((error) => {
              console.warn('[Smart Next Autoload] Failed to release unused remote-stream warmup:', error);
            });
        }
        smartNextWarmupHandoffRef.current = null;
        smartNextPreparationRef.current = null;
      }
      if (addonProxySessionId) {
        const releasedSessionId = addonProxySessionId;
        addonProxySessionId = null;
        if (useStore.getState().addonTransferSessionId === releasedSessionId) {
          useStore.getState().setAddonTransferSessionId(null);
        }
        void window.electronAPI.releaseAddonStream(releasedSessionId).catch((error) => {
          console.warn('[Remote Stream] Failed to clean up playback proxy:', error);
        });
      }
      clearInterval(interval);
      for (const lookup of introSkipperLookups.values()) {
        if (lookup.retryTimer != null) {
          window.clearTimeout(lookup.retryTimer);
        }
      }
      introSkipperLookups.clear();
      cancelSegmentBoundaryTimer('player-effect-cleanup');
      for (const lookup of introSkipperOutroLookups.values()) {
        if (lookup.retryTimer != null) {
          window.clearTimeout(lookup.retryTimer);
        }
      }
      introSkipperOutroLookups.clear();
      for (const run of segmentDetectionRuns.values()) {
        run.pending = null;
      }
      if (segmentDetectionHandlerRef.current === ownedSegmentDetectionHandler) {
        segmentDetectionHandlerRef.current = null;
      }
      clearMediaTitleRetries();
      clearQbitRetry();
      if (prelaunchedMpvPid != null && !prelaunchedMpvLoaded) {
        void window.electronAPI.stopMpvProcess(prelaunchedMpvPid).catch(() => {});
      }
      playbackLaunchIdRef.current += 1;
      mpvPidRef.current = null;
      readyUnlisten?.();
      startupStateUnlisten?.();
      progressUnlisten?.();
      subtitleProgressUnlisten?.();
      subtitleSegmentUnlisten?.();
      addonStreamErrorUnlisten?.();
      playerProgressUnlisten?.();
      playerPauseUnlisten?.();
      playerPlayUnlisten?.();
      playerStopUnlisten?.();
      playerSeekUnlisten?.();
      playerPlaylistChangedUnlisten?.();
      playerSmartNextUnlisten?.();
      playerAudioTrackChangedUnlisten?.();
      playerClosedUnlisten?.();
      playerEofUnlisten?.();
      playerReconnectedUnlisten?.();
      playerHdrRestartUnlisten?.();
      initInProgress.current = false;
      activeStartupSessionRef.current = null;
      playerObservingStarted.current = false;
      subtitleJobRef.current += 1;
      whisperSeekRestartTokenRef.current += 1;
      if (whisperSeekRestartTimeoutRef.current != null) {
        window.clearTimeout(whisperSeekRestartTimeoutRef.current);
        whisperSeekRestartTimeoutRef.current = null;
      }
      if (!streamStillSelected) {
        smartNextTransitionRef.current = false;
        smartNextWindowRestoreRef.current = null;
        smartNextWindowRestoreInFlightRef.current = false;
        useStore.getState().setPlaybackTransitionActive(false);
        smartNextPendingPersistenceRef.current = null;
        void window.electronAPI.player.setSmartNextAvailable(false).catch(() => {});
        restartSubtitlePipeline = null;
        restartSubtitlePipelineRef.current = null;
        setRetryWhisperAction(null);
        setRetryAudioNormalizerAction(null);
      }
      lastKnownPlaybackTimeRef.current = 0;
      lastKnownAtRef.current = 0;
      playbackPausedRef.current = false;
      if (!streamStillSelected) {
        setSubtitleStatus('disabled');
        setSubtitleMessage('Subtitles disabled');
        clearSubtitleAssist();
        setWhisperProcessedSeconds(null);
        setCurrentPlayingMeta(null);
        setAudioNormalizerReason('no_data');
        cleanupPlaylist();
      }
    };
      setStartupState(null);
      setStartupError(null);
  }, [selectedStream, selectedMeta, setDownloadStats, startupNonce]);

  const handleBack = async () => {
    if (selectedStream) {
      flushCurrentPlayingProgress();
      if (!selectedStream.sourceType || selectedStream.sourceType === 'webtorrent') {
        await window.electronAPI.torrent.remove();
        await window.electronAPI.player.stop().catch(() => {});
      }
      resetDownloadStats();
    }
    clearQbitRetry();
    setMpvPid(null);
    mpvPidRef.current = null;
    exitToMetaDetails();
  };

  const handleRetryStartup = async () => {
    if (!selectedStream?.sourceType || selectedStream.sourceType === 'webtorrent') {
      try {
        await window.electronAPI.torrent.remove();
        await window.electronAPI.player.stop().catch(() => {});
      } catch (error) {
        console.warn('[Player] Failed to stop the existing remote source before retry:', error);
      }
    }

    activeStartupSessionRef.current = null;
    initInProgress.current = false;
    streamOpenedRef.current = false;
    torrentStartedRef.current = false;
    playerObservingStarted.current = false;
    clearQbitRetry();
    setMpvPid(null);
    mpvPidRef.current = null;
    setStartupError(null);
    setIsLoading(true);
    resetDownloadStats();
    setStartupNonce((current) => current + 1);
  };

  if (!selectedStream) {
    return (
      <div className="player">
        <p>No stream selected</p>
      </div>
    );
  }

  return (
    <div className="player" ref={containerRef}>
      <button className="player-back" onClick={handleBack}>
        <FiArrowLeft />
      </button>
      {subtitleStatus !== 'disabled' && (
        <div className={`player-subtitle-pill player-subtitle-${subtitleStatus}`}>
          <FiFileText />
          <span>{subtitleMessage}</span>
        </div>
      )}

      {isLoading && (
        <div className="player-loading">
          <div className="player-spinner" />
          <p>{startupState?.message || 'Loading...'}</p>
          {startupState && (
            <span className="player-loading-detail">
              {startupState.phase.replace(/_/g, ' ')}
              {startupState.attempt > 0 ? ` • attempt ${startupState.attempt}` : ''}
            </span>
          )}
          {startupError && (
            <button className="player-retry-button" onClick={() => void handleRetryStartup()} type="button">
              Retry Startup
            </button>
          )}
        </div>
      )}

      {!isLoading && startupError && (
        <div className="player-loading player-loading-failed">
          <p>{startupError}</p>
          <button className="player-retry-button" onClick={() => void handleRetryStartup()} type="button">
            Retry Startup
          </button>
        </div>
      )}

      {showDebug && (
        <div className="player-debug">
          <div className="debug-header">
            <span><FiActivity /> Debug Info</span>
          </div>
          <div className="debug-content">
            <div className="debug-row">
              <span className="debug-label">Status:</span>
              <span className={`debug-value debug-status-${stats.status.toLowerCase()}`}>{stats.status}</span>
            </div>
            <div className="debug-row">
              <span className="debug-label">Time:</span>
              <span className="debug-value">{formatTime(stats.timeConnected)}</span>
            </div>
            <div className="debug-section">
              <span className="debug-label">Speed:</span>
              <div className="debug-speeds">
                <span className="debug-value debug-download">↓ {formatSpeed(stats.downloadSpeed)}</span>
                <span className="debug-value debug-upload">↑ {formatSpeed(stats.uploadSpeed)}</span>
              </div>
            </div>
            <div className="debug-section">
              <span className="debug-label">Total:</span>
              <div className="debug-totals">
                <span className="debug-value">↓ {formatSize(stats.downloadedTotal)}</span>
                <span className="debug-value">↑ {formatSize(stats.uploadedTotal)}</span>
              </div>
            </div>
            <div className="debug-row">
              <span className="debug-label">Progress:</span>
              <span className="debug-value">{stats.progress.toFixed(1)}%</span>
            </div>
            {stats.downloadSpeed > 0 && stats.progress < 100 && (
              <div className="debug-row">
                <span className="debug-label">Remaining:</span>
                <span className="debug-value">{formatTime(stats.remainingTime)}</span>
              </div>
            )}
            <div className="debug-row">
              <span className="debug-label">Pieces:</span>
              <span className="debug-value">{stats.pieces.ready} / {stats.pieces.total}</span>
            </div>
            {stats.pieces.total > 0 && (
              <div className="piece-visualizer">
                {Array.from({ length: 200 }).map((_, i) => {
                  const piecesPerBlock = Math.ceil(stats.pieces.total / 200);
                  const startPiece = i * piecesPerBlock;
                  const endPiece = Math.min(startPiece + piecesPerBlock, stats.pieces.total);
                  let downloadedInBlock = 0;
                  for (let p = startPiece; p < endPiece; p++) {
                    if (pieceBitfield.length > 0 && isPieceDone(pieceBitfield, p)) {
                      downloadedInBlock++;
                    }
                  }
                  const percent = piecesPerBlock > 0 ? (downloadedInBlock / piecesPerBlock) * 100 : 0;
                  let className = 'piece-block piece-pending';
                  if (percent === 100) className = 'piece-block piece-downloaded';
                  else if (percent > 0) className = 'piece-block piece-partial';
                  return (
                    <div 
                      key={i} 
                      className={className}
                      title={`Pieces ${startPiece + 1}-${endPiece}: ${downloadedInBlock}/${piecesPerBlock} (${percent.toFixed(0)}%)`}
                    />
                  );
                })}
              </div>
            )}
            <div className="piece-toggle">
              <label>
                <input 
                  type="checkbox" 
                  checked={showDetailedPieces}
                  onChange={(e) => setShowDetailedPieces(e.target.checked)}
                />
                Show detailed piece view
              </label>
            </div>
            {showDetailedPieces && stats.pieces.total > 0 && pieceBitfield.length > 0 && (
              <div className="piece-canvas-container">
                <canvas 
                  ref={pieceCanvasRef}
                  className="piece-canvas"
                />
              </div>
            )}
            <div className="debug-section">
              <span className="debug-label">Connections:</span>
              <div className="debug-peers">
                <span className="debug-value">Connected: {stats.peers.connected}</span>
                <span className="debug-value">Discovered: {stats.trackerPeers.total}</span>
                <span className="debug-value debug-seeds">Available: {stats.trackerPeers.seeders}</span>
                <span className="debug-value debug-leechs">Receiving: {stats.trackerPeers.leechers}</span>
              </div>
            </div>
            {stats.file && (
              <div className="debug-row">
                <span className="debug-label">File:</span>
                <span className="debug-value debug-file" title={stats.file.name}>{stats.file.name.slice(0, 40)}{stats.file.name.length > 40 ? '...' : ''} ({formatSize(stats.file.size)})</span>
              </div>
            )}
            {stats.streamUrl && (
              <div className="debug-row">
                <span className="debug-label">Stream:</span>
                <span className="debug-value debug-file" title={stats.streamUrl}>{stats.streamUrl}</span>
              </div>
            )}
            {mpvDebugBounds && (
              <>
                <div className="debug-row">
                  <span className="debug-label">Target Offset:</span>
                  <span className="debug-value">{mpvDebugBounds.offsetX}, {mpvDebugBounds.offsetY}</span>
                </div>
                <div className="debug-row">
                  <span className="debug-label">Target Size:</span>
                  <span className="debug-value">{mpvDebugBounds.width} x {mpvDebugBounds.height}</span>
                </div>
                {mpvActualBounds && (
                  <>
                    <div className="debug-row">
                      <span className="debug-label">MPV Offset:</span>
                      <span className="debug-value">{mpvActualBounds.offsetX}, {mpvActualBounds.offsetY}</span>
                    </div>
                    <div className="debug-row">
                      <span className="debug-label">MPV Size:</span>
                      <span className="debug-value">{mpvActualBounds.width} x {mpvActualBounds.height}</span>
                    </div>
                    <div className="debug-row">
                      <span className="debug-label">MPV Window:</span>
                      <span className="debug-value">{mpvActualBounds.x}, {mpvActualBounds.y}</span>
                    </div>
                  </>
                )}
                <div className="debug-row">
                  <span className="debug-label">App Window:</span>
                  <span className="debug-value">{mpvDebugBounds.appWidth} x {mpvDebugBounds.appHeight} @ {mpvDebugBounds.appX}, {mpvDebugBounds.appY}</span>
                </div>
              </>
            )}
            <div className="debug-peers-list-toggle" onClick={() => setShowPeerList(!showPeerList)}>
              {showPeerList ? <FiChevronUp /> : <FiChevronDown />}
              <span>Connection Details ({stats.peerList.length})</span>
            </div>
            {showPeerList && (
              <div className="debug-peers-list">
                {stats.peerList.length === 0 ? (
                  <div className="debug-peer-empty">No active connections</div>
                ) : (
                  stats.peerList.map((peer, idx) => (
                    <div key={idx} className="debug-peer">
                      <span className="debug-peer-ip">{peer.ip}</span>
                      <span className={`debug-peer-protocol ${peer.protocol.toLowerCase()}`}>{peer.protocol}</span>
                    </div>
                  ))
                )}
              </div>
            )}
            <div className="debug-trackers-list-toggle" onClick={() => setShowTrackerList(!showTrackerList)}>
              {showTrackerList ? <FiChevronUp /> : <FiChevronDown />}
              <span>Trackers ({stats.trackers.length})</span>
            </div>
            {showTrackerList && (
              <div className="debug-trackers-list">
                {stats.trackers.length === 0 ? (
                  <div className="debug-peer-empty">No discovery endpoints</div>
                ) : (
                  stats.trackers.map((tracker, idx) => {
                    const url = tracker.url.replace('udp://', '').replace('http://', '').replace('wss://', '').split('/')[0];
                    return (
                      <div key={idx} className="debug-tracker">
                        <span className="debug-tracker-url">{url}</span>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Player;
