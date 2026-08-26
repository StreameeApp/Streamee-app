/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TMDB_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
