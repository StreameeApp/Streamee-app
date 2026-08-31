import { invoke } from '@tauri-apps/api/core';

interface RequestCacheEntry {
  expiresAt: number;
  promise: Promise<unknown>;
}

interface PersistentRequestCacheEntry {
  key: string;
  expiresAt: number;
  storedAt: number;
  value: unknown;
}

const DEFAULT_MAX_ENTRIES = 1_500;
const DEFAULT_STALE_FALLBACK_TTL_MS = 15 * 60 * 1000;
const PERSISTENT_CACHE_DATABASE = 'streamee-request-cache';
const PERSISTENT_CACHE_STORE = 'responses';
const SHARED_CACHE_SAVE_DELAY_MS = 100;
const SHARED_CACHE_PATCH_FLAG = '__streameeSharedRequestCachePatchedV1';
const requestCache = new Map<string, RequestCacheEntry>();
let persistentCacheDatabasePromise: Promise<IDBDatabase> | null = null;
let sharedCacheEntries: Map<string, PersistentRequestCacheEntry> | null = null;
let sharedCacheInitializationPromise: Promise<void> | null = null;
let sharedCacheSaveTimer: number | null = null;
let sharedCacheWriteChain: Promise<unknown> = Promise.resolve();

function openPersistentCacheDatabase(): Promise<IDBDatabase> {
  if (persistentCacheDatabasePromise) return persistentCacheDatabasePromise;

  const databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PERSISTENT_CACHE_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PERSISTENT_CACHE_STORE)) {
        const store = database.createObjectStore(PERSISTENT_CACHE_STORE, { keyPath: 'key' });
        store.createIndex('storedAt', 'storedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the response cache.'));
  });
  persistentCacheDatabasePromise = databasePromise.catch((error) => {
    persistentCacheDatabasePromise = null;
    throw error;
  });

  return persistentCacheDatabasePromise;
}

function isPersistentRequestCacheEntry(value: unknown): value is PersistentRequestCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<PersistentRequestCacheEntry>;
  return typeof entry.key === 'string'
    && Number.isFinite(entry.expiresAt)
    && Number.isFinite(entry.storedAt)
    && Object.prototype.hasOwnProperty.call(entry, 'value');
}

function readAllPersistentRequests(database: IDBDatabase): Promise<PersistentRequestCacheEntry[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PERSISTENT_CACHE_STORE, 'readonly');
    const request = transaction.objectStore(PERSISTENT_CACHE_STORE).getAll();
    request.onsuccess = () => resolve(
      (request.result as unknown[]).filter(isPersistentRequestCacheEntry),
    );
    request.onerror = () => reject(request.error ?? new Error('Could not read the response cache.'));
  });
}

function replacePersistentRequests(
  database: IDBDatabase,
  entries: PersistentRequestCacheEntry[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PERSISTENT_CACHE_STORE, 'readwrite');
    const store = transaction.objectStore(PERSISTENT_CACHE_STORE);
    store.clear();
    entries.forEach((entry) => store.put(entry));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not synchronize the response cache.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Response cache synchronization was aborted.'));
  });
}

function pruneSharedCacheEntries(maxEntries: number, removeExpired: boolean): void {
  if (!sharedCacheEntries) return;
  const now = Date.now();
  if (removeExpired) {
    for (const [key, entry] of sharedCacheEntries) {
      if (entry.expiresAt <= now) sharedCacheEntries.delete(key);
    }
  }
  const oldestFirst = [...sharedCacheEntries.values()].sort((left, right) => left.storedAt - right.storedAt);
  while (oldestFirst.length > maxEntries) {
    const oldest = oldestFirst.shift();
    if (oldest) sharedCacheEntries.delete(oldest.key);
  }
}

function serializeSharedCache(): string {
  return JSON.stringify(
    [...(sharedCacheEntries?.values() ?? [])].sort((left, right) => left.key.localeCompare(right.key)),
  );
}

function flushSharedCache(): void {
  if (sharedCacheSaveTimer !== null) {
    window.clearTimeout(sharedCacheSaveTimer);
    sharedCacheSaveTimer = null;
  }
  const value = serializeSharedCache();
  sharedCacheWriteChain = sharedCacheWriteChain
    .catch(() => undefined)
    .then(() => invoke<void>('write_request_cache', { value }))
    .catch((error) => console.error('[Storage] Failed to save shared request cache:', error));
}

function scheduleSharedCacheSave(): void {
  if (sharedCacheSaveTimer !== null) window.clearTimeout(sharedCacheSaveTimer);
  sharedCacheSaveTimer = window.setTimeout(flushSharedCache, SHARED_CACHE_SAVE_DELAY_MS);
}

