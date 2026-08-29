import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectStreamCacheIdentity } from '../src/renderer/services/stream-cache-identity.ts';

const baseSource = {
  id: 'installation:stream',
  infoHash: 'ABC123',
  size: 7_000,
  sourceFileIndex: 2,
  addonInstallationId: 'installation',
  addonId: 'addon',
  directStreamProvider: 'addon' as const,
  sourceProvider: 'addon' as const,
};

test('direct stream cache identity is stable for the same resolved source', () => {
  assert.equal(
    buildDirectStreamCacheIdentity(baseSource),
    'installation:addon:abc123:2:7000',
  );
  assert.equal(
    buildDirectStreamCacheIdentity({ ...baseSource }),
    buildDirectStreamCacheIdentity(baseSource),
  );
});

test('direct stream cache identity canonicalizes hash formats', () => {
  const zeroHex = '0'.repeat(40);
  const zeroBase32 = 'A'.repeat(32);
  assert.equal(
    buildDirectStreamCacheIdentity({ ...baseSource, infoHash: zeroBase32 }),
    buildDirectStreamCacheIdentity({ ...baseSource, infoHash: zeroHex }),
  );
});

test('direct stream cache identity survives provider result reordering', () => {
  const withoutHash = {
    ...baseSource,
    infoHash: '',
    streamFilename: 'Folder\\Episode 01.mkv',
  };
  assert.equal(
    buildDirectStreamCacheIdentity({ ...withoutHash, id: 'installation:0' }),
    buildDirectStreamCacheIdentity({ ...withoutHash, id: 'installation:9' }),
  );
});

test('direct stream cache identity distinguishes a missing file index from index zero', () => {
  assert.notEqual(
    buildDirectStreamCacheIdentity({ ...baseSource, sourceFileIndex: undefined }),
    buildDirectStreamCacheIdentity({ ...baseSource, sourceFileIndex: 0 }),
  );
});

test('direct stream cache identity separates files, installations, and sizes', () => {
  const identity = buildDirectStreamCacheIdentity(baseSource);
  assert.notEqual(
    buildDirectStreamCacheIdentity({ ...baseSource, sourceFileIndex: 3 }),
    identity,
  );
  assert.notEqual(
    buildDirectStreamCacheIdentity({ ...baseSource, addonInstallationId: 'other-installation' }),
    identity,
  );
  assert.notEqual(
    buildDirectStreamCacheIdentity({ ...baseSource, size: 8_000 }),
    identity,
  );
});
