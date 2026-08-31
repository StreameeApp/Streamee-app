import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  getEnabledCatalogAddons,
  getEnabledStreamAddons,
  getSupportedCatalogs,
  loadInstalledAddons,
  reorderInstalledAddons,
  saveInstalledAddons,
  setInstalledAddonEnabled,
  type InstalledAddon,
} from '../src/renderer/services/installed-addons.ts';

const values = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  },
});

const installedAddon = (
  installationId: string,
  overrides: Partial<InstalledAddon> = {},
): InstalledAddon => ({
  installationId,
  addonId: `community.${installationId}`,
  manifestUrlSecretRef: `vault:addon:${installationId}`,
  manifest: {
    id: `community.${installationId}`,
    version: '1.0.0',
    name: `Add-on ${installationId}`,
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
  },
  enabled: true,
  installedAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => values.clear());

test('saved array order is the add-on fallback priority', () => {
  saveInstalledAddons([installedAddon('alpha'), installedAddon('beta'), installedAddon('gamma')]);

  const reordered = reorderInstalledAddons(['gamma', 'alpha']);

  assert.deepEqual(reordered.map((addon) => addon.installationId), ['gamma', 'alpha', 'beta']);
  assert.deepEqual(loadInstalledAddons().map((addon) => addon.installationId), ['gamma', 'alpha', 'beta']);
});

test('stream selection excludes disabled and incompatible add-ons', () => {
  const disabled = installedAddon('disabled', { enabled: false });
  const movieOnly = installedAddon('movie-only', {
    manifest: {
      ...installedAddon('movie-only').manifest,
      types: ['movie'],
      resources: [{ name: 'stream', types: ['movie'], idPrefixes: ['tt'] }],
    },
  });
  const wrongPrefix = installedAddon('wrong-prefix', {
    manifest: {
      ...installedAddon('wrong-prefix').manifest,
      idPrefixes: ['custom:'],
      resources: [{ name: 'stream', types: ['series'], idPrefixes: ['custom:'] }],
    },
  });
  const compatible = installedAddon('compatible');

  const selected = getEnabledStreamAddons(
    'series',
    'tt1234567:1:2',
    [disabled, movieOnly, wrongPrefix, compatible],
  );

  assert.deepEqual(selected.map((addon) => addon.installationId), ['compatible']);
});

test('catalog selection requires an enabled declared catalog and explicit adult access', () => {
  const streamOnly = installedAddon('stream-only');
  const catalogManifest = {
    ...installedAddon('catalog').manifest,
    resources: ['catalog', 'meta', 'stream'],
    catalogs: [{ type: 'movie' as const, id: 'latest', name: 'Latest' }],
  };
  const catalog = installedAddon('catalog', { manifest: catalogManifest });
  const adultCatalog = installedAddon('adult-catalog', {
    manifest: { ...catalogManifest, id: 'community.adult-catalog', behaviorHints: { adult: true } },
  });

  assert.deepEqual(
    getEnabledCatalogAddons(false, [streamOnly, catalog, adultCatalog])
      .map((addon) => addon.installationId),
    ['catalog'],
  );
  assert.deepEqual(
    getEnabledCatalogAddons(true, [streamOnly, catalog, adultCatalog])
      .map((addon) => addon.installationId),
    ['catalog', 'adult-catalog'],
  );
});

test('catalog selection requires compatible catalog and metadata resources', () => {
  const baseManifest = {
    ...installedAddon('capabilities').manifest,
    catalogs: [{ type: 'movie' as const, id: 'latest', name: 'Latest' }],
  };
  const catalogOnly = installedAddon('catalog-only', {
    manifest: { ...baseManifest, id: 'community.catalog-only', resources: ['catalog'] },
  });
  const wrongMetaType = installedAddon('wrong-meta-type', {
    manifest: {
      ...baseManifest,
      id: 'community.wrong-meta-type',
      resources: ['catalog', { name: 'meta', types: ['series'] }],
    },
  });
  const compatible = installedAddon('compatible-catalog', {
    manifest: {
      ...baseManifest,
      id: 'community.compatible-catalog',
      resources: ['catalog', { name: 'meta', types: ['movie'], idPrefixes: ['provider:'] }],
    },
  });

  assert.deepEqual(getSupportedCatalogs(catalogOnly), []);
  assert.deepEqual(getSupportedCatalogs(wrongMetaType), []);
  assert.deepEqual(getSupportedCatalogs(compatible), baseManifest.catalogs);
});

test('enabling an installation does not affect another installation of the same add-on', () => {
  const first = installedAddon('first');
  const second = installedAddon('second', {
    addonId: first.addonId,
    manifest: first.manifest,
    enabled: false,
  });
  saveInstalledAddons([first, second]);

  const updated = setInstalledAddonEnabled('second', true);

  assert.equal(updated[0].enabled, true);
  assert.equal(updated[1].enabled, true);
  assert.notEqual(updated[0].installationId, updated[1].installationId);
});

test('malformed and duplicate stored records are ignored safely', () => {
  const valid = installedAddon('valid');
  localStorage.setItem('streamee-installed-addons-v1', JSON.stringify({
    version: 1,
    addons: [
      valid,
      { ...valid, addonId: 'does.not.match.manifest' },
      valid,
      { installationId: 'incomplete' },
    ],
  }));

  assert.deepEqual(loadInstalledAddons(), [valid]);
});
