import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { MetaPreview, useStore } from '../store';
import { enrichTmdbItemsById } from './tmdb';
import { getCachedRequest } from './request-cache';

const TRAKT_API_BASE = 'https://api.trakt.tv';
const TRAKT_AUTH_SERVICE_BASE = 'https://streamee-auth.streameeapp.workers.dev';
const TRAKT_AUTH_SERVICE_TIMEOUT_MS = 15_000;
const TRAKT_LEGACY_CREDENTIALS_KEY = 'streamee-trakt-creds';
const TOKEN_REFRESH_BUFFER_SECONDS = 5 * 60;
const TRAKT_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const TRAKT_METADATA_CACHE_TTL_MS = 30 * 60 * 1000;
const TRAKT_ID_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TRAKT_WRITE_INTERVAL_MS = 1100;
const TRAKT_DEFAULT_RATE_LIMIT_DELAY_MS = 60 * 1000;
const TRAKT_SERVER_RETRY_BASE_DELAY_MS = 750;
const TRAKT_SERVER_RETRY_LIMIT = 2;

export class TraktRateLimitError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number) {
    const retrySeconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    super(`Trakt rate limit reached. Try again in ${retrySeconds} seconds.`);
    this.name = 'TraktRateLimitError';
    this.retryAt = retryAt;
  }
}

export function isTraktRateLimitError(error: unknown): error is TraktRateLimitError {
  return error instanceof TraktRateLimitError;
}

let traktCooldownUntil = 0;
let lastTraktWriteStartedAt = 0;
let traktWriteQueue: Promise<void> = Promise.resolve();

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
}

function parseRateLimitUntil(headers: Record<string, unknown> | undefined): number {
  if (!headers) return 0;

  const retryAfterValue = headers['retry-after'];
  const retryAfterSeconds = Number(retryAfterValue);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Date.now() + retryAfterSeconds * 1000;
  }
  if (typeof retryAfterValue === 'string') {
    const retryAfterDate = new Date(retryAfterValue).getTime();
    if (Number.isFinite(retryAfterDate)) {
      return retryAfterDate;
    }
  }

  const rateLimitValue = headers['x-ratelimit'];
  if (typeof rateLimitValue === 'string') {
    try {
      const rateLimit = JSON.parse(rateLimitValue) as { remaining?: number; until?: string };
      if (rateLimit.remaining === 0 && rateLimit.until) {
        const until = new Date(rateLimit.until).getTime();
        return Number.isFinite(until) ? until : 0;
      }
    } catch {
      // Ignore malformed advisory headers and fall back to the default cooldown.
    }
  }

  return 0;
}

function applyTraktCooldown(headers?: Record<string, unknown>): number {
  const headerUntil = parseRateLimitUntil(headers);
  const retryAt = headerUntil > Date.now()
    ? headerUntil
    : Date.now() + TRAKT_DEFAULT_RATE_LIMIT_DELAY_MS;
  traktCooldownUntil = Math.max(traktCooldownUntil, retryAt);
  return traktCooldownUntil;
}

async function waitForTraktCooldown(): Promise<void> {
  const waitMs = traktCooldownUntil - Date.now();
  if (waitMs > 0) {
    await delay(waitMs);
  }
}

async function scheduleTraktWrite(): Promise<void> {
  const previousWrite = traktWriteQueue;
  let releaseWrite: (() => void) | undefined;
  traktWriteQueue = new Promise<void>(resolve => {
    releaseWrite = resolve;
  });

  await previousWrite;
  try {
    await waitForTraktCooldown();
    const spacingMs = TRAKT_WRITE_INTERVAL_MS - (Date.now() - lastTraktWriteStartedAt);
    if (spacingMs > 0) {
      await delay(spacingMs);
    }
    lastTraktWriteStartedAt = Date.now();
  } finally {
    releaseWrite?.();
  }
}

export function getTraktRateLimitRetryAt(): number | null {
  return traktCooldownUntil > Date.now() ? traktCooldownUntil : null;
}

function rethrowTraktRateLimit(error: unknown): void {
  if (isTraktRateLimitError(error)) {
    throw error;
  }
}

function removeLegacyTraktCredentials(): void {
  try {
    localStorage.removeItem(TRAKT_LEGACY_CREDENTIALS_KEY);
  } catch (error) {
    console.warn('[Trakt] Could not remove legacy application credentials:', getTraktErrorDiagnostics(error));
  }
}

removeLegacyTraktCredentials();

export function hasTraktCredentials(): boolean {
  return true;
}

interface TraktDeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface TraktToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  created_at: number;
}

export interface TraktShow {
  ids: {
    trakt: number;
    slug: string;
    tvdb?: number;
    imdb?: string;
    tmdb: number;
    tvrage?: number;
  };
  title: string;
  year: number;
  overview?: string;
  poster?: string;
  background?: string;
  votes?: number;
  rating?: number;
  runtime?: number;
}

export interface TraktEpisode {
  season: number;
  number: number;
  title?: string;
  episode_type?:
    | 'standard'
    | 'series_premiere'
    | 'season_premiere'
    | 'mid_season_finale'
    | 'mid_season_premiere'
    | 'season_finale'
    | 'series_finale';
  ids: {
    trakt: number;
    tvdb?: number;
    imdb?: string;
    tmdb: number;
  };
  watched?: boolean;
}

export interface TraktWatchedShowSeason {
  number: number;
  episodes: { number: number; plays: number; last_watched_at: string }[];
}

export interface TraktWatchedShow {
  show: TraktShow;
  seasons: TraktWatchedShowSeason[];
}

export interface TraktCalendarShow {
  show: TraktShow;
  episode: TraktEpisode;
  first_aired: string;
  released?: string;
  overview?: string;
}

export interface TraktCalendarMovie {
  movie: {
    ids: {
      trakt: number;
      imdb?: string;
      tmdb: number;
    };
    title: string;
    year: number;
    overview?: string;
    poster?: string;
    background?: string;
    rating?: number;
  };
  released: string;
  overview?: string;
}

