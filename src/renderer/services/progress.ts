import { ContinueWatchingItem } from '../store';

function clampProgress(progress?: number | null): number | null {
  if (progress === undefined || progress === null || Number.isNaN(progress)) {
    return null;
  }

  return Math.max(0, Math.min(100, progress));
}

export function getContinueWatchingProgress(
  continueWatching: ContinueWatchingItem[],
  metaId: string
): number | null {
  const item = continueWatching.find((entry) => entry.metaId === metaId);
  return clampProgress(item?.progress);
}

export function getContinueWatchingProgressForTmdb(
  continueWatching: ContinueWatchingItem[],
  type: 'movie' | 'series',
  tmdbId: string | number
): number | null {
  const metaId = `${type === 'movie' ? 'movie' : 'tv'}:${tmdbId}`;
  return getContinueWatchingProgress(continueWatching, metaId);
}
