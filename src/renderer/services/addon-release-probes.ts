import type { MetaPreview } from '../store';
import {
  addonReleaseProbeItemKey,
  dedupeAddonReleaseProbeItems,
} from './addon-release-probe-utils';
import {
  getEnabledStreamAddons,
  probeInstalledAddonStreams,
  type InstalledAddon,
} from './installed-addons';
import { getTmdbEpisodes, getTmdbSeasons } from './tmdb';
import { resolveTmdbImdbId } from './tmdb-identity';
import {
  getXrelQualityBadgesEnabled,
  getXrelQualitySnapshot,
  mergeAddonReleaseQualityObservations,
  shouldProbeAddonReleaseQuality,
} from './xrel';

const STORAGE_KEY = 'streamee-addon-release-probes-v1';
const SUCCESS_FRESH_MS = 24 * 60 * 60 * 1000;
const EMPTY_FRESH_MS = 12 * 60 * 60 * 1000;
const MIN_PROVIDER_RETRY_MS = 5 * 60 * 1000;
const MAX_PROVIDER_RETRY_MS = 60 * 60 * 1000;
const PROBE_SPACING_MS = 1500;
const MAX_SAVED_ITEMS = 500;

interface SavedItemProbe {
  checkedAt: number;
  found: boolean;
  lastInstallationId?: string;
  attemptedAt?: number;
}

interface SavedProviderFailure {
  failures: number;
  retryAt: number;
}

interface AddonReleaseProbeState {
  version: 1;
  items: Record<string, SavedItemProbe>;
  providers: Record<string, SavedProviderFailure>;
}

interface ResolvedProbeTarget {
  item: MetaPreview & { imdbId: string };
  contentId: string;
  key: string;
  season?: number;
  episode?: number;
}

const pendingItems = new Map<string, MetaPreview>();
const activeItems = new Set<string>();
let workerRunning = false;

function emptyState(): AddonReleaseProbeState {
  return { version: 1, items: {}, providers: {} };
}

function readState(): AddonReleaseProbeState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<AddonReleaseProbeState> | null;
    if (!parsed || parsed.version !== 1 || !parsed.items || !parsed.providers) return emptyState();
    return {
      version: 1,
      items: parsed.items,
      providers: parsed.providers,
    };
  } catch {
    return emptyState();
  }
}