interface TraktWatchlistItem {
  id: number;
  listed_at: string;
  type: 'movie' | 'show';
  movie?: {
    ids: { trakt: number; tmdb: number; imdb?: string };
    title: string;
    year: number;
  };
  show?: {
    ids: { trakt: number; tmdb: number; imdb?: string };
    title: string;
    year: number;
  };
}

interface TraktTrendingMovie {
  watchers: number;
  movie: {
    ids: { trakt: number; tmdb: number; imdb?: string };
    title: string;
    year: number;
    released?: string;
  };
}

interface TraktTrendingShow {
  watchers: number;
  show: {
    ids: { trakt: number; tmdb: number; imdb?: string };
    title: string;
    year: number;
    first_aired?: string;
  };
}

interface TraktAnticipatedMovie {
  list_count: number;
  movie: {
    ids: { trakt: number; tmdb: number; imdb?: string };
    title: string;
    year: number;
    released?: string;
  };
}

interface TraktAnticipatedShow {
  list_count: number;
  show: {
    ids: { trakt: number; tmdb: number; imdb?: string };
    title: string;
    year: number;
    first_aired?: string;
  };
}

export interface TraktListSearchResult {
  id: number;
  name: string;
  description?: string;
  likes: number;
  itemCount: number;
  owner: string;
  previewPosters: string[];
  previewsLoaded: boolean;
}

interface TraktListSearchPageResult extends TraktFetchResult<TraktListSearchResult[]> {
  page: number;
  pageCount: number;
}

interface TraktListStreamProgress {
  loaded: number;
  total: number;
  totalKnown: boolean;
  page: number;
  pageCount: number;
  phase: 'raw' | 'enriched';
}

interface TraktListSearchResponse {
  type: 'list';
  list?: {
    name: string;
    description?: string | null;
    item_count: number;
    likes: number;
    ids: { trakt: number; slug: string };
    user: {
      username: string;
      name?: string | null;
    };
  } | null;
}

interface TraktListMedia {
  title: string;
  year?: number | null;
  rating?: number | null;
  released?: string | null;
  first_aired?: string | null;
  ids: { trakt: number; tmdb?: number | null; imdb?: string | null };
}

interface TraktListItemResponse {
  type: 'movie' | 'show';
  movie?: TraktListMedia | null;
  show?: TraktListMedia | null;
}

function mapTraktListItemsToPreviews(items: TraktListItemResponse[]): MetaPreview[] {
  return items.flatMap((item) => {
    const media = item.type === 'movie' ? item.movie : item.show;
    const tmdbId = media?.ids.tmdb;
    if (!media) return [];

    const releaseDate = item.type === 'movie' ? media.released : media.first_aired;
    return [{
      id: tmdbId
        ? `${item.type === 'movie' ? 'movie' : 'tv'}:${tmdbId}`
        : `trakt:${item.type}:${media.ids.trakt}`,
      type: item.type === 'movie' ? 'movie' : 'series',
      name: media.title,
      year: media.year ? String(media.year) : undefined,
      releaseDate: releaseDate || undefined,
      imdbId: media.ids.imdb || undefined,
      rating: media.rating ?? undefined
    } satisfies MetaPreview];
  });
}

async function enrichTraktListPreviews(items: TraktListItemResponse[]): Promise<MetaPreview[]> {
  const rawItems = mapTraktListItemsToPreviews(items);
  const enrichedItems: MetaPreview[] = [];
  const batchSize = 12;
  const tmdbItems = rawItems.flatMap((item) => {
    const [mediaType, tmdbId] = item.id.split(':');
    const parsedTmdbId = Number(tmdbId);
    if ((mediaType !== 'movie' && mediaType !== 'tv') || !Number.isInteger(parsedTmdbId)) {
      return [];
    }

    return [{
      tmdbId: parsedTmdbId,
      mediaType: item.type === 'movie' ? 'movie' as const : 'tv' as const,
      releaseDate: item.releaseDate,
      name: item.name
    }];
  });

  for (let index = 0; index < tmdbItems.length; index += batchSize) {
    const enrichedBatch = await enrichTmdbItemsById(tmdbItems.slice(index, index + batchSize));
    enrichedItems.push(...enrichedBatch);
  }

  const enrichedById = new Map(enrichedItems.map((item) => [item.id, item]));
  return rawItems.map((item) => {
    const enriched = enrichedById.get(item.id);
    return enriched
      ? {
          ...item,
          ...enriched,
          rating: item.rating ?? enriched.rating
        }
      : item;
  });
}

async function fetchTraktListPreviewPosters(
  client: AxiosInstance,
  listId: number,
  limit: number = 8
): Promise<string[]> {
  try {
    const response = await client.get<TraktListItemResponse[]>(`/lists/${listId}/items/movie,show`, {
      params: { page: 1, limit, extended: 'full' }
    });
    const previews = await enrichTraktListPreviews(response.data);
    return previews.flatMap((item) => item.poster ? [item.poster] : []).slice(0, limit);
  } catch (error) {
    console.warn(`[Trakt] Failed to load preview posters for list ${listId}:`, getTraktErrorDiagnostics(error));
    return [];
  }
}

const traktListPreviewPosterCache = new Map<string, Promise<string[]>>();

export async function getTraktListPreviewPosters(listId: number, limit: number = 8): Promise<string[]> {
  const cacheKey = `${listId}:${limit}`;
  const cachedRequest = traktListPreviewPosterCache.get(cacheKey);
  if (cachedRequest) return cachedRequest;

  const request = (async () => {
    const client = await createPublicApiClient();
    if (!client) return [];
    return fetchTraktListPreviewPosters(client, listId, limit);
  })();
  traktListPreviewPosterCache.set(cacheKey, request);

  const posters = await request;
  if (posters.length === 0) traktListPreviewPosterCache.delete(cacheKey);
  return posters;
}

