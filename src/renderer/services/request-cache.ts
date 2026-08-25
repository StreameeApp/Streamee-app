interface RequestCacheEntry {
  expiresAt: number;
  promise: Promise<unknown>;
}

const DEFAULT_MAX_ENTRIES = 300;
const requestCache = new Map<string, RequestCacheEntry>();

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
