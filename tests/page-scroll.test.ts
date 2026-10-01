import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageScrollSession } from '../src/renderer/services/page-scroll.ts';

const port = (maximum = 3000) => ({ scrollTop: 0, scrollHeight: maximum + 600, clientHeight: 600 });

test('restores zero instead of inheriting another page offset', () => {
  const container = port();
  container.scrollTop = 1200;
  const session = createPageScrollSession(container, 0);
  session.restore(true);
  assert.equal(container.scrollTop, 0);
  assert.equal(session.pending, false);
});

test('waits for readiness and for enough cached content height', () => {
  const container = port(100);
  const session = createPageScrollSession(container, 1800);
  session.restore(false);
  assert.equal(container.scrollTop, 0);
  session.restore(true);
  assert.equal(container.scrollTop, 100);
  session.capture();
  assert.equal(session.position, 1800);
  assert.equal(session.pending, true);
  container.scrollHeight = 3600;
  session.restore(true);
  assert.equal(container.scrollTop, 1800);
  assert.equal(session.pending, false);
});

test('pagination, telemetry, and later layout updates do not reapply an old offset', () => {
  const container = port();
  const session = createPageScrollSession(container, 900);
  session.restore(true);
  container.scrollTop = 1600;
  session.capture();
  container.scrollHeight += 1000;
  session.restore(true);
  assert.equal(container.scrollTop, 1600);
  assert.equal(session.position, 1600);
});

test('user input cancels a pending restore even if loading finishes later', () => {
  const container = port(100);
  const session = createPageScrollSession(container, 1800);
  session.restore(true);
  session.interrupt();
  container.scrollTop = 60;
  session.capture();
  container.scrollHeight = 3600;
  session.restore(true);
  assert.equal(container.scrollTop, 60);
  assert.equal(session.position, 60);
});

test('navigation keeps the last captured position when page teardown clamps the DOM', () => {
  const container = port();
  const session = createPageScrollSession(container, 900);
  session.restore(true);
  container.scrollTop = 1900;
  session.capture();
  container.scrollTop = 0;
  container.scrollHeight = 600;
  assert.equal(session.position, 1900);
});

test('a genuinely shorter page can settle at its remaining scroll range', () => {
  const container = port(400);
  const session = createPageScrollSession(container, 1900);
  session.restore(true);
  assert.equal(session.pending, true);
  session.restore(true, true);
  assert.equal(session.pending, false);
  assert.equal(session.position, 400);
  container.scrollTop = 150;
  session.capture();
  session.restore(true);
  assert.equal(container.scrollTop, 150);
});