interface TraktSearchLookupResult {
  type: 'movie' | 'show';
  movie?: {
    ids: { trakt: number; tmdb?: number; imdb?: string };
    title: string;
    year: number;
    released?: string;
  };
  show?: {
    ids: { trakt: number; tmdb?: number; imdb?: string };
    title: string;
    year: number;
    first_aired?: string;
  };
}

interface TraktRelatedMovie {
  ids: { trakt: number; tmdb?: number; imdb?: string };
  title: string;
  year: number;
  released?: string;
}

interface TraktRelatedShow {
  ids: { trakt: number; tmdb?: number; imdb?: string };
  title: string;
  year: number;
  first_aired?: string;
}

export interface TraktSentimentItem {
  sentiment: string;
  comment_ids?: number[] | null;
}

export interface TraktSentiments {
  bad: TraktSentimentItem[];
  good: TraktSentimentItem[];
  analyzed_at: string;
  comment_count: number;
}

interface TraktActivityCategory {
  watched_at?: string;
  paused_at?: string;
  watchlisted_at?: string;
  collected_at?: string;
  rated_at?: string;
  commented_at?: string;
  hidden_at?: string;
}

interface TraktFetchResult<T> {
  data: T;
  success: boolean;
  error?: string;
}

function getTraktRequestErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail = error.response?.data?.error || error.response?.data?.message;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
    return status ? `${fallback} (HTTP ${status})` : fallback;
  }

  return error instanceof Error && error.message ? error.message : fallback;
}

export function getTraktErrorDiagnostics(error: unknown): Record<string, unknown> {
  if (!axios.isAxiosError(error)) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  // Keep HTTP payloads and headers out of both DevTools and persisted logs.
  // Axios errors can retain request data, response data, and credentials.
  return {
    status: error.response?.status,
    message: error.message,
    code: error.code,
    requestId: error.response?.headers?.['x-request-id']
  };
}

interface TraktLastActivities {
  all: string;
  movies: TraktActivityCategory;
  shows: TraktActivityCategory;
  episodes: TraktActivityCategory;
  seasons?: TraktActivityCategory;
  lists?: { updated_at?: string; liked_at?: string };
  watchlist?: string | { updated_at?: string; added_at?: string; deleted_at?: string };
  user: string;
}

interface TraktClientConfiguration {
  client_id: string;
}

let traktClientIdPromise: Promise<string> | null = null;

async function postToTraktAuthService<T>(path: string, body: Record<string, string> = {}): Promise<T> {
  const response = await axios.post<T>(`${TRAKT_AUTH_SERVICE_BASE}${path}`, body, {
    timeout: TRAKT_AUTH_SERVICE_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json' }
  });
  return response.data;
}

async function getTraktClientId(): Promise<string> {
  if (!traktClientIdPromise) {
    traktClientIdPromise = postToTraktAuthService<TraktClientConfiguration>('/trakt/client-id')
      .then((configuration) => {
        if (!configuration.client_id) {
          throw new Error('The Streamee authentication service returned an invalid Trakt configuration.');
        }
        return configuration.client_id;
      })
      .catch((error) => {
        traktClientIdPromise = null;
        throw error;
      });
  }
  return traktClientIdPromise;
}

function getToken(): TraktToken | null {
  try {
    const stored = localStorage.getItem('streamee-trakt-token');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to get token:', getTraktErrorDiagnostics(e));
  }
  return null;
}

let lastTraktAuthError: string | null = null;

function saveToken(token: TraktToken): void {
  lastTraktAuthError = null;
  localStorage.setItem('streamee-trakt-token', JSON.stringify(token));
}

function clearToken(): void {
  localStorage.removeItem('streamee-trakt-token');
  useStore.getState().setTraktConnected(false);
}

export function consumeTraktAuthError(): string | null {
  const message = lastTraktAuthError;
  lastTraktAuthError = null;
  return message;
}

function getTraktOAuthErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : fallback;
  }

  const responseData = error.response?.data as {
    error?: string;
    error_description?: string;
  } | undefined;
  const oauthError = responseData?.error;
  const description = responseData?.error_description;

  if (oauthError === 'invalid_client') {
    return 'Trakt rejected the application credentials. Check the Client ID and Client Secret.';
  }
  if (oauthError === 'invalid_grant' && description === 'session not found') {
    return 'Your previous Trakt authorization is no longer valid. Please connect to Trakt again.';
  }
  if (error.response?.status === 410) {
    return 'The Trakt device code expired. Please try again.';
  }
  if (error.response?.status === 418) {
    return 'Trakt authorization was denied. Please try again when you are ready to approve access.';
  }
  if (error.response?.status === 429) {
    return 'Trakt asked Streamee to slow down. Please wait a moment and try again.';
  }
  if (description) {
    return `Trakt authentication failed: ${description}`;
  }

  return error.response?.status
    ? `${fallback} (HTTP ${error.response.status})`
    : fallback;
}

function isTokenExpired(token: TraktToken, bufferSeconds = 0): boolean {
  const now = Math.floor(Date.now() / 1000);
  return token.created_at + token.expires_in <= now + bufferSeconds;
}

type RetryableRequestConfig = InternalAxiosRequestConfig & {
  _traktAuthRetry?: boolean;
  _traktRateLimitRetry?: boolean;
  _traktServerRetryCount?: number;
};

function isWriteRequest(config: InternalAxiosRequestConfig): boolean {
  const method = config.method?.toLowerCase();
  return method === 'post' || method === 'put' || method === 'patch' || method === 'delete';
}