function installSharedCacheFlush(): void {
  const patchedWindow = window as unknown as Record<string, unknown>;
  if (patchedWindow[SHARED_CACHE_PATCH_FLAG]) return;
  patchedWindow[SHARED_CACHE_PATCH_FLAG] = true;
  window.addEventListener('pagehide', flushSharedCache);
}

export function initializeSharedRequestCache(): Promise<void> {
  if (sharedCacheInitializationPromise) return sharedCacheInitializationPromise;

  sharedCacheInitializationPromise = (async () => {
    const database = await openPersistentCacheDatabase();
    const localEntries = await readAllPersistentRequests(database);
    let nativeEntries: PersistentRequestCacheEntry[] = [];
    try {
      const nativeValue = await invoke<unknown[] | null>('read_request_cache');
      nativeEntries = (nativeValue ?? []).filter(isPersistentRequestCacheEntry);
    } catch (error) {
      console.warn('[Storage] Shared request cache is unavailable; using this origin\'s IndexedDB:', error);
    }

    const merged = new Map<string, PersistentRequestCacheEntry>();
    for (const entry of [...localEntries, ...nativeEntries]) {
      const current = merged.get(entry.key);
      if (!current || entry.storedAt >= current.storedAt) merged.set(entry.key, entry);
    }
    sharedCacheEntries = merged;
    pruneSharedCacheEntries(DEFAULT_MAX_ENTRIES, false);
    const synchronizedEntries = [...sharedCacheEntries.values()];
    await replacePersistentRequests(database, synchronizedEntries);
    installSharedCacheFlush();
    try {
      await invoke<void>('write_request_cache', { value: serializeSharedCache() });
    } catch (error) {
      console.warn('[Storage] Could not initialize the shared request cache:', error);
    }
  })().catch((error) => {
    sharedCacheEntries = new Map();
    installSharedCacheFlush();
    console.error('[Storage] Request cache synchronization failed; continuing without persistent cache:', error);
  });

  return sharedCacheInitializationPromise;
}

async function readPersistentRequest(key: string): Promise<PersistentRequestCacheEntry | null> {
  await initializeSharedRequestCache();
  const database = await openPersistentCacheDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PERSISTENT_CACHE_STORE, 'readwrite');
    const store = transaction.objectStore(PERSISTENT_CACHE_STORE);
    const request = store.get(key);
    const now = Date.now();
    let result: PersistentRequestCacheEntry | null = null;

    request.onsuccess = () => {
      const entry = (request.result as PersistentRequestCacheEntry | undefined) ?? null;
      result = entry;
      if (entry && entry.expiresAt > now && entry.storedAt < now) {
        result = { ...entry, storedAt: now };
        store.put(result);
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Could not read the response cache.'));
    transaction.oncomplete = () => {
      if (result && sharedCacheEntries) {
        sharedCacheEntries.set(result.key, result);
        scheduleSharedCacheSave();
      }
      resolve(result);
    };
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not refresh response cache recency.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Response cache recency update was aborted.'));
  });
}

async function writePersistentRequest<T>(
  key: string,
  value: T,
  expiresAt: number,
  maxEntries: number,
): Promise<void> {
  return writePersistentRequests([{ key, value }], expiresAt, maxEntries);
}

async function writePersistentRequests<T>(
  entries: Array<{ key: string; value: T }>,
  expiresAt: number,
  maxEntries: number,
): Promise<void> {
  if (entries.length === 0) return;
  await initializeSharedRequestCache();
  const database = await openPersistentCacheDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PERSISTENT_CACHE_STORE, 'readwrite');
    const store = transaction.objectStore(PERSISTENT_CACHE_STORE);
    const now = Date.now();
    for (const { key, value } of entries) {
      store.put({ key, value, expiresAt, storedAt: now } satisfies PersistentRequestCacheEntry);
    }

    const cursorRequest = store.index('storedAt').openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        const countRequest = store.count();
        countRequest.onsuccess = () => {
          let entriesToDelete = Math.max(0, countRequest.result - maxEntries);
          if (entriesToDelete === 0) return;
          const oldestRequest = store.index('storedAt').openCursor();
          oldestRequest.onsuccess = () => {
            const oldest = oldestRequest.result;
            if (!oldest || entriesToDelete === 0) return;
            oldest.delete();
            entriesToDelete -= 1;
            oldest.continue();
          };
        };
        return;
      }
      const entry = cursor.value as PersistentRequestCacheEntry;
      if (entry.expiresAt <= now) {
        cursor.delete();
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not write the response cache.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Response cache write was aborted.'));
  });
  if (sharedCacheEntries) {
    const storedAt = Date.now();
    for (const { key, value } of entries) {
      sharedCacheEntries.set(key, { key, value, expiresAt, storedAt });
    }
    pruneSharedCacheEntries(maxEntries, true);
    scheduleSharedCacheSave();
  }
}

