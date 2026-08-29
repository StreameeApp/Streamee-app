import type { TorrentResult } from '../store';
import {
  fetchInstalledAddonStreams,
  getEnabledStreamAddons,
  type AddonMediaType,
  type InstalledAddon,
  type InstalledAddonStream,
} from './installed-addons';
export {
  selectAddonResumeResult,
  type AddonResumeIdentity,
} from './addon-resume-selection';

export interface AddonSourceSearchRequest {
  imdbId: string;
  mediaType: AddonMediaType;
  season?: number;
  episode?: number;
  onlyInstallationId?: string;
  skipInstallationIds?: string[];
  signal?: AbortSignal;
  onProgress?: (outcome: AddonSourceSearchOutcome) => void;
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

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  else request.signal?.addEventListener('abort', abortFromCaller, { once: true });

  const results: TorrentResult[] = [];
  const attemptedInstallationIds = addons.map((addon) => addon.installationId);
  const failedInstallations: AddonSourceSearchOutcome['failedInstallations'] = [];
  const currentOutcome = (): AddonSourceSearchOutcome => ({
    results: [...results],
    attemptedInstallationIds: [...attemptedInstallationIds],
    failedInstallations: [...failedInstallations],
    hasCompatibleAddons: true,
  });

  try {
    await Promise.all(addons.map(async (addon) => {
      controller.signal.throwIfAborted();
      try {
        results.push(...await searchAddon(addon, request, contentId, controller.signal));
      } catch (error) {
        controller.signal.throwIfAborted();
        failedInstallations.push({
          installationId: addon.installationId,
          addonName: addon.manifest.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      request.onProgress?.(currentOutcome());
    }));
    return currentOutcome();
  } finally {
    request.signal?.removeEventListener('abort', abortFromCaller);
  }
}
