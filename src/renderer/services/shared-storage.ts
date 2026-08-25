import { invoke } from '@tauri-apps/api/core';

const SHARED_STORAGE_SETTING_KEY = 'sharedRendererStorageV1';
const LOCAL_BACKUP_KEY = 'streamee-shared-storage-backup-v1';
const PATCH_FLAG = '__streameeSharedStoragePatchedV1';
const STARTUP_SYNC_TIMEOUT_MS = 3_000;

const withStartupTimeout = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const timeoutId = window.setTimeout(() => {
    reject(new Error(`Shared storage startup synchronization timed out after ${STARTUP_SYNC_TIMEOUT_MS}ms`));
  }, STARTUP_SYNC_TIMEOUT_MS);

  operation.then(
    (value) => {
      window.clearTimeout(timeoutId);
      resolve(value);
    },
    (error) => {
      window.clearTimeout(timeoutId);
      reject(error);
    },
  );
});

interface SharedStorageSnapshot {
  version: 1;
  updatedAt: string;
  entries: Record<string, string>;
}

const isSharedKey = (key: string) => key.startsWith('streamee-') && key !== LOCAL_BACKUP_KEY;

const readSharedEntries = (): Record<string, string> => {
  const entries: Record<string, string> = {};
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => !!key && isSharedKey(key))
    .sort();

  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value !== null) {
      entries[key] = value;
    }
  }

  return entries;
};

const serializeSnapshot = (): string => JSON.stringify({
  version: 1,
  updatedAt: new Date().toISOString(),
  entries: readSharedEntries(),
} satisfies SharedStorageSnapshot);

const parseSnapshot = (raw: string): SharedStorageSnapshot | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<SharedStorageSnapshot>;
    if (
      parsed.version !== 1 ||
      !parsed.entries ||
      typeof parsed.entries !== 'object' ||
      Array.isArray(parsed.entries)
    ) {
      return null;
    }

    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (isSharedKey(key) && typeof value === 'string') {
        entries[key] = value;
      }
    }

    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      entries,
    };
  } catch {
    return null;
  }
};

const entriesMatch = (left: Record<string, string>, right: Record<string, string>) => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => (
    key === rightKeys[index] && left[key] === right[key]
  ));
};

const replaceSharedEntries = (entries: Record<string, string>) => {
  const existingKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => !!key && isSharedKey(key));

  existingKeys.forEach((key) => localStorage.removeItem(key));
  Object.entries(entries).forEach(([key, value]) => localStorage.setItem(key, value));
};

const saveOriginBackupOnce = (entries: Record<string, string>) => {
  if (Object.keys(entries).length === 0 || localStorage.getItem(LOCAL_BACKUP_KEY) !== null) {
    return;
  }

  localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify({
    version: 1,
    capturedAt: new Date().toISOString(),
    origin: window.location.origin,
    entries,
  }));
};

const installStorageMirror = () => {
  const patchedWindow = window as unknown as Record<string, unknown>;
  if (patchedWindow[PATCH_FLAG]) {
    return;
  }
  patchedWindow[PATCH_FLAG] = true;

  const originalSetItem = Storage.prototype.setItem;
  const originalRemoveItem = Storage.prototype.removeItem;
  const originalClear = Storage.prototype.clear;
  let saveTimer: number | null = null;
  let writeChain: Promise<unknown> = Promise.resolve();

  const flushSave = () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }

    const value = serializeSnapshot();
    writeChain = writeChain
      .catch(() => undefined)
      .then(() => invoke<void>('set_setting', { key: SHARED_STORAGE_SETTING_KEY, value }))
      .catch((error) => console.error('[Storage] Failed to save AppData snapshot:', error));
  };

  const scheduleSave = (delay = 50) => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }

    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      flushSave();
    }, delay);
  };

  Storage.prototype.setItem = function setItem(key: string, value: string) {
    originalSetItem.call(this, key, value);
    if (this === window.localStorage && isSharedKey(key)) {
      scheduleSave();
    }
  };

  Storage.prototype.removeItem = function removeItem(key: string) {
    originalRemoveItem.call(this, key);
    if (this === window.localStorage && isSharedKey(key)) {
      scheduleSave();
    }
  };

  Storage.prototype.clear = function clear() {
    const shouldSave = this === window.localStorage && Object.keys(readSharedEntries()).length > 0;
    originalClear.call(this);
    if (shouldSave) {
      scheduleSave();
    }
  };

  window.addEventListener('pagehide', flushSave);
};

export const initializeSharedRendererStorage = async () => {
  const localEntries = readSharedEntries();

  try {
    const rawSnapshot = await withStartupTimeout(
      invoke<string | null>('get_setting', { key: SHARED_STORAGE_SETTING_KEY }),
    );
    const sharedSnapshot = rawSnapshot ? parseSnapshot(rawSnapshot) : null;

    if (sharedSnapshot) {
      if (!entriesMatch(localEntries, sharedSnapshot.entries)) {
        saveOriginBackupOnce(localEntries);
        replaceSharedEntries(sharedSnapshot.entries);
      }
    } else {
      await withStartupTimeout(
        invoke<void>('set_setting', {
          key: SHARED_STORAGE_SETTING_KEY,
          value: serializeSnapshot(),
        }),
      );
    }
  } catch (error) {
    console.error('[Storage] Startup synchronization failed; using this origin\'s local data:', error);
  }

  installStorageMirror();
};
