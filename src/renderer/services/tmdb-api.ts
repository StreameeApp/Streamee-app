import axios, { type InternalAxiosRequestConfig } from 'axios';
import { getApiKey } from './api-keys.ts';
import { logger } from './logger.ts';

const TMDB_REQUEST_DIAGNOSTIC_QUIET_MS = 2_000;
const TMDB_REQUEST_DIAGNOSTIC_MAX_WINDOW_MS = 60_000;

interface TmdbRequestDiagnosticBucket {
  startedAt: number;
  lastRequestAt: number;
  requestCount: number;
  completedCount: number;
  failedCount: number;
  routes: Map<string, number>;
}

let tmdbRequestDiagnosticBucket: TmdbRequestDiagnosticBucket | null = null;
let tmdbRequestDiagnosticTimer: number | undefined;
const tmdbRequestDiagnosticBucketsByConfig = new WeakMap<object, TmdbRequestDiagnosticBucket>();

function classifyTmdbRoute(url?: string): string {
  const path = (url ?? '').split('?')[0];
  if (/^\/tv\/\d+\/season\/\d+$/.test(path)) return 'tv.season';
  if (/^\/(?:tv|movie)\/\d+\/watch\/providers$/.test(path)) return 'title.watch_providers';
  if (/^\/(?:tv|movie)\/\d+\/videos$/.test(path)) return 'title.videos';
  if (/^\/person\/\d+\/combined_credits$/.test(path)) return 'person.combined_credits';
  if (/^\/tv\/\d+$/.test(path)) return 'tv.detail';
  if (/^\/movie\/\d+$/.test(path)) return 'movie.detail';
  if (/^\/aggregate\/[a-z_]+$/.test(path)) return path.slice(1).replace('/', '.');
  if (/^\/discover\/(?:tv|movie)$/.test(path)) return path.slice(1).replace('/', '.');
  if (/^\/search\/(?:multi|person)$/.test(path)) return path.slice(1).replace('/', '.');
  if (path === '/configuration/languages') return 'configuration.languages';
  return 'other';
}

function getTmdbDiagnosticInFlightCount(bucket: TmdbRequestDiagnosticBucket): number {
  return Math.max(0, bucket.requestCount - bucket.completedCount - bucket.failedCount);
}

function flushTmdbRequestDiagnostics(status: 'completed' | 'partial', flushReason: 'quiet' | 'max_window'): void {
  if (tmdbRequestDiagnosticTimer !== undefined) {
    window.clearTimeout(tmdbRequestDiagnosticTimer);
    tmdbRequestDiagnosticTimer = undefined;
  }

  const bucket = tmdbRequestDiagnosticBucket;
  tmdbRequestDiagnosticBucket = null;
  if (!bucket) return;

  const durationMs = Math.max(0, Date.now() - bucket.startedAt);
  logger.info('tmdb.worker_request_batch.finished', `[TMDB Worker Requests] Batch ${status}`, {
    status,
    flush_reason: flushReason,
    duration_ms: durationMs,
    request_count: bucket.requestCount,
    completed_count: bucket.completedCount,
    failed_count: bucket.failedCount,
    in_flight_count: getTmdbDiagnosticInFlightCount(bucket),
    route_counts: [...bucket.routes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([route, count]) => ({ route, count })),
  }, 'tmdb.worker_requests');
}

function scheduleTmdbRequestDiagnosticFlush(): void {
  const bucket = tmdbRequestDiagnosticBucket;
  if (!bucket) return;
  if (tmdbRequestDiagnosticTimer !== undefined) window.clearTimeout(tmdbRequestDiagnosticTimer);

  const now = Date.now();
  const quietDeadline = bucket.lastRequestAt + TMDB_REQUEST_DIAGNOSTIC_QUIET_MS;
  const maxDeadline = bucket.startedAt + TMDB_REQUEST_DIAGNOSTIC_MAX_WINDOW_MS;
  const inFlightCount = getTmdbDiagnosticInFlightCount(bucket);
  const nextDeadline = inFlightCount > 0 && quietDeadline <= now
    ? maxDeadline
    : Math.min(quietDeadline, maxDeadline);
  tmdbRequestDiagnosticTimer = window.setTimeout(
    () => {
      tmdbRequestDiagnosticTimer = undefined;
      const activeBucket = tmdbRequestDiagnosticBucket;
      if (!activeBucket) return;

      const currentTime = Date.now();
      if (currentTime >= activeBucket.startedAt + TMDB_REQUEST_DIAGNOSTIC_MAX_WINDOW_MS) {
        flushTmdbRequestDiagnostics('partial', 'max_window');
        return;
      }

      if (
        currentTime >= activeBucket.lastRequestAt + TMDB_REQUEST_DIAGNOSTIC_QUIET_MS
        && getTmdbDiagnosticInFlightCount(activeBucket) === 0
      ) {
        flushTmdbRequestDiagnostics('completed', 'quiet');
        return;
      }

      scheduleTmdbRequestDiagnosticFlush();
    },
    Math.max(0, nextDeadline - now),
  );
}

