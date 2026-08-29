import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('../src-tauri/src/webtorrent-server.cjs', import.meta.url),
  'utf8',
);

test('WebTorrent persistence is keyed without requiring Continue to know the size', () => {
  const policyStart = source.indexOf('const usePersistentCache =');
  const policyEnd = source.indexOf('\n\n  if (usePersistentCache)', policyStart);
  assert.ok(policyStart >= 0 && policyEnd > policyStart);
  const policy = source.slice(policyStart, policyEnd);
  assert.match(policy, /cacheOptions\.persistentCacheEnabled === true/);
  assert.match(policy, /&& !!infoHash/);
  assert.doesNotMatch(policy, /expectedSize/);
});

test('WebTorrent validates the torrent cache without comparing a selected-file size', () => {
  const manifestCheckStart = source.indexOf('if (existingManifest && (');
  const manifestCheckEnd = source.indexOf('\n    )) {', manifestCheckStart);
  assert.ok(manifestCheckStart >= 0 && manifestCheckEnd > manifestCheckStart);
  const manifestCheck = source.slice(manifestCheckStart, manifestCheckEnd);
  assert.doesNotMatch(manifestCheck, /expectedSize|total_size/);
  assert.match(
    source,
    /prunePersistentStreamCache\([\s\S]*?activeStreamCacheDir,[\s\S]*?torrent\.length,/,
  );
});

test('WebTorrent canonicalizes every source type through parse-torrent', () => {
  assert.match(source, /import\('parse-torrent'\)/);
  assert.match(
    source,
    /parsedTorrentSource = await parseTorrentSource\(resolvedTorrentSource\)/,
  );
  assert.match(source, /parsedTorrentSource\.infoHash\.toLowerCase\(\)/);
  assert.doesNotMatch(source, /extractMagnetInfoHash/);
});

test('WebTorrent only accounts for cache entries that were actually deleted', () => {
  assert.match(
    source,
    /if \(!cleanupStreamCacheDirectory\(entry\.entryDirectory\)\) continue;\s+residentTotal = Math\.max/,
  );
  assert.match(source, /return true;[\s\S]*cache\.cleanup_failed[\s\S]*return false;/);
  assert.match(
    source,
    /if \(!cleanupStreamCacheDirectory\(activeStreamCacheDir\)\) \{\s+throw new Error\('Failed to reset an incompatible persistent WebTorrent cache'\)/,
  );
});
