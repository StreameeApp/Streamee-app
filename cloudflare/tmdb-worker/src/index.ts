const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const WORKER_ROUTE_PREFIX = '/v1/tmdb';
const MAX_QUERY_LENGTH = 200;

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
  if (path.includes('/season/')) return 1_800;
  if (path.startsWith('/search/') || path.startsWith('/discover/') || path.includes('/trending/')) return 900;
  return 21_600;
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
  if (!isAllowedPath(tmdbPath)) {
    return jsonResponse({ error: 'TMDB endpoint is not allowed' }, 404, origin);
  }

  const query = validateAndCopyQuery(requestUrl.searchParams);
  if (!query) {
    return jsonResponse({ error: 'Invalid query parameters' }, 400, origin);
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

  const rateLimitKey = request.headers.get('CF-Connecting-IP') ?? 'unknown-client';
  const { success: withinRateLimit } = await env.TMDB_RATE_LIMITER.limit({ key: rateLimitKey });
  if (!withinRateLimit) {
    return jsonResponse({ error: 'Too many requests' }, 429, origin);
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
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'TMDB proxy request failed',
        error: error instanceof Error ? error.message : String(error),
        path: new URL(request.url).pathname,
      }));
      return jsonResponse(
        { error: 'TMDB service is temporarily unavailable' },
        502,
        request.headers.get('Origin'),
      );
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
