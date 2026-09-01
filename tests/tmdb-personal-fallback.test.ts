import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readSource = (path: string): string => fs.readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
);

const apiKeysSource = readSource('src/renderer/services/api-keys.ts');
const nativeApiKeysSource = readSource('src-tauri/src/api_keys.rs');
const settingsSource = readSource('src/renderer/features/settings/Settings.tsx');
const tmdbApiSource = readSource('src/renderer/services/tmdb-api.ts');
const tmdbSource = readSource('src/renderer/services/tmdb.ts');
const tmdbIdentitySource = readSource('src/renderer/services/tmdb-identity.ts');

test('TMDB personal credentials use the existing secure credential vault', () => {
  assert.match(apiKeysSource, /ApiKeyProvider = 'tmdb' \| 'omdb'/);
  assert.match(apiKeysSource, /tmdb: 'streamee-tmdb'/);
  assert.match(nativeApiKeysSource, /"tmdb" => Ok\("Streamee\/api\/tmdb\/key"\)/);
  assert.doesNotMatch(apiKeysSource, /localStorage\.removeItem\('streamee-tmdb'\);\s*\n\s*for/);
});

test('Settings exposes and securely autosaves the optional TMDB credential', () => {
  assert.match(settingsSource, /TMDB API Key or Read Access Token/);
  assert.match(settingsSource, /getApiKey\('tmdb'\)/);
  assert.match(settingsSource, /setTmdbSettings\(\{ apiKey: tmdbApiKey \}\)/);
  assert.match(settingsSource, /Stored in Windows Credential Manager and sent only to TMDB/);
});

test('standard TMDB requests prefer the personal credential and retry managed access selectively', () => {
  assert.match(tmdbApiSource, /routedRequest\.baseURL = tmdbDirectBaseUrl/);
  assert.match(tmdbApiSource, /applyPersonalCredential\(routedRequest, personalApiKey\)/);
  assert.match(tmdbApiSource, /status === 401/);
  assert.match(tmdbApiSource, /status === 403/);
  assert.match(tmdbApiSource, /status === 429/);
  assert.match(tmdbApiSource, /status >= 500/);
  assert.match(tmdbApiSource, /return tmdbClient\.request\(routedRequest\)/);
  assert.doesNotMatch(tmdbApiSource, /status === 404/);
});

test('personal credentials bypass Worker-only aggregate routes with direct TMDB requests', () => {
  assert.match(tmdbSource, /if \(await hasPersonalTmdbApiKey\(\)\) \{[\s\S]*fetchDiscoverMovies/);
  assert.match(tmdbSource, /if \(await hasPersonalTmdbApiKey\(\)\) \{[\s\S]*getTmdbMovies\('trending'\)/);
  assert.match(tmdbSource, /if \(await hasPersonalTmdbApiKey\(\)\) \{[\s\S]*getTmdbItemById/);
  assert.match(tmdbSource, /if \(await hasPersonalTmdbApiKey\(\)\) \{[\s\S]*detailsResponse/);
  assert.match(tmdbIdentitySource, /if \(!\(await hasPersonalTmdbApiKey\(\)\)\) \{/);
});