function writeState(state: AddonReleaseProbeState): void {
  try {
    const items = Object.fromEntries(
      Object.entries(state.items)
        .sort(([, left], [, right]) => (
          (right.checkedAt || right.attemptedAt || 0) - (left.checkedAt || left.attemptedAt || 0)
        ))
        .slice(0, MAX_SAVED_ITEMS),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, items }));
  } catch (error) {
    console.warn('[Add-on release probes] Failed to persist probe state:', error);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function numericHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function isFresh(entry: SavedItemProbe | undefined, now = Date.now()): boolean {
  if (!entry?.checkedAt) return false;
  return now - entry.checkedAt < (entry.found ? SUCCESS_FRESH_MS : EMPTY_FRESH_MS);
}

function selectRotatingAddon(
  addons: InstalledAddon[],
  targetKey: string,
  previousInstallationId?: string,
): InstalledAddon {
  const previousIndex = previousInstallationId
    ? addons.findIndex((addon) => addon.installationId === previousInstallationId)
    : -1;
  const index = previousIndex >= 0
    ? (previousIndex + 1) % addons.length
    : numericHash(targetKey) % addons.length;
  return addons[index];
}

function tmdbId(item: MetaPreview): number | null {
  const match = /^(?:tv|movie):(\d+)$/.exec(item.id);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

async function latestAiredEpisode(item: MetaPreview): Promise<{ season: number; episode: number } | null> {
  const id = tmdbId(item);
  if (!id) return null;
  const seasons = (await getTmdbSeasons(id))
    .filter((season) => season.season_number > 0)
    .sort((left, right) => right.season_number - left.season_number);
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  for (const season of seasons) {
    const latest = (await getTmdbEpisodes(id, season.season_number))
      .filter((episode) => {
        if (!episode.air_date) return false;
        const timestamp = Date.parse(`${episode.air_date}T00:00:00`);
        return Number.isFinite(timestamp) && timestamp <= today.getTime();
      })
      .sort((left, right) => right.episode_number - left.episode_number)[0];
    if (latest) return { season: season.season_number, episode: latest.episode_number };
  }
  return null;
}

async function resolveTarget(item: MetaPreview): Promise<ResolvedProbeTarget | null> {
  const imdbId = await resolveTmdbImdbId(item);
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return null;
  if (item.type === 'movie') {
    return {
      item: { ...item, imdbId },
      contentId: imdbId,
      key: `movie:${imdbId}`,
    };
  }
  const latest = await latestAiredEpisode(item);
  if (!latest) return null;
  return {
    item: { ...item, imdbId },
    contentId: `${imdbId}:${latest.season}:${latest.episode}`,
    key: `series:${imdbId}:${latest.season}:${latest.episode}`,
    ...latest,
  };
}

function availableAddons(
  target: ResolvedProbeTarget,
  state: AddonReleaseProbeState,
  now = Date.now(),
): InstalledAddon[] {
  return getEnabledStreamAddons(target.item.type, target.contentId)
    .filter((addon) => (state.providers[addon.installationId]?.retryAt ?? 0) <= now);
}

function recordProviderFailure(
  state: AddonReleaseProbeState,
  installationId: string,
  now = Date.now(),
): void {
  const failures = (state.providers[installationId]?.failures ?? 0) + 1;
  state.providers[installationId] = {
    failures,
    retryAt: now + Math.min(MAX_PROVIDER_RETRY_MS, MIN_PROVIDER_RETRY_MS * (2 ** (failures - 1))),
  };
}

async function probeItem(item: MetaPreview): Promise<void> {
  if (!getXrelQualityBadgesEnabled() || navigator.onLine === false) return;
  if (!shouldProbeAddonReleaseQuality(item)) return;
  const target = await resolveTarget(item);
  if (!target) return;
  const state = readState();
  const saved = state.items[target.key];
  if (isFresh(saved)) return;
  const addons = availableAddons(target, state);
  if (addons.length === 0) return;

  const addon = selectRotatingAddon(addons, target.key, saved?.lastInstallationId);
  const now = Date.now();
  state.items[target.key] = {
    ...saved,
    lastInstallationId: addon.installationId,
    attemptedAt: now,
  };
  writeState(state);

  try {
    const observations = await probeInstalledAddonStreams({
      installationId: addon.installationId,
      mediaType: target.item.type,
      contentId: target.contentId,
    });
    if (!shouldProbeAddonReleaseQuality(target.item)) return;
    const classified = mergeAddonReleaseQualityObservations(
      target.item,
      observations,
      { season: target.season, episode: target.episode },
    );
    const nextState = readState();
    nextState.items[target.key] = {
      checkedAt: Date.now(),
      found: classified > 0,
      lastInstallationId: addon.installationId,
      attemptedAt: now,
    };
    delete nextState.providers[addon.installationId];
    writeState(nextState);
  } catch (error) {
    const nextState = readState();
    nextState.items[target.key] = {
      ...(nextState.items[target.key] ?? saved),
      checkedAt: saved?.checkedAt ?? 0,
      found: saved?.found ?? false,
      lastInstallationId: addon.installationId,
      attemptedAt: now,
    };
    recordProviderFailure(nextState, addon.installationId);
    writeState(nextState);
    console.warn(`[Add-on release probes] ${addon.manifest.name} probe failed:`, error);
  }
}

async function runWorker(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (pendingItems.size > 0) {
      if (!getXrelQualityBadgesEnabled() || getXrelQualitySnapshot().backgroundPaused) {
        pendingItems.clear();
        break;
      }
      const next = pendingItems.entries().next().value as [string, MetaPreview] | undefined;
      if (!next) break;
      const [key, item] = next;
      pendingItems.delete(key);
      if (activeItems.has(key)) continue;
      activeItems.add(key);
      try {
        await probeItem(item);
      } finally {
        activeItems.delete(key);
      }
      if (pendingItems.size > 0) await wait(PROBE_SPACING_MS);
    }
  } finally {
    workerRunning = false;
  }
}

export function scheduleAddonReleaseQualityProbes(items: MetaPreview[]): void {
  if (!getXrelQualityBadgesEnabled()) return;
  for (const item of dedupeAddonReleaseProbeItems(items)) {
    const key = addonReleaseProbeItemKey(item);
    if (!activeItems.has(key) && !pendingItems.has(key)) pendingItems.set(key, item);
  }
  void runWorker();
}
