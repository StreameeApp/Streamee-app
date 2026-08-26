const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const WORKER_ROUTE_PREFIX = '/v1/tmdb';
const MAX_QUERY_LENGTH = 200;
const BOARD_PAGE_SIZE = 20;
const BOARD_MAX_SOURCE_PAGES = 8;
const PREVIEW_BATCH_MAX_ITEMS = 20;
const PREVIEW_BATCH_MAX_QUERY_LENGTH = 500;

type WorkerEnv = Env & {
  TMDB_API_READ_ACCESS_TOKEN: string;
};

const ALLOWED_QUERY_PARAMETERS = new Set([
  'append_to_response',
  'first_air_date_year',
  'include_image_language',
  'page',
  'primary_release_year',
  'query',
  'with_genres',
  'with_original_language',
]);

const ALLOWED_APPEND_RESPONSES = new Set([
  'aggregate_credits',
  'alternative_titles',
  'credits',
  'external_ids',
  'images',
  'videos',
]);

const ALLOWED_PATHS = [
  /^\/configuration\/languages$/,
  /^\/discover\/(?:movie|tv)$/,
  /^\/search\/(?:multi|person)$/,
  /^\/person\/\d+\/combined_credits$/,
  /^\/trending\/(?:movie|tv)\/week$/,
  /^\/movie\/(?:popular|top_rated|upcoming|now_playing)$/,
  /^\/tv\/(?:popular|top_rated|on_the_air|airing_today)$/,
  /^\/(?:movie|tv)\/\d+$/,
  /^\/(?:movie|tv)\/\d+\/(?:external_ids|videos|watch\/providers)$/,
  /^\/tv\/\d+\/season\/\d+$/,
];

type DiscoveryContentMode = 'all' | 'anime-only' | 'exclude-anime';

interface TmdbCatalogItem {
  id: number;
  genre_ids?: number[];
  original_language?: string;
}

interface TmdbCatalogResponse {
  page: number;
  results: TmdbCatalogItem[];
  total_pages: number;
  total_results: number;
}

function corsHeaders(origin: string | null): HeadersInit {
  const allowedOrigin = origin && (
    origin === 'tauri://localhost'
    || origin === 'http://tauri.localhost'
    || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
  ) ? origin : 'null';

  return {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(origin),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function isAllowedPath(path: string): boolean {
  return ALLOWED_PATHS.some((pattern) => pattern.test(path));
}

function validateAndCopyQuery(source: URLSearchParams): URLSearchParams | null {
  const destination = new URLSearchParams();

  for (const [key, value] of source) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key) || value.length > MAX_QUERY_LENGTH) return null;
    destination.append(key, value);
  }

  const page = destination.get('page');
  if (page && (!/^\d{1,3}$/.test(page) || Number(page) < 1 || Number(page) > 500)) return null;

  const query = destination.get('query');
  if (query !== null && query.trim().length === 0) return null;

  const appendToResponse = destination.get('append_to_response');
  if (appendToResponse) {
    const requested = appendToResponse.split(',');
    if (requested.some((entry) => !ALLOWED_APPEND_RESPONSES.has(entry))) return null;
  }

  destination.sort();
  return destination;
}

function cacheTtlSeconds(path: string): number {
  if (path === '/configuration/languages') return 86_400;
  if (path === '/aggregate/board' || path === '/aggregate/discovery') return 1_800;
  if (path === '/aggregate/previews') return 21_600;
  if (path.includes('/season/')) return 1_800;
  if (path.startsWith('/search/')) return 900;
  if (path.startsWith('/discover/') || path.includes('/trending/')) return 1_800;
  return 21_600;
}

function isAggregatePath(path: string): boolean {
  return path === '/aggregate/board'
    || path === '/aggregate/discovery'
    || path === '/aggregate/previews'
    || /^\/aggregate\/title\/(?:movie|tv)\/\d+$/.test(path);
}

