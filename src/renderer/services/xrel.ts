import axios, { type AxiosResponse } from 'axios';
import { invoke } from '@tauri-apps/api/core';
import type { MetaPreview } from '../store';
import {
  classifyXrelRelease,
  extractXrelReleaseYear,
  normalizeXrelTitle,
  xrelTitleYearKey,
  type XrelQuality,
  type XrelQualityLabel,
} from './xrel-quality.ts';
import { resolveTmdbImdbId } from './tmdb-identity.ts';

const XREL_API_BASE = 'https://xrel-api.nfos.to/v2';
const SRRDB_API_BASE = 'https://api.srrdb.com/v1';
const XREL_ENABLED_STORAGE_KEY = 'streamee-xrel-quality-badges-enabled';
const XREL_LANGUAGE_STORAGE_KEY = 'streamee-xrel-release-language';
const XREL_DISPLAY_MODE_STORAGE_KEY = 'streamee-xrel-badge-display-mode';
const XREL_BACKGROUND_PAUSED_STORAGE_KEY = 'streamee-xrel-background-lookups-paused';
const XREL_BACKGROUND_BUDGET_STORAGE_KEY = 'streamee-xrel-background-budget-v2';
const XREL_LEGACY_BACKGROUND_BUDGET_STORAGE_KEY = 'streamee-xrel-background-budget-v1';
const XREL_BACKGROUND_QUEUE_STORAGE_KEY = 'streamee-xrel-background-queue-v1';
const SRRDB_BACKGROUND_BUDGET_STORAGE_KEY = 'streamee-srrdb-background-budget-v1';
const SRRDB_BACKGROUND_QUEUE_STORAGE_KEY = 'streamee-srrdb-background-queue-v1';
const SRRDB_FEED_REFRESH_STORAGE_KEY = 'streamee-srrdb-feed-refresh-v1';
const XREL_CACHE_STORAGE_KEY = 'streamee-xrel-release-quality-cache-v2';
const XREL_LEGACY_CACHE_STORAGE_KEY = 'streamee-xrel-release-quality-cache-v1';
const SHARED_STORAGE_BACKUP_KEY = 'streamee-shared-storage-backup-v1';
const XREL_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const XREL_INITIAL_BACKFILL_PAGES = 10;
const XREL_MAX_INCREMENTAL_PAGES = 10;
const XREL_PAGE_SIZE = 100;
const XREL_MAX_CACHED_ENTRIES = 7500;
const XREL_MAX_SEEN_RELEASES = 10000;
const XREL_SEARCH_WINDOW_MS = 5000;
const XREL_SEARCHES_PER_WINDOW = 2;
const XREL_UPGRADE_BADGE_MS = 7 * 24 * 60 * 60 * 1000;
const XREL_PRECISE_LOOKUP_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const XREL_BACKGROUND_LOOKUP_INTERVAL_MS = 3000;
const XREL_BACKGROUND_MAX_ACTIVE_INTERVAL_MS = 5000;
const XREL_BACKGROUND_INITIAL_DELAY_MS = 2000;
const XREL_BACKGROUND_HOURLY_LIMIT = 250;
const XREL_BACKGROUND_BUDGET_WINDOW_MS = 60 * 60 * 1000;
const XREL_BACKGROUND_QUOTA_RESERVE = 150;
const XREL_MAX_BACKGROUND_QUEUE = 500;
const XREL_BACKGROUND_QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const XREL_BACKGROUND_ENTRY_RETRY_MS = 15 * 60 * 1000;
const XREL_BACKGROUND_SERVICE_RETRY_MS = 60 * 1000;
const SRRDB_BACKGROUND_HOURLY_LIMIT = 250;
const SRRDB_BACKGROUND_INTERVAL_MS = 5 * 1000;
const SRRDB_BACKGROUND_COOLDOWN_MS = 10 * 60 * 1000;
const SRRDB_UPGRADE_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const SRRDB_RECENT_MAX_PAGES = 3;
const SRRDB_SUCCESS_LOOKUP_FRESH_MS = 3 * 24 * 60 * 60 * 1000;
const SRRDB_NEGATIVE_LOOKUP_FRESH_MS = 12 * 60 * 60 * 1000;
const XREL_MAX_PRECISE_LOOKUPS = 2500;
const XREL_IDENTITY_ALIAS_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const XREL_MAX_IDENTITY_ALIASES = 5000;

type XrelMediaType = 'movie' | 'series';
type XrelReleaseLanguage = 'english' | 'german' | 'unknown';
export type XrelProvider = 'xrel' | 'srrdb';
export type XrelLookupTier = 'feed' | 'background' | 'precise';
export type XrelQueuePriority = 'nearby' | 'visible' | 'library';

type XrelLookupItem = Pick<MetaPreview, 'type' | 'name' | 'year' | 'imdbId' | 'originalName' | 'aliases'>
  & Partial<Pick<MetaPreview, 'id'>>;

export type XrelLanguagePreference = 'any' | 'english' | 'german';
export type XrelBadgeDisplayMode = 'all' | 'minimal';
export type XrelMatchMethod = 'imdb' | 'title-year' | 'title';

interface XrelExtInfo {
  id?: string;
  type?: string;
  title?: string;
  alt_title?: string;
  uris?: string[];
}

interface XrelRelease {
  id?: string;
  dirname?: string;
  link_href?: string;
  time?: number | string;
  pub_time?: number | string;
  video_type?: string;
  category?: unknown;
  main_lang?: string;
  tv_season?: number;
  tv_episode?: number;
  flags?: { english?: boolean };
  ext_info?: XrelExtInfo;
}

interface XrelFeedResponse {
  list?: XrelRelease[];
}

interface XrelSearchResponse {
  results?: XrelExtInfo[];
  result?: XrelExtInfo[];
}

interface XrelReleaseSearchResponse {
  results?: XrelRelease[];
  p2p_results?: XrelRelease[];
}

interface SrrdbRelease {
  release?: string;
  date?: string;
  isForeign?: string;
  imdbId?: string;
}

interface SrrdbSearchResponse {
  results?: SrrdbRelease[];
  resultsCount?: number;
}

export interface XrelQualityBadge extends XrelQuality {
  provider: XrelProvider;
  lookupTier: XrelLookupTier;
  verifiedAt: number;
  dirname: string;
  releaseUrl?: string;
  updatedAt: number;
  language: XrelReleaseLanguage;
  season?: number;
  episode?: number;
  matchMethod: XrelMatchMethod;
  previousLabel?: XrelQualityLabel;
  upgradedAt?: number;
}

interface XrelTitleEntry extends Omit<XrelQualityBadge, 'matchMethod'> {
  cacheKey: string;
  xrelId: string;
  mediaType: XrelMediaType;
  title: string;
  year?: string;
  imdbId?: string;
}

interface XrelReleaseCache {
  version: 2;
  backgroundMatcherVersion: 4;
  fetchedAt: number;
  seenReleaseIds: string[];
  entries: XrelTitleEntry[];
  negativeLookups: Record<string, number>;
  preciseLookups: Record<string, number>;
  identityAliases: Record<string, XrelIdentityAlias>;
  srrdbLookups: Record<string, number>;
}

interface XrelIdentityAlias {
  imdbId: string;
  updatedAt: number;
}

export interface XrelQualitySnapshot {
  enabled: boolean;
  language: XrelLanguagePreference;
  displayMode: XrelBadgeDisplayMode;
  fetchedAt: number;
  indexedTitles: number;
  preciseTitles: number;
  isRefreshing: boolean;
  isLookingUp: boolean;
  online: boolean;
  lastError: string | null;
  rateLimit: number | null;
  rateRemaining: number | null;
  rateResetAt: number | null;
  xrelRequestsThisHour: number;
  srrdbLastLookupAt: number | null;
  srrdbLastError: string | null;
  srrdbBackgroundQueued: number;
  srrdbBackgroundProcessing: boolean;
  srrdbCompletedThisHour: number;
  srrdbRequestsThisHour: number;
  srrdbHourlyLimit: number;
  srrdbCooldownUntil: number;
  backgroundPaused: boolean;
  backgroundQueued: number;
  backgroundProcessing: boolean;
  backgroundCompletedThisHour: number;
  backgroundRequestsThisHour: number;
  backgroundHourlyLimit: number;
  backgroundBudgetResetAt: number;
  backgroundQuotaReserve: number;
  backgroundNextDelayMs: number;
  revision: number;
}

interface XrelBackgroundBudget {
  resetAt: number;
  requests: number;
  completed: number;
  totalRequests: number;
}

interface XrelBackgroundQueueEntry {
  item: XrelLookupItem;
  registrations: Map<number, XrelQueuePriority>;
  queuedAt: number;
  retryAt: number;
}

interface XrelPersistedBackgroundQueue {
  version: 1;
  entries: Array<Omit<XrelBackgroundQueueEntry, 'registrations'>>;
}

interface SrrdbBackgroundBudget {
  resetAt: number;
  requests: number;
  completed: number;
  cooldownUntil: number;
}

type XrelRequestSource = 'feed' | 'background' | 'precise';

interface SrrdbBackgroundQueueEntry {
  item: Pick<MetaPreview, 'type' | 'name' | 'year'> & { imdbId: string };
  priority: XrelQueuePriority;
  queuedAt: number;
}

interface SrrdbPersistedBackgroundQueue {
  version: 1;
  entries: SrrdbBackgroundQueueEntry[];
}

type XrelBackgroundTimerMode = 'normal' | 'retry' | 'global';

const EMPTY_CACHE: XrelReleaseCache = {
  version: 2,
  backgroundMatcherVersion: 4,
  fetchedAt: 0,
  seenReleaseIds: [],
  entries: [],
  negativeLookups: {},
  preciseLookups: {},
  identityAliases: {},
  srrdbLookups: {},
};

const listeners = new Set<() => void>();
const lazyLookupPromises = new Map<string, Promise<void>>();
const backgroundQueue = readBackgroundQueue();
const srrdbBackgroundQueue = readSrrdbBackgroundQueue();
const searchStartTimes: number[] = [];
let nextBackgroundRegistrationId = 1;
let refreshPromise: Promise<void> | null = null;
let refreshTimer: number | null = null;
let srrdbRefreshTimer: number | null = null;
let srrdbFeedFetchedAt = Number(storageValue(SRRDB_FEED_REFRESH_STORAGE_KEY)) || 0;
let networkListenersInstalled = false;
let lastError: string | null = null;
let rateLimit: number | null = null;
let rateRemaining: number | null = null;
let rateResetAt: number | null = null;
let srrdbLastLookupAt: number | null = null;
let srrdbLastError: string | null = null;
let srrdbBackgroundTimer: number | null = null;
let srrdbBackgroundProcessingKey: string | null = null;
let backgroundTimer: number | null = null;
let backgroundTimerMode: XrelBackgroundTimerMode | null = null;
let backgroundProcessingKey: string | null = null;
let backgroundBudget = readBackgroundBudget();
let srrdbBackgroundBudget = readSrrdbBackgroundBudget();
let cache = readCache();
let nativeCacheStorageEnabled = false;
let nativeCacheWriteChain: Promise<unknown> = Promise.resolve();
let cacheStorageInitialization: Promise<void> | null = null;
let byImdb = new Map<string, XrelTitleEntry>();
let byTitleYear = new Map<string, XrelTitleEntry>();
let bySeriesTitle = new Map<string, XrelTitleEntry>();
let byImdbSeason = new Map<string, XrelTitleEntry>();
let byTitleSeason = new Map<string, XrelTitleEntry>();
let byImdbEpisode = new Map<string, XrelTitleEntry>();
let byTitleEpisode = new Map<string, XrelTitleEntry>();
let snapshot: XrelQualitySnapshot = createSnapshot(0);

