import { createRoot } from 'react-dom/client';
import './services/logger';
import './services/tauri';
import './styles/global.css';
import { initializeSharedRendererStorage } from './services/shared-storage';

import { Buffer } from 'buffer';
if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer;
}

const bootstrap = async () => {
  await initializeSharedRendererStorage();
  const container = document.getElementById('root');

  if (container) {
    const root = createRoot(container);
    const isAudioNormalizerWindow = new URLSearchParams(window.location.search)
      .get('window') === 'audio-normalizer';

    if (isAudioNormalizerWindow) {
      const { default: AudioNormalizer } = await import('./features/audio-normalizer/AudioNormalizer');
      root.render(
        <div className="audio-normalizer-window-root">
          <AudioNormalizer />
        </div>,
      );
      return;
    }

    const { initializeXrelReleaseCacheStorage } = await import('./services/xrel');
    await initializeXrelReleaseCacheStorage();
    const { default: App } = await import('./App');
    root.render(<App />);
  }
};

void bootstrap().catch((error) => {
  console.error('[Startup] Failed to initialize Streamee:', error);
});
