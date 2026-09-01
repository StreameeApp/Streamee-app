import { invoke } from '@tauri-apps/api/core';

export type ApiKeyProvider = 'tmdb' | 'omdb';

const LEGACY_STORAGE_KEYS: Record<ApiKeyProvider, string> = {
  tmdb: 'streamee-tmdb',
  omdb: 'streamee-omdb',
};

const apiKeyCache = new Map<ApiKeyProvider, string>();

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function readLegacyApiKey(provider: ApiKeyProvider): string {
  try {
    const stored = localStorage.getItem(LEGACY_STORAGE_KEYS[provider]);
    if (!stored) return '';
    const parsed = JSON.parse(stored) as { apiKey?: unknown };
    return typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
  } catch {
    return '';
  }
}

export async function getApiKey(provider: ApiKeyProvider): Promise<string> {
  const cached = apiKeyCache.get(provider);
  if (cached !== undefined) return cached;

  if (!isTauriRuntime()) return readLegacyApiKey(provider);
  const stored = (await invoke<string | null>('get_api_key', { provider }))?.trim() ?? '';
  const apiKey = stored || readLegacyApiKey(provider);
  apiKeyCache.set(provider, apiKey);
  return apiKey;
}

export async function hasApiKey(provider: ApiKeyProvider): Promise<boolean> {
  if (!isTauriRuntime()) return !!readLegacyApiKey(provider);
  return invoke<boolean>('has_api_key', { provider });
}

export async function setApiKey(provider: ApiKeyProvider, apiKey: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('Secure API-key storage requires the Streamee desktop app.');
  }
  const normalizedApiKey = apiKey.trim();
  await invoke('set_api_key', { provider, apiKey: normalizedApiKey });
  apiKeyCache.set(provider, normalizedApiKey);
}

export async function clearApiKeys(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('clear_api_keys');
  apiKeyCache.clear();
}

export async function migrateLegacyApiKeys(): Promise<void> {
  if (!isTauriRuntime()) return;

  for (const provider of Object.keys(LEGACY_STORAGE_KEYS) as ApiKeyProvider[]) {
    const storageKey = LEGACY_STORAGE_KEYS[provider];
    const legacyApiKey = readLegacyApiKey(provider);
    if (!legacyApiKey) {
      localStorage.removeItem(storageKey);
      continue;
    }

    if (!(await hasApiKey(provider))) {
      await setApiKey(provider, legacyApiKey);
    }
    localStorage.removeItem(storageKey);
  }
}
