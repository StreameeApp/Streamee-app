import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  getEnabledStreamAddons,
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
