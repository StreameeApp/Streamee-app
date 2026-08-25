import assert from 'node:assert/strict';
import test from 'node:test';

import { rendererLoggerTestUtils } from '../src/renderer/services/logger.ts';

test('renderer serializer redacts secrets and survives circular Error objects', () => {
  const error = new Error('request failed: authorization=Bearer-private');
  const payload: Record<string, unknown> = {
    accessToken: 'secret-token',
    nested: {
      url: 'https://user:password@example.test/file?signature=signed&safe=1',
    },
    error,
  };
  payload.self = payload;

  const serialized = rendererLoggerTestUtils.serializeValue(payload) as Record<string, unknown>;
  assert.equal(serialized.accessToken, '<redacted>');
  assert.equal(serialized.self, '[Circular]');
  assert.match(JSON.stringify(serialized.error), /<redacted>/);
  assert.doesNotMatch(JSON.stringify(serialized), /secret-token|Bearer-private|signature=signed/);
});

test('renderer console normalization strips styling and infers bracketed subsystem', () => {
  const normalized = rendererLoggerTestUtils.normalizeConsoleArguments([
    '%c[Player][Add-on] Stream ready',
    'color: green',
    { status: 206 },
  ]);

  assert.equal(normalized.message, '[Player][Add-on] Stream ready');
  assert.equal(
    rendererLoggerTestUtils.subsystemFromMessage(normalized.message),
    'player.add_on',
  );
  assert.deepEqual(normalized.fields, { args: [{ status: 206 }] });
});

test('renderer performance messages promote decimal milliseconds without changing the message', () => {
  const normalized = rendererLoggerTestUtils.normalizeConsoleArguments([
    '[Performance] Board catalogs first row ready: 33.5ms',
  ]);

  assert.equal(
    normalized.message,
    '[Performance] Board catalogs first row ready: 33.5ms',
  );
  assert.deepEqual(normalized.fields, { duration_ms: 33.5 });
});
