import type { TorrentResult } from '../store';
import { searchInstalledStreamAddons } from './addon-source-search';

export type SourceSearchMode = 'episode' | 'season-pack' | 'all-seasons';

export interface SourceSearchRequest {
  name: string;
  originalName?: string;
  aliases?: string[];
  year?: string | number | null;
  knownSeasonCount?: number | null;
  imdbId?: string;
  isTvShow: boolean;
  mode: SourceSearchMode;
  season?: number;
  episode?: number;
  onlyAddonInstallationId?: string;
  query: string;
  signal?: AbortSignal;
  onProgress?: (outcome: SourceSearchOutcome) => void;
}

export interface SourceSearchOutcome {
  results: TorrentResult[];
  attemptedAddons: string[];
  failedAddons: Array<{ installationId: string; addonName: string; message: string }>;
}

export function deduplicateResults(results: TorrentResult[]): TorrentResult[] {
  const canonicalKey = (result: TorrentResult) => {
    const hash = result.infoHash.trim().toLowerCase();
    if (hash) {
      const streamFileKey = result.directStreamProvider && result.sourceFileIndex != null
        ? `:file:${result.sourceFileIndex}`
        : '';
      return `hash:${hash}${streamFileKey}`;
    }
    if (result.magnetUri) return `source:${result.magnetUri}`;
    return `id:${result.id}`;
  };
  const sourceRank = (result: TorrentResult) => {
    if (result.directStreamProvider && (result.streamUrl || result.streamHandle)) return 3;
    if (result.cached) return 2;
    return 1;
  };
  const preferResult = (candidate: TorrentResult, existing: TorrentResult) => {
    const rankDifference = sourceRank(candidate) - sourceRank(existing);
    if (rankDifference !== 0) return rankDifference > 0;
    if (candidate.peers !== existing.peers) return candidate.peers > existing.peers;
    return candidate.seeds > existing.seeds;
  };

  const bestBySource = new Map<string, TorrentResult>();
  for (const result of results) {
    const key = canonicalKey(result);
    const existing = bestBySource.get(key);
    if (!existing || preferResult(result, existing)) bestBySource.set(key, result);
  }
  return [...bestBySource.values()];
}

export async function searchEnabledSourceProviders(request: SourceSearchRequest): Promise<SourceSearchOutcome> {
  if (!request.imdbId) {
    throw new Error('Installed stream add-ons require an IMDb ID.');
  }
  if (request.isTvShow && request.mode !== 'episode') {
    throw new Error('Installed stream add-ons support individual episodes, not pack searches.');
  }

  const outcome = await searchInstalledStreamAddons({
    imdbId: request.imdbId,
    mediaType: request.isTvShow ? 'series' : 'movie',
    season: request.season,
    episode: request.episode,
    onlyInstallationId: request.onlyAddonInstallationId,
    signal: request.signal,
  });
  if (!outcome.hasCompatibleAddons) {
    if (request.onlyAddonInstallationId) {
      throw new Error('The selected stream add-on is not enabled or compatible with this title.');
    }
    throw new Error('No compatible stream add-ons are enabled. Install one in Settings.');
  }

  const result: SourceSearchOutcome = {
    results: deduplicateResults(outcome.results),
    attemptedAddons: outcome.attemptedInstallationIds,
    failedAddons: outcome.failedInstallations,
  };
  request.onProgress?.(result);
  return result;
}