async function createApiClient(accessToken?: string): Promise<AxiosInstance> {
  const clientId = await getTraktClientId();
  const client = axios.create({
    baseURL: TRAKT_API_BASE,
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
      ...(accessToken && { Authorization: `Bearer ${accessToken}` })
    }
  });

  client.interceptors.request.use(async config => {
    if (isWriteRequest(config)) {
      await scheduleTraktWrite();
    } else {
      await waitForTraktCooldown();
    }
    return config;
  });

  client.interceptors.response.use(
    response => {
      const rateLimitUntil = parseRateLimitUntil(response.headers as Record<string, unknown>);
      if (rateLimitUntil > Date.now()) {
        traktCooldownUntil = Math.max(traktCooldownUntil, rateLimitUntil);
      }
      return response;
    },
    async (error: AxiosError) => {
      const retryConfig = error.config as RetryableRequestConfig | undefined;

      if (error.response?.status === 429) {
        const retryAt = applyTraktCooldown(error.response.headers as Record<string, unknown>);
        if (!retryConfig || retryConfig._traktRateLimitRetry) {
          return Promise.reject(new TraktRateLimitError(retryAt));
        }

        retryConfig._traktRateLimitRetry = true;
        await waitForTraktCooldown();
        return client(retryConfig);
      }

      const status = error.response?.status;
      const method = retryConfig?.method?.toLowerCase();
      const serverRetryCount = retryConfig?._traktServerRetryCount ?? 0;
      if (
        retryConfig &&
        method === 'get' &&
        status !== undefined &&
        [500, 502, 503, 504].includes(status) &&
        serverRetryCount < TRAKT_SERVER_RETRY_LIMIT
      ) {
        retryConfig._traktServerRetryCount = serverRetryCount + 1;
        const retryAfter = parseRateLimitUntil(error.response?.headers as Record<string, unknown>);
        const backoff = TRAKT_SERVER_RETRY_BASE_DELAY_MS * (2 ** serverRetryCount);
        const waitMs = retryAfter > Date.now()
          ? retryAfter - Date.now()
          : backoff + Math.floor(Math.random() * 250);
        console.warn(
          `[Trakt] GET ${retryConfig.url ?? ''} failed with HTTP ${status}; ` +
          `retrying ${retryConfig._traktServerRetryCount}/${TRAKT_SERVER_RETRY_LIMIT}.`
        );
        await delay(waitMs);
        return client(retryConfig);
      }

      if (
        accessToken &&
        error.response?.status === 401 &&
        retryConfig &&
        !retryConfig._traktAuthRetry
      ) {
        retryConfig._traktAuthRetry = true;
        const refreshedToken = await refreshAccessToken();
        if (refreshedToken?.access_token) {
          (retryConfig.headers as Record<string, string>)['Authorization'] = `Bearer ${refreshedToken.access_token}`;
          return client(retryConfig);
        }
      }

      return Promise.reject(error);
    }
  );

  return client;
}

async function createPublicApiClient(): Promise<AxiosInstance | null> {
  try {
    return await createApiClient();
  } catch (error) {
    console.warn('[Trakt] Authentication service configuration is unavailable:', getTraktErrorDiagnostics(error));
    return null;
  }
}

async function getAllTraktPages<T>(
  client: AxiosInstance,
  path: string,
  params: Record<string, unknown> = {},
  maxPages = 100
): Promise<T[]> {
  const allItems: T[] = [];
  const limit = 100;

  for (let page = 1; page <= maxPages; page++) {
    const response = await client.get<T[]>(path, {
      params: { ...params, page, limit }
    });
    const items = Array.isArray(response.data) ? response.data : [];
    allItems.push(...items);

    const pageCount = Number(response.headers['x-pagination-page-count']);
    const reachedLastPage = Number.isFinite(pageCount)
      ? page >= pageCount
      : items.length < limit;
    if (reachedLastPage) {
      break;
    }
  }

  return allItems;
}

export async function startOAuthFlow(): Promise<TraktDeviceCode> {
  try {
    return await postToTraktAuthService<TraktDeviceCode>('/trakt/device-code');
  } catch (error) {
    throw new Error(getTraktOAuthErrorMessage(error, 'Unable to start Trakt authentication.'));
  }
}

export async function pollForToken(deviceCode: string): Promise<TraktToken | null> {
  try {
    const tokenResponse = await postToTraktAuthService<TraktToken>('/trakt/device-token', {
      code: deviceCode
    });
    
    if (tokenResponse.access_token) {
      const token: TraktToken = {
        ...tokenResponse,
        created_at: Math.floor(Date.now() / 1000)
      };
      saveToken(token);
      return token;
    }
  } catch (error: unknown) {
    const axiosError = axios.isAxiosError(error) ? error : null;
    if (axiosError?.response?.status === 400) {
      return null;
    }
    throw new Error(getTraktOAuthErrorMessage(error, 'Unable to complete Trakt authentication.'));
  }
  return null;
}

async function refreshAccessToken(): Promise<TraktToken | null> {
  const token = getToken();
  if (!token?.refresh_token) return null;

  try {
    const tokenResponse = await postToTraktAuthService<TraktToken>('/trakt/refresh-token', {
      refresh_token: token.refresh_token
    });

    if (tokenResponse.access_token) {
      const newToken: TraktToken = {
        ...tokenResponse,
        created_at: Math.floor(Date.now() / 1000)
      };
      saveToken(newToken);
      return newToken;
    }
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      const retryAt = applyTraktCooldown(error.response.headers as Record<string, unknown>);
      lastTraktAuthError = new TraktRateLimitError(retryAt).message;
      console.warn('[Trakt] Token refresh rate limited; preserving the existing session');
      throw new TraktRateLimitError(retryAt);
    }

    lastTraktAuthError = getTraktOAuthErrorMessage(
      error,
      'Your Trakt session could not be refreshed. Please connect to Trakt again.'
    );
    console.error('Failed to refresh token:', getTraktErrorDiagnostics(error));
    const responseData = axios.isAxiosError(error)
      ? error.response?.data as { error?: string } | undefined
      : undefined;
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const refreshWasRejected =
      responseData?.error === 'invalid_grant' ||
      responseData?.error === 'invalid_client' ||
      status === 401;
    if (refreshWasRejected) {
      clearToken();
      return null;
    }

    // Network and server failures are transient. Keep the refresh token so the
    // next request can recover without forcing the user to reconnect.
    throw new Error(lastTraktAuthError);
  }
  return null;
}