function storageValue(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readEnabledSetting(): boolean {
  const stored = storageValue(XREL_ENABLED_STORAGE_KEY);
  return stored === null ? true : stored === 'true';
}

function readBackgroundPaused(): boolean {
  return storageValue(XREL_BACKGROUND_PAUSED_STORAGE_KEY) === 'true';
}

function readBackgroundBudget(): XrelBackgroundBudget {
  const now = Date.now();
  try {
    const parsed = JSON.parse(storageValue(XREL_BACKGROUND_BUDGET_STORAGE_KEY) ?? 'null') as Partial<XrelBackgroundBudget> | null;
    if (typeof parsed?.resetAt === 'number'
      && parsed.resetAt > now
      && parsed.resetAt <= now + XREL_BACKGROUND_BUDGET_WINDOW_MS + 5 * 60 * 1000) {
      const requests = Math.max(0, Number(parsed.requests) || 0);
      return {
        resetAt: parsed.resetAt,
        requests,
        completed: Math.max(0, Number(parsed.completed) || 0),
        totalRequests: Math.max(requests, Number(parsed.totalRequests) || 0),
      };
    }
  } catch {
    // A malformed or expired budget record is safe to replace with a fresh hourly window.
  }
  return {
    resetAt: now + XREL_BACKGROUND_BUDGET_WINDOW_MS,
    requests: 0,
    completed: 0,
    totalRequests: 0,
  };
}

function currentBackgroundBudget(): XrelBackgroundBudget {
  if (backgroundBudget.resetAt <= Date.now()) {
    backgroundBudget = {
      resetAt: Date.now() + XREL_BACKGROUND_BUDGET_WINDOW_MS,
      requests: 0,
      completed: 0,
      totalRequests: 0,
    };
    persistBackgroundBudget();
  }
  return backgroundBudget;
}

function alignBackgroundBudgetReset(resetAt: number): void {
  const now = Date.now();
  if (!Number.isFinite(resetAt)
    || resetAt <= now
    || resetAt > now + XREL_BACKGROUND_BUDGET_WINDOW_MS + 5 * 60 * 1000) return;
  const budget = currentBackgroundBudget();
  if (Math.abs(budget.resetAt - resetAt) < 1000) return;
  budget.resetAt = resetAt;
  persistBackgroundBudget();
}

function persistBackgroundBudget(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(XREL_BACKGROUND_BUDGET_STORAGE_KEY, JSON.stringify(backgroundBudget));
    localStorage.removeItem(XREL_LEGACY_BACKGROUND_BUDGET_STORAGE_KEY);
  } catch (error) {
    console.warn('[xREL] Failed to persist background lookup budget:', error);
  }
}

function readBackgroundQueue(): Map<string, XrelBackgroundQueueEntry> {
  const result = new Map<string, XrelBackgroundQueueEntry>();
  const now = Date.now();
  const cutoff = now - XREL_BACKGROUND_QUEUE_TTL_MS;
  try {
    const parsed = JSON.parse(
      storageValue(XREL_BACKGROUND_QUEUE_STORAGE_KEY) ?? 'null',
    ) as Partial<XrelPersistedBackgroundQueue> | null;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return result;
    parsed.entries
      .flatMap((stored) => {
        if (!stored?.item || (stored.item.type !== 'movie' && stored.item.type !== 'series')) return [];
        const name = typeof stored.item.name === 'string' ? stored.item.name.trim() : '';
        const queuedAt = Number(stored.queuedAt);
        if (!name || !Number.isFinite(queuedAt) || queuedAt < cutoff || queuedAt > now + 5 * 60 * 1000) return [];
        const year = typeof stored.item.year === 'string' ? stored.item.year : undefined;
        const imdbId = typeof stored.item.imdbId === 'string' ? stored.item.imdbId : undefined;
        const retryAt = Number.isFinite(Number(stored.retryAt)) ? Math.max(0, Number(stored.retryAt)) : 0;
        return [{
          item: { type: stored.item.type, name, year, imdbId },
          queuedAt,
          retryAt,
        }];
      })
      .sort((left, right) => left.queuedAt - right.queuedAt)
      .slice(0, XREL_MAX_BACKGROUND_QUEUE)
      .forEach((stored) => {
        const key = lazyLookupKey(stored.item);
        if (!result.has(key)) {
          result.set(key, { ...stored, registrations: new Map<number, XrelQueuePriority>() });
        }
      });
  } catch (error) {
    console.warn('[xREL] Failed to load background queue:', error);
  }
  return result;
}

function persistBackgroundQueue(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const now = Date.now();
    const cutoff = now - XREL_BACKGROUND_QUEUE_TTL_MS;
    for (const [key, entry] of backgroundQueue) {
      if (entry.queuedAt < cutoff) backgroundQueue.delete(key);
    }
    const persisted: XrelPersistedBackgroundQueue = {
      version: 1,
      entries: [...backgroundQueue.values()]
        .sort((left, right) => left.queuedAt - right.queuedAt)
        .slice(0, XREL_MAX_BACKGROUND_QUEUE)
        .map(({ item, queuedAt, retryAt }) => ({ item, queuedAt, retryAt })),
    };
    localStorage.setItem(XREL_BACKGROUND_QUEUE_STORAGE_KEY, JSON.stringify(persisted));
  } catch (error) {
    console.warn('[xREL] Failed to persist background queue:', error);
  }
}

function readSrrdbBackgroundBudget(): SrrdbBackgroundBudget {
  const now = Date.now();
  try {
    const parsed = JSON.parse(
      storageValue(SRRDB_BACKGROUND_BUDGET_STORAGE_KEY) ?? 'null',
    ) as Partial<SrrdbBackgroundBudget> | null;
    if (typeof parsed?.resetAt === 'number'
      && parsed.resetAt > now
      && parsed.resetAt <= now + XREL_BACKGROUND_BUDGET_WINDOW_MS + 5 * 60 * 1000) {
      return {
        resetAt: parsed.resetAt,
        requests: Math.max(0, Number(parsed.requests) || 0),
        completed: Math.max(0, Number(parsed.completed) || 0),
        cooldownUntil: Math.max(0, Number(parsed.cooldownUntil) || 0),
      };
    }
  } catch {
    // A malformed or expired srrDB budget is safe to replace.
  }
  return {
    resetAt: now + XREL_BACKGROUND_BUDGET_WINDOW_MS,
    requests: 0,
    completed: 0,
    cooldownUntil: 0,
  };
}

function currentSrrdbBackgroundBudget(): SrrdbBackgroundBudget {
  if (srrdbBackgroundBudget.resetAt <= Date.now()) {
    srrdbBackgroundBudget = {
      resetAt: Date.now() + XREL_BACKGROUND_BUDGET_WINDOW_MS,
      requests: 0,
      completed: 0,
      cooldownUntil: srrdbBackgroundBudget.cooldownUntil,
    };
    persistSrrdbBackgroundBudget();
  }
  return srrdbBackgroundBudget;
}

function persistSrrdbBackgroundBudget(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SRRDB_BACKGROUND_BUDGET_STORAGE_KEY, JSON.stringify(srrdbBackgroundBudget));
  } catch (error) {
    console.warn('[srrDB] Failed to persist background budget:', error);
  }
}

function readSrrdbBackgroundQueue(): Map<string, SrrdbBackgroundQueueEntry> {
  const result = new Map<string, SrrdbBackgroundQueueEntry>();
  const now = Date.now();
  const cutoff = now - XREL_BACKGROUND_QUEUE_TTL_MS;
  try {
    const parsed = JSON.parse(
      storageValue(SRRDB_BACKGROUND_QUEUE_STORAGE_KEY) ?? 'null',
    ) as Partial<SrrdbPersistedBackgroundQueue> | null;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return result;
    parsed.entries
      .filter((entry) => (
        entry?.item
        && (entry.item.type === 'movie' || entry.item.type === 'series')
        && typeof entry.item.name === 'string'
        && /^tt\d+$/i.test(entry.item.imdbId ?? '')
        && Number.isFinite(entry.queuedAt)
        && entry.queuedAt >= cutoff
        && entry.queuedAt <= now + 5 * 60 * 1000
      ))
      .sort((left, right) => left.queuedAt - right.queuedAt)
      .slice(0, XREL_MAX_BACKGROUND_QUEUE)
      .forEach((entry) => {
        const imdbId = entry.item.imdbId.toLowerCase();
        if (!result.has(imdbId)) {
          result.set(imdbId, {
            item: { ...entry.item, imdbId },
            priority: entry.priority === 'library' || entry.priority === 'visible' ? entry.priority : 'nearby',
            queuedAt: entry.queuedAt,
          });
        }
      });
  } catch (error) {
    console.warn('[srrDB] Failed to load background queue:', error);
  }
  return result;
}

function persistSrrdbBackgroundQueue(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const cutoff = Date.now() - XREL_BACKGROUND_QUEUE_TTL_MS;
    for (const [key, entry] of srrdbBackgroundQueue) {
      if (entry.queuedAt < cutoff) srrdbBackgroundQueue.delete(key);
    }
    const persisted: SrrdbPersistedBackgroundQueue = {
      version: 1,
      entries: [...srrdbBackgroundQueue.values()]
        .sort((left, right) => left.queuedAt - right.queuedAt)
        .slice(0, XREL_MAX_BACKGROUND_QUEUE),
    };
    localStorage.setItem(SRRDB_BACKGROUND_QUEUE_STORAGE_KEY, JSON.stringify(persisted));
  } catch (error) {
    console.warn('[srrDB] Failed to persist background queue:', error);
  }
}

export function normalizeXrelLanguagePreference(value: unknown): XrelLanguagePreference {
  return value === 'english' || value === 'german' ? value : 'any';
}

export function normalizeXrelBadgeDisplayMode(value: unknown): XrelBadgeDisplayMode {
  return value === 'minimal' ? 'minimal' : 'all';
}

function readLanguagePreference(): XrelLanguagePreference {
  return normalizeXrelLanguagePreference(storageValue(XREL_LANGUAGE_STORAGE_KEY));
}

function readDisplayMode(): XrelBadgeDisplayMode {
  return normalizeXrelBadgeDisplayMode(storageValue(XREL_DISPLAY_MODE_STORAGE_KEY));
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function pruneXrelPreciseLookups(
  lookups: Record<string, unknown>,
  now = Date.now(),
  maxEntries = XREL_MAX_PRECISE_LOOKUPS,
): Record<string, number> {
  const cutoff = now - XREL_PRECISE_LOOKUP_FRESH_MS;
  return Object.fromEntries(
    Object.entries(lookups)
      .flatMap(([key, value]) => (
        typeof value === 'number' && Number.isFinite(value)
          ? [[key, Math.min(value, now)] as const]
          : []
      ))
      .filter(([, verifiedAt]) => verifiedAt >= cutoff)
      .sort(([, left], [, right]) => right - left)
      .slice(0, Math.max(0, maxEntries)),
  );
}

function pruneXrelIdentityAliases(
  aliases: Record<string, unknown>,
  now = Date.now(),
): Record<string, XrelIdentityAlias> {
  const cutoff = now - XREL_IDENTITY_ALIAS_TTL_MS;
  return Object.fromEntries(
    Object.entries(aliases)
      .flatMap(([key, value]) => {
        if (!value || typeof value !== 'object') return [];
        const alias = value as Partial<XrelIdentityAlias>;
        const imdbId = alias.imdbId?.trim().toLowerCase();
        if (!imdbId || !/^tt\d+$/.test(imdbId) || typeof alias.updatedAt !== 'number') return [];
        const updatedAt = Math.min(alias.updatedAt, now);
        return Number.isFinite(updatedAt) && updatedAt >= cutoff
          ? [[key, { imdbId, updatedAt }] as const]
          : [];
      })
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, XREL_MAX_IDENTITY_ALIASES),
  );
}

