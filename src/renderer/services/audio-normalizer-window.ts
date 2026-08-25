import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const AUDIO_NORMALIZER_WINDOW_LABEL = 'audio-normalizer';
const AUDIO_NORMALIZER_WINDOW_URL = 'index.html?window=audio-normalizer';

let pendingOpen: Promise<void> | null = null;

const focusWindow = async (window: WebviewWindow) => {
  await window.show();
  await window.setFocus();
};

const openOrFocusAudioNormalizerWindow = async () => {
  const existing = await WebviewWindow.getByLabel(AUDIO_NORMALIZER_WINDOW_LABEL);
  if (existing) {
    await focusWindow(existing);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const window = new WebviewWindow(AUDIO_NORMALIZER_WINDOW_LABEL, {
      url: AUDIO_NORMALIZER_WINDOW_URL,
      title: 'Streamee - Audio Normalizer',
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 620,
      center: true,
      resizable: true,
      focus: true,
    });

    void window.once('tauri://created', () => {
      void focusWindow(window).then(resolve).catch(reject);
    });
    void window.once('tauri://error', (event) => {
      reject(new Error(`Failed to create Audio Normalizer window: ${String(event.payload)}`));
    });
  });
};

export const openAudioNormalizerWindow = async () => {
  if (!pendingOpen) {
    pendingOpen = openOrFocusAudioNormalizerWindow().finally(() => {
      pendingOpen = null;
    });
  }

  await pendingOpen;
};