export function isAuthenticated(): boolean {
  const token = getToken();
  if (!token) return false;
  return !isTokenExpired(token) || Boolean(token.refresh_token);
}

let tokenRefreshPromise: Promise<TraktToken | null> | null = null;

export async function ensureValidToken(): Promise<string | null> {
  let token = getToken();
  if (!token) return null;
  if (!isTokenExpired(token, TOKEN_REFRESH_BUFFER_SECONDS)) return token.access_token;

  if (!tokenRefreshPromise) {
    tokenRefreshPromise = refreshAccessToken().finally(() => {
      tokenRefreshPromise = null;
    });
  }
  token = await tokenRefreshPromise;
  return token?.access_token ?? null;
}

export async function getWatchedShowsResult(): Promise<TraktFetchResult<TraktWatchedShow[]>> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return { data: [], success: false };

  try {
    const client = await createApiClient(accessToken);
    const shows = await getAllTraktPages<TraktWatchedShow>(
      client,
      '/sync/watched/shows',
      { extended: 'progress' }
    );
    return { data: shows, success: true };
  } catch (e) {
    console.error('Failed to get watched shows:', getTraktErrorDiagnostics(e));
    return { data: [], success: false };
  }
}

export async function getWatchedShows(): Promise<TraktWatchedShow[]> {
  return (await getWatchedShowsResult()).data;
}

export interface TraktWatchedMovie {
  movie: TraktShow;
  watched: string;
}

export async function getWatchedMoviesResult(): Promise<TraktFetchResult<TraktWatchedMovie[]>> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return { data: [], success: false };

  try {
    const client = await createApiClient(accessToken);
    const movies = await getAllTraktPages<TraktWatchedMovie>(client, '/sync/watched/movies');
    return { data: movies, success: true };
  } catch (e) {
    console.error('Failed to get watched movies:', getTraktErrorDiagnostics(e));
    return { data: [], success: false };
  }
}

export async function getWatchedMovies(): Promise<TraktWatchedMovie[]> {
  return (await getWatchedMoviesResult()).data;
}

export async function getWatchlistResult(): Promise<TraktFetchResult<TraktWatchlistItem[]>> {
  const accessToken = await ensureValidToken();
  if (!accessToken) {
    console.error('[Trakt] No access token for getWatchlist');
    return { data: [], success: false };
  }

  try {
    const client = await createApiClient(accessToken);
    // Trakt's combined watchlist reader can fail with HTTP 500 for larger
    // accounts. Read the supported typed collections separately and merge them
    // locally so one oversized mixed query cannot block every pending push.
    const movies = await getAllTraktPages<TraktWatchlistItem>(client, '/sync/watchlist/movies/rank/asc');
    const shows = await getAllTraktPages<TraktWatchlistItem>(client, '/sync/watchlist/shows/rank/asc');
    return { data: [...movies, ...shows], success: true };
  } catch (e: unknown) {
    console.error('[Trakt] Failed to get watchlist:', getTraktErrorDiagnostics(e));
    return { data: [], success: false };
  }
}

export async function getWatchlist(): Promise<TraktWatchlistItem[]> {
  return (await getWatchlistResult()).data;
}

export interface TraktHistorySyncPayload {
  movies?: Array<{ ids: { tmdb: number }; watched_at?: string }>;
  shows?: Array<{
    ids: { tmdb: number };
    watched_at?: string;
    seasons?: Array<{
      number: number;
      episodes: Array<{ number: number; watched_at?: string }>;
    }>;
  }>;
}

export interface TraktWatchlistSyncPayload {
  movies?: Array<{ ids: { tmdb: number } }>;
  shows?: Array<{ ids: { tmdb: number } }>;
}

async function postTraktSyncBatch(path: string, payload: object): Promise<boolean> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return false;

  try {
    const client = await createApiClient(accessToken);
    const response = await client.post(path, payload);
    return response.status >= 200 && response.status < 300;
  } catch (error) {
    rethrowTraktRateLimit(error);
    console.error(`[Trakt] Failed sync batch ${path}:`, getTraktErrorDiagnostics(error));
    return false;
  }
}

export async function addHistoryBatch(payload: TraktHistorySyncPayload): Promise<boolean> {
  return postTraktSyncBatch('/sync/history', payload);
}

export async function removeHistoryBatch(payload: TraktHistorySyncPayload): Promise<boolean> {
  return postTraktSyncBatch('/sync/history/remove', payload);
}

export async function addWatchlistBatch(payload: TraktWatchlistSyncPayload): Promise<boolean> {
  return postTraktSyncBatch('/sync/watchlist', payload);
}

export async function removeWatchlistBatch(payload: TraktWatchlistSyncPayload): Promise<boolean> {
  return postTraktSyncBatch('/sync/watchlist/remove', payload);
}

export async function addToWatchlist(type: 'movie' | 'show', tmdbId: number): Promise<boolean> {
  const accessToken = await ensureValidToken();
  if (!accessToken) {
    console.error('[Trakt] No access token for addToWatchlist');
    return false;
  }

  try {
    const client = await createApiClient(accessToken);
    const payload = type === 'movie' 
      ? { movies: [{ ids: { tmdb: tmdbId } }] }
      : { shows: [{ ids: { tmdb: tmdbId } }] };
    
    const response = await client.post('/sync/watchlist', payload);
    return response.status === 201 || response.status === 200;
  } catch (e: unknown) {
    rethrowTraktRateLimit(e);
    console.error('[Trakt] Failed to add to watchlist:', getTraktErrorDiagnostics(e));
    return false;
  }
}

export async function removeFromWatchlist(type: 'movie' | 'show', tmdbId: number): Promise<boolean> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return false;

  try {
    const client = await createApiClient(accessToken);
    const payload = type === 'movie'
      ? { movies: [{ ids: { tmdb: tmdbId } }] }
      : { shows: [{ ids: { tmdb: tmdbId } }] };
    
    await client.post('/sync/watchlist/remove', payload);
    return true;
  } catch (e) {
    rethrowTraktRateLimit(e);
    console.error('Failed to remove from watchlist:', getTraktErrorDiagnostics(e));
    return false;
  }
}

