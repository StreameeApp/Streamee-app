import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAnnouncement } from '../src/renderer/services/announcements.ts';

const now = Date.parse('2026-08-27T12:00:00Z');

test('normalizes a currently active announcement', () => {
  assert.deepEqual(normalizeAnnouncement({
    id: 'release-2.0.9',
    message: '  A new Streamee update is available.  ',
    kind: 'warning',
    startsAt: '2026-08-27T00:00:00Z',
    expiresAt: '2026-09-03T00:00:00Z',
  }, now), {
    id: 'release-2.0.9',
    message: 'A new Streamee update is available.',
    kind: 'warning',
    startsAt: '2026-08-27T00:00:00Z',
    expiresAt: '2026-09-03T00:00:00Z',
  });
});

test('defaults unknown kinds to info', () => {
  assert.equal(normalizeAnnouncement({
    id: 'general-notice',
    message: 'A general announcement.',
    kind: 'unexpected',
  }, now)?.kind, 'info');
});

test('keeps announcements link-free when no link is configured', () => {
  assert.deepEqual(normalizeAnnouncement({
    id: 'plain-notice',
    message: 'No link is needed.',
  }, now), {
    id: 'plain-notice',
    message: 'No link is needed.',
    kind: 'info',
  });
});

test('normalizes an optional HTTPS link and defaults its label', () => {
  assert.deepEqual(normalizeAnnouncement({
    id: 'linked-notice',
    message: 'Read the full details.',
    linkUrl: ' https://streamee.app/news?id=42 ',
  }, now), {
    id: 'linked-notice',
    message: 'Read the full details.',
    kind: 'info',
    linkUrl: 'https://streamee.app/news?id=42',
    linkLabel: 'Learn more',
  });
});

test('keeps the announcement but strips unsafe or incomplete links', () => {
  const unsafe = normalizeAnnouncement({
    id: 'unsafe-link',
    message: 'The message remains visible.',
    linkUrl: 'javascript:alert(1)',
    linkLabel: 'Open',
  }, now);
  const labelOnly = normalizeAnnouncement({
    id: 'label-only',
    message: 'A label alone is not a link.',
    linkLabel: 'Open',
  }, now);

  assert.equal(unsafe?.linkUrl, undefined);
  assert.equal(unsafe?.linkLabel, undefined);
  assert.equal(labelOnly?.linkUrl, undefined);
  assert.equal(labelOnly?.linkLabel, undefined);
});

test('rejects announcements outside their active window', () => {
  assert.equal(normalizeAnnouncement({
    id: 'future',
    message: 'Not active yet.',
    startsAt: '2026-08-28T00:00:00Z',
  }, now), null);
  assert.equal(normalizeAnnouncement({
    id: 'expired',
    message: 'No longer active.',
    expiresAt: '2026-08-27T11:59:59Z',
  }, now), null);
});

test('rejects malformed or excessively large announcements', () => {
  assert.equal(normalizeAnnouncement({ id: '', message: 'Missing ID.' }, now), null);
  assert.equal(normalizeAnnouncement({ id: 'missing-message', message: '' }, now), null);
  assert.equal(normalizeAnnouncement({ id: 'bad-date', message: 'Invalid.', expiresAt: 'later' }, now), null);
  assert.equal(normalizeAnnouncement({ id: 'too-long', message: 'x'.repeat(2_001) }, now), null);
});
