import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const traktSource = readSource('src/renderer/services/trakt.ts');
const syncSource = readSource('src/renderer/services/trakt-sync.ts');
const connectSource = readSource('src/renderer/features/trakt/TraktConnect.tsx');
const settingsSource = readSource('src/renderer/features/settings/Settings.tsx');
const legalSource = readSource('src/renderer/features/settings/LegalDocuments.tsx');

test('Trakt client globally spaces writes and honors 429 cooldown headers', () => {
  assert.match(traktSource, /const TRAKT_WRITE_INTERVAL_MS = 1100/);
  assert.match(traktSource, /headers\['retry-after'\]/);
  assert.match(traktSource, /headers\['x-ratelimit'\]/);
  assert.match(traktSource, /error\.response\?\.status === 429/);
  assert.match(traktSource, /await scheduleTraktWrite\(\)/);
});

test('Trakt retries transient server failures only for idempotent reads', () => {
  assert.match(traktSource, /method === 'get'/);
  assert.match(traktSource, /\[500, 502, 503, 504\]\.includes\(status\)/);
  assert.match(traktSource, /serverRetryCount < TRAKT_SERVER_RETRY_LIMIT/);
  assert.match(traktSource, /TRAKT_SERVER_RETRY_LIMIT = 2/);
});

test('forced-paginated sync collections are read completely', () => {
  assert.match(traktSource, /async function getAllTraktPages/);
  assert.match(traktSource, /params: \{ \.\.\.params, page, limit \}/);
  assert.match(traktSource, /response\.headers\['x-pagination-page-count'\]/);
  assert.match(traktSource, /'\/sync\/watched\/shows',\s*\{ extended: 'progress' \}/);
  assert.match(traktSource, /getAllTraktPages<TraktWatchedMovie>\(client, '\/sync\/watched\/movies'\)/);
  assert.match(traktSource, /getAllTraktPages<TraktWatchlistItem>\(client, '\/sync\/watchlist\/movies\/rank\/asc'\)/);
  assert.match(traktSource, /getAllTraktPages<TraktWatchlistItem>\(client, '\/sync\/watchlist\/shows\/rank\/asc'\)/);
});

test('Trakt server failures expose only allowlisted support diagnostics', () => {
  const diagnosticsStart = traktSource.indexOf('function getTraktErrorDiagnostics');
  const diagnosticsEnd = traktSource.indexOf('interface TraktLastActivities', diagnosticsStart);
  const diagnosticsSource = traktSource.slice(diagnosticsStart, diagnosticsEnd);

  assert.match(diagnosticsSource, /status: error\.response\?\.status/);
  assert.match(diagnosticsSource, /code: error\.code/);
  assert.match(diagnosticsSource, /requestId: error\.response\?\.headers\?\.\['x-request-id'\]/);
  assert.doesNotMatch(diagnosticsSource, /\bresponse\s*:|\.data\b|\brequest\s*:|\bconfig\s*:|serverMessage/);
  assert.doesNotMatch(diagnosticsSource, /Authorization|clientSecret|accessToken|refreshToken/);
});

