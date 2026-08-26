import axios from 'axios';

const configuredWorkerUrl = import.meta.env?.VITE_TMDB_WORKER_URL?.trim().replace(/\/+$/, '');

export const isTmdbServiceConfigured = Boolean(configuredWorkerUrl) || Boolean(import.meta.env?.DEV);

export const tmdbClient = axios.create({
  baseURL: configuredWorkerUrl
    ? `${configuredWorkerUrl}/v1/tmdb`
    : 'http://127.0.0.1:8787/v1/tmdb',
  timeout: 15_000,
});

tmdbClient.interceptors.request.use((request) => {
  if (!isTmdbServiceConfigured) {
    throw new axios.CanceledError('TMDB Worker URL is not configured for this build.');
  }
  return request;
});
