import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';

test('OMDb requests recover across key changes and respect concurrency and quota', async (context) => {
  context.mock.method(console, 'warn', () => {});
  context.mock.method(console, 'error', () => {});
  let key = 'first-test-key';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  const browser = Object.assign(new EventTarget(), {
    setTimeout, clearTimeout,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: { apiKey?: string }) => {
        if (command === 'get_api_key') return key;
        if (command === 'set_api_key') { key = args!.apiKey!; return; }
        if (command === 'read_request_cache') return [];
        return null;
      },
    },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  const omdb = await import('../src/renderer/services/omdb.ts');
  const originalAdapter = axios.defaults.adapter;
  context.after(() => { axios.defaults.adapter = originalAdapter; });
  const response = (config: unknown, data: unknown, status = 200) => ({ data, status, statusText: 'Test response', headers: {}, config });

  await context.test('a request using a replacement key does not join the rejected old request', async () => {
    let started!: () => void;
    let release!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const keys: string[] = [];
    axios.defaults.adapter = async (config) => {
      keys.push(config.params.apikey);
      if (config.params.apikey === 'first-test-key') {
        started();
        await gate;
        return response(config, { Response: 'False', Error: 'Invalid API key!' }, 401) as never;
      }
      return response(config, { Response: 'True', imdbRating: '8.1', imdbVotes: '12,345' }) as never;
    };
    const old = omdb.getOmdbRatingDetails('tt9000000001');
    await requestStarted;
    await omdb.setOmdbSettings({ apiKey: 'replacement-test-key' });
    const current = omdb.getOmdbRatingDetails('tt9000000001');
    release();
    assert.equal(await old, null);
    assert.deepEqual(await current, { rating: 8.1, votes: 12345 });
    assert.deepEqual(keys, ['first-test-key', 'replacement-test-key']);
    assert.equal(await omdb.canFetchOmdbRatings(), true);
  });

  await context.test('parallel title requests stay within two active requests and deduplicate titles', async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    axios.defaults.adapter = async (config) => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return response(config, { Response: 'True', imdbRating: '7.5', imdbVotes: '500' }) as never;
    };
    const ids = Array.from({ length: 12 }, (_, index) => `tt${9000000100 + index}`);
    const ratings = await Promise.all([...ids, ids[0]].map(omdb.getOmdbRatingDetails));
    assert.ok(ratings.every((rating) => rating?.rating === 7.5));
    assert.equal(maximum, 2);
    assert.equal(calls, 12);
    assert.equal((await omdb.getOmdbRatingDetails(ids[0]))?.votes, 500);
    assert.equal(calls, 12);
  });

  await context.test('a quota response pauses queued requests and preserves already cached ratings', async () => {
    let calls = 0;
    axios.defaults.adapter = async (config) => {
      calls += 1;
      return response(config, { Response: 'False', Error: 'Request limit reached!' }, 429) as never;
    };
    const ratings = await Promise.all(Array.from({ length: 20 }, (_, index) => omdb.getOmdbRatingDetails(`tt${9000000200 + index}`)));
    assert.ok(ratings.every((rating) => rating === null));
    assert.ok(calls <= 2);
    assert.equal(await omdb.canFetchOmdbRatings(), false);
    assert.equal((await omdb.getOmdbRatingDetails('tt9000000001'))?.rating, 8.1);
  });
});