function pruneSrrdbLookups(
  lookups: Record<string, unknown>,
  now = Date.now(),
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(lookups)
      .filter(([key, expiresAt]) => (
        /^tt\d+$/.test(key)
        && typeof expiresAt === 'number'
        && Number.isFinite(expiresAt)
        && expiresAt > now
        && expiresAt <= now + SRRDB_SUCCESS_LOOKUP_FRESH_MS + 5 * 60 * 1000
      ))
      .sort(([, left], [, right]) => Number(right) - Number(left))
      .slice(0, XREL_MAX_PRECISE_LOOKUPS) as Array<[string, number]>,
  );
}

function emptyCache(): XrelReleaseCache {
  return { ...EMPTY_CACHE, negativeLookups: {}, preciseLookups: {}, identityAliases: {}, srrdbLookups: {} };
}

function parseCacheValue(stored: unknown): XrelReleaseCache | null {
  try {
    const parsed = (typeof stored === 'string' ? JSON.parse(stored) : stored) as Partial<XrelReleaseCache> & { version?: number };
    if (!Array.isArray(parsed.entries) || !Array.isArray(parsed.seenReleaseIds)) {
      return null;
    }
    const now = Date.now();
    const negativeLookups = parsed.backgroundMatcherVersion === 4
      ? Object.fromEntries(
        Object.entries(parsed.negativeLookups ?? {}).filter(([, expiresAt]) => (
          typeof expiresAt === 'number' && expiresAt > now
        )),
      )
      : {};
    return {
      version: 2,
      backgroundMatcherVersion: 4,
      fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      seenReleaseIds: parsed.seenReleaseIds.filter((id): id is string => typeof id === 'string'),
      entries: parsed.entries.flatMap(migrateCachedTitleEntry),
      negativeLookups,
      preciseLookups: pruneXrelPreciseLookups(parsed.preciseLookups ?? {}, now),
      identityAliases: pruneXrelIdentityAliases(parsed.identityAliases ?? {}, now),
      srrdbLookups: pruneSrrdbLookups(parsed.srrdbLookups ?? {}, now),
    };
  } catch {
    return null;
  }
}

function readCache(): XrelReleaseCache {
  if (typeof localStorage === 'undefined') return emptyCache();
  try {
    const stored = localStorage.getItem(XREL_CACHE_STORAGE_KEY)
      ?? localStorage.getItem(XREL_LEGACY_CACHE_STORAGE_KEY);
    if (!stored) return emptyCache();
    const parsed = parseCacheValue(stored);
    if (parsed) return parsed;
    console.warn('[xREL] Ignoring an invalid release quality cache.');
    return emptyCache();
  } catch (error) {
    console.warn('[xREL] Failed to load release quality cache:', error);
    return emptyCache();
  }
}

function migrateCachedTitleEntry(value: unknown): XrelTitleEntry[] {
  if (!value || typeof value !== 'object') return [];
  const entry = value as Partial<XrelTitleEntry>;
  if (typeof entry.xrelId !== 'string'
    || (entry.mediaType !== 'movie' && entry.mediaType !== 'series')
    || typeof entry.title !== 'string'
    || typeof entry.label !== 'string'
    || typeof entry.rank !== 'number'
    || typeof entry.dirname !== 'string'
    || typeof entry.updatedAt !== 'number') {
    return [];
  }
  const language = entry.language === 'english' || entry.language === 'german'
    ? entry.language
    : 'unknown';
  const provider = entry.provider === 'srrdb' ? 'srrdb' : 'xrel';
  const lookupTier = entry.lookupTier === 'background' || entry.lookupTier === 'precise'
    ? entry.lookupTier
    : 'feed';
  const verifiedAt = typeof entry.verifiedAt === 'number' ? entry.verifiedAt : entry.updatedAt;
  const scopeKey = entry.mediaType === 'series'
    ? `s${entry.season ?? 'all'}e${entry.episode ?? 'all'}`
    : 'title';
  const cacheKey = entry.cacheKey?.startsWith(`${provider}:`)
    ? entry.cacheKey
    : `${provider}:${entry.xrelId}:${language}:${scopeKey}`;
  return [{ ...entry, provider, lookupTier, verifiedAt, language, cacheKey } as XrelTitleEntry];
}

function persistCache(): void {
  try {
    cache.preciseLookups = pruneXrelPreciseLookups(cache.preciseLookups);
    cache.identityAliases = pruneXrelIdentityAliases(cache.identityAliases);
    cache.srrdbLookups = pruneSrrdbLookups(cache.srrdbLookups);
    const serialized = JSON.stringify(cache);
    if (nativeCacheStorageEnabled) {
      nativeCacheWriteChain = nativeCacheWriteChain
        .catch(() => undefined)
        .then(() => invoke<void>('write_xrel_release_cache', { value: serialized }))
        .catch((error) => console.warn('[xREL] Failed to persist AppData release quality cache:', error));
      return;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(XREL_CACHE_STORAGE_KEY, serialized);
      localStorage.removeItem(XREL_LEGACY_CACHE_STORAGE_KEY);
    }
  } catch (error) {
    console.warn('[xREL] Failed to persist release quality cache:', error);
  }
}

function removeMigratedCacheFromLocalStorage(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(XREL_CACHE_STORAGE_KEY);
  localStorage.removeItem(XREL_LEGACY_CACHE_STORAGE_KEY);

  const rawBackup = localStorage.getItem(SHARED_STORAGE_BACKUP_KEY);
  if (!rawBackup) return;
  try {
    const backup = JSON.parse(rawBackup) as { entries?: Record<string, unknown> };
    if (!backup.entries || typeof backup.entries !== 'object' || Array.isArray(backup.entries)) return;
    const hadMigratedCache = XREL_CACHE_STORAGE_KEY in backup.entries
      || XREL_LEGACY_CACHE_STORAGE_KEY in backup.entries;
    if (!hadMigratedCache) return;
    delete backup.entries[XREL_CACHE_STORAGE_KEY];
    delete backup.entries[XREL_LEGACY_CACHE_STORAGE_KEY];
    localStorage.setItem(SHARED_STORAGE_BACKUP_KEY, JSON.stringify(backup));
  } catch (error) {
    console.warn('[xREL] Failed to trim the shared-storage backup after migration:', error);
  }
}

export function initializeXrelReleaseCacheStorage(): Promise<void> {
  if (cacheStorageInitialization) return cacheStorageInitialization;

  cacheStorageInitialization = (async () => {
    try {
      const nativeValue = await invoke<unknown | null>('read_xrel_release_cache');
      if (nativeValue !== null) {
        const parsed = parseCacheValue(nativeValue);
        if (!parsed) throw new Error('The AppData release quality cache is invalid.');
        cache = parsed;
      } else {
        const legacyValue = storageValue(XREL_CACHE_STORAGE_KEY)
          ?? storageValue(XREL_LEGACY_CACHE_STORAGE_KEY);
        if (legacyValue) {
          const parsed = parseCacheValue(legacyValue);
          if (!parsed) throw new Error('The local release quality cache is invalid.');
          cache = parsed;
          await invoke<void>('write_xrel_release_cache', { value: JSON.stringify(cache) });
        }
      }

      nativeCacheStorageEnabled = true;
      removeMigratedCacheFromLocalStorage();
      rebuildIndexes();
      emitChange();
    } catch (error) {
      console.warn('[xREL] AppData cache initialization failed; retaining localStorage fallback:', error);
    }
  })();

  return cacheStorageInitialization;
}

function languageMatches(language: XrelReleaseLanguage): boolean {
  const preference = readLanguagePreference();
  return preference === 'any' || preference === language;
}

function notableBadge(entry: XrelTitleEntry): boolean {
  return entry.rank < 35
    || entry.label === 'WEB'
    || entry.label.startsWith('4K')
    || !!entry.dynamicRange;
}

function negativeLookupFreshMs(item: Pick<MetaPreview, 'year'>): number {
  const itemYear = Number(item.year);
  const currentYear = new Date().getFullYear();
  return Number.isFinite(itemYear) && Math.abs(itemYear - currentYear) <= 1
    ? 2 * 60 * 60 * 1000
    : SRRDB_NEGATIVE_LOOKUP_FRESH_MS;
}

function qualityLookupFreshMs(rank: number): number {
  if (rank < 35) return 30 * 60 * 1000;
  if (rank < 80) return 2 * 60 * 60 * 1000;
  if (rank < 88) return 6 * 60 * 60 * 1000;
  if (rank < 96) return 24 * 60 * 60 * 1000;
  return SRRDB_SUCCESS_LOOKUP_FRESH_MS;
}

function providerLookupFreshMs(
  item: Pick<MetaPreview, 'type' | 'name' | 'year' | 'imdbId'>,
  classifiedReleases: number,
): number {
  if (classifiedReleases === 0) return negativeLookupFreshMs(item);
  return qualityLookupFreshMs(entryForItem(item).entry?.rank ?? 0);
}

function preciseLookupMarker(freshMs: number): number {
  return Date.now() - XREL_PRECISE_LOOKUP_FRESH_MS
    + Math.min(XREL_PRECISE_LOOKUP_FRESH_MS, Math.max(0, freshMs));
}

function hasActiveUpgrade(entry: Pick<XrelTitleEntry, 'previousLabel' | 'upgradedAt'>, now = Date.now()): boolean {
  return !!entry.previousLabel
    && typeof entry.upgradedAt === 'number'
    && Number.isFinite(entry.upgradedAt)
    && now - entry.upgradedAt < XREL_UPGRADE_BADGE_MS;
}

function selectBetter(
  current: XrelTitleEntry | undefined,
  candidate: XrelTitleEntry
): XrelTitleEntry {
  if (!current) return candidate;
  const preferred = candidate.rank !== current.rank
    ? (candidate.rank > current.rank ? candidate : current)
    : (candidate.updatedAt > current.updatedAt ? candidate : current);
  if (candidate.rank !== current.rank) return preferred;
  const currentUpgrade = hasActiveUpgrade(current) ? current : undefined;
  const candidateUpgrade = hasActiveUpgrade(candidate) ? candidate : undefined;
  const recentUpgrade = !currentUpgrade
    ? candidateUpgrade
    : !candidateUpgrade || (currentUpgrade.upgradedAt ?? 0) >= (candidateUpgrade.upgradedAt ?? 0)
      ? currentUpgrade
      : candidateUpgrade;
  return recentUpgrade && recentUpgrade !== preferred
    ? {
      ...preferred,
      previousLabel: recentUpgrade.previousLabel,
      upgradedAt: recentUpgrade.upgradedAt,
    }
    : preferred;
}

function mergeSameScope(
  current: XrelTitleEntry | undefined,
  candidate: XrelTitleEntry,
  trackUpgrade: boolean
): XrelTitleEntry {
  if (!current) return candidate;
  const candidateWins = candidate.rank > current.rank
    || (candidate.rank === current.rank && candidate.updatedAt > current.updatedAt);
  const preferred = candidateWins ? candidate : current;
  const alternate = candidateWins ? current : candidate;
  const isNewUpgrade = trackUpgrade && candidate.rank > current.rank;
  return {
    ...preferred,
    imdbId: preferred.imdbId ?? alternate.imdbId,
    year: preferred.year ?? alternate.year,
    previousLabel: isNewUpgrade
      ? current.label
      : preferred.previousLabel ?? current.previousLabel,
    upgradedAt: isNewUpgrade
      ? Date.now()
      : preferred.upgradedAt ?? current.upgradedAt,
  };
}

function upgradeScopeKey(entry: Pick<XrelTitleEntry, 'mediaType' | 'season' | 'episode'>): string {
  return `${entry.mediaType}:s${entry.season ?? 'all'}e${entry.episode ?? 'all'}`;
}