export async function markAsWatched(type: 'movie' | 'show', tmdbId: number, season?: number, episode?: number, watchedAt?: string): Promise<boolean> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return false;

  try {
    const client = await createApiClient(accessToken);
    let payload: Record<string, unknown>;

    if (type === 'movie') {
      payload = { movies: [{ ids: { tmdb: tmdbId }, ...(watchedAt && { watched_at: watchedAt }) }] };
    } else if (season !== undefined && episode !== undefined) {
      payload = {
        shows: [{
          ids: { tmdb: tmdbId },
          seasons: [{ number: season, episodes: [{ number: episode, ...(watchedAt && { watched_at: watchedAt }) }] }]
        }]
      };
    } else {
      payload = { shows: [{ ids: { tmdb: tmdbId }, ...(watchedAt && { watched_at: watchedAt }) }] };
    }

    await client.post('/sync/history', payload);
    return true;
  } catch (e) {
    rethrowTraktRateLimit(e);
    console.error('[Trakt] Failed to mark as watched:', getTraktErrorDiagnostics(e));
    return false;
  }
}

export async function removeFromHistory(type: 'movie' | 'show', tmdbId: number, season?: number, episode?: number): Promise<boolean> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return false;

  try {
    const client = await createApiClient(accessToken);
    let payload: Record<string, unknown>;

    if (type === 'movie') {
      payload = { movies: [{ ids: { tmdb: tmdbId } }] };
    } else if (season !== undefined && episode !== undefined) {
      payload = {
        shows: [{
          ids: { tmdb: tmdbId },
          seasons: [{ number: season, episodes: [{ number: episode }] }]
        }]
      };
    } else {
      payload = { shows: [{ ids: { tmdb: tmdbId } }] };
    }

    await client.post('/sync/history/remove', payload);
    return true;
  } catch (e) {
    rethrowTraktRateLimit(e);
    console.error('[Trakt] Failed to remove from history:', getTraktErrorDiagnostics(e));
    return false;
  }
}

export async function markSeasonAsWatched(
  tmdbId: number,
  seasonNumber: number,
  episodes: number[] | { number: number; watchedAt?: string }[]
): Promise<boolean> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return false;

  try {
    const client = await createApiClient(accessToken);
    const normalizedEpisodes = episodes.map(ep =>
      typeof ep === 'number'
        ? { number: ep }
        : { number: ep.number, ...(ep.watchedAt && { watched_at: ep.watchedAt }) }
    );
    const payload = {
      shows: [{
        ids: { tmdb: tmdbId },
        seasons: [{ number: seasonNumber, episodes: normalizedEpisodes }]
      }]
    };

    await client.post('/sync/history', payload);
    return true;
  } catch (e) {
    rethrowTraktRateLimit(e);
    console.error('Failed to mark season as watched:', getTraktErrorDiagnostics(e));
    return false;
  }
}

export async function getCalendarShows(startDate: string, days: number = 7): Promise<TraktCalendarShow[]> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return [];

  try {
    const client = await createApiClient(accessToken);
    const response = await client.get<TraktCalendarShow[]>(`/calendars/my/shows/${startDate}/${days}`);
    return response.data;
  } catch (e) {
    console.error('Failed to get calendar shows:', getTraktErrorDiagnostics(e));
    return [];
  }
}

export async function getCalendarMovies(startDate: string, days: number = 7): Promise<TraktCalendarMovie[]> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return [];

  try {
    const client = await createApiClient(accessToken);
    const response = await client.get<TraktCalendarMovie[]>(`/calendars/my/movies/${startDate}/${days}`);
    return response.data;
  } catch (e) {
    console.error('Failed to get calendar movies:', getTraktErrorDiagnostics(e));
    return [];
  }
}

export async function getCalendarFinales(startDate: string, days: number = 30): Promise<TraktCalendarShow[]> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return [];

  try {
    const client = await createApiClient(accessToken);
    const response = await client.get<TraktCalendarShow[]>(`/calendars/my/shows/finales/${startDate}/${days}`, {
      params: { extended: 'full' }
    });
    return response.data;
  } catch (e) {
    console.error('Failed to get calendar finales:', getTraktErrorDiagnostics(e));
    return [];
  }
}

interface TraktPlaybackProgress {
  id?: number;
  type?: 'movie' | 'episode';
  show?: TraktShow & { season?: number; episode?: number; episode_title?: string };
  episode?: TraktEpisode;
  movie?: {
    ids: { trakt: number; tmdb: number };
    title: string;
  };
  progress: number;
  paused_at: string;
}

export async function getPlaybackProgressResult(): Promise<TraktFetchResult<TraktPlaybackProgress[]>> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return { data: [], success: false };

  try {
    const client = await createApiClient(accessToken);
    const allItems: TraktPlaybackProgress[] = [];
    const limit = 100;

    for (let page = 1; page <= 10; page++) {
      const response = await client.get<TraktPlaybackProgress[]>('/sync/playback', {
        params: { page, limit }
      });
      const items = Array.isArray(response.data) ? response.data : [];
      allItems.push(...items);

      const pageCount = Number(response.headers['x-pagination-page-count']);
      if ((Number.isFinite(pageCount) && page >= pageCount) || items.length < limit) {
        break;
      }
    }

    return { data: allItems, success: true };
  } catch (e) {
    console.error('Failed to get playback progress:', getTraktErrorDiagnostics(e));
    return { data: [], success: false };
  }
}

export async function getLastActivities(): Promise<TraktLastActivities | null> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return null;

  try {
    const client = await createApiClient(accessToken);
    const response = await client.get<TraktLastActivities>('/sync/last_activities');
    return response.data;
  } catch (e) {
    console.error('Failed to get last activities:', getTraktErrorDiagnostics(e));
    return null;
  }
}

