import type { IntroDbSegment, IntroDbSegments } from './tauri';

export type IntroDbSegmentType = 'intro' | 'recap' | 'outro';
export type IntroDbSkipMode = 'always-watch' | 'watch-once' | 'always-skip';

export interface IntroDbPlaybackSettings {
  introMode: IntroDbSkipMode;
  recapMode: IntroDbSkipMode;
  autoNextAtOutro: boolean;
  introSkipperEnabled: boolean;
}

export interface ValidatedIntroDbSegment extends IntroDbSegment {
  type: IntroDbSegmentType;
}

export const DEFAULT_INTRODB_PLAYBACK_SETTINGS: IntroDbPlaybackSettings = {
  introMode: 'always-watch',
  recapMode: 'always-watch',
  autoNextAtOutro: false,
  introSkipperEnabled: false,
};

const watchedOnceSegments = new Set<string>();

export function normalizeIntroDbSkipMode(value: unknown): IntroDbSkipMode {
  return value === 'watch-once' || value === 'always-skip' ? value : 'always-watch';
}

export function getIntroDbPlaybackSettings(): IntroDbPlaybackSettings {
  try {
    const stored = JSON.parse(localStorage.getItem('streamee-settings') || '{}') as Record<string, unknown>;
    return {
      introMode: normalizeIntroDbSkipMode(stored.introDbIntroMode),
      recapMode: normalizeIntroDbSkipMode(stored.introDbRecapMode),
      autoNextAtOutro: stored.introDbAutoNextAtOutro === true,
      introSkipperEnabled: stored.introSkipperEnabled === true,
    };
  } catch {
    return DEFAULT_INTRODB_PLAYBACK_SETTINGS;
  }
}

export function introDbWatchOnceKey(imdbId: string, type: 'intro' | 'recap'): string {
  return `${imdbId.toLowerCase()}:${type}`;
}

export function hasWatchedIntroDbSegmentOnce(imdbId: string, type: 'intro' | 'recap'): boolean {
  return watchedOnceSegments.has(introDbWatchOnceKey(imdbId, type));
}

export function rememberWatchedIntroDbSegmentOnce(imdbId: string, type: 'intro' | 'recap'): void {
  watchedOnceSegments.add(introDbWatchOnceKey(imdbId, type));
}

export function shouldAutoSkipIntroDbSegment(
  mode: IntroDbSkipMode,
  imdbId: string,
  type: 'intro' | 'recap',
): boolean {
  if (mode === 'always-skip') return true;
  if (mode === 'watch-once') return hasWatchedIntroDbSegmentOnce(imdbId, type);
  return false;
}

export function validateIntroDbSegment(
  type: IntroDbSegmentType,
  segment: IntroDbSegment | null,
  duration: number,
): ValidatedIntroDbSegment | null {
  if (
    !segment
    || !Number.isFinite(duration)
    || duration <= 0
    || !Number.isFinite(segment.start_sec)
    || !Number.isFinite(segment.end_sec)
    || segment.start_sec < 0
    || segment.end_sec <= segment.start_sec
    || segment.end_sec > duration + 2
  ) {
    return null;
  }

  const segmentDuration = segment.end_sec - segment.start_sec;
  const remoteOutroMinimumDuration = segment.source === 'theintrodb'
    || segment.source === 'introdb'
    ? 4
    : 5;
  const placementIsValid = type === 'intro' && segment.source === 'intro-skipper'
    ? segmentDuration >= 15 && segmentDuration <= 120 && segment.start_sec <= Math.min(13 * 60, duration * 0.5)
    : type === 'outro' && segment.source === 'intro-skipper-outro'
      ? segmentDuration >= 10
        && segmentDuration <= 12 * 60 + 2
        && segment.start_sec >= duration * 0.55
        && segment.end_sec >= duration - 2
    : type === 'intro'
      ? segmentDuration >= 5 && segmentDuration <= 240 && segment.start_sec <= Math.min(30 * 60, duration * 0.5)
    : type === 'recap'
      ? segmentDuration >= 5 && segmentDuration <= 480 && segment.start_sec <= Math.min(20 * 60, duration * 0.4)
      : segmentDuration >= remoteOutroMinimumDuration
        && segmentDuration <= 15 * 60
        && segment.start_sec >= duration * 0.55;

  return placementIsValid ? { ...segment, type } : null;
}

export async function fetchIntroDbSegments(
  imdbId: string | null,
  tmdbId: number,
  season: number,
  episode: number,
  durationSeconds: number,
): Promise<IntroDbSegments | null> {
  return window.electronAPI.introDb.getSegments(
    imdbId,
    tmdbId,
    season,
    episode,
    durationSeconds,
  );
}

export function introSegmentSourceLabel(segment: Pick<IntroDbSegment, 'source'>): string {
  if (segment.source === 'theintrodb') return 'TheIntroDB';
  if (segment.source === 'intro-skipper' || segment.source === 'intro-skipper-outro') return 'Intro Skipper';
  if (segment.source === 'chapter') return 'Chapter';
  return 'IntroDB';
}