function recordTmdbWorkerRequest(config: object, url?: string): void {
  const now = Date.now();
  if (!tmdbRequestDiagnosticBucket) {
    tmdbRequestDiagnosticBucket = {
      startedAt: now,
      lastRequestAt: now,
      requestCount: 0,
      completedCount: 0,
      failedCount: 0,
      routes: new Map(),
    };
  }

  const route = classifyTmdbRoute(url);
  tmdbRequestDiagnosticBucket.lastRequestAt = now;
  tmdbRequestDiagnosticBucket.requestCount += 1;
  tmdbRequestDiagnosticBucket.routes.set(route, (tmdbRequestDiagnosticBucket.routes.get(route) ?? 0) + 1);
  tmdbRequestDiagnosticBucketsByConfig.set(config, tmdbRequestDiagnosticBucket);
  scheduleTmdbRequestDiagnosticFlush();
}

function recordTmdbWorkerOutcome(config: object | undefined, failed: boolean): void {
  if (!config) return;
  const bucket = tmdbRequestDiagnosticBucketsByConfig.get(config);
  if (!bucket) return;
  tmdbRequestDiagnosticBucketsByConfig.delete(config);
  if (failed) bucket.failedCount += 1;
  else bucket.completedCount += 1;
  if (bucket === tmdbRequestDiagnosticBucket) scheduleTmdbRequestDiagnosticFlush();
}

const configuredWorkerUrl = import.meta.env?.VITE_TMDB_WORKER_URL?.trim().replace(/\/+$/, '');
const tmdbWorkerBaseUrl = configuredWorkerUrl
  ? `${configuredWorkerUrl}/v1/tmdb`
  : 'http://127.0.0.1:8787/v1/tmdb';
const tmdbDirectBaseUrl = 'https://api.themoviedb.org/3';

type TmdbRequestRoute = 'personal' | 'worker';
type RoutedTmdbRequestConfig = InternalAxiosRequestConfig & {
  streameeTmdbRoute?: TmdbRequestRoute;
  streameeTmdbFallbackAttempted?: boolean;
};

function isWorkerOnlyRoute(url?: string): boolean {
  return (url ?? '').split('?')[0].startsWith('/aggregate/');
}

function removePersonalCredential(request: RoutedTmdbRequestConfig): void {
  if (request.params && typeof request.params === 'object') {
    const { api_key: _apiKey, ...params } = request.params as Record<string, unknown>;
    request.params = params;
  }
  request.headers.delete('Authorization');
}

function applyPersonalCredential(request: RoutedTmdbRequestConfig, apiKey: string): void {
  if (/^[a-f\d]{32}$/i.test(apiKey)) {
    request.params = {
      ...(request.params && typeof request.params === 'object' ? request.params : {}),
      api_key: apiKey,
    };
    return;
  }

  request.headers.set('Authorization', `Bearer ${apiKey}`);
}

function canFallbackToWorker(error: unknown): boolean {
  if (!axios.isAxiosError(error) || axios.isCancel(error)) return false;
  const status = error.response?.status;
  return status === undefined
    || status === 401
    || status === 403
    || status === 408
    || status === 429
    || status >= 500;
}

export async function hasPersonalTmdbApiKey(): Promise<boolean> {
  return !!(await getApiKey('tmdb'));
}

export const isTmdbServiceConfigured = Boolean(configuredWorkerUrl)
  || Boolean(import.meta.env?.DEV)
  || (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);

export const tmdbClient = axios.create({
  baseURL: tmdbWorkerBaseUrl,
  timeout: 15_000,
});

tmdbClient.interceptors.request.use(async (request) => {
  const routedRequest = request as RoutedTmdbRequestConfig;
  const personalApiKey = isWorkerOnlyRoute(request.url) || routedRequest.streameeTmdbFallbackAttempted
    ? ''
    : await getApiKey('tmdb');

  if (personalApiKey) {
    routedRequest.streameeTmdbRoute = 'personal';
    routedRequest.baseURL = tmdbDirectBaseUrl;
    applyPersonalCredential(routedRequest, personalApiKey);
    return routedRequest;
  }

  if (!isTmdbServiceConfigured) {
    throw new axios.CanceledError('TMDB access is not configured for this build.');
  }

  routedRequest.streameeTmdbRoute = 'worker';
  routedRequest.baseURL = tmdbWorkerBaseUrl;
  removePersonalCredential(routedRequest);
  recordTmdbWorkerRequest(routedRequest, routedRequest.url);
  return routedRequest;
});

tmdbClient.interceptors.response.use(
  (response) => {
    const routedRequest = response.config as RoutedTmdbRequestConfig;
    if (routedRequest.streameeTmdbRoute === 'worker') {
      recordTmdbWorkerOutcome(routedRequest, false);
    }
    return response;
  },
  async (error) => {
    const routedRequest = error?.config as RoutedTmdbRequestConfig | undefined;
    if (routedRequest?.streameeTmdbRoute === 'worker') {
      recordTmdbWorkerOutcome(routedRequest, true);
    }

    if (
      routedRequest?.streameeTmdbRoute === 'personal'
      && !routedRequest.streameeTmdbFallbackAttempted
      && canFallbackToWorker(error)
      && (Boolean(configuredWorkerUrl) || Boolean(import.meta.env?.DEV))
    ) {
      routedRequest.streameeTmdbFallbackAttempted = true;
      routedRequest.baseURL = tmdbWorkerBaseUrl;
      removePersonalCredential(routedRequest);
      logger.warn(
        'tmdb.personal_request_fallback',
        '[TMDB] Personal credential request failed; retrying through the managed service',
        {
          route: classifyTmdbRoute(routedRequest.url),
          status: axios.isAxiosError(error) ? error.response?.status ?? null : null,
        },
        'tmdb.requests',
      );
      return tmdbClient.request(routedRequest);
    }

    return Promise.reject(error);
  },
);