function validateAggregateQuery(path: string, source: URLSearchParams): URLSearchParams | null {
  const destination = new URLSearchParams();
  const allowed = path === '/aggregate/board'
    ? new Set(['content_mode'])
    : path === '/aggregate/discovery'
      ? new Set(['content_mode', 'genre_id', 'language', 'media_type', 'page', 'year'])
    : path === '/aggregate/previews'
      ? new Set(['items'])
    : new Set(['include_watch_providers']);

  for (const [key, value] of source) {
    const maxLength = path === '/aggregate/previews'
      ? PREVIEW_BATCH_MAX_QUERY_LENGTH
      : MAX_QUERY_LENGTH;
    if (!allowed.has(key) || value.length > maxLength) return null;
    destination.append(key, value);
  }

  if (path === '/aggregate/board') {
    const mode = destination.get('content_mode') ?? 'all';
    if (!['all', 'anime-only', 'exclude-anime'].includes(mode)) return null;
    destination.set('content_mode', mode);
  } else if (path === '/aggregate/discovery') {
    const mode = destination.get('content_mode') ?? 'all';
    const mediaType = destination.get('media_type') ?? 'all';
    const page = destination.get('page') ?? '1';
    const genreId = destination.get('genre_id');
    const year = destination.get('year');
    const language = destination.get('language');
    if (!['all', 'anime-only', 'exclude-anime'].includes(mode)) return null;
    if (!['all', 'movie', 'tv'].includes(mediaType)) return null;
    if (!/^\d{1,3}$/.test(page) || Number(page) < 1 || Number(page) > 500) return null;
    if (genreId !== null && (!/^\d{1,6}$/.test(genreId) || Number(genreId) < 1)) return null;
    if (year !== null && !/^\d{4}$/.test(year)) return null;
    if (language !== null && !/^[a-z]{2}$/.test(language)) return null;
    destination.set('content_mode', mode);
    destination.set('media_type', mediaType);
    destination.set('page', page);
  } else if (path === '/aggregate/previews') {
    const items = destination.get('items')?.split(',') ?? [];
    const normalizedItems = [...new Set(items)]
      .filter((item) => /^(?:movie|tv):\d{1,10}$/.test(item))
      .sort();
    if (
      normalizedItems.length === 0
      || normalizedItems.length > PREVIEW_BATCH_MAX_ITEMS
      || normalizedItems.length !== items.length
    ) return null;
    destination.set('items', normalizedItems.join(','));
  } else {
    const includeProviders = destination.get('include_watch_providers') ?? '0';
    if (!['0', '1'].includes(includeProviders)) return null;
    destination.set('include_watch_providers', includeProviders);
  }

  destination.sort();
  return destination;
}

async function fetchTmdbJson<T>(
  path: string,
  query: URLSearchParams,
  apiToken: string,
): Promise<T> {
  const upstreamUrl = new URL(`${TMDB_API_BASE}${path}`);
  upstreamUrl.search = query.toString();
  const response = await fetch(upstreamUrl, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`TMDB request failed with status ${response.status}`);
  }
  return response.json<T>();
}

function matchesContentMode(item: TmdbCatalogItem, mode: DiscoveryContentMode): boolean {
  if (mode === 'all') return true;
  const isAnime = item.genre_ids?.includes(16) === true && item.original_language === 'ja';
  return mode === 'anime-only' ? isAnime : !isAnime;
}

