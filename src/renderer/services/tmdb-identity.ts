import axios from 'axios';
import { getCachedRequest } from './request-cache.ts';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_EXTERNAL_ID_CACHE_MS = 24 * 60 * 60 * 1000;
const TMDB_EXTERNAL_ID_MAX_RETRIES = 3;
const TMDB_EXTERNAL_ID_CONCURRENCY = 4;

let activeRequests = 0;
const requestQueue: Array<() => void> = [];

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

function tmdbApiKey(): string {
  try {
    const stored = localStorage.getItem('streamee-tmdb');
    if (!stored) return '';
    const parsed = JSON.parse(stored) as { apiKey?: unknown };
    return typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
  } catch {
    return '';
  }
}

function waitForRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 300 * 2 ** attempt));
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
  const apiKey = tmdbApiKey();
  if (!apiKey) return undefined;

  return getCachedRequest(
    `tmdb:external-id:${mediaType}:${match[2]}`,
    TMDB_EXTERNAL_ID_CACHE_MS,
    () => withRequestSlot(async () => {
      for (let attempt = 0; attempt < TMDB_EXTERNAL_ID_MAX_RETRIES; attempt += 1) {
        try {
          const response = await axios.get<{ imdb_id?: string }>(
            `${TMDB_API_BASE}/${mediaType}/${match[2]}/external_ids`,
            { params: { api_key: apiKey }, timeout: 15_000 },
          );
          const imdbId = response.data.imdb_id?.trim();
          return imdbId && /^tt\d+$/.test(imdbId) ? imdbId : undefined;
        } catch (error) {
          const status = axios.isAxiosError(error) ? error.response?.status : undefined;
          const retryable = status === 429 || (typeof status === 'number' && status >= 500);
          if (!retryable || attempt === TMDB_EXTERNAL_ID_MAX_RETRIES - 1) return undefined;
          await waitForRetry(attempt);
        }
      }
      return undefined;
    }),
  );
}
