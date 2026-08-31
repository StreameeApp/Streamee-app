import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const storeSource = readFileSync('src/renderer/store/index.ts', 'utf8');
const appSource = readFileSync('src/renderer/App.tsx', 'utf8');
const catalogSource = readFileSync('src/renderer/features/catalog/Catalog.tsx', 'utf8');
const playerSource = readFileSync('src/renderer/features/player/Player.tsx', 'utf8');

test('provider provenance survives Continue Watching persistence', () => {
  assert.match(storeSource, /interface ContinueWatchingItem[\s\S]*metadataSource\?: 'tmdb' \| 'addon';[\s\S]*addonInstallationId\?: string;/);
  assert.match(appSource, /addToContinueWatching\(\{[\s\S]*metadataSource: currentPlayingMeta\.metadataSource,[\s\S]*addonInstallationId: currentPlayingMeta\.addonInstallationId,/);
});

test('add-on catalog paging advances by the raw provider response count', () => {
  assert.match(catalogSource, /page \+ data\.sourceCount/);
  assert.match(catalogSource, /addonSkip \+= data\.sourceCount/);
  assert.doesNotMatch(catalogSource, /\(page - 1\) \* ADDON_CATALOG_PAGE_SIZE/);
});

test('Smart Next requires a numeric identity only for TMDB metadata', () => {
  assert.match(playerSource, /const isAddonMetadata = selectedMeta\.metadataSource === 'addon';/);
  assert.match(playerSource, /if \(!isAddonMetadata && !Number\.isFinite\(tmdbId\)\)/);
});
