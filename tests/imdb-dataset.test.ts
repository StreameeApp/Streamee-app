import assert from 'node:assert/strict';
import test from 'node:test';

test('local IMDb lookups follow opt-in, batching, dataset changes and disable events', async (context) => {
  const status = {
    revision: 0, enabled: false, ready: false, refreshing: false, entryCount: 0,
    downloadedAt: null as number | null, lastCheckedAt: null as number | null,
    sourceModifiedAt: null, error: null,
  };
  const callbacks = new Map<number, (event: unknown) => void>();
  const lookups: string[][] = [];
  let eventHandler = 0;
  let score = 8.1;
  let holdLookup: (() => Promise<void>) | undefined;
  let lookupResponse: 'valid' | 'null' | 'invalid' = 'valid';
  let statusUnavailable = true;
  const sendStatus = () => callbacks.get(eventHandler)?.({ payload: { ...status } });
  const browser = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {
      transformCallback: (callback: (event: unknown) => void) => {
        const id = callbacks.size + 1;
        callbacks.set(id, callback);
        return id;
      },
      invoke: async (command: string, args: { handler?: number; enabled?: boolean; ids?: string[] } = {}) => {
        if (command === 'plugin:event|listen') { eventHandler = args.handler!; return 1; }
        if (command === 'get_imdb_dataset_status') {
          if (statusUnavailable) throw new Error('Temporary desktop connection failure');
          const older = { ...status };
          status.revision += 1;
          sendStatus();
          return older;
        }
        if (command === 'set_imdb_dataset_enabled') {
          status.enabled = args.enabled!;
          status.revision += 1;
          sendStatus();
          return { ...status };
        }
        if (command === 'lookup_imdb_dataset_ratings') {
          lookups.push(args.ids!);
          await holdLookup?.();
          if (lookupResponse === 'null') return null;
          if (lookupResponse === 'invalid') return Object.fromEntries(args.ids!.map((id) => [id, { rating: Number.NaN, votes: -1 }]));
          return Object.fromEntries(args.ids!.map((id) => [id, { rating: score, votes: 12345 }]));
        }
        if (command === 'refresh_imdb_dataset') {
          const older = { ...status };
          score = 9.2;
          status.revision += 1;
          status.downloadedAt = 2000;
          sendStatus();
          return older;
        }
        if (command === 'clear_imdb_dataset') {
          Object.assign(status, { revision: status.revision + 1, enabled: false, ready: false, entryCount: 0, downloadedAt: null, lastCheckedAt: null });
          sendStatus();
          return { ...status };
        }
        throw new Error(`Unexpected native command ${command}`);
      },
    },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  const dataset = await import('../src/renderer/services/imdb-dataset.ts');
  await dataset.initializeImdbDataset();
  assert.equal(dataset.getImdbDatasetSnapshot().available, false);
  assert.equal(dataset.getImdbDatasetSnapshot().initialized, true);
  statusUnavailable = false;
  await dataset.initializeImdbDataset(true);
  assert.equal(dataset.getImdbDatasetSnapshot().available, true);
  assert.equal(dataset.getImdbDatasetSnapshot().initialized, true);
  assert.equal(dataset.getImdbDatasetSnapshot().revision, 1);

  await context.test('disabled and not-yet-downloaded datasets perform no rating lookups', async () => {
    assert.equal(await dataset.getLocalImdbRating('tt1234567'), null);
    await dataset.setImdbDatasetEnabled(true);
    assert.equal(await dataset.getLocalImdbRating('tt1234567'), null);
    assert.equal(lookups.length, 0);
    Object.assign(status, { revision: 3, ready: true, entryCount: 2_000_000, downloadedAt: 1000 });
    sendStatus();
  });

  await context.test('concurrent lookups are deduplicated, batched and cached', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `tt${1000000 + index}`);
    const results = await Promise.all([...ids, ids[0]].map(dataset.getLocalImdbRating));
    assert.equal(results.length, 206);
    assert.ok(results.every((result) => result?.rating === 8.1 && result.votes === 12345));
    assert.equal(lookups.length, 3);
    assert.ok(lookups.every((ids) => ids.length <= 100));
    assert.equal(lookups.flat().length, 205);
    assert.equal((await dataset.getLocalImdbRating(ids[0]))?.rating, 8.1);
    assert.equal(await dataset.getLocalImdbRating('invalid'), null);
    assert.equal(lookups.length, 3);
  });

  await context.test('new snapshots invalidate scores and older command responses cannot undo them', async () => {
    await dataset.refreshImdbDataset();
    assert.equal(dataset.getImdbDatasetSnapshot().downloadedAt, 2000);
    assert.equal((await dataset.getLocalImdbRating('tt1000000'))?.rating, 9.2);
    assert.equal(lookups.length, 4);
  });

  await context.test('malformed native responses resolve safely and remain retryable', async () => {
    lookupResponse = 'null';
    assert.equal(await dataset.getLocalImdbRating('tt9000000'), null);
    lookupResponse = 'invalid';
    assert.equal(await dataset.getLocalImdbRating('tt9000000'), null);
    lookupResponse = 'valid';
    assert.equal((await dataset.getLocalImdbRating('tt9000000'))?.rating, 9.2);
  });

  await context.test('disabling discards a lookup already in flight and keeps the saved dataset', async () => {
    let complete!: () => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const requestGate = new Promise<void>((resolve) => { complete = resolve; });
    holdLookup = async () => { started(); await requestGate; };
    const pending = dataset.getLocalImdbRating('tt9999999');
    await requestStarted;
    await dataset.setImdbDatasetEnabled(false);
    complete();
    assert.equal(await pending, null);
    assert.equal(dataset.getImdbDatasetSnapshot().enabled, false);
    assert.equal(dataset.getImdbDatasetSnapshot().ready, true);
    assert.equal(await dataset.getLocalImdbRating('tt1000000'), null);
  });

  await context.test('clearing removes the saved dataset and disables automatic downloads', async () => {
    await dataset.clearImdbDataset();
    assert.equal(dataset.getImdbDatasetSnapshot().enabled, false);
    assert.equal(dataset.getImdbDatasetSnapshot().ready, false);
    assert.equal(dataset.getImdbDatasetSnapshot().entryCount, 0);
    assert.equal(dataset.getImdbDatasetSnapshot().downloadedAt, null);
  });
});
