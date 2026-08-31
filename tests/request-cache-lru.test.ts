import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const requestCacheSource = fs.readFileSync(
  new URL('../src/renderer/services/request-cache.ts', import.meta.url),
  'utf8',
);

test('persistent cache hits refresh recency before resolving', () => {
  assert.match(
    requestCacheSource,
    /database\.transaction\(PERSISTENT_CACHE_STORE, 'readwrite'\)/,
  );
  assert.match(
    requestCacheSource,
    /entry && entry\.expiresAt > now && entry\.storedAt < now/,
  );
  assert.match(requestCacheSource, /result = \{ \.\.\.entry, storedAt: now \}/);
  assert.match(requestCacheSource, /store\.put\(result\)/);
  assert.match(
    requestCacheSource,
    /transaction\.oncomplete = \(\) => \{[\s\S]*?resolve\(result\);[\s\S]*?\};/,
  );
});

test('persistent cache eviction remains ordered by refreshed recency', () => {
  assert.match(requestCacheSource, /store\.createIndex\('storedAt', 'storedAt'\)/);
  assert.match(requestCacheSource, /store\.index\('storedAt'\)\.openCursor\(\)/);
  assert.match(requestCacheSource, /oldest\.delete\(\)/);
});

test('persistent cache synchronizes Dev and Release origins through AppData', () => {
  assert.match(requestCacheSource, /export function initializeSharedRequestCache\(\)/);
  assert.match(requestCacheSource, /invoke<unknown\[\] \| null>\('read_request_cache'\)/);
  assert.match(requestCacheSource, /\[\.\.\.localEntries, \.\.\.nativeEntries\]/);
  assert.match(requestCacheSource, /entry\.storedAt >= current\.storedAt/);
  assert.match(requestCacheSource, /replacePersistentRequests\(database, synchronizedEntries\)/);
  assert.match(requestCacheSource, /invoke<void>\('write_request_cache'/);
  assert.match(requestCacheSource, /window\.addEventListener\('pagehide', flushSharedCache\)/);
});
