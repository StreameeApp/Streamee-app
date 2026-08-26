import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import worker from '../cloudflare/tmdb-worker/src/index.ts';

function installCacheMock(context: TestContext): void {
  const previousCaches = globalThis.caches;
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  context.after(() => {
    if (previousCaches) {
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: previousCaches });
    } else {
      Reflect.deleteProperty(globalThis, 'caches');
    }
  });
}

function workerEnvironment() {
  return {
    TMDB_API_READ_ACCESS_TOKEN: 'test-token',
    TMDB_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
  };
}

function executionContext() {
  return {
    waitUntil: (_promise: Promise<unknown>) => undefined,
  };
}

test('aggregate title preserves details when optional watch providers fail', async (context) => {
  installCacheMock(context);
  context.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/watch/providers')) {
      return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
    }
    return Response.json({ id: 11, title: 'Test title', poster_path: null, backdrop_path: null, vote_average: 8 });
  });

  const response = await worker.fetch(
    new Request('https://metadata.example/v1/tmdb/aggregate/title/movie/11?include_watch_providers=1'),
    workerEnvironment() as never,
    executionContext() as never,
  );
  const body = await response.json() as { details: { id: number }; watchProviders: unknown };

  assert.equal(response.status, 200);
  assert.equal(body.details.id, 11);
  assert.equal(body.watchProviders, null);
});

test('aggregate Board preserves successful rows when one TMDB catalog fails', async (context) => {
  installCacheMock(context);
  context.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/movie/popular')) {
      return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
    }
    return Response.json({
      page: 1,
      results: [{ id: 1, genre_ids: [], original_language: 'en' }],
      total_pages: 1,
      total_results: 1,
    });
  });

  const response = await worker.fetch(
    new Request('https://metadata.example/v1/tmdb/aggregate/board?content_mode=all'),
    workerEnvironment() as never,
    executionContext() as never,
  );
  const body = await response.json() as Record<string, { results: unknown[] } | null>;

  assert.equal(response.status, 200);
  assert.equal(body.popularMovies, null);
  assert.equal(body.trendingMovies?.results.length, 1);
  assert.equal(body.trendingTv?.results.length, 1);
  assert.equal(body.popularTv?.results.length, 1);
});

test('aggregate Discovery preserves TV results when Movie discovery fails', async (context) => {
  installCacheMock(context);
  context.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/discover/movie')) {
      return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
    }
    return Response.json({
      page: 1,
      results: [{ id: 2, genre_ids: [], original_language: 'en' }],
      total_pages: 1,
      total_results: 1,
    });
  });

  const response = await worker.fetch(
    new Request('https://metadata.example/v1/tmdb/aggregate/discovery?content_mode=all&media_type=all&page=1'),
    workerEnvironment() as never,
    executionContext() as never,
  );
  const body = await response.json() as {
    movies: { results: unknown[] } | null;
    tv: { results: unknown[] } | null;
  };

  assert.equal(response.status, 200);
  assert.equal(body.movies, null);
  assert.equal(body.tv?.results.length, 1);
});