function upgradeTitleKey(entry: Pick<XrelTitleEntry, 'mediaType' | 'title' | 'year' | 'season' | 'episode'>): string {
  return `${upgradeScopeKey(entry)}:${xrelTitleYearKey(entry.title, entry.year)}`;
}

function addBest(map: Map<string, XrelTitleEntry>, key: string, entry: XrelTitleEntry): void {
  map.set(key, selectBetter(map.get(key), entry));
}

function rebuildIndexes(): void {
  byImdb = new Map();
  byTitleYear = new Map();
  bySeriesTitle = new Map();
  byImdbSeason = new Map();
  byTitleSeason = new Map();
  byImdbEpisode = new Map();
  byTitleEpisode = new Map();

  for (const entry of cache.entries) {
    if (!languageMatches(entry.language)) continue;
    const imdbId = entry.imdbId?.toLowerCase();
    const titleYear = `${entry.mediaType}:${xrelTitleYearKey(entry.title, entry.year)}`;
    const seriesTitle = normalizeXrelTitle(entry.title);

    if (imdbId) addBest(byImdb, imdbId, entry);
    addBest(byTitleYear, titleYear, entry);
    if (entry.mediaType === 'series') addBest(bySeriesTitle, seriesTitle, entry);

    if (entry.mediaType !== 'series' || entry.season === undefined) continue;
    if (imdbId) addBest(byImdbSeason, `${imdbId}:s${entry.season}`, entry);
    addBest(byTitleSeason, `${seriesTitle}:s${entry.season}`, entry);

    if (entry.episode === undefined) continue;
    if (imdbId) addBest(byImdbEpisode, `${imdbId}:s${entry.season}e${entry.episode}`, entry);
    addBest(byTitleEpisode, `${seriesTitle}:s${entry.season}e${entry.episode}`, entry);
  }
}

function eligibleTitleCount(): number {
  return new Set(
    cache.entries
      .filter((entry) => languageMatches(entry.language))
      .map((entry) => entry.imdbId ?? `${entry.mediaType}:${xrelTitleYearKey(entry.title, entry.year)}`),
  ).size;
}

function preciseTitleCount(): number {
  const cutoff = Date.now() - XREL_PRECISE_LOOKUP_FRESH_MS;
  return Object.values(cache.preciseLookups).filter((verifiedAt) => verifiedAt >= cutoff).length;
}

export function calculateXrelBackgroundDelay(options: {
  now: number;
  rateRemaining: number | null;
  rateResetAt: number | null;
  quotaReserve: number;
  budgetRemaining: number;
  minimumMs?: number;
  maximumMs?: number;
}): number {
  const minimumMs = options.minimumMs ?? XREL_BACKGROUND_LOOKUP_INTERVAL_MS;
  const maximumMs = options.maximumMs ?? XREL_BACKGROUND_MAX_ACTIVE_INTERVAL_MS;
  if (options.rateRemaining === null || options.rateResetAt === null) return minimumMs;
  const usableRequests = Math.min(
    Math.max(0, options.budgetRemaining),
    Math.max(0, options.rateRemaining - options.quotaReserve),
  );
  if (usableRequests <= 0) return maximumMs;
  const timeUntilReset = Math.max(minimumMs, options.rateResetAt - options.now);
  return Math.min(maximumMs, Math.max(minimumMs, Math.ceil(timeUntilReset / usableRequests)));
}

function adaptiveBackgroundDelay(): number {
  const budget = currentBackgroundBudget();
  return calculateXrelBackgroundDelay({
    now: Date.now(),
    rateRemaining,
    rateResetAt,
    quotaReserve: XREL_BACKGROUND_QUOTA_RESERVE,
    budgetRemaining: XREL_BACKGROUND_HOURLY_LIMIT - budget.requests,
  });
}

function queuedBackgroundCount(): number {
  return [...backgroundQueue.keys()].filter((key) => key !== backgroundProcessingKey).length;
}

function createSnapshot(revision: number): XrelQualitySnapshot {
  const budget = currentBackgroundBudget();
  const srrdbBudget = currentSrrdbBackgroundBudget();
  return {
    enabled: readEnabledSetting(),
    language: readLanguagePreference(),
    displayMode: readDisplayMode(),
    fetchedAt: cache?.fetchedAt ?? 0,
    indexedTitles: cache ? eligibleTitleCount() : 0,
    preciseTitles: cache ? preciseTitleCount() : 0,
    isRefreshing: refreshPromise !== null,
    isLookingUp: lazyLookupPromises.size > 0,
    online: isOnline(),
    lastError,
    rateLimit,
    rateRemaining,
    rateResetAt,
    xrelRequestsThisHour: budget.totalRequests,
    srrdbLastLookupAt,
    srrdbLastError,
    srrdbBackgroundQueued: [...srrdbBackgroundQueue.keys()].filter((key) => key !== srrdbBackgroundProcessingKey).length,
    srrdbBackgroundProcessing: srrdbBackgroundProcessingKey !== null,
    srrdbCompletedThisHour: srrdbBudget.completed,
    srrdbRequestsThisHour: srrdbBudget.requests,
    srrdbHourlyLimit: SRRDB_BACKGROUND_HOURLY_LIMIT,
    srrdbCooldownUntil: srrdbBudget.cooldownUntil,
    backgroundPaused: readBackgroundPaused(),
    backgroundQueued: queuedBackgroundCount(),
    backgroundProcessing: backgroundProcessingKey !== null,
    backgroundCompletedThisHour: budget.completed,
    backgroundRequestsThisHour: budget.requests,
    backgroundHourlyLimit: XREL_BACKGROUND_HOURLY_LIMIT,
    backgroundBudgetResetAt: budget.resetAt,
    backgroundQuotaReserve: XREL_BACKGROUND_QUOTA_RESERVE,
    backgroundNextDelayMs: adaptiveBackgroundDelay(),
    revision,
  };
}

function emitChange(): void {
  snapshot = createSnapshot(snapshot.revision + 1);
  listeners.forEach((listener) => listener());
}

function xrelMediaType(type: string | undefined): XrelMediaType | null {
  if (type === 'movie') return 'movie';
  if (type === 'tv') return 'series';
  return null;
}

