import type { TorrentResult } from '../store';
import {
  fetchInstalledAddonStreams,
  getEnabledStreamAddons,
  type AddonMediaType,
  type InstalledAddon,
  type InstalledAddonStream,
} from './installed-addons';
import { runPrioritizedFallback } from './prioritized-fallback';

const ADDON_FALLBACK_STAGGER_MS = 800;

export interface AddonSourceSearchRequest {
  imdbId: string;
  mediaType: AddonMediaType;
  season?: number;
  episode?: number;
  onlyInstallationId?: string;
  skipInstallationIds?: string[];
  signal?: AbortSignal;
}

export interface AddonSourceSearchOutcome {
  results: TorrentResult[];
  attemptedInstallationIds: string[];
  failedInstallations: Array<{ installationId: string; addonName: string; message: string }>;
  hasCompatibleAddons: boolean;
}

function buildContentId(request: AddonSourceSearchRequest): string {
  const imdbId = request.imdbId.trim();
  if (!/^tt\d+$/i.test(imdbId)) throw new Error('Installed stream add-ons require an IMDb ID.');
  if (request.mediaType === 'movie') return imdbId;
  if (request.season == null || request.episode == null) {
    throw new Error('Installed stream add-ons require a selected episode.');
  }
  return `${imdbId}:${request.season}:${request.episode}`;
}

function parseQuality(value: string): TorrentResult['quality'] {
  if (/\b(2160p?|4k|uhd)\b/i.test(value)) return '4K';
  if (/\b(1080p?|fhd)\b/i.test(value)) return '1080p';
  if (/\b(720p?|hd)\b/i.test(value)) return '720p';
  if (/\b(480p?|sd)\b/i.test(value)) return '480p';
  return 'unknown';
}

function parseSeeds(value: string): number {
  const match = value.match(/(?:\u{1F464}|seed(?:er)?s?)\s*[:\-]?\s*(\d+)/iu);
  return match ? Number(match[1]) : 0;
}

function parseSize(value: string): number {
  const match = value.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)\b/i);
  if (!match) return 0;
  const multipliers: Record<string, number> = {
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.round(Number(match[1]) * multipliers[match[2].toUpperCase()]);
}

function toTorrentResult(addon: InstalledAddon, stream: InstalledAddonStream): TorrentResult {
  const combined = [stream.title, stream.description, stream.filename].filter(Boolean).join('\n');
  const infoHash = stream.infoHash?.trim() || '';
  const streamHandle = stream.streamHandle?.trim() || undefined;
  const magnetUri = infoHash
    ? `magnet:?xt=urn:btih:${encodeURIComponent(infoHash)}`
    : streamHandle
      ? `streamee-addon://${streamHandle}`
      : '';
  return {
    id: `${addon.installationId}:${stream.id}`,
    title: stream.filename || stream.title,
    infoHash,
    magnetUri,
    size: stream.size || parseSize(combined),
    seeds: parseSeeds(combined),
    peers: 0,
    quality: parseQuality(combined),
    indexer: addon.manifest.name,
    cached: stream.playbackKind === 'http',
    cacheProvider: stream.playbackKind === 'http' ? 'addon' : undefined,
    sourceProvider: 'addon',
    directStreamProvider: streamHandle ? 'addon' : undefined,
    streamHandle,
    streamFilename: stream.filename || stream.title,
    sourceFileIndex: stream.fileIndex,
    addonInstallationId: addon.installationId,
    addonId: addon.addonId,
    addonName: addon.manifest.name,
  };
}

export interface AddonResumeIdentity {
  infoHash?: string;
  fileIndex?: number;
  filename?: string;
  size?: number;
  indexer?: string;
  quality?: TorrentResult['quality'];
}

const normalizeIdentityText = (value?: string): string => value?.trim().toLowerCase() || '';

export function selectAddonResumeResult(
  results: TorrentResult[],
  identity: AddonResumeIdentity,
): TorrentResult | null {
  if (results.length === 0) return null;

  const infoHash = normalizeIdentityText(identity.infoHash);
  const hashMatch = infoHash
    ? results.find((result) => normalizeIdentityText(result.infoHash) === infoHash
      && (identity.fileIndex == null || result.sourceFileIndex === identity.fileIndex))
    : undefined;
  if (hashMatch) return hashMatch;

  const filename = normalizeIdentityText(identity.filename);
  const filenameMatch = filename
    ? results.find((result) => normalizeIdentityText(result.streamFilename || result.title) === filename
      && (identity.size == null || identity.size <= 0 || result.size === identity.size))
    : undefined;
  if (filenameMatch) return filenameMatch;

  const indexer = normalizeIdentityText(identity.indexer);
  return results.find((result) =>
    (!indexer || normalizeIdentityText(result.indexer) === indexer)
    && (identity.size == null || identity.size <= 0 || result.size === identity.size)
    && (!identity.quality || result.quality === identity.quality)
  ) || results[0];
}

async function searchAddon(
  addon: InstalledAddon,
  request: AddonSourceSearchRequest,
  contentId: string,
  signal: AbortSignal,
): Promise<TorrentResult[]> {
  signal.throwIfAborted();
  const streams = await fetchInstalledAddonStreams({
    installationId: addon.installationId,
    mediaType: request.mediaType,
    contentId,
  });
  signal.throwIfAborted();
  return streams
    .filter((stream) => !!stream.streamHandle || !!stream.infoHash)
    .map((stream) => toTorrentResult(addon, stream));
}

export async function searchInstalledStreamAddons(
  request: AddonSourceSearchRequest,
): Promise<AddonSourceSearchOutcome> {
  const contentId = buildContentId(request);
  const skipped = new Set(request.skipInstallationIds || []);
  const addons = getEnabledStreamAddons(request.mediaType, contentId)
    .filter((addon) => !request.onlyInstallationId || addon.installationId === request.onlyInstallationId)
    .filter((addon) => !skipped.has(addon.installationId));
  if (addons.length === 0) {
    return {
      results: [],
      attemptedInstallationIds: [],
      failedInstallations: [],
      hasCompatibleAddons: false,
    };
  }

  const fallback = await runPrioritizedFallback(addons, {
    staggerMs: ADDON_FALLBACK_STAGGER_MS,
    signal: request.signal,
    run: (addon, signal) => searchAddon(addon, request, contentId, signal),
    accepts: (results) => results.length > 0,
  });
  const failedInstallations = fallback.attempts.flatMap((attempt) => {
    if (attempt.error === undefined) return [];
    return [{
      installationId: attempt.item.installationId,
      addonName: attempt.item.manifest.name,
      message: attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
    }];
  });

  return {
    results: fallback.winner?.value || [],
    attemptedInstallationIds: fallback.startedItems.map((addon) => addon.installationId),
    failedInstallations,
    hasCompatibleAddons: true,
  };
}
