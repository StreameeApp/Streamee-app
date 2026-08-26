import type { TorrentResult } from '../store';
import { searchInstalledStreamAddons } from './addon-source-search';
export { deduplicateResults } from './source-deduplication';

export interface SourceSearchRequest {
  imdbId?: string;
  isTvShow: boolean;
  season?: number;
  episode?: number;
  onlyAddonInstallationId?: string;
  signal?: AbortSignal;
  onProgress?: (outcome: SourceSearchOutcome) => void;
}

export interface SourceSearchOutcome {
  results: TorrentResult[];
  attemptedAddons: string[];
  failedAddons: Array<{ installationId: string; addonName: string; message: string }>;
}

export async function searchEnabledSourceProviders(request: SourceSearchRequest): Promise<SourceSearchOutcome> {
  if (!request.imdbId) {
    throw new Error('Installed stream add-ons require an IMDb ID.');
  }
  const toSourceOutcome = (outcome: Awaited<ReturnType<typeof searchInstalledStreamAddons>>): SourceSearchOutcome => ({
    results: outcome.results,
    attemptedAddons: outcome.attemptedInstallationIds,
    failedAddons: outcome.failedInstallations,
  });
  const outcome = await searchInstalledStreamAddons({
    imdbId: request.imdbId,
    mediaType: request.isTvShow ? 'series' : 'movie',
    season: request.season,
    episode: request.episode,
    onlyInstallationId: request.onlyAddonInstallationId,
    signal: request.signal,
    onProgress: (progressiveOutcome) => request.onProgress?.(toSourceOutcome(progressiveOutcome)),
  });
  if (!outcome.hasCompatibleAddons) {
    if (request.onlyAddonInstallationId) {
      throw new Error('The selected stream add-on is not enabled or compatible with this title.');
    }
    throw new Error('No compatible stream add-ons are enabled. Install one in Settings.');
  }

  return toSourceOutcome(outcome);
}
