import axios from 'axios';
import { getPersistentlyCachedRequest, invalidateRequestCache } from './request-cache.ts';
import { getApiKey, setApiKey } from './api-keys.ts';
import { parseOmdbRating, type ImdbRatingDetails } from './rating-policy.ts';

const OMDB_BASE = 'https://www.omdbapi.com/';
const OMDB_RATING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const OMDB_MISSING_RATING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OMDB_CONCURRENCY = 2;
export const OMDB_SETTINGS_CHANGED_EVENT = 'streamee:omdb-settings-changed';

let activeRequests = 0;
let blockedUntil = 0;
let settingsVersion = 0;
const requestQueue: Array<() => void> = [];

interface OmdbResponse {
  Title?: string;
  Year?: string;
  imdbRating?: string;
  imdbVotes?: string;
  Response: string;
  Error?: string;
}

export async function canFetchOmdbRatings(): Promise<boolean> {
  try {
    return Date.now() >= blockedUntil && !!(await getApiKey('omdb'));
  } catch {
    return false;
  }
}

async function withRequestSlot<T>(load: () => Promise<T>): Promise<T> {
  if (activeRequests >= OMDB_CONCURRENCY) {
    await new Promise<void>((resolve) => requestQueue.push(resolve));
  }
  activeRequests += 1;
  try {
    return await load();
  } finally {
    activeRequests -= 1;
    requestQueue.shift()?.();
  }
}

export async function getOmdbRatingDetails(imdbId: string): Promise<ImdbRatingDetails | null> {
  const normalizedId = imdbId.trim().toLowerCase();
  if (!/^tt\d+$/.test(normalizedId)) return null;

  try {
    return await getPersistentlyCachedRequest(
      `omdb:rating-details:v1:${normalizedId}`,
      (value) => value ? OMDB_RATING_CACHE_TTL_MS : OMDB_MISSING_RATING_CACHE_TTL_MS,
      () => withRequestSlot(async () => {
        const apiKey = await getApiKey('omdb');
        if (!apiKey || Date.now() < blockedUntil) throw new Error('IMDb ratings are temporarily unavailable.');
        const version = settingsVersion;
        const response = await axios.get<OmdbResponse>(OMDB_BASE, {
          params: {
            apikey: apiKey,
            i: normalizedId,
            plot: 'short'
          },
          timeout: 10_000,
          validateStatus: (status) => (status >= 200 && status < 300) || status === 401 || status === 429,
        });
        const error = response.data.Error ?? '';
        if (response.status === 401 || response.status === 429 || /(?:limit|api key)/i.test(error)) {
          if (version === settingsVersion) {
            blockedUntil = /limit/i.test(error) || response.status === 429
              ? Date.now() + 24 * 60 * 60 * 1000
              : Number.POSITIVE_INFINITY;
          }
          throw new Error('IMDb rating requests are paused until the API key or allowance is available.');
        }
        if (response.data.Response !== 'True' && !/not found/i.test(error)) {
          throw new Error('The rating service could not return this title.');
        }
        return parseOmdbRating(response.data);
      }),
    );
  } catch {
    // Keep cached scores or the labeled metadata fallback when the service is unavailable.
    return null;
  }
}

export async function getOmdbRating(imdbId: string): Promise<number | null> {
  return (await getOmdbRatingDetails(imdbId))?.rating ?? null;
}

export async function setOmdbSettings(settings: { apiKey: string }): Promise<void> {
  const previousKey = await getApiKey('omdb');
  await setApiKey('omdb', settings.apiKey);
  if (previousKey === settings.apiKey.trim()) return;
  settingsVersion += 1;
  blockedUntil = 0;
  invalidateRequestCache('persistent:omdb:rating-details:');
  window.dispatchEvent(new Event(OMDB_SETTINGS_CHANGED_EVENT));
}
