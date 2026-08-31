import assert from 'node:assert/strict';
import { test } from 'node:test';

test('xREL cache migrates to AppData and leaves localStorage state small', async () => {
  const cacheKey = 'streamee-xrel-release-quality-cache-v2';
  const backupKey = 'streamee-shared-storage-backup-v1';
  const cacheValue = JSON.stringify({
    version: 2,
    backgroundMatcherVersion: 4,
    addonMatcherVersion: 2,
    fetchedAt: 123,
    seenReleaseIds: ['release-1'],
    entries: [],
    negativeLookups: {},
    preciseLookups: {},
    identityAliases: {},
    srrdbLookups: {},
  });
  const storage = new Map<string, string>([
    [cacheKey, cacheValue],
    [backupKey, JSON.stringify({
      version: 1,
      entries: {
        [cacheKey]: cacheValue,
        'streamee-settings': '{"theme":"dark"}',
      },
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

  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          if (command === 'read_xrel_release_cache') return null;
          return null;
        },
      },
    },
  });

  const service = await import('../src/renderer/services/xrel.ts?cache-storage-test');
  await service.initializeXrelReleaseCacheStorage();

  assert.deepEqual(calls.map(({ command }) => command), [
    'read_xrel_release_cache',
    'write_xrel_release_cache',
  ]);
  assert.equal(calls[1]?.args?.value, cacheValue);
  assert.equal(storage.has(cacheKey), false, 'migrated cache is removed from localStorage');

  const trimmedBackup = JSON.parse(storage.get(backupKey) ?? '{}');
  assert.equal(trimmedBackup.entries?.[cacheKey], undefined, 'backup no longer duplicates the migrated cache');
  assert.equal(trimmedBackup.entries?.['streamee-settings'], '{"theme":"dark"}');

  service.clearXrelReleaseCache();
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  assert.equal(calls.at(-1)?.command, 'clear_xrel_release_cache');
});
