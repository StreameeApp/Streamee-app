import { check, type Update } from '@tauri-apps/plugin-updater';

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export type UpdaterSnapshot = {
  status: UpdaterStatus;
  version: string | null;
  notes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
};

const listeners = new Set<() => void>();
let pendingUpdate: Update | null = null;
let checkPromise: Promise<void> | null = null;
let snapshot: UpdaterSnapshot = {
  status: 'idle',
  version: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

const publish = (next: Partial<UpdaterSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
};

const messageFromError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const subscribeUpdater = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getUpdaterSnapshot = () => snapshot;

export const checkForUpdates = async (manual = false) => {
  if (checkPromise) {
    return checkPromise;
  }

  if (snapshot.status === 'downloading' || snapshot.status === 'installing') {
    return;
  }

  checkPromise = (async () => {
    publish({ status: 'checking', error: null });

    try {
      const update = await check({ timeout: 30_000 });
      if (pendingUpdate && pendingUpdate !== update) {
        await pendingUpdate.close().catch(() => {});
      }
      pendingUpdate = update;

      if (!update) {
        publish({
          status: manual ? 'up-to-date' : 'idle',
          version: null,
          notes: null,
          downloadedBytes: 0,
          totalBytes: null,
        });
        return;
      }

      publish({
        status: 'available',
        version: update.version,
        notes: update.body?.trim() || null,
        downloadedBytes: 0,
        totalBytes: null,
      });
    } catch (error) {
      if (manual) {
        publish({ status: 'error', error: messageFromError(error) });
      } else {
        publish({ status: 'idle', error: null });
        console.warn('[Updater] Automatic update check failed:', error);
      }
    }
  })().finally(() => {
    checkPromise = null;
  });

  return checkPromise;
};

export const downloadUpdate = async () => {
  if (!pendingUpdate || snapshot.status !== 'available') {
    return;
  }

  publish({
    status: 'downloading',
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
  });

  try {
    await pendingUpdate.download((event) => {
      if (event.event === 'Started') {
        publish({ totalBytes: event.data.contentLength ?? null });
      } else if (event.event === 'Progress') {
        publish({ downloadedBytes: snapshot.downloadedBytes + event.data.chunkLength });
      } else if (event.event === 'Finished') {
        publish({ status: 'ready' });
      }
    }, { timeout: 120_000 });
    publish({ status: 'ready' });
  } catch (error) {
    publish({ status: 'error', error: messageFromError(error) });
  }
};

export const installUpdate = async () => {
  if (!pendingUpdate || snapshot.status !== 'ready') {
    return;
  }

  publish({ status: 'installing', error: null });
  try {
    await pendingUpdate.install();
  } catch (error) {
    publish({ status: 'error', error: messageFromError(error) });
  }
};

export const downloadAndInstallUpdate = async () => {
  await downloadUpdate();

  if (snapshot.status === 'ready') {
    await installUpdate();
  }
};
