import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, watch } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = process.env.TAURI_DEV_HOST;
const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));
const mpvSourceRoot = resolve(workspaceRoot, 'mpv');
const mpvDebugRoot = resolve(workspaceRoot, 'src-tauri', 'target', 'debug', 'mpv');

function mpvDevSyncPlugin() {
  return {
    name: 'streamee-mpv-dev-sync',
    apply: 'serve' as const,
    configureServer(server: { config: { logger: { info(message: string): void; error(message: string): void } }; httpServer: { once(event: 'close', listener: () => void): void } | null }) {
      const pending = new Map<string, ReturnType<typeof setTimeout>>();

      const scheduleSync = (sourcePath: string) => {
        const relativePath = relative(mpvSourceRoot, sourcePath);
        if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return;

        const existingTimer = pending.get(relativePath);
        if (existingTimer) clearTimeout(existingTimer);

        pending.set(relativePath, setTimeout(() => {
          pending.delete(relativePath);
          const destinationPath = resolve(mpvDebugRoot, relativePath);

          try {
            if (existsSync(sourcePath)) {
              if (!statSync(sourcePath).isFile()) return;
              mkdirSync(dirname(destinationPath), { recursive: true });
              copyFileSync(sourcePath, destinationPath);
              server.config.logger.info(`[mpv-sync] Updated ${relativePath}`);
            } else if (existsSync(destinationPath) && statSync(destinationPath).isFile()) {
              rmSync(destinationPath, { force: true });
              server.config.logger.info(`[mpv-sync] Removed ${relativePath}`);
            }
          } catch (error) {
            server.config.logger.error(`[mpv-sync] Failed to sync ${relativePath}: ${String(error)}`);
          }
        }, 75));
      };

      const mpvWatcher = watch(mpvSourceRoot, { recursive: true }, (_eventType, filename) => {
        if (filename) scheduleSync(resolve(mpvSourceRoot, filename.toString()));
      });

      server.httpServer?.once('close', () => {
        mpvWatcher.close();
        for (const timer of pending.values()) clearTimeout(timer);
        pending.clear();
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [
    mpvDevSyncPlugin(),
    react(),
  ],
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: false,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
