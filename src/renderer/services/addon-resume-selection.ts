import type { TorrentResult } from '../store';

export interface AddonResumeIdentity {
  installationId?: string;
  addonId?: string;
  infoHash?: string;
  fileIndex?: number;
  filename?: string;
  size?: number;
  indexer?: string;
  quality?: TorrentResult['quality'];
}

export interface AddonResumeRouting {
  sourceType: 'webtorrent' | 'qbittorrent' | 'addon' | 'local';
  isTvShow: boolean;
  hasAddonOrigin: boolean;
  storedSeason?: number;
  storedEpisode?: number;
  targetSeason?: number;
  targetEpisode?: number;
}

const normalizeIdentityText = (value?: string): string => value?.trim().toLowerCase() || '';

export function shouldResolveAddonResumeSource(route: AddonResumeRouting): boolean {
  if (route.sourceType === 'addon') return true;
  if (!route.hasAddonOrigin || !route.isTvShow) return false;
  if (route.targetSeason == null || route.targetEpisode == null) return false;
  return route.storedSeason == null
    || route.storedEpisode == null
    || route.targetSeason !== route.storedSeason
    || route.targetEpisode !== route.storedEpisode;
}

export function selectAddonResumeResult(
  results: TorrentResult[],
  identity: AddonResumeIdentity,
): TorrentResult | null {
  if (results.length === 0) return null;

  const installationId = normalizeIdentityText(identity.installationId);
  const addonId = normalizeIdentityText(identity.addonId);
  const originalInstallationResults = results.filter((result) =>
    (!installationId || normalizeIdentityText(result.addonInstallationId) === installationId)
    && (!addonId || normalizeIdentityText(result.addonId) === addonId)
  );
  const resultGroups = originalInstallationResults.length > 0
    ? [originalInstallationResults, results]
    : [results];

  const infoHash = normalizeIdentityText(identity.infoHash);
  if (infoHash) {
    for (const candidates of resultGroups) {
      const hashMatch = candidates.find((result) =>
        normalizeIdentityText(result.infoHash) === infoHash
        && (identity.fileIndex == null || result.sourceFileIndex === identity.fileIndex)
      );
      if (hashMatch) return hashMatch;
    }
  }

  const filename = normalizeIdentityText(identity.filename);
  if (filename) {
    for (const candidates of resultGroups) {
      const filenameMatch = candidates.find((result) =>
        normalizeIdentityText(result.streamFilename || result.title) === filename
        && (identity.size == null || identity.size <= 0 || result.size === identity.size)
      );
      if (filenameMatch) return filenameMatch;
    }
  }

  const indexer = normalizeIdentityText(identity.indexer);
  for (const candidates of resultGroups) {
    const metadataMatch = candidates.find((result) =>
      (!indexer || normalizeIdentityText(result.indexer) === indexer)
      && (identity.size == null || identity.size <= 0 || result.size === identity.size)
      && (!identity.quality || result.quality === identity.quality)
    );
    if (metadataMatch) return metadataMatch;
  }
  return results[0];
}
