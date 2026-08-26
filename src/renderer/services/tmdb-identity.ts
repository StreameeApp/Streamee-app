import axios from 'axios';
import {
  getPersistentlyCachedRequest,
  readPersistentlyCachedValue,
  writePersistentlyCachedValues,
} from './request-cache.ts';
import { tmdbClient } from './tmdb-api.ts';

const TMDB_EXTERNAL_ID_CACHE_MS = 90 * 24 * 60 * 60 * 1000;
const TMDB_EXTERNAL_ID_NEGATIVE_CACHE_MS = 6 * 60 * 60 * 1000;
const TMDB_PREVIEW_DETAIL_CACHE_MS = 24 * 60 * 60 * 1000;
const TMDB_EXTERNAL_ID_MAX_RETRIES = 3;
const TMDB_EXTERNAL_ID_CONCURRENCY = 4;
const TMDB_EXTERNAL_ID_BATCH_SIZE = 20;
const TMDB_EXTERNAL_ID_BATCH_DELAY_MS = 10;

let activeRequests = 0;
const requestQueue: Array<() => void> = [];
const identityBatchQueue: Array<{
  mediaType: 'movie' | 'tv';
  tmdbId: string;
  resolve: (imdbId: string | undefined) => void;
  reject: (error: unknown) => void;
}> = [];
let identityBatchTimer: number | undefined;

interface TmdbIdentityDetail {
  imdb_id?: string;
  external_ids?: { imdb_id?: string };
}

function readImdbId(detail: TmdbIdentityDetail | undefined): string | undefined {
  const imdbId = detail?.external_ids?.imdb_id ?? detail?.imdb_id;
  return imdbId && /^tt\d+$/.test(imdbId) ? imdbId : undefined;
}

async function withRequestSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeRequests >= TMDB_EXTERNAL_ID_CONCURRENCY) {
    await new Promise<void>((resolve) => requestQueue.push(resolve));
  }
  activeRequests += 1;
  try {
    return await operation();
  } finally {
    activeRequests -= 1;
    requestQueue.shift()?.();
  }
}

function waitForRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 300 * 2 ** attempt));
}

async function fetchExternalIdIndividually(
  mediaType: 'movie' | 'tv',
  tmdbId: string,
): Promise<string | undefined> {
  return withRequestSlot(async () => {
    for (let attempt = 0; attempt < TMDB_EXTERNAL_ID_MAX_RETRIES; attempt += 1) {
      try {
        const response = await tmdbClient.get<{ imdb_id?: string }>(
          `/${mediaType}/${tmdbId}/external_ids`,
        );
        const imdbId = response.data.imdb_id?.trim();
        return imdbId && /^tt\d+$/.test(imdbId) ? imdbId : undefined;
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const retryable = status === 429 || (typeof status === 'number' && status >= 500);
        if (!retryable || attempt === TMDB_EXTERNAL_ID_MAX_RETRIES - 1) throw error;
        await waitForRetry(attempt);
      }
    }
    return undefined;
  });
}

function scheduleIdentityBatch(): void {
  if (identityBatchTimer !== undefined) return;
  identityBatchTimer = window.setTimeout(() => {
    identityBatchTimer = undefined;
    void flushIdentityBatch();
  }, TMDB_EXTERNAL_ID_BATCH_DELAY_MS);
}

async function flushIdentityBatch(): Promise<void> {
  const batch = identityBatchQueue.splice(0, TMDB_EXTERNAL_ID_BATCH_SIZE);
  if (batch.length === 0) return;

  let identities: Map<string, string | undefined> | null = null;
  try {
    const canonicalItems = batch
      .map((item) => `${item.mediaType}:${item.tmdbId}`)
      .sort();
    const response = await tmdbClient.get<{
      items: Array<{
        mediaType: 'movie' | 'tv';
        tmdbId: number;
        detail: TmdbIdentityDetail;
      }>;
    }>('/aggregate/previews', {
      params: { items: canonicalItems.join(',') },
    });
    identities = new Map(response.data.items.map((item) => [
      `${item.mediaType}:${item.tmdbId}`,
      readImdbId(item.detail),
    ]));
    await writePersistentlyCachedValues(
      response.data.items.map((item) => ({
        key: `tmdb:preview-detail:${item.mediaType}:${item.tmdbId}`,
        value: item.detail,
      })),
      TMDB_PREVIEW_DETAIL_CACHE_MS,
    );

  } catch {
    identities = null;
  }

  await Promise.all(batch.map(async (item) => {
    const key = `${item.mediaType}:${item.tmdbId}`;
    if (identities?.has(key)) {
      item.resolve(identities.get(key));
      return;
    }
    try {
      item.resolve(await fetchExternalIdIndividually(item.mediaType, item.tmdbId));
    } catch (error) {
      item.reject(error);
    }
  }));
  if (identityBatchQueue.length > 0) scheduleIdentityBatch();
}

function queueExternalIdLookup(
  mediaType: 'movie' | 'tv',
  tmdbId: string,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    identityBatchQueue.push({ mediaType, tmdbId, resolve, reject });
    scheduleIdentityBatch();
  });
}

export async function resolveTmdbImdbId(item: {
  id?: string;
  type: 'movie' | 'series';
  imdbId?: string;
}): Promise<string | undefined> {
  const existingImdbId = item.imdbId?.trim();
  if (existingImdbId) return existingImdbId;

  const match = /^(movie|tv):(\d+)$/.exec(item.id ?? '');
  if (!match) return undefined;
  const mediaType = match[1] as 'movie' | 'tv';
  if ((item.type === 'movie') !== (mediaType === 'movie')) return undefined;
  const cachedDetail = await readPersistentlyCachedValue<TmdbIdentityDetail>(
    `tmdb:preview-detail:${mediaType}:${match[2]}`,
  ) ?? await readPersistentlyCachedValue<TmdbIdentityDetail>(
    `tmdb:title-detail:${mediaType}:${match[2]}`,
  );
  const cachedImdbId = readImdbId(cachedDetail);
  if (cachedImdbId) return cachedImdbId;
  return getPersistentlyCachedRequest(
    `tmdb:external-id:${mediaType}:${match[2]}`,
    (imdbId: string | undefined) => imdbId
      ? TMDB_EXTERNAL_ID_CACHE_MS
      : TMDB_EXTERNAL_ID_NEGATIVE_CACHE_MS,
    () => queueExternalIdLookup(mediaType, match[2]),
  );
}
