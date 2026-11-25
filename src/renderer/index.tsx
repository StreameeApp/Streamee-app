import { createRoot } from 'react-dom/client';
import './services/logger';
import './services/tauri';
import './styles/global.css';
import { initializeSharedRendererStorage } from './services/shared-storage';
import { initializeSharedRequestCache } from './services/request-cache';
import { migrateLegacyApiKeys } from './services/api-keys';
import { initializeImdbDataset } from './services/imdb-dataset';

import { Buffer } from 'buffer';
if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer;
}

// Optional caches get a few seconds each; past that the app opens without
// them while they keep loading in the background.
const OPTIONAL_STARTUP_STEP_TIMEOUT_MS = 5_000;
// If the interface has not mounted by then, reload the page once. This is the
// same recovery a manual restart gives.
const STARTUP_WATCHDOG_MS = 20_000;
const STARTUP_RELOAD_FLAG = '__streameeStartupReloadAttemptedV1';

const startupStartedAt = performance.now();
let currentStartupStage = 'starting';

const markStartupStage = (stage: string) => {
  currentStartupStage = stage;
  console.info('[Startup] Stage', {
    stage,
    elapsedMs: Math.round(performance.now() - startupStartedAt),
  });
};

const readSessionFlag = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeSessionFlag = (key: string, value: string | null) => {
  try {
    if (value === null) {
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, value);
    }
  } catch {
    // Session storage is only used to avoid repeated reloads.
  }
};

const runOptionalStartupStep = async (stage: string, operation: () => Promise<unknown>) => {
  markStartupStage(stage);
  let timeoutId: number | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timeoutId = window.setTimeout(() => resolve('timeout'), OPTIONAL_STARTUP_STEP_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([operation().then(() => 'done' as const), timedOut]);
    if (result === 'timeout') {
      console.warn('[Startup] Step is slow; continuing without waiting for it', {
        stage,
        timeoutMs: OPTIONAL_STARTUP_STEP_TIMEOUT_MS,
      });
    }
  } catch (error) {
    console.error(`[Startup] Step failed; continuing: ${stage}`, error);
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const startStartupWatchdog = () => {
  let mounted = false;
  const timerId = window.setTimeout(() => {
    if (mounted) return;
    if (readSessionFlag(STARTUP_RELOAD_FLAG)) {
      console.error('[Startup] Interface still has not mounted after a reload', {
        stage: currentStartupStage,
        elapsedMs: Math.round(performance.now() - startupStartedAt),
      });
      return;
    }
    console.error('[Startup] Interface did not mount in time; reloading once', {
      stage: currentStartupStage,
      timeoutMs: STARTUP_WATCHDOG_MS,
    });
    writeSessionFlag(STARTUP_RELOAD_FLAG, currentStartupStage);
    window.location.reload();
  }, STARTUP_WATCHDOG_MS);

  return () => {
    mounted = true;
    window.clearTimeout(timerId);
    const reloadedFrom = readSessionFlag(STARTUP_RELOAD_FLAG);
    if (reloadedFrom) {
      console.info('[Startup] Interface mounted after a startup reload', { previousStage: reloadedFrom });
      writeSessionFlag(STARTUP_RELOAD_FLAG, null);
    }
  };
};

const bootstrap = async () => {
  const isAudioNormalizerWindow = new URLSearchParams(window.location.search)
    .get('window') === 'audio-normalizer';
  const markMounted = isAudioNormalizerWindow ? () => undefined : startStartupWatchdog();
  markStartupStage('migrate-api-keys');
  try {
    await migrateLegacyApiKeys();
  } catch (error) {
    console.error('Failed to migrate legacy API keys to secure storage:', error);
  }
  markStartupStage('shared-storage');
  await initializeSharedRendererStorage();
  if (!isAudioNormalizerWindow) {
    await runOptionalStartupStep('request-cache', initializeSharedRequestCache);
    void initializeImdbDataset();
  }
  const container = document.getElementById('root');

  if (container) {
    const root = createRoot(container);
    if (isAudioNormalizerWindow) {
      const { default: AudioNormalizer } = await import('./features/audio-normalizer/AudioNormalizer');
      root.render(
        <div className="audio-normalizer-window-root">
          <AudioNormalizer />
        </div>,
      );
      return;
    }

    await runOptionalStartupStep('release-cache', async () => {
      const { initializeXrelReleaseCacheStorage } = await import('./services/xrel');
      await initializeXrelReleaseCacheStorage();
    });
    markStartupStage('load-app');
    const { default: App } = await import('./App');
    markStartupStage('render-app');
    root.render(<App />);
    markMounted();
  }
};

void bootstrap().catch((error) => {
  console.error('[Startup] Failed to initialize Streamee:', error);
});