export interface TraktHistoryItem {
  id: number;
  watched_at: string;
  action: 'scrobble' | 'checkin' | 'watched';
  type: 'movie' | 'show' | 'episode';
  movie?: TraktShow;
  show?: TraktShow;
  episode?: TraktEpisode;
}

export async function getWatchHistoryResult(
  media: 'movies' | 'episodes' | 'shows' | 'all' = 'all',
  page: number = 1,
  limit: number = 20,
  startAt?: string
): Promise<TraktFetchResult<TraktHistoryItem[]>> {
  const accessToken = await ensureValidToken();
  if (!accessToken) return { data: [], success: false };

  try {
    const client = await createApiClient(accessToken);
    const path = media === 'all' ? '/sync/history' : `/sync/history/${media}`;
    const response = await client.get<TraktHistoryItem[]>(path, {
      params: { page, limit, ...(startAt && { start_at: startAt }) }
    });
    return { data: response.data, success: true };
  } catch (e) {
    console.error('Failed to get watch history:', getTraktErrorDiagnostics(e));
    return { data: [], success: false };
  }
}

export function disconnectTrakt(): void {
  clearToken();
  localStorage.removeItem('streamee-trakt-startup-push-baseline-v1');
  useStore.getState().clearPendingTraktHistory();
  useStore.getState().clearPendingTraktWatchlist();
}

export async function getTrendingMovies(page: number = 1, limit: number = 20): Promise<TraktTrendingMovie[]> {
  const client = await createPublicApiClient();
  if (!client) return [];

  try {
    return await getCachedRequest(`trakt:catalog:trending:movie:${page}:${limit}`, TRAKT_CATALOG_CACHE_TTL_MS, async () => {
      const response = await client.get<TraktTrendingMovie[]>('/movies/trending', {
        params: { page, limit }
      });
      return response.data;
    });
  } catch (e) {
    console.error('Failed to get trending movies:', getTraktErrorDiagnostics(e));
    throw e;
  }
}

export async function getTrendingShows(page: number = 1, limit: number = 20): Promise<TraktTrendingShow[]> {
  const client = await createPublicApiClient();
  if (!client) return [];

  try {
    return await getCachedRequest(`trakt:catalog:trending:show:${page}:${limit}`, TRAKT_CATALOG_CACHE_TTL_MS, async () => {
      const response = await client.get<TraktTrendingShow[]>('/shows/trending', {
        params: { page, limit }
      });
      return response.data;
    });
  } catch (e) {
    console.error('Failed to get trending shows:', getTraktErrorDiagnostics(e));
    throw e;
  }
}

export async function getAnticipatedMovies(page: number = 1, limit: number = 20): Promise<TraktAnticipatedMovie[]> {
  const client = await createPublicApiClient();
  if (!client) return [];

  try {
    return await getCachedRequest(`trakt:catalog:anticipated:movie:${page}:${limit}`, TRAKT_CATALOG_CACHE_TTL_MS, async () => {
      const response = await client.get<TraktAnticipatedMovie[]>('/movies/anticipated', {
        params: { page, limit }
      });
      return response.data;
    });
  } catch (e) {
    console.error('Failed to get anticipated movies:', getTraktErrorDiagnostics(e));
    throw e;
  }
}

export async function getAnticipatedShows(page: number = 1, limit: number = 20): Promise<TraktAnticipatedShow[]> {
  const client = await createPublicApiClient();
  if (!client) return [];

  try {
    return await getCachedRequest(`trakt:catalog:anticipated:show:${page}:${limit}`, TRAKT_CATALOG_CACHE_TTL_MS, async () => {
      const response = await client.get<TraktAnticipatedShow[]>('/shows/anticipated', {
        params: { page, limit }
      });
      return response.data;
    });
  } catch (e) {
    console.error('Failed to get anticipated shows:', getTraktErrorDiagnostics(e));
    throw e;
  }
}

export async function searchTraktListsResult(
  query: string,
  page: number = 1,
  limit: number = 20
): Promise<TraktListSearchPageResult> {
  const client = await createPublicApiClient();
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return { data: [], success: true, page, pageCount: 0 };
  if (!client) {
    return {
      data: [],
      success: false,
      error: 'Trakt API credentials are not configured.',
      page,
      pageCount: 0
    };
  }

  try {
    const response = await client.get<TraktListSearchResponse[]>('/search/list', {
      params: {
        query: trimmedQuery,
        page,
        limit,
        extended: 'full'
      }
    });

    const data = response.data.flatMap((result) => {
      const list = result.list;
      if (!list) return [];

      return [{
        id: list.ids.trakt,
        name: list.name,
        description: list.description || undefined,
        likes: list.likes,
        itemCount: list.item_count,
        owner: list.user.name || list.user.username,
        previewPosters: [],
        previewsLoaded: false
      }];
    });
    const pageCount = Number(response.headers['x-pagination-page-count']);
    return {
      data,
      success: true,
      page,
      pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1
    };
  } catch (e) {
    console.error(`[Trakt] Failed to search lists for "${trimmedQuery}":`, getTraktErrorDiagnostics(e));
    return {
      data: [],
      success: false,
      error: getTraktRequestErrorMessage(e, 'Could not search Trakt lists.'),
      page,
      pageCount: 0
    };
  }
}

