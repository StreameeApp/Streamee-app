import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isValidRating, type ImdbRatingDetails } from './rating-policy.ts';

export const IMDB_DATASET_RATINGS_CHANGED_EVENT = 'streamee:imdb-dataset-ratings-changed';

interface NativeDatasetStatus {
  revision: number;
  enabled: boolean;
  ready: boolean;
  refreshing: boolean;
  entryCount: number;
  downloadedAt: number | null;
  lastCheckedAt: number | null;
  sourceModifiedAt: string | null;
  error: string | null;
}

export interface ImdbDatasetSnapshot extends NativeDatasetStatus {
  available: boolean;
  initialized: boolean;
}

let snapshot: ImdbDatasetSnapshot = {
  revision: -1,
  available: false, initialized: false, enabled: false, ready: false, refreshing: false,
  entryCount: 0, downloadedAt: null, lastCheckedAt: null, sourceModifiedAt: null, error: null,
};
const subscribers = new Set<() => void>();
let initialization: Promise<void> | undefined;
let listening = false;
let retryAfter = 0;
let generation = 0;
const ratings = new Map<string, Promise<ImdbRatingDetails | null>>();
const queue: Array<{ id: string; resolve: (rating: ImdbRatingDetails | null) => void }> = [];
let batchTimer: ReturnType<typeof setTimeout> | undefined;

function publish(status: Partial<ImdbDatasetSnapshot>): void {
  if (status.revision !== undefined && status.revision < snapshot.revision) return;
  const previous = snapshot;
  snapshot = { ...snapshot, ...status };
  const changed = previous.enabled !== snapshot.enabled || previous.ready !== snapshot.ready
    || previous.downloadedAt !== snapshot.downloadedAt;
  if (changed) {
    generation += 1;
    ratings.clear();
  }
  subscribers.forEach((listener) => listener());
  if (changed) window.dispatchEvent(new Event(IMDB_DATASET_RATINGS_CHANGED_EVENT));
}

export function subscribeImdbDataset(listener: () => void): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

export const getImdbDatasetSnapshot = (): ImdbDatasetSnapshot => snapshot;

export function initializeImdbDataset(force = false): Promise<void> {
  if (initialization) return initialization;
  if (snapshot.available) return Promise.resolve();
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    if (!snapshot.initialized) publish({ initialized: true });
    return Promise.resolve();
  }
  if (!force && Date.now() < retryAfter) return Promise.resolve();
  if (force) publish({ initialized: false, error: null });
  initialization = (async () => {
    try {
      if (!listening) {
        await listen<NativeDatasetStatus>('imdb-dataset://changed', (event) => publish(event.payload));
        listening = true;
      }
      const status = await invoke<NativeDatasetStatus>('get_imdb_dataset_status');
      // Availability still resolves if a newer status event arrived before this response.
      publish({ available: true, initialized: true });
      publish(status);
    } catch {
      retryAfter = Date.now() + 30_000;
      publish({ initialized: true, error: 'Could not connect to local IMDb ratings. Retry the connection or restart an updated Streamee desktop app.' });
    }
  })().finally(() => { initialization = undefined; });
  return initialization;
}

export async function setImdbDatasetEnabled(enabled: boolean): Promise<void> {
  await initializeImdbDataset();
  const status = await invoke<NativeDatasetStatus>('set_imdb_dataset_enabled', { enabled });
  publish(status);
}

export async function refreshImdbDataset(): Promise<void> {
  await initializeImdbDataset();
  const status = await invoke<NativeDatasetStatus>('refresh_imdb_dataset');
  publish(status);
}

export async function clearImdbDataset(): Promise<void> {
  await initializeImdbDataset();
  const status = await invoke<NativeDatasetStatus>('clear_imdb_dataset');
  publish(status);
  if (status.error) throw new Error(status.error);
}

async function flushLookups(): Promise<void> {
  batchTimer = undefined;
  const batch = queue.splice(0, 100);
  if (batch.length === 0) return;
  const requestedGeneration = generation;
  let values: Record<string, ImdbRatingDetails> = {};
  let failed = false;
  if (snapshot.enabled && snapshot.ready) {
    try {
      const response = await invoke<Record<string, ImdbRatingDetails> | null>('lookup_imdb_dataset_ratings', {
        ids: batch.map((item) => item.id),
      });
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid IMDb lookup response.');
      values = response;
    } catch {
      // OMDb and metadata scores remain available if a local lookup fails.
      failed = true;
    }
  }
  for (const item of batch) {
    const rating = values[item.id];
    const valid = rating && isValidRating(rating.rating) && rating.rating >= 1
      && Number.isSafeInteger(rating.votes) && rating.votes! > 0;
    if ((failed || rating && !valid) && requestedGeneration === generation) ratings.delete(item.id);
    item.resolve(requestedGeneration === generation && snapshot.enabled && valid ? rating : null);
  }
  if (queue.length > 0 && batchTimer === undefined) batchTimer = setTimeout(() => { void flushLookups(); }, 10);
}

export async function getLocalImdbRating(imdbId: string): Promise<ImdbRatingDetails | null> {
  await initializeImdbDataset();
  if (!snapshot.enabled || !snapshot.ready) return null;
  const id = imdbId.trim().toLowerCase();
  if (!/^tt\d+$/.test(id)) return null;
  const cached = ratings.get(id);
  if (cached) return cached;
  const promise = new Promise<ImdbRatingDetails | null>((resolve) => queue.push({ id, resolve }));
  ratings.set(id, promise);
  while (ratings.size > 1_500) ratings.delete(ratings.keys().next().value!);
  if (batchTimer === undefined) batchTimer = setTimeout(() => { void flushLookups(); }, 10);
  return promise;
}