function pruneRequestCache(maxEntries: number): void {
  const now = Date.now();
  for (const [key, entry] of requestCache) {
    if (entry.expiresAt <= now) {
      requestCache.delete(key);
    }
  }

  while (requestCache.size >= maxEntries) {
    const oldestKey = requestCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    requestCache.delete(oldestKey);
  }
}

export function getCachedRequest<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  maxEntries: number = DEFAULT_MAX_ENTRIES
): Promise<T> {
  const cached = requestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise as Promise<T>;
  }

  if (cached) {
    requestCache.delete(key);
  }
  pruneRequestCache(maxEntries);

  const promise = load().catch((error) => {
    const current = requestCache.get(key);
    if (current?.promise === promise) {
      requestCache.delete(key);
    }
    throw error;
  });

  requestCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    promise
  });
  return promise;
}

export function getPersistentlyCachedRequest<T>(
  key: string,
  ttlMs: number | ((value: T) => number),
  load: () => Promise<T>,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): Promise<T> {
  const memoryKey = `persistent:${key}`;
  const cached = requestCache.get(memoryKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise as Promise<T>;
  }
  if (cached) requestCache.delete(memoryKey);
  pruneRequestCache(maxEntries);

  const cacheEntry: RequestCacheEntry = {
    expiresAt: Date.now() + (typeof ttlMs === 'number' ? ttlMs : DEFAULT_STALE_FALLBACK_TTL_MS),
    promise: Promise.resolve(undefined),
  };
  const promise = (async () => {
    let staleEntry: PersistentRequestCacheEntry | null = null;
    try {
      const persistent = await readPersistentRequest(key);
      if (persistent && persistent.expiresAt > Date.now()) {
        cacheEntry.expiresAt = persistent.expiresAt;
        return persistent.value as T;
      }
      staleEntry = persistent;
    } catch (error) {
      console.warn('Persistent response cache is unavailable:', error);
    }

    let value: T;
    try {
      value = await load();
    } catch (error) {
      if (staleEntry) {
        cacheEntry.expiresAt = Date.now() + DEFAULT_STALE_FALLBACK_TTL_MS;
        console.warn('Using a stale cached response after its refresh failed.', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        return staleEntry.value as T;
      }
      throw error;
    }
    const resolvedTtlMs = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
    const expiresAt = Date.now() + Math.max(0, resolvedTtlMs);
    cacheEntry.expiresAt = expiresAt;
    try {
      await writePersistentRequest(key, value, expiresAt, maxEntries);
    } catch (error) {
      console.warn('Could not persist a cached response:', error);
    }
    return value;
  })().catch((error) => {
    if (requestCache.get(memoryKey) === cacheEntry) requestCache.delete(memoryKey);
    throw error;
  });

  cacheEntry.promise = promise;
  requestCache.set(memoryKey, cacheEntry);
  return promise;
}

export async function readPersistentlyCachedValue<T>(key: string): Promise<T | undefined> {
  const memoryKey = `persistent:${key}`;
  const cached = requestCache.get(memoryKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise as Promise<T>;
  }
  if (cached) requestCache.delete(memoryKey);

  try {
    const persistent = await readPersistentRequest(key);
    if (!persistent || persistent.expiresAt <= Date.now()) return undefined;
    const promise = Promise.resolve(persistent.value as T);
    requestCache.set(memoryKey, { expiresAt: persistent.expiresAt, promise });
    return persistent.value as T;
  } catch (error) {
    console.warn('Persistent response cache is unavailable:', error);
    return undefined;
  }
}

export async function writePersistentlyCachedValue<T>(
  key: string,
  value: T,
  ttlMs: number,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): Promise<void> {
  return writePersistentlyCachedValues([{ key, value }], ttlMs, maxEntries);
}

export async function writePersistentlyCachedValues<T>(
  entries: Array<{ key: string; value: T }>,
  ttlMs: number,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): Promise<void> {
  if (entries.length === 0) return;
  const expiresAt = Date.now() + ttlMs;
  for (const { key, value } of entries) {
    requestCache.set(`persistent:${key}`, {
      expiresAt,
      promise: Promise.resolve(value),
    });
  }
  pruneRequestCache(maxEntries + 1);
  try {
    await writePersistentRequests(entries, expiresAt, maxEntries);
  } catch (error) {
    console.warn('Could not persist a cached response:', error);
  }
}

export function invalidateRequestCache(prefix?: string): void {
  if (!prefix) {
    requestCache.clear();
    return;
  }

  for (const key of requestCache.keys()) {
    if (key.startsWith(prefix)) {
      requestCache.delete(key);
    }
  }
}

export function deleteCachedRequest(key: string): void {
  requestCache.delete(key);
}