function imdbIdFromUris(uris: string[] | undefined): string | undefined {
  for (const uri of uris ?? []) {
    const match = /^imdb:(tt\d+)$/i.exec(uri.trim());
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

function releaseTimestamp(release: XrelRelease): number {
  const raw = Number(release.time ?? release.pub_time ?? 0);
  return Number.isFinite(raw) ? raw * 1000 : 0;
}

function releaseLanguage(release: XrelRelease): XrelReleaseLanguage {
  const mainLanguage = release.main_lang?.trim().toLowerCase();
  if (mainLanguage === 'english') return 'english';
  if (mainLanguage === 'german' || mainLanguage === 'deutsch') return 'german';
  if (release.flags?.english === true) return 'english';
  const dirname = release.dirname?.toUpperCase() ?? '';
  if (/(?:^|[. _-])(?:GERMAN|DEUTSCH)(?:[. _-]|$)/.test(dirname)) return 'german';
  if (/(?:^|[. _-])ENGLISH(?:[. _-]|$)/.test(dirname)) return 'english';
  return 'unknown';
}

function releaseEpisodeScope(release: XrelRelease): { season?: number; episode?: number } {
  if (Number.isInteger(release.tv_season)) {
    return {
      season: release.tv_season,
      episode: Number.isInteger(release.tv_episode) ? release.tv_episode : undefined,
    };
  }
  const match = /(?:^|[. _-])S(\d{1,3})(?:E(\d{1,4}))?(?=[. _-]|$)/i.exec(release.dirname ?? '');
  if (!match) return {};
  return {
    season: Number(match[1]),
    episode: match[2] ? Number(match[2]) : undefined,
  };
}

function mergeReleases(
  releases: XrelRelease[],
  trackUpgrades: boolean,
  provider: XrelProvider = 'xrel',
  lookupTier: XrelLookupTier = 'feed'
): number {
  const entriesBeforeMerge = cache.entries;
  const originalCacheKeys = new Set(entriesBeforeMerge.map((entry) => entry.cacheKey));
  const previousByImdb = new Map<string, XrelTitleEntry>();
  const previousByTitle = new Map<string, { best: XrelTitleEntry; imdbIds: Set<string> }>();
  for (const entry of entriesBeforeMerge) {
    if (!languageMatches(entry.language)) continue;
    if (entry.imdbId) {
      const imdbKey = `${upgradeScopeKey(entry)}:${entry.imdbId}`;
      previousByImdb.set(imdbKey, selectBetter(previousByImdb.get(imdbKey), entry));
    }
    const titleKey = upgradeTitleKey(entry);
    const titleGroup = previousByTitle.get(titleKey);
    if (titleGroup) {
      titleGroup.best = selectBetter(titleGroup.best, entry);
      if (entry.imdbId) titleGroup.imdbIds.add(entry.imdbId);
    } else {
      previousByTitle.set(titleKey, {
        best: entry,
        imdbIds: new Set(entry.imdbId ? [entry.imdbId] : []),
      });
    }
  }
  const entriesByCacheKey = new Map(cache.entries.map((entry) => [entry.cacheKey, entry]));
  const seenReleaseIds = new Set(cache.seenReleaseIds);
  let classifiedCount = 0;

  for (const release of releases) {
    if (provider === 'xrel' && release.id) seenReleaseIds.add(release.id);
    if (!release.dirname || !release.ext_info?.id || !release.ext_info.title) continue;
    const mediaType = xrelMediaType(release.ext_info.type);
    if (!mediaType) continue;

    const quality = classifyXrelRelease({
      dirname: release.dirname,
      video_type: release.video_type,
      category: release.category,
    });
    if (!quality) continue;

    const language = releaseLanguage(release);
    const scope = mediaType === 'series' ? releaseEpisodeScope(release) : {};
    const scopeKey = mediaType === 'series'
      ? `s${scope.season ?? 'all'}e${scope.episode ?? 'all'}`
      : 'title';
    const cacheKey = `${provider}:${release.ext_info.id}:${language}:${scopeKey}`;
    const candidate: XrelTitleEntry = {
      ...quality,
      provider,
      lookupTier,
      verifiedAt: Date.now(),
      cacheKey,
      xrelId: release.ext_info.id,
      mediaType,
      title: release.ext_info.title,
      year: extractXrelReleaseYear(release.dirname),
      imdbId: imdbIdFromUris(release.ext_info.uris),
      language,
      season: scope.season,
      episode: scope.episode,
      dirname: release.dirname,
      releaseUrl: release.link_href,
      updatedAt: releaseTimestamp(release),
    };
    const titleBaseline = previousByTitle.get(upgradeTitleKey(candidate));
    const previousBest = candidate.imdbId
      ? previousByImdb.get(`${upgradeScopeKey(candidate)}:${candidate.imdbId}`)
      : titleBaseline && titleBaseline.imdbIds.size <= 1 ? titleBaseline.best : undefined;
    const isDisplayedUpgrade = trackUpgrades
      && !!previousBest
      && candidate.rank > previousBest.rank;
    const merged = mergeSameScope(
      entriesByCacheKey.get(cacheKey),
      candidate,
      trackUpgrades && originalCacheKeys.has(cacheKey),
    );
    entriesByCacheKey.set(cacheKey, isDisplayedUpgrade
      ? {
        ...merged,
        previousLabel: previousBest.label,
        upgradedAt: Date.now(),
      }
      : merged);
    classifiedCount += 1;
  }

  const now = Date.now();
  cache.entries = [...entriesByCacheKey.values()]
    .sort((left, right) => (
      Number(hasActiveUpgrade(right, now)) - Number(hasActiveUpgrade(left, now))
      || right.updatedAt - left.updatedAt
    ))
    .slice(0, XREL_MAX_CACHED_ENTRIES);
  cache.seenReleaseIds = [...seenReleaseIds].slice(-XREL_MAX_SEEN_RELEASES);
  rebuildIndexes();
  return classifiedCount;
}

function numberHeader(response: AxiosResponse, name: string): number | null {
  const value = Number(response.headers[name]);
  return Number.isFinite(value) ? value : null;
}

function updateRateLimit(response: AxiosResponse): void {
  rateLimit = numberHeader(response, 'x-ratelimit-limit') ?? rateLimit;
  rateRemaining = numberHeader(response, 'x-ratelimit-remaining') ?? rateRemaining;
  const resetSeconds = numberHeader(response, 'x-ratelimit-reset');
  if (resetSeconds !== null) {
    rateResetAt = resetSeconds * 1000;
    alignBackgroundBudgetReset(rateResetAt);
  }
}

function errorMessage(error: unknown, service = 'xREL'): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const apiMessage = typeof error.response?.data?.error === 'string'
      ? error.response.data.error
      : typeof error.response?.data?.message === 'string'
        ? error.response.data.message
        : error.message;
    const resetSeconds = Number(error.response?.headers?.['x-ratelimit-reset']);
    if (Number.isFinite(resetSeconds)) {
      rateResetAt = resetSeconds * 1000;
      alignBackgroundBudgetReset(rateResetAt);
    }
    if (status === 429) {
      const remaining = error.response ? numberHeader(error.response, 'x-ratelimit-remaining') : null;
      const reason = remaining === 0 ? `${service} hourly quota exhausted` : `Rate limited by ${service}`;
      return `${reason}${apiMessage ? `: ${apiMessage}` : ''}`;
    }
    return status
      ? `${service} request failed (${status}): ${apiMessage}`
      : `${service} request failed: ${apiMessage}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function xrelGet<T>(
  path: string,
  params: Record<string, unknown>,
  reportError = true,
  source: XrelRequestSource = 'feed',
): Promise<AxiosResponse<T>> {
  if (!isOnline()) throw new Error('Offline; xREL refresh will resume when the connection returns.');
  if (rateRemaining === 0 && rateResetAt && rateResetAt > Date.now()) {
    throw new Error(`xREL rate limit resets at ${new Date(rateResetAt).toLocaleTimeString()}.`);
  }
  const budget = currentBackgroundBudget();
  if (source === 'background' && budget.requests >= XREL_BACKGROUND_HOURLY_LIMIT) {
    throw new Error('xREL background lookup budget is exhausted for this hour.');
  }
  budget.totalRequests += 1;
  if (source === 'background') budget.requests += 1;
  persistBackgroundBudget();
  if (rateRemaining !== null) rateRemaining = Math.max(0, rateRemaining - 1);
  emitChange();
  try {
    const response = await axios.get<T>(`${XREL_API_BASE}${path}`, { params, timeout: 15_000 });
    updateRateLimit(response);
    return response;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      updateRateLimit(error.response);
    }
    if (reportError) {
      lastError = errorMessage(error);
      emitChange();
    }
    throw error;
  }
}

async function waitBetweenPages(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
}

async function fetchFeed(
  path: '/release/latest.json' | '/p2p/releases.json',
  seenBefore: Set<string>,
  initialBackfill: boolean,
  onPage: (releases: XrelRelease[]) => void
): Promise<number> {
  const maxPages = initialBackfill ? XREL_INITIAL_BACKFILL_PAGES : XREL_MAX_INCREMENTAL_PAGES;
  let fetched = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await xrelGet<XrelFeedResponse>(
      path,
      { per_page: XREL_PAGE_SIZE, page },
      true,
      'feed',
    );
    const pageReleases = Array.isArray(response.data.list) ? response.data.list : [];
    fetched += pageReleases.length;
    onPage(pageReleases);

    const reachedKnownRelease = !initialBackfill
      && pageReleases.some((release) => !!release.id && seenBefore.has(release.id));
    if (reachedKnownRelease || pageReleases.length < XREL_PAGE_SIZE) break;
    await waitBetweenPages();
  }
  return fetched;
}

export async function refreshXrelReleaseQualities(force = false): Promise<void> {
  if (!readEnabledSetting() || !isOnline()) return;
  if (!force && Date.now() - cache.fetchedAt < XREL_REFRESH_INTERVAL_MS) return;
  if (rateRemaining === 0 && rateResetAt && rateResetAt > Date.now()) return;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    lastError = null;
    emitChange();
    const initialBackfill = cache.seenReleaseIds.length === 0;
    const seenBefore = new Set(cache.seenReleaseIds);
    const onPage = (releases: XrelRelease[]) => {
      mergeReleases(releases, !initialBackfill);
      emitChange();
    };
    const results = await Promise.allSettled([
      fetchFeed('/release/latest.json', seenBefore, initialBackfill, onPage),
      fetchFeed('/p2p/releases.json', seenBefore, initialBackfill, onPage),
    ]);
    const successes = results.filter((result) => result.status === 'fulfilled');
    results.forEach((result) => {
      if (result.status === 'rejected') console.warn('[xREL] Release feed refresh failed:', result.reason);
    });
    if (successes.length === 0) return;
    cache.fetchedAt = Date.now();
    lastError = null;
    persistCache();
  })().finally(() => {
    refreshPromise = null;
    emitChange();
  });
  return refreshPromise;
}

function srrdbImdbId(value: string | undefined): string | undefined {
  const digits = value?.trim().replace(/^tt/i, '');
  return digits && /^\d+$/.test(digits) ? `tt${digits}` : undefined;
}

export async function refreshSrrdbReleaseQualities(force = false): Promise<void> {
  if (!readEnabledSetting() || readBackgroundPaused() || !isOnline()) return;
  if (!force && Date.now() - srrdbFeedFetchedAt < SRRDB_UPGRADE_REFRESH_INTERVAL_MS) return;
  if (srrdbBackgroundProcessingKey !== null || !canRunSrrdbBackgroundLookup()) return;

  const knownItems = new Map<string, Pick<MetaPreview, 'type' | 'name' | 'year'> & { imdbId: string }>();
  cache.entries.forEach((entry) => {
    const imdbId = srrdbImdbId(entry.imdbId);
    if (imdbId && !knownItems.has(imdbId)) {
      knownItems.set(imdbId, {
        type: entry.mediaType,
        name: entry.title,
        year: entry.year,
        imdbId,
      });
    }
  });
  if (knownItems.size === 0) return;

  srrdbBackgroundProcessingKey = 'feed';
  const budget = currentSrrdbBackgroundBudget();
  emitChange();
  try {
    const date = new Date().toISOString().slice(0, 10);
    const language = readLanguagePreference();
    const foreignFilter = language === 'english'
      ? '/foreign:no'
      : language === 'german' ? '/foreign:yes' : '';
    let fetchedResults = 0;
    for (let page = 1; page <= SRRDB_RECENT_MAX_PAGES; page += 1) {
      if (budget.requests >= SRRDB_BACKGROUND_HOURLY_LIMIT) break;
      budget.requests += 1;
      persistSrrdbBackgroundBudget();
      emitChange();
      const response = await axios.get<SrrdbSearchResponse>(
        `${SRRDB_API_BASE}/search/date:${date}${foreignFilter}/order:date-desc/page:${page}`,
        { timeout: 15_000 },
      );
      if (!response.data || !Array.isArray(response.data.results)) {
        throw new Error('srrDB returned an invalid recent-release response.');
      }
      const releases: XrelRelease[] = response.data.results.flatMap((result) => {
        const dirname = result.release?.trim();
        const imdbId = srrdbImdbId(result.imdbId);
        const item = imdbId ? knownItems.get(imdbId) : undefined;
        if (!dirname || !imdbId || !item) return [];
        const parsedDate = result.date ? Date.parse(`${result.date}Z`) : Number.NaN;
        return [{
          id: `srrdb:${dirname}`,
          dirname,
          link_href: `https://www.srrdb.com/release/details/${encodeURIComponent(dirname)}`,
          time: Number.isFinite(parsedDate) ? Math.floor(parsedDate / 1000) : 0,
          flags: { english: result.isForeign?.toLowerCase() === 'no' },
          ext_info: {
            id: `imdb:${imdbId}`,
            type: item.type === 'movie' ? 'movie' : 'tv',
            title: item.name,
            uris: [`imdb:${imdbId}`],
          },
        }];
      });
      mergeReleases(releases, true, 'srrdb', 'feed');
      budget.completed += 1;
      budget.cooldownUntil = 0;
      persistCache();
      persistSrrdbBackgroundBudget();
      fetchedResults += response.data.results.length;
      const totalResults = Number(response.data.resultsCount);
      if (response.data.results.length === 0
        || (Number.isFinite(totalResults) && fetchedResults >= totalResults)) break;
    }
    srrdbFeedFetchedAt = Date.now();
    srrdbLastLookupAt = Date.now();
    srrdbLastError = null;
    localStorage.setItem(SRRDB_FEED_REFRESH_STORAGE_KEY, String(srrdbFeedFetchedAt));
    persistCache();
    persistSrrdbBackgroundBudget();
  } catch (error) {
    srrdbLastLookupAt = Date.now();
    srrdbLastError = errorMessage(error, 'srrDB');
    budget.cooldownUntil = Date.now() + srrdbRetryDelay(error);
    persistSrrdbBackgroundBudget();
  } finally {
    srrdbBackgroundProcessingKey = null;
    emitChange();
    scheduleSrrdbBackgroundWorker();
  }
}

function installNetworkListeners(): void {
  if (networkListenersInstalled || typeof window === 'undefined') return;
  networkListenersInstalled = true;
  window.addEventListener('online', () => {
    emitChange();
    if (readEnabledSetting()) {
      void refreshXrelReleaseQualities(true);
      scheduleBackgroundWorker(0);
      void refreshSrrdbReleaseQualities(true);
      scheduleSrrdbBackgroundWorker(0);
    }
  });
  window.addEventListener('offline', emitChange);
}

function startRefreshLoop(): void {
  if (!readEnabledSetting() || refreshTimer !== null || typeof window === 'undefined') return;
  installNetworkListeners();
  void refreshXrelReleaseQualities();
  void refreshSrrdbReleaseQualities();
  scheduleBackgroundWorker();
  scheduleSrrdbBackgroundWorker();
  refreshTimer = window.setInterval(() => {
    void refreshXrelReleaseQualities(true);
  }, XREL_REFRESH_INTERVAL_MS);
  srrdbRefreshTimer = window.setInterval(() => {
    void refreshSrrdbReleaseQualities(true);
  }, SRRDB_UPGRADE_REFRESH_INTERVAL_MS);
}

function stopRefreshLoop(): void {
  if (refreshTimer === null || typeof window === 'undefined') return;
  window.clearInterval(refreshTimer);
  refreshTimer = null;
  if (srrdbRefreshTimer !== null) {
    window.clearInterval(srrdbRefreshTimer);
    srrdbRefreshTimer = null;
  }
}

async function waitForSearchSlot(): Promise<void> {
  while (true) {
    const now = Date.now();
    while (searchStartTimes.length > 0 && now - searchStartTimes[0] >= XREL_SEARCH_WINDOW_MS) {
      searchStartTimes.shift();
    }
    if (searchStartTimes.length < XREL_SEARCHES_PER_WINDOW) {
      searchStartTimes.push(Date.now());
      return;
    }
    const waitMs = Math.max(50, XREL_SEARCH_WINDOW_MS - (now - searchStartTimes[0]) + 25);
    await new Promise<void>((resolve) => window.setTimeout(resolve, waitMs));
  }
}

function titleYearLookupKey(
  item: Pick<MetaPreview, 'type' | 'name' | 'year'>,
): string | null {
  return item.year ? `${item.type}:${xrelTitleYearKey(item.name, item.year)}` : null;
}