test('Trakt logging never emits HTTP request or response bodies', () => {
  assert.doesNotMatch(traktSource, /\[OAuth\] Poll response/);
  assert.doesNotMatch(traktSource, /console\.(?:log|warn|error)\([^;]*response\?*\.data/s);
  assert.doesNotMatch(traktSource, /console\.(?:log|warn|error)\([^;]*config\?*\.data/s);
  assert.doesNotMatch(traktSource, /console\.error\([^;]*,\s*(?:e|error)\s*\);/s);

  assert.match(syncSource, /getTraktErrorDiagnostics/);
  assert.doesNotMatch(syncSource, /console\.error\([^;]*queuedAction\s*,/s);
  assert.doesNotMatch(syncSource, /playback progress without episode identity:',\s*progress/);
  assert.doesNotMatch(syncSource, /console\.error\([^;]*,\s*(?:e|error)\s*\);/s);
  assert.doesNotMatch(connectSource, /console\.error\([^;]*,\s*error\s*\);/s);
});

test('temporary refresh failures preserve the saved Trakt session', () => {
  const refreshStart = traktSource.indexOf('async function refreshAccessToken');
  const refreshEnd = traktSource.indexOf('export function isAuthenticated', refreshStart);
  const refreshSource = traktSource.slice(refreshStart, refreshEnd);

  assert.match(refreshSource, /refreshWasRejected/);
  assert.match(refreshSource, /if \(refreshWasRejected\) \{\s*clearToken\(\)/);
  assert.match(refreshSource, /Network and server failures are transient/);
});

test('Trakt application credentials stay behind the Streamee auth service', () => {
  assert.match(traktSource, /https:\/\/streamee-auth\.streameeapp\.workers\.dev/);
  assert.match(traktSource, /postToTraktAuthService<TraktClientConfiguration>\('\/trakt\/client-id'\)/);
  assert.match(traktSource, /postToTraktAuthService<TraktDeviceCode>\('\/trakt\/device-code'\)/);
  assert.match(traktSource, /postToTraktAuthService<TraktToken>\('\/trakt\/device-token'/);
  assert.match(traktSource, /postToTraktAuthService<TraktToken>\('\/trakt\/refresh-token'/);
  assert.doesNotMatch(traktSource, /https:\/\/auth\.trakt\.tv|client_secret\s*:/);
});

test('Settings does not expose or persist owner Trakt credentials', () => {
  assert.doesNotMatch(settingsSource, /Trakt Client ID|Trakt Client Secret|setTraktCredentials/);
  assert.doesNotMatch(settingsSource, /no API credentials are required/);
  assert.match(legalSource, /device authorization and token-refresh requests pass through Streamee/);
  assert.match(legalSource, /Trakt OAuth access and refresh tokens/);
  assert.match(traktSource, /localStorage\.removeItem\(TRAKT_LEGACY_CREDENTIALS_KEY\)/);
});

test('full pushes use batched mutations instead of concurrent per-item push branches', () => {
  const pushStart = syncSource.indexOf('async function syncToTraktInternal');
  const pushEnd = syncSource.indexOf('export function syncToTrakt', pushStart);
  const pushSource = syncSource.slice(pushStart, pushEnd);

  assert.match(pushSource, /pushBatchedTraktChanges/);
  assert.doesNotMatch(pushSource, /syncProgressToTrakt|syncWatchlistToTrakt|syncWatchedToTrakt|syncWatchedEpisodesToTrakt/);
  assert.match(syncSource, /postHistoryPayload\(addHistory, addHistoryBatch\)/);
  assert.match(syncSource, /postWatchlistPayload\(addWatchlist, addWatchlistBatch\)/);
});

test('ordinary Settings resync stops after failed push and performs an incremental pull', () => {
  const handlerStart = settingsSource.indexOf('const handleSync = async');
  const handlerEnd = settingsSource.indexOf('const handleToggleAudioNormalizer', handlerStart);
  const handlerSource = settingsSource.slice(handlerStart, handlerEnd);

  assert.match(handlerSource, /if \(pushResult\.success\)/);
  assert.match(handlerSource, /syncFromTrakt\(undefined, \{ fullHistory: false \}\)/);
  assert.match(handlerSource, /Some items failed; skipping pull/);
  assert.match(handlerSource, /getTraktRateLimitRetryAt\(\)/);
});

test('incremental history pulls use the last successful activity watermark', () => {
  assert.match(syncSource, /const incrementalHistoryStartAt = isIncrementalStartup/);
  assert.match(syncSource, /new Date\(lastSync\)\.toISOString\(\)/);
  assert.match(syncSource, /getWatchHistoryResult\(media, page, 100, startAt\)/);
});
