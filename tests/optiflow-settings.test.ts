import assert from 'node:assert/strict';
import test from 'node:test';
import { loadOptiflowEnabled, saveOptiflowEnabled } from '../src/renderer/services/optiflow-settings.ts';

const fixture = (nativeValue: string | null = 'true') => {
  let cached = JSON.stringify({ mpvOptiflowEnabled: false, watchRegion: 'MY' });
  const api = {
    async getSetting(key: string) {
      assert.equal(key, 'mpvOptiflowEnabled');
      return nativeValue;
    },
    async setSetting(key: string, value: string) {
      assert.equal(key, 'mpvOptiflowEnabled');
      nativeValue = value;
    },
  };
  const cache = {
    getItem: () => cached,
    setItem(key: string, value: string) {
      assert.equal(key, 'streamee-settings');
      cached = value;
    },
  };
  return { api, cache, cached: () => JSON.parse(cached) };
};

test('loads the playback preference even when the renderer cache says off', async () => {
  const { api, cached } = fixture();
  assert.equal(cached().mpvOptiflowEnabled, false);
  assert.equal(await loadOptiflowEnabled(api), true);
  assert.equal(await loadOptiflowEnabled(fixture('false').api), false);
  assert.equal(await loadOptiflowEnabled(fixture(null).api), false);
});

test('starts saving without a debounce and completes independently of the Settings view', async () => {
  const { api, cache, cached } = fixture();
  let finishSave!: () => void;
  let started = false;
  const pending = saveOptiflowEnabled({
    ...api,
    async setSetting(key, value) {
      started = true;
      await new Promise<void>((resolve) => { finishSave = resolve; });
      await api.setSetting(key, value);
    },
  }, cache, false);
  assert.equal(started, true);
  assert.equal(await loadOptiflowEnabled(api), true);
  // Other settings can change while native persistence is in flight.
  cache.setItem('streamee-settings', JSON.stringify({ watchRegion: 'GB', mpvRifeEnabled: true }));
  finishSave();
  await pending;
  assert.equal(await loadOptiflowEnabled(api), false);
  assert.deepEqual(cached(), { watchRegion: 'GB', mpvRifeEnabled: true, mpvOptiflowEnabled: false });
});

test('a failed native save keeps the cached value and propagates the error', async () => {
  const { api, cache, cached } = fixture('false');
  await assert.rejects(saveOptiflowEnabled({
    ...api,
    async setSetting() { throw new Error('Store unavailable'); },
  }, cache, true), /Store unavailable/);
  assert.equal(cached().mpvOptiflowEnabled, false);
  assert.equal(await loadOptiflowEnabled(api), false);
});

test('a full renderer cache does not report a successfully saved toggle as failed', async () => {
  const { api, cache } = fixture();
  await saveOptiflowEnabled(api, {
    ...cache,
    setItem() { throw new Error('Storage full'); },
  }, false);
  assert.equal(await loadOptiflowEnabled(api), false);
});
