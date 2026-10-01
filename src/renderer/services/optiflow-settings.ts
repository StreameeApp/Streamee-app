interface SettingsApi {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

interface SettingsCache {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Playback reads the native store, including preferences migrated at startup.
export async function loadOptiflowEnabled(api: SettingsApi): Promise<boolean> {
  return await api.getSetting('mpvOptiflowEnabled') === 'true';
}

export async function saveOptiflowEnabled(
  api: SettingsApi,
  cache: SettingsCache,
  enabled: boolean,
): Promise<void> {
  await api.setSetting('mpvOptiflowEnabled', String(enabled));
  try {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(cache.getItem('streamee-settings') || '{}');
    } catch {
      // The general Settings save will rebuild any malformed cache.
    }
    cache.setItem('streamee-settings', JSON.stringify({ ...settings, mpvOptiflowEnabled: enabled }));
  } catch {
    // Native persistence succeeded; an unavailable cache must not undo the toggle.
    console.warn('[Settings][OptiFlow] Could not update the settings cache');
  }
}