function explicitImdbId(item: Pick<MetaPreview, 'imdbId'>): string | undefined {
  const imdbId = item.imdbId?.trim().toLowerCase();
  return imdbId && /^tt\d+$/.test(imdbId) ? imdbId : undefined;
}

function resolvedImdbId(
  item: Pick<MetaPreview, 'type' | 'name' | 'year' | 'imdbId'>,
): string | undefined {
  const explicit = explicitImdbId(item);
  if (explicit) return explicit;
  const aliasKey = titleYearLookupKey(item);
  return aliasKey ? cache.identityAliases[aliasKey]?.imdbId : undefined;
}

function rememberResolvedIdentityAlias(
  item: Pick<MetaPreview, 'type' | 'name' | 'year' | 'imdbId'>,
  imdbId: string | undefined,
): boolean {
  const aliasKey = titleYearLookupKey(item);
  const normalizedImdbId = imdbId?.trim().toLowerCase();
  if (!normalizedImdbId || !/^tt\d+$/.test(normalizedImdbId) || !aliasKey) return false;
  const existing = cache.identityAliases[aliasKey];
  let changed = false;
  if (existing?.imdbId !== normalizedImdbId) {
    cache.identityAliases[aliasKey] = { imdbId: normalizedImdbId, updatedAt: Date.now() };
    changed = true;
  }
  if (aliasKey in cache.negativeLookups) {
    delete cache.negativeLookups[aliasKey];
    changed = true;
  }
  return changed;
}

function rememberIdentityAlias(
  item: Pick<MetaPreview, 'type' | 'name' | 'year' | 'imdbId'>,
): boolean {
  return rememberResolvedIdentityAlias(item, explicitImdbId(item));
}

function lazyLookupKey(item: Pick<MetaPreview, 'type' | 'name' | 'year' | 'imdbId'>): string {
  const imdbId = explicitImdbId(item);
  return imdbId ? `imdb:${imdbId}` : `${item.type}:${xrelTitleYearKey(item.name, item.year)}`;
}

