import assert from 'node:assert/strict';
import { test } from 'node:test';
import axios from 'axios';

interface FakeTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

test('background queue handles priority, freshness, retries, offline recovery, quota, and hourly reset', async (context) => {
  context.mock.method(console, 'warn', () => {});
  let now = Date.UTC(2026, 7, 14, 8, 0, 0);
  const realDateNow = Date.now;
  Date.now = () => now;
  context.after(() => {
    Date.now = realDateNow;
  });

  const storage = new Map<string, string>([
    ['streamee-tmdb', JSON.stringify({ apiKey: 'test-tmdb-key' })],
    ['streamee-xrel-background-budget-v1', JSON.stringify({
      date: '2026-08-13',
      requests: 250,
      completed: 250,
    })],
    ['streamee-xrel-background-budget-v2', JSON.stringify({
      resetAt: now - 1,
      requests: 250,
      completed: 250,
    })],
    ['streamee-xrel-background-queue-v1', JSON.stringify({
      version: 1,
      entries: [
        {
          item: { type: 'movie', name: 'Restored Movie', year: '2026' },
          queuedAt: now - 1_000,
          retryAt: 0,
        },
        {
          item: { type: 'movie', name: 'Expired Queue Movie', year: '2026' },
          queuedAt: now - 8 * 24 * 60 * 60 * 1000,
          retryAt: 0,
        },
      ],
    })],
    ['streamee-srrdb-background-budget-v1', JSON.stringify({
      resetAt: now - 1,
      requests: 60,
      completed: 60,
      cooldownUntil: 0,
    })],
    ['streamee-srrdb-background-queue-v1', JSON.stringify({
      version: 1,
      entries: [{
        item: { type: 'movie', name: 'Restored srrDB Movie', year: '2026', imdbId: 'tt1234567' },
        priority: 'library',
        queuedAt: now - 1_000,
      }],
    })],
    ['streamee-xrel-release-quality-cache-v2', JSON.stringify({
      version: 2,
      fetchedAt: 0,
      seenReleaseIds: [],
      entries: [],
      negativeLookups: { 'movie:obsession:2026': now + 24 * 60 * 60 * 1000 },
      preciseLookups: {},
      identityAliases: {},
    })],
  ]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
    },
  });

  let online = true;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { get onLine() { return online; } },
  });

  let nextTimerId = 1;
  const timers = new Map<number, FakeTimer>();
  const networkListeners = new Map<string, () => void>();
  const fakeWindow = {
    innerHeight: 900,
    innerWidth: 1400,
    setTimeout(callback: () => void, delay = 0) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { id, dueAt: now + Number(delay), callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    setInterval() {
      const id = nextTimerId;
      nextTimerId += 1;
      return id;
    },
    clearInterval() {},
    addEventListener(name: string, callback: () => void) {
      networkListeners.set(name, callback);
    },
    removeEventListener() {},
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });

  const flushPromises = async () => {
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
  };
  const runNextTimer = async () => {
    const next = [...timers.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
    assert.ok(next, `expected a scheduled queue timer; pending=${timers.size}`);
    timers.delete(next.id);
    now = Math.max(now, next.dueAt);
    next.callback();
    await flushPromises();
  };
  const runTimersUntil = async (predicate: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await flushPromises();
      if (predicate()) return;
      await runNextTimer();
    }
    assert.fail(message);
  };

  let remainingHeader = 899;
  const providerResetAt = now + 50 * 60 * 1000;
  const backgroundQueries: string[] = [];
  const allRequests: string[] = [];
  const preciseTitlesById = new Map<string, { title: string; imdbId?: string; year: string }>();
  const failures = new Map<string, number>();
  const serviceFailures = new Map<string, number>();
  const searchThrottleFailures = new Map<string, number>();
  let feedReleases: Array<Record<string, unknown>> = [];
  let srrdbRecentPages: Array<Array<Record<string, unknown>>> = [[]];

  context.mock.method(axios, 'get', async (url: string, config?: { params?: Record<string, unknown> }) => {
    allRequests.push(url);
    const params = config?.params ?? {};
    const headers = {
      'x-ratelimit-limit': '900',
      'x-ratelimit-remaining': String(remainingHeader),
      'x-ratelimit-reset': String(Math.floor(providerResetAt / 1000)),
    };

    if (url.includes('api.themoviedb.org/3/movie/')) {
      const tmdbId = /\/movie\/(\d+)/.exec(url)?.[1];
      const imdbId = tmdbId === '424242'
        ? 'tt0000003'
        : tmdbId === '424243' ? 'tt0000004' : tmdbId === '424244' ? 'tt0000005' : undefined;
      return {
        data: {
          imdb_id: imdbId,
        },
        headers: {},
      };
    }

    if (url.includes('api.srrdb.com')) {
      if (url.includes('/search/date:')) {
        const page = Number(/\/page:(\d+)/.exec(url)?.[1] ?? 1);
        return {
          data: {
            results: srrdbRecentPages[page - 1] ?? [],
            resultsCount: srrdbRecentPages.reduce((total, results) => total + results.length, 0),
          },
          headers: {},
        };
      }
      const imdbId = url.split('imdb:').at(-1);
      const release = imdbId === '33764258'
        ? 'The.Odyssey.2026.2160p.UHD.BluRay.HEVC-GROUP'
        : imdbId === '0000005'
          ? 'Independent.Provider.Movie.2026.2160p.WEB.H265-GROUP'
          : 'Tier.Movie.2026.2160p.UHD.BluRay.HEVC-GROUP';
      return {
        data: {
          results: url.endsWith('0000002') || url.endsWith('0000004') ? [] : [{
            release,
            date: '2026-08-14 08:00:00',
            isForeign: 'no',
          }],
        },
        headers: {},
      };
    }

    if (url.endsWith('/release/latest.json') || url.endsWith('/p2p/releases.json')) {
      return { data: { list: feedReleases }, headers };
    }

    if (url.endsWith('/search/releases.json')) {
      const title = String(params.q ?? 'Unknown');
      backgroundQueries.push(title);
      const throttleFailuresRemaining = searchThrottleFailures.get(title) ?? 0;
      if (throttleFailuresRemaining > 0) {
        searchThrottleFailures.set(title, throttleFailuresRemaining - 1);
        throw Object.assign(new Error(`search throttle ${title}`), {
          isAxiosError: true,
          response: { status: 429, data: {}, headers },
        });
      }
      const serviceFailuresRemaining = serviceFailures.get(title) ?? 0;
      if (serviceFailuresRemaining > 0) {
        serviceFailures.set(title, serviceFailuresRemaining - 1);
        throw Object.assign(new Error(`service ${title} failure`), {
          isAxiosError: true,
          response: { status: 503, data: {}, headers: {} },
        });
      }
      const failuresRemaining = failures.get(title) ?? 0;
      if (failuresRemaining > 0) {
        failures.set(title, failuresRemaining - 1);
        throw new Error(`temporary ${title} failure`);
      }
      if (title === 'Original Display Title') {
        return { data: { results: [], p2p_results: [] }, headers };
      }
      const isAliasPoster = title === 'Alias Poster';
      const isLocalizedPoster = title === 'The Odyssey';
      const isTmdbAliasPoster = title === 'TMDB Alias Poster';
      const isConflictingPoster = title === 'Conflicting Identity Poster';
      const isMissingIdentityPoster = title === 'Missing Identity Poster';
      const imdbId = title === 'Tier Movie'
        ? 'tt0000001'
        : isAliasPoster
          ? 'tt0000002'
          : isLocalizedPoster
            ? 'tt33764258'
            : isTmdbAliasPoster
              ? 'tt0000003'
              : isConflictingPoster ? 'tt9999999' : undefined;
      const releaseTitle = isAliasPoster
        ? 'Canonical Alias Title'
        : isLocalizedPoster
          ? 'Die Odyssee'
          : isTmdbAliasPoster ? 'Canonical TMDB Title' : title;
      const dirnameTitle = isAliasPoster
        ? 'Canonical Alias Title'
        : isTmdbAliasPoster ? 'Canonical TMDB Title' : title;
      const releaseYear = isAliasPoster || isTmdbAliasPoster || isMissingIdentityPoster ? '2025' : '2026';
      return {
        data: {
          results: [{
            id: `background-${title}`,
            dirname: `${dirnameTitle.replaceAll(' ', '.')}.${releaseYear}.1080p.WEB.H264-GROUP`,
            time: Math.floor(now / 1000),
            video_type: 'Web-Rip',
            ext_info: {
              id: `title-${title}`,
              type: 'movie',
              title: releaseTitle,
              uris: imdbId ? [`imdb:${imdbId}`] : [],
            },
          }],
          p2p_results: [],
        },
        headers,
      };
    }

    if (url.endsWith('/search/ext_info.json')) {
      const title = String(params.q ?? 'Unknown');
      const isAliasPoster = title === 'Alias Poster';
      const imdbId = title === 'Tier Movie'
        ? 'tt0000001'
        : isAliasPoster ? 'tt0000002' : undefined;
      const id = `precise-${title}`;
      const matchedTitle = isAliasPoster ? 'Canonical Alias Title' : title;
      preciseTitlesById.set(id, { title: matchedTitle, imdbId, year: isAliasPoster ? '2025' : '2026' });
      return {
        data: {
          results: [{
            id,
            type: 'movie',
            title: matchedTitle,
            uris: imdbId ? [`imdb:${imdbId}`] : [],
          }],
        },
        headers,
      };
    }

    if (url.endsWith('/release/ext_info.json')) {
      const precise = preciseTitlesById.get(String(params.id));
      return {
        data: {
          list: precise ? [{
            id: `release-${precise.title}`,
            dirname: `${precise.title.replaceAll(' ', '.')}.${precise.year}.2160p.DV.HDR.HEVC-GROUP`,
            time: Math.floor(now / 1000),
            ext_info: {
              id: String(params.id),
              type: 'movie',
              title: precise.title,
              uris: precise.imdbId ? [`imdb:${precise.imdbId}`] : [],
            },
          }] : [],
        },
        headers,
      };
    }

    return { data: { list: [] }, headers };
  });

  const service = await import('../src/renderer/services/xrel.ts?queue-test');
  assert.equal(service.getXrelQualitySnapshot().backgroundRequestsThisHour, 0, 'expired hourly budget resets');
  assert.equal(service.getXrelQualitySnapshot().backgroundHourlyLimit, 250);
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 1, 'fresh persisted work survives restart and stale work expires');
  assert.equal(service.getXrelQualitySnapshot().srrdbRequestsThisHour, 0, 'expired srrDB hourly budget resets');
  assert.equal(service.getXrelQualitySnapshot().srrdbBackgroundQueued, 1, 'persisted srrDB enrichment survives restart');
  const unsubscribeRestoredQueue = service.subscribeXrelQualitySnapshot(() => {});
  await flushPromises();
  await runNextTimer();
  assert.equal(backgroundQueries[0], 'Restored Movie', 'restored work resumes without revisiting its poster');
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 0);
  await runTimersUntil(
    () => service.getXrelQualitySnapshot().srrdbBackgroundQueued === 0
      && !service.getXrelQualitySnapshot().srrdbBackgroundProcessing,
    'persisted srrDB work did not resume after restart',
  );
  assert.equal(service.getXrelQualitySnapshot().srrdbCompletedThisHour, 1);
  assert.equal(
    service.getXrelQualitySnapshot().xrelRequestsThisHour,
    allRequests.filter((url) => url.includes('xrel-api.nfos.to')).length,
    'the xREL request counter includes feed and background calls',
  );
  const migratedCache = JSON.parse(storage.get('streamee-xrel-release-quality-cache-v2') ?? '{}');
  assert.equal(migratedCache.negativeLookups?.['movie:obsession:2026'], undefined, 'pre-fix false negatives are invalidated');
  assert.equal(migratedCache.backgroundMatcherVersion, 4);
  unsubscribeRestoredQueue();
  assert.equal(service.calculateXrelBackgroundDelay({
    now,
    rateRemaining: null,
    rateResetAt: null,
    quotaReserve: 150,
    budgetRemaining: 250,
  }), 3000);
  assert.equal(service.calculateXrelBackgroundDelay({
    now,
    rateRemaining: 400,
    rateResetAt: now + 2_500_000,
    quotaReserve: 150,
    budgetRemaining: 250,
  }), 5_000);
  assert.equal(service.calculateXrelBackgroundDelay({
    now,
    rateRemaining: 150,
    rateResetAt: now + 60_000,
    quotaReserve: 150,
    budgetRemaining: 250,
  }), 5_000);
  const prunedPrecise = service.pruneXrelPreciseLookups({
    future: now + 60_000,
    newest: now - 1_000,
    older: now - 2_000,
    stale: now - 8 * 24 * 60 * 60 * 1000,
    invalid: Number.NaN,
  }, now, 3);
  assert.deepEqual(Object.keys(prunedPrecise), ['future', 'newest', 'older'], 'precise markers are fresh and capped');
  assert.equal(prunedPrecise.future, now, 'future timestamps cannot extend freshness indefinitely');

  const duplicate = { type: 'movie' as const, name: 'Duplicate Movie', year: '2026' };
  const unregisterDuplicateA = service.registerXrelQualityLookup(duplicate, 'nearby');
  const unregisterDuplicateB = service.registerXrelQualityLookup(duplicate, 'visible');
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 1, 'duplicate titles share one job');
  unregisterDuplicateA();
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 1, 'one remaining poster keeps the job');
  unregisterDuplicateB();
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 1, 'leaving the viewport keeps discovered work queued');
  const persistedAfterNavigation = JSON.parse(storage.get('streamee-xrel-background-queue-v1') ?? '{}');
  assert.equal(persistedAfterNavigation.entries?.[0]?.item?.name, 'Duplicate Movie', 'navigation-safe work is persisted');
  await runNextTimer();
  assert.equal(backgroundQueries.at(-1), 'Duplicate Movie');
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 0);

  const priorityQueryStart = backgroundQueries.length;
  service.registerXrelQualityLookup({ type: 'movie', name: 'Nearby Movie', year: '2026' }, 'nearby');
  service.registerXrelQualityLookup({ type: 'movie', name: 'Visible Movie', year: '2026' }, 'visible');
  service.registerXrelQualityLookup({ type: 'movie', name: 'Library Movie', year: '2026' }, 'library');
  await runTimersUntil(
    () => backgroundQueries.length >= priorityQueryStart + 3
      && !service.getXrelQualitySnapshot().backgroundProcessing,
    'priority queue did not finish its first three jobs',
  );
  assert.deepEqual(backgroundQueries.slice(priorityQueryStart, priorityQueryStart + 3), ['Library Movie', 'Visible Movie', 'Nearby Movie']);
  assert.equal(service.getXrelQualitySnapshot().backgroundBudgetResetAt, providerResetAt, 'budget follows the provider reset window');
  assert.equal(storage.has('streamee-xrel-background-budget-v1'), false, 'legacy daily budget is discarded after migration');

  const missingIdentityPoster = {
    type: 'movie' as const,
    name: 'Missing Identity Poster',
    year: '2026',
  };
  service.registerXrelQualityLookup(missingIdentityPoster, 'visible');
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 1, 'missing-identity fallback enters the xREL queue');
  const queueBeforeMissingIdentity = JSON.parse(storage.get('streamee-xrel-background-queue-v1') ?? '{}');
  assert.equal(queueBeforeMissingIdentity.entries?.[0]?.item?.name, 'Missing Identity Poster');
  await runTimersUntil(
    () => service.getXrelQualityBadge(missingIdentityPoster)?.lookupTier === 'background',
    'missing provider identity did not use the exact-title one-year fallback',
  );
  assert.equal(service.getXrelQualityBadge(missingIdentityPoster)?.label, '1080p');
  assert.equal(service.getXrelQualityBadge(missingIdentityPoster)?.matchMethod, 'title-year');

  const originalTitlePoster = {
    type: 'movie' as const,
    name: 'Original Display Title',
    originalName: 'Titre Original',
    year: '2026',
  };
  const originalQueryStart = backgroundQueries.length;
  service.registerXrelQualityLookup(originalTitlePoster, 'visible');
  await runTimersUntil(
    () => service.getXrelQualityBadge(originalTitlePoster)?.lookupTier === 'background',
    'original-title fallback query did not resolve the release',
  );
  assert.deepEqual(
    backgroundQueries.slice(originalQueryStart, originalQueryStart + 2),
    ['Original Display Title', 'Titre Original'],
  );

  const conflictingIdentityPoster = {
    id: 'movie:424243',
    type: 'movie' as const,
    name: 'Conflicting Identity Poster',
    year: '2026',
  };
  const conflictingQueryStart = backgroundQueries.length;
  service.registerXrelQualityLookup(conflictingIdentityPoster, 'visible');
  await runTimersUntil(
    () => backgroundQueries.length > conflictingQueryStart
      && !service.getXrelQualitySnapshot().backgroundProcessing,
    'conflicting identity lookup did not finish',
  );
  assert.equal(service.getXrelQualityBadge(conflictingIdentityPoster), null, 'explicitly conflicting IMDb result is rejected');

  const tmdbAliasPoster = {
    id: 'movie:424242',
    type: 'movie' as const,
    name: 'TMDB Alias Poster',
    year: '2026',
  };
  service.registerXrelQualityLookup(tmdbAliasPoster, 'visible');
  await runTimersUntil(
    () => service.getXrelQualityBadge(tmdbAliasPoster)?.lookupTier === 'background',
    'TMDB identity did not bridge the canonical-title and release-year mismatch',
  );
  assert.equal(service.getXrelQualityBadge(tmdbAliasPoster)?.label, '1080p');
  assert.equal(service.getXrelQualityBadge(tmdbAliasPoster)?.matchMethod, 'imdb');
  const cacheAfterTmdbIdentity = JSON.parse(storage.get('streamee-xrel-release-quality-cache-v2') ?? '{}');
  assert.equal(cacheAfterTmdbIdentity.identityAliases?.['movie:tmdb alias poster:2026']?.imdbId, 'tt0000003');
  await runTimersUntil(
    () => service.getXrelQualitySnapshot().srrdbBackgroundQueued === 0
      && !service.getXrelQualitySnapshot().srrdbBackgroundProcessing,
    'TMDB-resolved title did not continue into srrDB enrichment',
  );
  const srrdbRequestsBeforeLocalized = service.getXrelQualitySnapshot().srrdbRequestsThisHour;
  const srrdbCompletedBeforeLocalized = service.getXrelQualitySnapshot().srrdbCompletedThisHour;

  const localizedPoster = { type: 'movie' as const, name: 'The Odyssey', year: '2026' };
  service.registerXrelQualityLookup(localizedPoster, 'visible');
  await runTimersUntil(
    () => service.getXrelQualityBadge(localizedPoster)?.lookupTier === 'background',
    'localized xREL metadata did not resolve from the release dirname',
  );
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.label, '1080p');
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.matchMethod, 'imdb');
  const cacheAfterLocalizedMatch = JSON.parse(storage.get('streamee-xrel-release-quality-cache-v2') ?? '{}');
  assert.equal(cacheAfterLocalizedMatch.identityAliases?.['movie:the odyssey:2026']?.imdbId, 'tt33764258');
  assert.equal(service.getXrelQualitySnapshot().srrdbBackgroundQueued, 1, 'weak xREL match enters the independent srrDB queue');
  await runTimersUntil(
    () => service.getXrelQualityBadge(localizedPoster)?.provider === 'srrdb',
    'srrDB background enrichment did not improve the localized poster',
  );
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.label, '4K');
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.previousLabel, '1080p', 'first cross-provider improvement receives NEW');
  assert.equal(service.getXrelQualitySnapshot().srrdbRequestsThisHour, srrdbRequestsBeforeLocalized + 1);
  assert.equal(service.getXrelQualitySnapshot().srrdbCompletedThisHour, srrdbCompletedBeforeLocalized + 1);
  assert.equal(service.getXrelQualitySnapshot().srrdbHourlyLimit, 250);
  const cacheAfterSrrdbEnrichment = JSON.parse(storage.get('streamee-xrel-release-quality-cache-v2') ?? '{}');
  assert.equal(
    cacheAfterSrrdbEnrichment.srrdbLookups?.tt33764258 - now,
    6 * 60 * 60 * 1000,
    'plain 4K enrichment is rechecked after six hours',
  );

  const indexedBeforeSrrdbFeed = service.getXrelQualitySnapshot().indexedTitles;
  srrdbRecentPages = [[{
    release: 'Unknown.Movie.2026.2160p.UHD.BluRay.HEVC-GROUP',
    date: '2026-08-14 08:05:00',
    isForeign: 'no',
    imdbId: '99999999',
  }], [{
    release: 'The.Odyssey.2026.2160p.DV.HDR.UHD.BluRay.HEVC-NEWGROUP',
    date: '2026-08-14 08:05:00',
    isForeign: 'no',
    imdbId: '33764258',
  }]];
  await service.refreshSrrdbReleaseQualities(true);
  srrdbRecentPages = [[]];
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.label, '4K DV', 'recent srrDB releases upgrade known IMDb titles');
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.previousLabel, '4K', 'quality upgrade receives a NEW marker');
  const localizedUpgradeAt = service.getXrelQualityBadge(localizedPoster)?.upgradedAt;
  assert.ok(localizedUpgradeAt, 'upgrade timestamp is retained with the badge');
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.lookupTier, 'feed');
  assert.equal(service.getXrelQualitySnapshot().indexedTitles, indexedBeforeSrrdbFeed, 'recent polling ignores unknown catalog titles');
  assert.equal(service.getXrelQualitySnapshot().srrdbRequestsThisHour, srrdbRequestsBeforeLocalized + 3, 'paginated polling counts each srrDB request');
  const recentSrrdbUrls = allRequests.filter((url) => url.includes('/search/date:')).slice(-2);
  assert.ok(recentSrrdbUrls[0]?.includes('/page:1'));
  assert.ok(recentSrrdbUrls[1]?.includes('/page:2'));
  assert.ok(recentSrrdbUrls.every((url) => !url.includes('/foreign:')), 'Any language does not force the English-only feed');

  srrdbRecentPages = [[{
    release: 'The.Odyssey.2026.2160p.DV.HDR.UHD.BluRay.HEVC-REPACK',
    date: '2026-08-14 08:06:00',
    isForeign: 'no',
    imdbId: '33764258',
  }]];
  await service.refreshSrrdbReleaseQualities(true);
  srrdbRecentPages = [[]];
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.previousLabel, '4K', 'same-quality replacement preserves NEW');
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.upgradedAt, localizedUpgradeAt, 'same-quality replacement preserves the original upgrade time');

  feedReleases = [{
    id: 'cross-provider-odyssey',
    dirname: 'The.Odyssey.2026.2160p.DV.HDR.WEB.H265-OTHERGROUP',
    time: Math.floor(Date.UTC(2026, 7, 14, 10, 0, 0) / 1000),
    ext_info: {
      id: 'cross-provider-The Odyssey',
      type: 'movie',
      title: 'The Odyssey',
      uris: ['imdb:tt33764258'],
    },
  }];
  await service.refreshXrelReleaseQualities(true);
  feedReleases = [];
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.provider, 'xrel', 'newer equal-quality provider becomes the displayed source');
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.previousLabel, '4K', 'provider switch preserves an active NEW marker');
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.upgradedAt, localizedUpgradeAt);
  const cacheWithUpgrade = JSON.parse(storage.get('streamee-xrel-release-quality-cache-v2') ?? '{}');
  assert.ok(
    cacheWithUpgrade.entries?.some((entry: { previousLabel?: string; upgradedAt?: number }) => (
      entry.previousLabel === '4K' && entry.upgradedAt === localizedUpgradeAt
    )),
    'upgrade marker is persisted for restart recovery',
  );

  const tierItem = { type: 'movie' as const, name: 'Tier Movie', year: '2026', imdbId: 'tt0000001' };
  service.registerXrelQualityLookup(tierItem, 'library');
  await runTimersUntil(
    () => service.getXrelQualityBadge(tierItem)?.lookupTier === 'background',
    'tier item background lookup did not finish',
  );
  assert.equal(service.getXrelQualityBadge(tierItem)?.lookupTier, 'background');
  now += 5_025;
  const requestsBeforePrecise = allRequests.length;
  await service.ensureXrelQualityForItem(tierItem);
  assert.equal(service.getXrelQualityBadge(tierItem)?.lookupTier, 'precise');
  assert.equal(service.getXrelQualityBadge(tierItem)?.label, '4K DV');
  assert.equal(service.getXrelQualitySnapshot().preciseTitles, 1);
  const requestsAfterPrecise = allRequests.length;
  assert.ok(requestsAfterPrecise > requestsBeforePrecise, 'background result is promoted by detail lookup');
  await service.ensureXrelQualityForItem(tierItem);
  assert.equal(allRequests.length, requestsAfterPrecise, 'fresh precise result skips repeat detail requests');
  now += 1_000;
  feedReleases = [{
    id: 'feed-tier-movie',
    dirname: 'Tier.Movie.2026.2160p.DV.HDR.HEVC-NEWGROUP',
    time: Math.floor(now / 1000),
    ext_info: {
      id: 'precise-Tier Movie',
      type: 'movie',
      title: 'Tier Movie',
      uris: ['imdb:tt0000001'],
    },
  }];
  await service.refreshXrelReleaseQualities(true);
  feedReleases = [];
  assert.equal(service.getXrelQualityBadge(tierItem)?.lookupTier, 'feed', 'badge provenance follows the winning release');
  assert.equal(service.getXrelQualitySnapshot().preciseTitles, 1, 'title freshness remains precise independently');

  const aliasPoster = { type: 'movie' as const, name: 'Alias Poster', year: '2026' };
  const aliasDetail = { ...aliasPoster, imdbId: 'tt0000002' };
  const aliasQueriesBefore = backgroundQueries.length;
  service.registerXrelQualityLookup(aliasPoster, 'visible');
  await runTimersUntil(
    () => backgroundQueries.length > aliasQueriesBefore
      && service.getXrelQualitySnapshot().backgroundQueued === 0
      && !service.getXrelQualitySnapshot().backgroundProcessing,
    'alias poster background lookup did not finish',
  );
  assert.equal(service.getXrelQualityBadge(aliasPoster), null, 'strict title-year lookup initially rejects the alias');
  const cacheBeforeAlias = JSON.parse(storage.get('streamee-xrel-release-quality-cache-v2') ?? '{}');
  assert.ok(cacheBeforeAlias.negativeLookups?.['movie:alias poster:2026'], 'strict miss is negatively cached');
  now += 5_025;
  await service.ensureXrelQualityForItem(aliasDetail);
  const aliasedBadge = service.getXrelQualityBadge(aliasPoster);
  assert.equal(aliasedBadge?.label, '4K DV', 'detail identity propagates back to the poster');
  assert.equal(aliasedBadge?.matchMethod, 'imdb');
  const cacheAfterAlias = JSON.parse(storage.get('streamee-xrel-release-quality-cache-v2') ?? '{}');
  assert.equal(cacheAfterAlias.identityAliases?.['movie:alias poster:2026']?.imdbId, 'tt0000002');
  assert.equal(cacheAfterAlias.negativeLookups?.['movie:alias poster:2026'], undefined, 'stale negative result is cleared');
  await runTimersUntil(
    () => service.getXrelQualitySnapshot().srrdbBackgroundQueued === 0
      && !service.getXrelQualitySnapshot().srrdbBackgroundProcessing,
    'completed precise lookups did not retire their queued srrDB enrichment',
  );

  failures.set('Retry Movie', 1);
  service.registerXrelQualityLookup({ type: 'movie', name: 'Retry Movie', year: '2026' }, 'visible');
  await runNextTimer();
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 1, 'failed work remains queued');
  const retryTimer = [...timers.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
  assert.equal(retryTimer.dueAt - now, 15 * 60 * 1000, 'failed work uses the retry backoff');
  service.registerXrelQualityLookup({ type: 'movie', name: 'Healthy Movie', year: '2026' }, 'visible');
  const preemptingTimer = [...timers.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
  assert.ok(preemptingTimer.dueAt < retryTimer.dueAt, 'healthy work preempts a title-specific retry timer');
  const queriesBeforeHealthy = backgroundQueries.length;
  await runTimersUntil(
    () => backgroundQueries.length > queriesBeforeHealthy,
    'healthy work did not start during title backoff',
  );
  assert.equal(backgroundQueries[queriesBeforeHealthy], 'Healthy Movie', 'unrelated work continues during title backoff');
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 1, 'failed title remains queued for retry');
  await runNextTimer();
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 0);

  remainingHeader = 400;
  searchThrottleFailures.set('Search Throttle Movie', 1);
  const throttledItem = { type: 'movie' as const, name: 'Search Throttle Movie', year: '2026' };
  service.registerXrelQualityLookup(throttledItem, 'visible');
  await runNextTimer();
  assert.equal(service.getXrelQualitySnapshot().rateRemaining, 400, 'search throttling does not zero the hourly quota');
  const searchRetryTimer = [...timers.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
  assert.equal(searchRetryTimer.dueAt - now, 5_025, 'search throttling retries after the search window');
  await runTimersUntil(
    () => service.getXrelQualitySnapshot().backgroundQueued === 0,
    'search-throttled work did not resume',
  );
  assert.ok(service.getXrelQualityBadge(throttledItem));

  serviceFailures.set('Service Failure Movie', 1);
  service.registerXrelQualityLookup({ type: 'movie', name: 'Service Failure Movie', year: '2026' }, 'visible');
  await runNextTimer();
  const globalRetryTimer = [...timers.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
  assert.equal(globalRetryTimer.dueAt - now, 60 * 1000, 'service failure uses global backoff');
  service.registerXrelQualityLookup({ type: 'movie', name: 'Globally Delayed Movie', year: '2026' }, 'library');
  const timerDuringGlobalBackoff = [...timers.values()].sort((left, right) => left.dueAt - right.dueAt)[0];
  assert.equal(timerDuringGlobalBackoff.dueAt, globalRetryTimer.dueAt, 'new work cannot bypass service backoff');
  await runNextTimer();
  assert.equal(backgroundQueries.at(-1), 'Globally Delayed Movie', 'highest-priority work resumes after service backoff');
  await runNextTimer();
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 0);

  const unsubscribe = service.subscribeXrelQualitySnapshot(() => {});
  await flushPromises();
  online = false;
  const offlineItem = { type: 'movie' as const, name: 'Offline Movie', year: '2026' };
  service.registerXrelQualityLookup(offlineItem, 'library');
  const offlineCalls = backgroundQueries.length;
  await runNextTimer();
  assert.equal(backgroundQueries.length, offlineCalls, 'offline worker does not call the API');
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 1);
  online = true;
  networkListeners.get('online')?.();
  await flushPromises();
  await runNextTimer();
  assert.ok(service.getXrelQualityBadge(offlineItem), 'online event resumes existing queued work');
  unsubscribe();

  remainingHeader = 150;
  service.registerXrelQualityLookup({ type: 'movie', name: 'Quota Setter', year: '2026' }, 'visible');
  await runTimersUntil(
    () => service.getXrelQualitySnapshot().rateRemaining === 150,
    'quota setter request did not finish',
  );
  assert.equal(service.getXrelQualitySnapshot().rateRemaining, 150, 'latest response updates the quota state');
  const blockedItem = { type: 'movie' as const, name: 'Quota Blocked', year: '2026' };
  const unregisterBlocked = service.registerXrelQualityLookup(blockedItem, 'visible');
  const callsBeforeBlocked = backgroundQueries.length;
  await runNextTimer();
  assert.equal(backgroundQueries.length, callsBeforeBlocked, 'quota reserve blocks another request');
  assert.equal(service.getXrelQualitySnapshot().backgroundQueued, 1);
  unregisterBlocked();

  const independentProviderItem = {
    id: 'movie:424244',
    type: 'movie' as const,
    name: 'Independent Provider Movie',
    year: '2026',
  };
  const xrelCallsBeforeIndependentLookup = backgroundQueries.length;
  service.registerXrelQualityLookup(independentProviderItem, 'library');
  await runTimersUntil(
    () => service.getXrelQualityBadge(independentProviderItem)?.provider === 'srrdb',
    'srrDB did not proceed independently while xREL was quota-blocked',
  );
  assert.equal(backgroundQueries.length, xrelCallsBeforeIndependentLookup);
  assert.equal(service.getXrelQualityBadge(independentProviderItem)?.label, '4K');

  now = service.getXrelQualitySnapshot().backgroundBudgetResetAt + 1;
  const unregisterNextWindow = service.registerXrelQualityLookup(
    { type: 'movie', name: 'Next Window Movie', year: '2026' },
    'nearby',
  );
  assert.equal(service.getXrelQualitySnapshot().backgroundRequestsThisHour, 0, 'hourly budget resets with the provider window');
  unregisterNextWindow();

  now = localizedUpgradeAt + 7 * 24 * 60 * 60 * 1000 - 1;
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.previousLabel, '4K', 'NEW remains visible for the full seven-day window');
  now += 2;
  assert.equal(service.getXrelQualityBadge(localizedPoster)?.previousLabel, undefined, 'NEW expires after seven days');
});
