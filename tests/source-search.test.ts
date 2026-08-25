import assert from 'node:assert/strict';
import test from 'node:test';

import { runPrioritizedFallback, selectFallbackItems } from '../src/renderer/services/prioritized-fallback.ts';

test('retains configured providers before any route is attempted', () => {
  assert.deepEqual(selectFallbackItems(['addon-a', 'addon-b', 'local'], ['local'], 0), ['addon-a', 'addon-b', 'local']);
});

test('does not repeat earlier providers after fallback begins', () => {
  assert.deepEqual(selectFallbackItems(['addon-a', 'addon-b', 'local'], ['local'], 2), ['local']);
});

test('starts the next fallback before a slow higher-priority provider finishes', async () => {
  const started: string[] = [];
  let finishTop!: (value: string[]) => void;
  const search = runPrioritizedFallback(['top', 'second'], {
    staggerMs: 20,
    run: async (provider) => {
      started.push(provider);
      if (provider === 'top') return new Promise<string[]>((resolve) => { finishTop = resolve; });
      return ['second-result'];
    },
    accepts: (results) => results.length > 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(started, ['top', 'second']);
  finishTop([]);
  assert.equal((await search).winner?.item, 'second');
});

test('retains strict priority when a hedged lower provider finishes first', async () => {
  let finishTop!: (value: string[]) => void;
  let secondFinished = false;
  const search = runPrioritizedFallback(['top', 'second'], {
    staggerMs: 20,
    run: async (provider) => {
      if (provider === 'top') return new Promise<string[]>((resolve) => { finishTop = resolve; });
      secondFinished = true;
      return ['second-result'];
    },
    accepts: (results) => results.length > 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondFinished, true);
  finishTop(['top-result']);
  assert.equal((await search).winner?.item, 'top');
});