async function fetchBoardCatalog(
  path: string,
  mode: DiscoveryContentMode,
  apiToken: string,
  useAnimeDiscover: boolean = false,
): Promise<TmdbCatalogResponse> {
  const items: TmdbCatalogItem[] = [];
  const seenIds = new Set<number>();
  let lastResponse: TmdbCatalogResponse | null = null;

  for (let page = 1; page <= BOARD_MAX_SOURCE_PAGES; page += 1) {
    const query = new URLSearchParams({ page: String(page) });
    if (useAnimeDiscover) {
      query.set('with_genres', '16');
      query.set('with_original_language', 'ja');
    }
    const response = await fetchTmdbJson<TmdbCatalogResponse>(path, query, apiToken);
    lastResponse = response;

    for (const item of response.results) {
      if (!matchesContentMode(item, mode) || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      items.push(item);
      if (items.length >= BOARD_PAGE_SIZE) break;
    }

    if (items.length >= BOARD_PAGE_SIZE || page >= response.total_pages) break;
  }

  return {
    page: 1,
    results: items.slice(0, BOARD_PAGE_SIZE),
    total_pages: lastResponse?.total_pages ?? 1,
    total_results: lastResponse?.total_results ?? items.length,
  };
}

function buildDiscoveryQuery(
  mediaType: 'movie' | 'tv',
  sourcePage: number,
  aggregateQuery: URLSearchParams,
  mode: DiscoveryContentMode,
): URLSearchParams {
  const query = new URLSearchParams({ page: String(sourcePage) });
  const genreId = aggregateQuery.get('genre_id');
  const year = aggregateQuery.get('year');
  const language = aggregateQuery.get('language');
  const genres = genreId ? [genreId] : [];
  if (mode === 'anime-only' && !genres.includes('16')) genres.push('16');
  if (genres.length > 0) query.set('with_genres', genres.join(','));
  if (year) query.set(mediaType === 'movie' ? 'primary_release_year' : 'first_air_date_year', year);
  if (language) query.set('with_original_language', language);
  else if (mode === 'anime-only') query.set('with_original_language', 'ja');
  return query;
}

async function fetchDiscoveryCatalog(
  mediaType: 'movie' | 'tv',
  logicalPage: number,
  mode: DiscoveryContentMode,
  aggregateQuery: URLSearchParams,
  apiToken: string,
): Promise<TmdbCatalogResponse> {
  const upstreamMode = mode === 'exclude-anime' ? 'all' : mode;
  const response = await fetchTmdbJson<TmdbCatalogResponse>(
    `/discover/${mediaType}`,
    buildDiscoveryQuery(mediaType, logicalPage, aggregateQuery, upstreamMode),
    apiToken,
  );
  return {
    ...response,
    results: response.results.filter((item) => matchesContentMode(item, mode)),
  };
}

async function fetchAggregateResponse(
  path: string,
  query: URLSearchParams,
  apiToken: string,
): Promise<unknown> {
  if (path === '/aggregate/board') {
    const mode = (query.get('content_mode') ?? 'all') as DiscoveryContentMode;
    const useAnimeDiscover = mode === 'anime-only';
    const results = await Promise.allSettled([
      fetchBoardCatalog('/trending/movie/week', mode, apiToken),
      fetchBoardCatalog(useAnimeDiscover ? '/discover/movie' : '/movie/popular', mode, apiToken, useAnimeDiscover),
      fetchBoardCatalog('/trending/tv/week', mode, apiToken),
      fetchBoardCatalog(useAnimeDiscover ? '/discover/tv' : '/tv/popular', mode, apiToken, useAnimeDiscover),
    ]);
    const [trendingMovies, popularMovies, trendingTv, popularTv] = results.map((result) => (
      result.status === 'fulfilled' ? result.value : null
    ));
    if (results.every((result) => result.status === 'rejected')) {
      throw new Error('All TMDB Board requests failed');
    }
    return { trendingMovies, popularMovies, trendingTv, popularTv };
  }

  if (path === '/aggregate/discovery') {
    const mode = (query.get('content_mode') ?? 'all') as DiscoveryContentMode;
    const mediaType = query.get('media_type') ?? 'all';
    const logicalPage = Number(query.get('page') ?? '1');
    const results = await Promise.allSettled([
      mediaType === 'tv'
        ? Promise.resolve(null)
        : fetchDiscoveryCatalog('movie', logicalPage, mode, query, apiToken),
      mediaType === 'movie'
        ? Promise.resolve(null)
        : fetchDiscoveryCatalog('tv', logicalPage, mode, query, apiToken),
    ]);
    const movies = results[0].status === 'fulfilled' ? results[0].value : null;
    const tv = results[1].status === 'fulfilled' ? results[1].value : null;
    const allRequestedSourcesFailed = mediaType === 'movie'
      ? movies === null
      : mediaType === 'tv'
        ? tv === null
        : movies === null && tv === null;
    if (allRequestedSourcesFailed) throw new Error('All requested TMDB Discovery requests failed');
    return { movies, tv };
  }

  if (path === '/aggregate/previews') {
    const requestedItems = query.get('items')?.split(',') ?? [];
    const results = await Promise.allSettled(requestedItems.map(async (item) => {
      const [mediaType, tmdbId] = item.split(':') as ['movie' | 'tv', string];
      const detail = await fetchTmdbJson<TmdbCatalogItem>(
        `/${mediaType}/${tmdbId}`,
        new URLSearchParams({ append_to_response: 'external_ids' }),
        apiToken,
      );
      return { mediaType, tmdbId: Number(tmdbId), detail };
    }));
    const items = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    if (items.length === 0) throw new Error('All TMDB preview requests failed');
    return { items };
  }

  const match = path.match(/^\/aggregate\/title\/(movie|tv)\/(\d+)$/);
  if (!match) throw new Error('Invalid aggregate title path');
  const [, mediaType, tmdbId] = match;
  const detailsQuery = new URLSearchParams({
    append_to_response: mediaType === 'tv'
      ? 'credits,aggregate_credits,external_ids,alternative_titles,videos,images'
      : 'credits,external_ids,alternative_titles,videos,images',
    include_image_language: 'en,null',
  });
  const includeProviders = query.get('include_watch_providers') === '1';
  const [details, watchProviders] = await Promise.all([
    fetchTmdbJson<unknown>(`/${mediaType}/${tmdbId}`, detailsQuery, apiToken),
    includeProviders
      ? fetchTmdbJson<unknown>(
          `/${mediaType}/${tmdbId}/watch/providers`,
          new URLSearchParams(),
          apiToken,
        ).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { details, watchProviders };
}

function routeCategory(pathname: string): string {
  if (pathname === '/health') return 'health';
  if (!pathname.startsWith(`${WORKER_ROUTE_PREFIX}/`)) return 'unknown';
  const path = pathname.slice(WORKER_ROUTE_PREFIX.length);
  if (path === '/aggregate/board') return 'aggregate_board';
  if (path === '/aggregate/discovery') return 'aggregate_discovery';
  if (path === '/aggregate/previews') return 'aggregate_previews';
  if (path.startsWith('/aggregate/title/')) return 'aggregate_title';
  if (path.startsWith('/search/')) return 'search';
  if (path.startsWith('/discover/')) return 'discover';
  if (path.includes('/watch/providers')) return 'watch_providers';
  if (path.includes('/season/')) return 'season';
  if (/^\/(?:movie|tv)\/\d+$/.test(path)) return 'title';
  return 'other_allowed';
}

async function handleRequest(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, origin);
  }
  if (requestUrl.pathname === '/health') {
    return jsonResponse({ ok: true }, 200, origin);
  }
  if (!requestUrl.pathname.startsWith(`${WORKER_ROUTE_PREFIX}/`)) {
    return jsonResponse({ error: 'Not found' }, 404, origin);
  }

  const tmdbPath = requestUrl.pathname.slice(WORKER_ROUTE_PREFIX.length);
  const aggregateRequest = isAggregatePath(tmdbPath);
  if (!aggregateRequest && !isAllowedPath(tmdbPath)) {
    return jsonResponse({ error: 'TMDB endpoint is not allowed' }, 404, origin);
  }

  const query = aggregateRequest
    ? validateAggregateQuery(tmdbPath, requestUrl.searchParams)
    : validateAndCopyQuery(requestUrl.searchParams);
  if (!query) {
    return jsonResponse({ error: 'Invalid query parameters' }, 400, origin);
  }

  const rateLimitKey = request.headers.get('CF-Connecting-IP') ?? 'unknown-client';
  const { success: withinRateLimit } = await env.TMDB_RATE_LIMITER.limit({ key: rateLimitKey });
  if (!withinRateLimit) {
    return jsonResponse({ error: 'Too many requests' }, 429, origin);
  }

  const cacheKeyUrl = new URL(requestUrl);
  cacheKeyUrl.hash = '';
  cacheKeyUrl.search = query.toString();
  const cacheKey = new Request(cacheKeyUrl, { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, cached);
    Object.entries(corsHeaders(origin)).forEach(([key, value]) => response.headers.set(key, String(value)));
    response.headers.set('X-Streamee-Cache', 'HIT');
    return response;
  }

  const apiToken = env.TMDB_API_READ_ACCESS_TOKEN?.trim();
  if (!apiToken) {
    return jsonResponse({ error: 'TMDB service is not configured' }, 503, origin);
  }

  if (aggregateRequest) {
    const body = await fetchAggregateResponse(tmdbPath, query, apiToken);
    const ttl = cacheTtlSeconds(tmdbPath);
    const response = Response.json(body, {
      headers: {
        ...corsHeaders(origin),
        'Cache-Control': `public, max-age=${ttl}`,
        'X-Content-Type-Options': 'nosniff',
        'X-Streamee-Cache': 'MISS',
      },
    });
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  }

  const upstreamUrl = new URL(`${TMDB_API_BASE}${tmdbPath}`);
  upstreamUrl.search = query.toString();
  const upstream = await fetch(upstreamUrl, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiToken}`,
    },
  });

  const ttl = cacheTtlSeconds(tmdbPath);
  const response = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: {
      ...corsHeaders(origin),
      'Cache-Control': upstream.ok ? `public, max-age=${ttl}` : 'no-store',
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Streamee-Cache': 'MISS',
    },
  });

  if (upstream.ok) {
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  }
  return response;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const startedAt = Date.now();
    try {
      const response = await handleRequest(request, env, ctx);
      console.log(JSON.stringify({
        message: 'TMDB proxy request',
        route: routeCategory(new URL(request.url).pathname),
        method: request.method,
        status: response.status,
        cache: response.headers.get('X-Streamee-Cache') ?? 'BYPASS',
        durationMs: Date.now() - startedAt,
      }));
      return response;
    } catch (error) {
      console.error(JSON.stringify({
        message: 'TMDB proxy request failed',
        error: error instanceof Error ? error.message : String(error),
        route: routeCategory(new URL(request.url).pathname),
      }));
      return jsonResponse(
        { error: 'TMDB service is temporarily unavailable' },
        502,
        request.headers.get('Origin'),
      );
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