function lookupNames(item: Pick<MetaPreview, 'name'> & Partial<Pick<MetaPreview, 'originalName' | 'aliases'>>): string[] {
  const seen = new Set<string>();
  return [item.name, item.originalName, ...(item.aliases ?? [])]
    .map((name) => name?.trim() ?? '')
    .filter((name) => {
      const normalized = normalizeXrelTitle(name);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function yearIsCompatible(itemYear: string | undefined, releaseYear: string | undefined): boolean {
  if (!itemYear || !releaseYear) return true;
  const itemYearNumber = Number(itemYear);
  const releaseYearNumber = Number(releaseYear);
  return Number.isFinite(itemYearNumber) && Number.isFinite(releaseYearNumber)
    ? Math.abs(itemYearNumber - releaseYearNumber) <= 1
    : itemYear === releaseYear;
}

function identityConflicts(itemImdbId: string | undefined, providerImdbId: string | undefined): boolean {
  return !!itemImdbId && !!providerImdbId && itemImdbId !== providerImdbId;
}

function findSearchMatch(
  results: XrelExtInfo[],
  item: XrelLookupItem
): XrelExtInfo | undefined {
  const imdbId = resolvedImdbId(item);
  if (imdbId) {
    const exactImdb = results.find((result) => imdbIdFromUris(result.uris) === imdbId);
    if (exactImdb) return exactImdb;
  }
  const normalizedNames = new Set(lookupNames(item).map(normalizeXrelTitle));
  const titleMatches = results.filter((result) => (
    !identityConflicts(imdbId, imdbIdFromUris(result.uris))
    && (normalizedNames.has(normalizeXrelTitle(result.title ?? ''))
      || normalizedNames.has(normalizeXrelTitle(result.alt_title ?? '')))
  ));
  if (!imdbId) {
    const candidateImdbIds = new Set(
      titleMatches.map((result) => imdbIdFromUris(result.uris)).filter(Boolean),
    );
    if (candidateImdbIds.size > 1) return undefined;
  }
  return titleMatches[0];
}

function releaseMatchesItem(
  release: XrelRelease,
  item: XrelLookupItem
): boolean {
  if (xrelMediaType(release.ext_info?.type) !== item.type) return false;
  const itemImdbId = resolvedImdbId(item);
  const providerImdbId = imdbIdFromUris(release.ext_info?.uris);
  if (itemImdbId && providerImdbId) return itemImdbId === providerImdbId;
  const normalizedNames = new Set(lookupNames(item).map(normalizeXrelTitle));
  const releaseYear = release.dirname ? extractXrelReleaseYear(release.dirname) : undefined;
  if (!yearIsCompatible(item.year, releaseYear)) return false;
  const metadataTitleMatches = normalizedNames.has(normalizeXrelTitle(release.ext_info?.title ?? ''))
    || normalizedNames.has(normalizeXrelTitle(release.ext_info?.alt_title ?? ''));
  if (metadataTitleMatches) return true;
  if (!release.dirname) return false;
  const normalizedDirname = normalizeXrelTitle(release.dirname);
  return [...normalizedNames].some((name) => (
    normalizedDirname === name || normalizedDirname.startsWith(`${name} `)
  ));
}

async function fetchQueuedXrelQuality(
  item: XrelLookupItem
): Promise<number> {
  const tmdbImdbId = await resolveTmdbImdbId(item);
  const resolvedItem = tmdbImdbId ? { ...item, imdbId: tmdbImdbId } : item;
  if (tmdbImdbId) rememberResolvedIdentityAlias(item, tmdbImdbId);
  let releases: XrelRelease[] = [];
  const searchNames = lookupNames(item).slice(0, 2);
  for (let index = 0; index < searchNames.length; index += 1) {
    if (index > 0) {
      if (!canRunBackgroundLookup()) break;
    }
    await waitForSearchSlot();
    const response = await xrelGet<XrelReleaseSearchResponse>('/search/releases.json', {
      q: searchNames[index],
      scene: true,
      p2p: true,
      limit: 25,
    }, true, 'background');
    releases = [
      ...(response.data.results ?? []),
      ...(response.data.p2p_results ?? []),
    ].filter((release) => releaseMatchesItem(release, resolvedItem));
    if (releases.length > 0) break;
  }
  if (!resolvedImdbId(resolvedItem)) {
    const candidateImdbIds = new Set(
      releases.map((release) => imdbIdFromUris(release.ext_info?.uris)).filter(Boolean),
    );
    if (candidateImdbIds.size > 1) releases = [];
  }
  const matchedImdbIds = new Set(
    releases
      .map((release) => imdbIdFromUris(release.ext_info?.uris))
      .filter((imdbId): imdbId is string => !!imdbId),
  );
  if (matchedImdbIds.size === 1) {
    rememberResolvedIdentityAlias(item, [...matchedImdbIds][0]);
  }
  return mergeReleases(releases, true, 'xrel', 'background');
}

function canRunBackgroundLookup(): boolean {
  const budget = currentBackgroundBudget();
  return readEnabledSetting()
    && !readBackgroundPaused()
    && isOnline()
    && budget.requests < XREL_BACKGROUND_HOURLY_LIMIT
    && (rateRemaining === null || rateRemaining > XREL_BACKGROUND_QUOTA_RESERVE);
}

function cancelBackgroundTimer(): void {
  if (backgroundTimer === null || typeof window === 'undefined') return;
  window.clearTimeout(backgroundTimer);
  backgroundTimer = null;
  backgroundTimerMode = null;
}

export function xrelQueuePriorityRank(priority: XrelQueuePriority): number {
  return priority === 'library' ? 3 : priority === 'visible' ? 2 : 1;
}

function queueEntryPriority(entry: XrelBackgroundQueueEntry): number {
  let priority = xrelQueuePriorityRank('nearby');
  entry.registrations.forEach((registrationPriority) => {
    priority = Math.max(priority, xrelQueuePriorityRank(registrationPriority));
  });
  return priority;
}

function queueEntryEffectivePriority(entry: XrelBackgroundQueueEntry): XrelQueuePriority {
  const rank = queueEntryPriority(entry);
  return rank >= xrelQueuePriorityRank('library')
    ? 'library'
    : rank >= xrelQueuePriorityRank('visible') ? 'visible' : 'nearby';
}

function selectNextBackgroundEntry(): [string, XrelBackgroundQueueEntry] | undefined {
  const now = Date.now();
  return [...backgroundQueue.entries()]
    .filter(([key, entry]) => (
      key !== backgroundProcessingKey
      && entry.retryAt <= now
      && !lazyLookupPromises.has(key)
    ))
    .sort(([, left], [, right]) => (
      queueEntryPriority(right) - queueEntryPriority(left)
      || left.queuedAt - right.queuedAt
    ))[0];
}

function scheduleBackgroundWorker(
  delay = XREL_BACKGROUND_INITIAL_DELAY_MS,
  mode: XrelBackgroundTimerMode = 'normal',
): void {
  if (typeof window === 'undefined'
    || !readEnabledSetting()
    || backgroundProcessingKey !== null
    || backgroundQueue.size === 0
    || readBackgroundPaused()) return;
  if (backgroundTimer !== null) {
    if (backgroundTimerMode !== 'retry' || mode !== 'normal') return;
    window.clearTimeout(backgroundTimer);
    backgroundTimer = null;
  }
  backgroundTimerMode = mode;
  backgroundTimer = window.setTimeout(() => {
    backgroundTimer = null;
    backgroundTimerMode = null;
    void processBackgroundQueue();
  }, delay);
}

function scheduleNextBackgroundWorker(preferredDelay: number): void {
  if (selectNextBackgroundEntry()) {
    scheduleBackgroundWorker(preferredDelay);
    return;
  }
  const now = Date.now();
  const earliestRetryAt = [...backgroundQueue.entries()]
    .filter(([key]) => (
      key !== backgroundProcessingKey
      && !lazyLookupPromises.has(key)
    ))
    .reduce((earliest, [, entry]) => Math.min(earliest, entry.retryAt), Number.POSITIVE_INFINITY);
  if (Number.isFinite(earliestRetryAt)) {
    scheduleBackgroundWorker(Math.max(0, earliestRetryAt - now), 'retry');
  } else {
    scheduleBackgroundWorker(preferredDelay);
  }
}

function isGlobalBackgroundFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return !error.response || status === 429 || (typeof status === 'number' && status >= 500);
}

function globalBackgroundRetryDelay(error: unknown): number {
  if (axios.isAxiosError(error) && error.response?.status === 429) {
    const remaining = numberHeader(error.response, 'x-ratelimit-remaining');
    if (remaining === 0 && rateResetAt) {
      return Math.max(XREL_BACKGROUND_SERVICE_RETRY_MS, rateResetAt - Date.now());
    }
    return XREL_SEARCH_WINDOW_MS + 25;
  }
  return XREL_BACKGROUND_SERVICE_RETRY_MS;
}

async function processBackgroundQueue(): Promise<void> {
  if (backgroundProcessingKey !== null || backgroundQueue.size === 0) return;
  if (!canRunBackgroundLookup()) {
    if (readEnabledSetting() && isOnline() && !readBackgroundPaused()) {
      scheduleBackgroundWorker(15 * 60 * 1000);
    }
    emitChange();
    return;
  }

  const next = selectNextBackgroundEntry();
  if (!next) {
    scheduleNextBackgroundWorker(adaptiveBackgroundDelay());
    return;
  }
  const [key, queueEntry] = next;
  const { item } = queueEntry;

  if (entryForItem(item).entry || (cache.negativeLookups[key] ?? 0) > Date.now()) {
    backgroundQueue.delete(key);
    persistBackgroundQueue();
    emitChange();
    scheduleBackgroundWorker(0);
    return;
  }

  backgroundProcessingKey = key;
  const budget = currentBackgroundBudget();

  let globalRetryDelay: number | null = null;
  try {
    const classified = await fetchQueuedXrelQuality(item);
    if (classified > 0) delete cache.negativeLookups[key];
    else cache.negativeLookups[key] = Date.now() + negativeLookupFreshMs(item);
    enqueueSrrdbQualityEnrichment(item, queueEntryEffectivePriority(queueEntry));
    budget.completed += 1;
    lastError = null;
    backgroundQueue.delete(key);
    persistBackgroundQueue();
    persistCache();
    persistBackgroundBudget();
  } catch (error) {
    console.warn('[xREL] Background title lookup failed:', error);
    if (isGlobalBackgroundFailure(error)) globalRetryDelay = globalBackgroundRetryDelay(error);
    else queueEntry.retryAt = Date.now() + XREL_BACKGROUND_ENTRY_RETRY_MS;
    persistBackgroundQueue();
  } finally {
    backgroundProcessingKey = null;
    emitChange();
    if (globalRetryDelay !== null) scheduleBackgroundWorker(globalRetryDelay, 'global');
    else scheduleNextBackgroundWorker(adaptiveBackgroundDelay());
  }
}

const NOOP_UNREGISTER = () => {};

function mergeLookupItem(current: XrelLookupItem, incoming: XrelLookupItem): XrelLookupItem {
  return {
    type: incoming.type,
    name: incoming.name || current.name,
    year: incoming.year ?? current.year,
    imdbId: incoming.imdbId ?? current.imdbId,
    id: incoming.id ?? current.id,
    originalName: incoming.originalName ?? current.originalName,
    aliases: incoming.aliases?.length ? incoming.aliases : current.aliases,
  };
}

function dispatchResolvedIdentity(item: XrelLookupItem, priority: XrelQueuePriority): void {
  const knownImdbId = resolvedImdbId(item);
  if (knownImdbId) {
    enqueueSrrdbQualityEnrichment({ ...item, imdbId: knownImdbId }, priority);
    return;
  }
  if (!item.id) return;

  void resolveTmdbImdbId(item).then((imdbId) => {
    if (!imdbId) return;
    const changed = rememberResolvedIdentityAlias(item, imdbId);
    const key = lazyLookupKey(item);
    const queuedEntry = backgroundQueue.get(key);
    if (queuedEntry) {
      queuedEntry.item = mergeLookupItem(queuedEntry.item, { ...item, imdbId });
      persistBackgroundQueue();
    }
    if (changed) persistCache();
    enqueueSrrdbQualityEnrichment({ ...item, imdbId }, priority);
    emitChange();
  });
}

export function registerXrelQualityLookup(
  item: XrelLookupItem,
  priority: XrelQueuePriority,
): () => void {
  if (!readEnabledSetting() || typeof window === 'undefined') return NOOP_UNREGISTER;
  const key = lazyLookupKey(item);
  if (entryForItem(item).entry
    || (cache.negativeLookups[key] ?? 0) > Date.now()
    || (!backgroundQueue.has(key) && backgroundQueue.size >= XREL_MAX_BACKGROUND_QUEUE)) {
    return NOOP_UNREGISTER;
  }

  const registrationId = nextBackgroundRegistrationId;
  nextBackgroundRegistrationId += 1;
  const existingEntry = backgroundQueue.get(key);
  const entry = existingEntry ?? {
    item: { ...item },
    registrations: new Map<number, XrelQueuePriority>(),
    queuedAt: Date.now(),
    retryAt: 0,
  };
  if (existingEntry) entry.item = mergeLookupItem(existingEntry.item, item);
  entry.registrations.set(registrationId, priority);
  backgroundQueue.set(key, entry);
  persistBackgroundQueue();
  emitChange();
  scheduleBackgroundWorker();
  dispatchResolvedIdentity(entry.item, queueEntryEffectivePriority(entry));
  return () => {
    const current = backgroundQueue.get(key);
    if (!current || !current.registrations.delete(registrationId)) return;
    emitChange();
  };
}

export function enqueueXrelQualityLookup(
  item: XrelLookupItem,
  priority: XrelQueuePriority = 'visible',
): boolean {
  const before = backgroundQueue.size;
  const unregister = registerXrelQualityLookup(item, priority);
  return unregister !== NOOP_UNREGISTER && backgroundQueue.size >= before;
}

async function fetchReleasesForExtInfo(
  extInfoId: string,
  reportError = true
): Promise<XrelRelease[]> {
  const results = await Promise.allSettled([
    xrelGet<XrelFeedResponse>('/release/ext_info.json', {
      id: extInfoId,
      per_page: XREL_PAGE_SIZE,
      page: 1,
    }, reportError, 'precise'),
    xrelGet<XrelFeedResponse>('/p2p/releases.json', {
      ext_info_id: extInfoId,
      per_page: XREL_PAGE_SIZE,
      page: 1,
    }, reportError, 'precise'),
  ]);
  if (results.every((result) => result.status === 'rejected')) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
  return results.flatMap((result) => (
    result.status === 'fulfilled' && Array.isArray(result.value.data.list)
      ? result.value.data.list
      : []
  ));
}

async function fetchXrelQualityForItem(
  item: XrelLookupItem
): Promise<number> {
  for (const searchName of lookupNames(item).slice(0, 2)) {
    await waitForSearchSlot();
    const response = await xrelGet<XrelSearchResponse>('/search/ext_info.json', {
      q: searchName,
      type: item.type === 'movie' ? 'movie' : 'tv',
      limit: 25,
    }, false, 'precise');
    const results = response.data.results ?? response.data.result ?? [];
    const match = findSearchMatch(results, item);
    if (!match?.id) continue;
    const releases = (await fetchReleasesForExtInfo(match.id, false))
      .filter((release) => releaseMatchesItem(release, item));
    if (releases.length > 0) return mergeReleases(releases, true, 'xrel', 'precise');
  }
  return 0;
}

async function fetchSrrdbQualityForItem(
  item: Pick<MetaPreview, 'type' | 'name' | 'year' | 'imdbId'>,
  lookupTier: XrelLookupTier = 'precise',
): Promise<number> {
  const imdbId = item.imdbId?.trim().toLowerCase();
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return 0;
  try {
    const response = await axios.get<SrrdbSearchResponse>(
      `${SRRDB_API_BASE}/search/imdb:${imdbId.slice(2)}`,
      { timeout: 15_000 },
    );
    srrdbLastLookupAt = Date.now();
    srrdbLastError = null;
    if (!response.data || !Array.isArray(response.data.results)) {
      throw new Error('srrDB returned an invalid response.');
    }
    const releases: XrelRelease[] = (response.data.results ?? []).flatMap((result) => {
      const dirname = result.release?.trim();
      if (!dirname) return [];
      const parsedDate = result.date ? Date.parse(`${result.date}Z`) : Number.NaN;
      return [{
        id: `srrdb:${dirname}`,
        dirname,
        link_href: `https://www.srrdb.com/release/details/${encodeURIComponent(dirname)}`,
        time: Number.isFinite(parsedDate) ? Math.floor(parsedDate / 1000) : 0,
        flags: { english: result.isForeign?.toLowerCase() === 'no' },
        ext_info: {
          id: `imdb:${imdbId}`,
          type: item.type === 'movie' ? 'movie' : 'tv',
          title: item.name,
          uris: [`imdb:${imdbId}`],
        },
      }];
    });
    const classified = mergeReleases(releases, true, 'srrdb', lookupTier);
    if (lookupTier === 'precise') {
      cache.srrdbLookups[imdbId] = Date.now() + providerLookupFreshMs(item, classified);
    }
    return classified;
  } catch (error) {
    srrdbLastLookupAt = Date.now();
    srrdbLastError = errorMessage(error, 'srrDB');
    throw error;
  }
}

function canRunSrrdbBackgroundLookup(): boolean {
  const budget = currentSrrdbBackgroundBudget();
  return readEnabledSetting()
    && !readBackgroundPaused()
    && isOnline()
    && budget.requests < SRRDB_BACKGROUND_HOURLY_LIMIT
    && budget.cooldownUntil <= Date.now();
}

function cancelSrrdbBackgroundTimer(): void {
  if (srrdbBackgroundTimer === null || typeof window === 'undefined') return;
  window.clearTimeout(srrdbBackgroundTimer);
  srrdbBackgroundTimer = null;
}

function scheduleSrrdbBackgroundWorker(delay = SRRDB_BACKGROUND_INTERVAL_MS): void {
  if (typeof window === 'undefined'
    || !readEnabledSetting()
    || readBackgroundPaused()
    || srrdbBackgroundTimer !== null
    || srrdbBackgroundProcessingKey !== null
    || srrdbBackgroundQueue.size === 0) return;
  srrdbBackgroundTimer = window.setTimeout(() => {
    srrdbBackgroundTimer = null;
    void processSrrdbBackgroundQueue();
  }, delay);
}

function selectNextSrrdbBackgroundEntry(): [string, SrrdbBackgroundQueueEntry] | undefined {
  return [...srrdbBackgroundQueue.entries()]
    .sort(([, left], [, right]) => (
      xrelQueuePriorityRank(right.priority) - xrelQueuePriorityRank(left.priority)
      || left.queuedAt - right.queuedAt
    ))[0];
}

function srrdbRetryDelay(error: unknown): number {
  return axios.isAxiosError(error) && error.response?.status === 503
    ? SRRDB_BACKGROUND_COOLDOWN_MS
    : 60 * 1000;
}

async function processSrrdbBackgroundQueue(): Promise<void> {
  if (srrdbBackgroundProcessingKey !== null || srrdbBackgroundQueue.size === 0) return;
  if (!canRunSrrdbBackgroundLookup()) {
    const budget = currentSrrdbBackgroundBudget();
    if (readEnabledSetting() && isOnline() && !readBackgroundPaused()) {
      const resumeAt = Math.max(
        budget.requests >= SRRDB_BACKGROUND_HOURLY_LIMIT ? budget.resetAt : 0,
        budget.cooldownUntil,
      );
      scheduleSrrdbBackgroundWorker(Math.max(60 * 1000, resumeAt - Date.now()));
    }
    emitChange();
    return;
  }

  const next = selectNextSrrdbBackgroundEntry();
  if (!next) return;
  const [imdbId, entry] = next;
  const badgeRank = entryForItem(entry.item).entry?.rank ?? 0;
  if ((cache.srrdbLookups[imdbId] ?? 0) > Date.now() || badgeRank >= 96) {
    srrdbBackgroundQueue.delete(imdbId);
    persistSrrdbBackgroundQueue();
    emitChange();
    scheduleSrrdbBackgroundWorker(0);
    return;
  }

  srrdbBackgroundProcessingKey = imdbId;
  const budget = currentSrrdbBackgroundBudget();
  budget.requests += 1;
  persistSrrdbBackgroundBudget();
  emitChange();
  let retryDelay: number | null = null;
  try {
    const classified = await fetchSrrdbQualityForItem(entry.item, 'background');
    cache.srrdbLookups[imdbId] = Date.now() + providerLookupFreshMs(entry.item, classified);
    budget.completed += 1;
    budget.cooldownUntil = 0;
    srrdbBackgroundQueue.delete(imdbId);
    persistCache();
    persistSrrdbBackgroundQueue();
    persistSrrdbBackgroundBudget();
  } catch (error) {
    retryDelay = srrdbRetryDelay(error);
    budget.cooldownUntil = Date.now() + retryDelay;
    persistSrrdbBackgroundBudget();
  } finally {
    srrdbBackgroundProcessingKey = null;
    emitChange();
    scheduleSrrdbBackgroundWorker(retryDelay ?? SRRDB_BACKGROUND_INTERVAL_MS);
  }
}

export function enqueueSrrdbQualityEnrichment(
  item: XrelLookupItem,
  priority: XrelQueuePriority = 'visible',
): boolean {
  if (!readEnabledSetting() || typeof window === 'undefined') return false;
  const imdbId = resolvedImdbId(item);
  if (!imdbId) {
    if (!item.id) return false;
    void resolveTmdbImdbId(item).then((resolvedId) => {
      if (!resolvedId) return;
      if (rememberResolvedIdentityAlias(item, resolvedId)) {
        persistCache();
        emitChange();
      }
      enqueueSrrdbQualityEnrichment({ ...item, imdbId: resolvedId }, priority);
    });
    return true;
  }
  if ((cache.srrdbLookups[imdbId] ?? 0) > Date.now()) return false;
  if ((entryForItem(item).entry?.rank ?? 0) >= 96) return false;
  const existing = srrdbBackgroundQueue.get(imdbId);
  if (!existing && srrdbBackgroundQueue.size >= XREL_MAX_BACKGROUND_QUEUE) return false;
  if (existing) {
    if (xrelQueuePriorityRank(priority) > xrelQueuePriorityRank(existing.priority)) {
      existing.priority = priority;
      persistSrrdbBackgroundQueue();
      emitChange();
    }
  } else {
    srrdbBackgroundQueue.set(imdbId, {
      item: { type: item.type, name: item.name, year: item.year, imdbId },
      priority,
      queuedAt: Date.now(),
    });
    persistSrrdbBackgroundQueue();
    emitChange();
  }
  scheduleSrrdbBackgroundWorker();
  return true;
}

export async function ensureXrelQualityForItem(
  item: XrelLookupItem
): Promise<void> {
  if (!readEnabledSetting() || !isOnline()) return;
  if (rememberIdentityAlias(item)) {
    persistCache();
    emitChange();
  }
  const key = lazyLookupKey(item);
  const preciseVerifiedAt = cache.preciseLookups[key] ?? 0;
  if (Date.now() - preciseVerifiedAt < XREL_PRECISE_LOOKUP_FRESH_MS) return;
  const existing = lazyLookupPromises.get(key);
  if (existing) return existing;

  const lookup = (async () => {
    lastError = null;
    emitChange();
    const tmdbImdbId = await resolveTmdbImdbId(item);
    const resolvedItem = tmdbImdbId ? { ...item, imdbId: tmdbImdbId } : item;
    if (tmdbImdbId && rememberResolvedIdentityAlias(item, tmdbImdbId)) {
      persistCache();
      emitChange();
    }
    const attempts: Array<{ service: string; task: Promise<number> }> = [
      { service: 'xREL', task: fetchXrelQualityForItem(resolvedItem) },
      ...(resolvedItem.imdbId
        ? [{ service: 'srrDB', task: fetchSrrdbQualityForItem(resolvedItem) }]
        : []),
    ];
    let successfulProviders = 0;
    let classifiedReleases = 0;
    const failures: string[] = [];

    await Promise.all(attempts.map(async (attempt) => {
      try {
        const classified = await attempt.task;
        successfulProviders += 1;
        classifiedReleases += classified;
        if (classified > 0) {
          delete cache.negativeLookups[key];
          persistCache();
          emitChange();
        }
      } catch (error) {
        failures.push(errorMessage(error, attempt.service));
      }
    }));

    if (classifiedReleases === 0 && successfulProviders === attempts.length) {
      cache.negativeLookups[key] = Date.now() + negativeLookupFreshMs(item);
    }
    if (successfulProviders > 0) {
      const freshMs = providerLookupFreshMs(item, classifiedReleases);
      cache.preciseLookups[key] = preciseLookupMarker(
        successfulProviders === attempts.length ? freshMs : Math.min(freshMs, 24 * 60 * 60 * 1000),
      );
    }
    lastError = successfulProviders === 0
      ? failures[0] ?? 'Release-quality lookup failed.'
      : null;
    persistCache();
  })().finally(() => {
    lazyLookupPromises.delete(key);
    emitChange();
  });
  lazyLookupPromises.set(key, lookup);
  emitChange();
  return lookup;
}

export function getXrelQualityBadgesEnabled(): boolean {
  return readEnabledSetting();
}

export function setXrelQualityBadgesEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(XREL_ENABLED_STORAGE_KEY, String(enabled));
  } catch (error) {
    console.warn('[xREL] Failed to persist badge preference:', error);
  }
  emitChange();
  if (enabled) {
    startRefreshLoop();
    scheduleBackgroundWorker();
    scheduleSrrdbBackgroundWorker();
  } else {
    stopRefreshLoop();
    cancelBackgroundTimer();
    cancelSrrdbBackgroundTimer();
    emitChange();
  }
}