export async function streamTraktListItems(
  listId: number,
  onBatch: (items: MetaPreview[], progress: TraktListStreamProgress) => void | Promise<void>,
  signal?: AbortSignal,
  startPage: number = 1
): Promise<TraktFetchResult<number>> {
  const client = await createPublicApiClient();
  if (!client) {
    return {
      data: 0,
      success: false,
      error: 'Trakt API credentials are not configured.'
    };
  }

  const pageLimit = 100;
  const enrichmentBatchSize = 12;
  let page = startPage;
  let pageCount = 1;
  let loaded = 0;
  let total = 0;

  try {
    do {
      if (signal?.aborted) return { data: loaded, success: false, error: 'cancelled' };
      const response = await client.get<TraktListItemResponse[]>(`/lists/${listId}/items/movie,show`, {
        params: { page, limit: pageLimit, extended: 'full' },
        signal
      });
      pageCount = Math.max(1, Number(response.headers['x-pagination-page-count']) || 1);
      const responseTotal = Number(response.headers['x-pagination-item-count']);
      if (Number.isFinite(responseTotal) && responseTotal > 0) {
        total = responseTotal;
      }

      for (let index = 0; index < response.data.length; index += enrichmentBatchSize) {
        if (signal?.aborted) return { data: loaded, success: false, error: 'cancelled' };
        const sourceBatch = response.data.slice(index, index + enrichmentBatchSize);
        const rawBatch = mapTraktListItemsToPreviews(sourceBatch);
        loaded += rawBatch.length;
        const progress = {
          loaded,
          total: total || loaded,
          totalKnown: total > 0,
          page,
          pageCount,
          phase: 'raw' as const
        };
        await onBatch(rawBatch, progress);

        const enrichedBatch = await enrichTraktListPreviews(sourceBatch);
        if (signal?.aborted) return { data: loaded, success: false, error: 'cancelled' };
        await onBatch(enrichedBatch, { ...progress, phase: 'enriched' });
      }
      page += 1;
    } while (page <= pageCount);

    return { data: loaded, success: true };
  } catch (error) {
    if (signal?.aborted) return { data: loaded, success: false, error: 'cancelled' };
    console.error(`[Trakt] Failed to stream items for list ${listId}:`, getTraktErrorDiagnostics(error));
    return {
      data: loaded,
      success: false,
      error: getTraktRequestErrorMessage(error, 'Could not finish loading this Trakt list.')
    };
  }
}

async function getTraktItemIdByTmdb(type: 'movie' | 'show', tmdbId: number): Promise<number | null> {
  const client = await createPublicApiClient();
  if (!client) return null;

  try {
    return await getCachedRequest(`trakt:id:${type}:${tmdbId}`, TRAKT_ID_CACHE_TTL_MS, async () => {
      const response = await client.get<TraktSearchLookupResult[]>(`/search/tmdb/${tmdbId}`, {
        params: { type, limit: 1 }
      });
      const match = response.data.find((item) => item.type === type);
      if (!match) {
        return null;
      }

      return type === 'movie'
        ? (match.movie?.ids.trakt ?? null)
        : (match.show?.ids.trakt ?? null);
    });
  } catch (e) {
    console.error(`[Trakt] Failed to look up ${type} by TMDB id ${tmdbId}:`, getTraktErrorDiagnostics(e));
    return null;
  }
}

interface RelatedRecommendationsPage {
  items: MetaPreview[];
  hasMore: boolean;
}

export async function getRelatedRecommendations(
  type: 'movie' | 'show',
  tmdbId: number,
  page: number = 1,
  limit: number = 12
): Promise<RelatedRecommendationsPage> {
  const client = await createPublicApiClient();
  if (!client) return { items: [], hasMore: false };

  const traktId = await getTraktItemIdByTmdb(type, tmdbId);
  if (!traktId) {
    console.warn(`[Trakt] No Trakt ${type} id found for TMDB id ${tmdbId}`);
    return { items: [], hasMore: false };
  }

  try {
    return await getCachedRequest(
      `trakt:related:${type}:${tmdbId}:${page}:${limit}`,
      TRAKT_METADATA_CACHE_TTL_MS,
      async () => {
        if (type === 'movie') {
          const response = await client.get<TraktRelatedMovie[]>(`/movies/${traktId}/related`, {
            params: { page, limit }
          });

          const items = await enrichTmdbItemsById(
            response.data
              .filter((item) => !!item.ids.tmdb)
              .map((item) => ({
                tmdbId: item.ids.tmdb as number,
                mediaType: 'movie' as const,
                releaseDate: item.released,
                name: item.title
              }))
          );
          const pageCount = Number(response.headers['x-pagination-page-count']);
          return { items, hasMore: Number.isFinite(pageCount) ? page < pageCount : response.data.length === limit };
        }

        const response = await client.get<TraktRelatedShow[]>(`/shows/${traktId}/related`, {
          params: { page, limit }
        });

        const items = await enrichTmdbItemsById(
          response.data
            .filter((item) => !!item.ids.tmdb)
            .map((item) => ({
              tmdbId: item.ids.tmdb as number,
              mediaType: 'tv' as const,
              releaseDate: item.first_aired,
              name: item.title
            }))
        );
        const pageCount = Number(response.headers['x-pagination-page-count']);
        return { items, hasMore: Number.isFinite(pageCount) ? page < pageCount : response.data.length === limit };
      }
    );
  } catch (e) {
    console.error(`[Trakt] Failed to get related ${type} titles for TMDB id ${tmdbId}:`, getTraktErrorDiagnostics(e));
    return { items: [], hasMore: false };
  }
}

export async function getTraktSentiments(type: 'movie' | 'show', tmdbId: number): Promise<TraktSentiments | null> {
  const client = await createPublicApiClient();
  if (!client) return null;

  const traktId = await getTraktItemIdByTmdb(type, tmdbId);
  if (!traktId) {
    console.warn(`[Trakt] No Trakt ${type} id found for TMDB id ${tmdbId}`);
    return null;
  }

  try {
    return await getCachedRequest(`trakt:sentiments:${type}:${tmdbId}`, TRAKT_METADATA_CACHE_TTL_MS, async () => {
      const response = await client.get<TraktSentiments>(`/${type === 'movie' ? 'movies' : 'shows'}/${traktId}/sentiments`);
      return response.data;
    });
  } catch (e) {
    console.error(`[Trakt] Failed to get ${type} sentiments for TMDB id ${tmdbId}:`, getTraktErrorDiagnostics(e));
    return null;
  }
}