export function setXrelBackgroundLookupsPaused(paused: boolean): void {
  try {
    localStorage.setItem(XREL_BACKGROUND_PAUSED_STORAGE_KEY, String(paused));
  } catch (error) {
    console.warn('[xREL] Failed to persist background queue preference:', error);
  }
  if (paused) {
    cancelBackgroundTimer();
    cancelSrrdbBackgroundTimer();
  } else {
    scheduleBackgroundWorker(0);
    scheduleSrrdbBackgroundWorker(0);
    void refreshSrrdbReleaseQualities();
  }
  emitChange();
}

export function setXrelLanguagePreference(preference: XrelLanguagePreference): void {
  localStorage.setItem(XREL_LANGUAGE_STORAGE_KEY, normalizeXrelLanguagePreference(preference));
  rebuildIndexes();
  emitChange();
}

export function setXrelBadgeDisplayMode(mode: XrelBadgeDisplayMode): void {
  localStorage.setItem(XREL_DISPLAY_MODE_STORAGE_KEY, normalizeXrelBadgeDisplayMode(mode));
  emitChange();
}

export function clearXrelReleaseCache(rebuild = false): void {
  cache = {
    ...EMPTY_CACHE,
    seenReleaseIds: [],
    entries: [],
    negativeLookups: {},
    preciseLookups: {},
    identityAliases: {},
    srrdbLookups: {},
  };
  srrdbFeedFetchedAt = 0;
  if (nativeCacheStorageEnabled) {
    nativeCacheWriteChain = nativeCacheWriteChain
      .catch(() => undefined)
      .then(() => invoke<void>('clear_xrel_release_cache'))
      .catch((error) => console.warn('[xREL] Failed to clear AppData release quality cache:', error));
  }
  localStorage.removeItem(XREL_CACHE_STORAGE_KEY);
  localStorage.removeItem(XREL_LEGACY_CACHE_STORAGE_KEY);
  localStorage.removeItem(SRRDB_FEED_REFRESH_STORAGE_KEY);
  rebuildIndexes();
  emitChange();
  if (rebuild && readEnabledSetting()) {
    void refreshXrelReleaseQualities(true).then(() => refreshSrrdbReleaseQualities(true));
  }
}

export function getXrelQualitySnapshot(): XrelQualitySnapshot {
  return snapshot;
}

export function subscribeXrelQualitySnapshot(listener: () => void): () => void {
  listeners.add(listener);
  startRefreshLoop();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopRefreshLoop();
  };
}

function entryForItem(
  item: XrelLookupItem,
  scope?: { season?: number; episode?: number }
): { entry?: XrelTitleEntry; matchMethod: XrelMatchMethod } {
  const imdbId = resolvedImdbId(item);
  const titles = lookupNames(item).map(normalizeXrelTitle);
  const title = titles[0];
  const season = scope?.season;
  const episode = scope?.episode;

  if (item.type === 'series' && season !== undefined && episode !== undefined) {
    const imdbEntry = imdbId ? byImdbEpisode.get(`${imdbId}:s${season}e${episode}`) : undefined;
    if (imdbEntry) return { entry: imdbEntry, matchMethod: 'imdb' };
    const titleEntry = byTitleEpisode.get(`${title}:s${season}e${episode}`);
    if (titleEntry) return { entry: titleEntry, matchMethod: 'title' };
    const imdbSeasonPack = imdbId ? byImdbSeason.get(`${imdbId}:s${season}`) : undefined;
    if (imdbSeasonPack?.episode === undefined) return { entry: imdbSeasonPack, matchMethod: 'imdb' };
    const titleSeasonPack = byTitleSeason.get(`${title}:s${season}`);
    if (titleSeasonPack?.episode === undefined) return { entry: titleSeasonPack, matchMethod: 'title' };
    return { matchMethod: imdbId ? 'imdb' : 'title' };
  }

  if (item.type === 'series' && season !== undefined) {
    const imdbEntry = imdbId ? byImdbSeason.get(`${imdbId}:s${season}`) : undefined;
    if (imdbEntry) return { entry: imdbEntry, matchMethod: 'imdb' };
    const titleEntry = byTitleSeason.get(`${title}:s${season}`);
    return { entry: titleEntry, matchMethod: 'title' };
  }

  const imdbEntry = imdbId ? byImdb.get(imdbId) : undefined;
  if (imdbEntry) return { entry: imdbEntry, matchMethod: 'imdb' };
  if (item.year) {
    const numericYear = Number(item.year);
    const compatibleYears = Number.isFinite(numericYear)
      ? [numericYear, numericYear - 1, numericYear + 1].map(String)
      : [item.year];
    const candidates = new Map<string, XrelTitleEntry>();
    for (const candidateTitle of lookupNames(item)) {
      for (const candidateYear of compatibleYears) {
        const candidate = byTitleYear.get(`${item.type}:${xrelTitleYearKey(candidateTitle, candidateYear)}`);
        if (candidate && !identityConflicts(imdbId, candidate.imdbId)) {
          candidates.set(candidate.cacheKey, candidate);
        }
      }
    }
    const candidateEntries = [...candidates.values()];
    if (!imdbId) {
      const candidateImdbIds = new Set(candidateEntries.map((entry) => entry.imdbId).filter(Boolean));
      if (candidateImdbIds.size > 1) return { matchMethod: 'title-year' };
    }
    const titleYearEntry = candidateEntries.reduce<XrelTitleEntry | undefined>(selectBetter, undefined);
    if (titleYearEntry) return { entry: titleYearEntry, matchMethod: 'title-year' };
  }
  if (item.type === 'series') {
    const titleEntry = titles
      .map((candidateTitle) => bySeriesTitle.get(candidateTitle))
      .filter((entry): entry is XrelTitleEntry => !!entry)
      .reduce<XrelTitleEntry | undefined>(selectBetter, undefined);
    return { entry: titleEntry, matchMethod: 'title' };
  }
  return { matchMethod: item.year ? 'title-year' : 'title' };
}

export function getXrelQualityBadge(
  item: XrelLookupItem,
  scope?: { season?: number; episode?: number }
): XrelQualityBadge | null {
  if (!readEnabledSetting()) return null;
  const { entry, matchMethod } = entryForItem(item, scope);
  if (!entry) return null;
  if (readDisplayMode() === 'minimal' && !notableBadge(entry)) return null;
  const upgradeIsRecent = hasActiveUpgrade(entry);
  return {
    provider: entry.provider,
    lookupTier: entry.lookupTier,
    verifiedAt: entry.verifiedAt,
    label: entry.label,
    rank: entry.rank,
    resolution: entry.resolution,
    dynamicRange: entry.dynamicRange,
    source: entry.source,
    codec: entry.codec,
    audio: entry.audio,
    dirname: entry.dirname,
    releaseUrl: entry.releaseUrl,
    updatedAt: entry.updatedAt,
    language: entry.language,
    season: entry.season,
    episode: entry.episode,
    matchMethod,
    previousLabel: upgradeIsRecent ? entry.previousLabel : undefined,
    upgradedAt: upgradeIsRecent ? entry.upgradedAt : undefined,
  };
}

rebuildIndexes();
