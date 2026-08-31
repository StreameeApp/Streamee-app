import { invoke } from '@tauri-apps/api/core';

export type AddonMediaType = 'movie' | 'series';

export type AddonResourceName = 'catalog' | 'meta' | 'stream' | 'subtitles' | 'addon_catalog';

export interface AddonResourceDescriptor {
  name: AddonResourceName | string;
  types?: string[];
  idPrefixes?: string[];
}

export interface AddonManifestBehaviorHints {
  adult?: boolean;
  p2p?: boolean;
  configurable?: boolean;
  configurationRequired?: boolean;
}

export interface AddonCatalogExtra {
  name: string;
  isRequired?: boolean;
  options?: string[];
}

export interface AddonCatalogDescriptor {
  type: AddonMediaType;
  id: string;
  name: string;
  extra?: AddonCatalogExtra[];
}

export interface AddonManifestSnapshot {
  id: string;
  version: string;
  name: string;
  description?: string;
  logo?: string;
  background?: string;
  resources: Array<AddonResourceName | string | AddonResourceDescriptor>;
  types: string[];
  idPrefixes?: string[];
  catalogs?: AddonCatalogDescriptor[];
  behaviorHints?: AddonManifestBehaviorHints;
}

export interface InstalledAddon {
  /** Identifies this installation, even when the same manifest is configured more than once. */
  installationId: string;
  /** Stable identity declared by the add-on manifest. */
  addonId: string;
  /** Opaque reference to the configured manifest URL held in secure backend storage. */
  manifestUrlSecretRef: string;
  manifest: AddonManifestSnapshot;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
}

export interface InstalledAddonStream {
  id: string;
  title: string;
  description?: string;
  playbackKind: 'http' | 'torrent';
  streamHandle?: string;
  infoHash?: string;
  fileIndex?: number;
  filename?: string;
  size?: number;
}

export interface InstalledAddonStreamRequest {
  installationId: string;
  mediaType: AddonMediaType;
  contentId: string;
}

export interface InstalledAddonStreamProbe {
  title: string;
  description?: string;
  filename?: string;
}

export interface InstalledAddonCatalogRequest {
  installationId: string;
  mediaType: AddonMediaType;
  catalogId: string;
  skip?: number;
  search?: string;
  genre?: string;
}

export interface InstalledAddonMetaRequest {
  installationId: string;
  mediaType: AddonMediaType;
  contentId: string;
}

interface InstalledAddonRegistryV1 {
  version: 1;
  /** Array order is the fallback priority, from highest to lowest. */
  addons: InstalledAddon[];
}

const STORAGE_KEY = 'streamee-installed-addons-v1';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function isResourceDescriptor(value: unknown): value is AddonResourceDescriptor {
  if (!isRecord(value) || !isNonEmptyString(value.name)) return false;
  if (value.types !== undefined && !isStringArray(value.types)) return false;
  if (value.idPrefixes !== undefined && !isStringArray(value.idPrefixes)) return false;
  return true;
}

function isCatalogExtra(value: unknown): value is AddonCatalogExtra {
  if (!isRecord(value) || !isNonEmptyString(value.name)) return false;
  if (value.isRequired !== undefined && typeof value.isRequired !== 'boolean') return false;
  if (value.options !== undefined && !isStringArray(value.options)) return false;
  return true;
}

function isCatalogDescriptor(value: unknown): value is AddonCatalogDescriptor {
  if (!isRecord(value) || (value.type !== 'movie' && value.type !== 'series')) return false;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.name)) return false;
  if (value.extra !== undefined
    && (!Array.isArray(value.extra) || !value.extra.every(isCatalogExtra))) return false;
  return true;
}

function isManifestSnapshot(value: unknown): value is AddonManifestSnapshot {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.version) || !isNonEmptyString(value.name)) {
    return false;
  }
  if (!isStringArray(value.types) || !Array.isArray(value.resources)) return false;
  if (!value.resources.every((resource) => typeof resource === 'string' || isResourceDescriptor(resource))) {
    return false;
  }
  if (value.idPrefixes !== undefined && !isStringArray(value.idPrefixes)) return false;
  if (value.catalogs !== undefined
    && (!Array.isArray(value.catalogs) || !value.catalogs.every(isCatalogDescriptor))) return false;
  return true;
}

function isInstalledAddon(value: unknown): value is InstalledAddon {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.installationId)
    && isNonEmptyString(value.addonId)
    && isNonEmptyString(value.manifestUrlSecretRef)
    && isManifestSnapshot(value.manifest)
    && value.addonId === value.manifest.id
    && typeof value.enabled === 'boolean'
    && isNonEmptyString(value.installedAt)
    && isNonEmptyString(value.updatedAt);
}

function emptyRegistry(): InstalledAddonRegistryV1 {
  return { version: 1, addons: [] };
}

export function loadInstalledAddons(): InstalledAddon[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.addons)) return [];

    const installationIds = new Set<string>();
    return parsed.addons.filter((addon): addon is InstalledAddon => {
      if (!isInstalledAddon(addon) || installationIds.has(addon.installationId)) return false;
      installationIds.add(addon.installationId);
      return true;
    });
  } catch (error) {
    console.error('Failed to load installed add-ons:', error);
    return [];
  }
}

export function saveInstalledAddons(addons: InstalledAddon[]): void {
  const registry: InstalledAddonRegistryV1 = { version: 1, addons };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
}

export function upsertInstalledAddon(addon: InstalledAddon): InstalledAddon[] {
  if (!isInstalledAddon(addon)) throw new Error('The installed add-on record is invalid.');

  const addons = loadInstalledAddons();
  const existingIndex = addons.findIndex((item) => item.installationId === addon.installationId);
  if (existingIndex === -1) {
    addons.push(addon);
  } else {
    addons[existingIndex] = addon;
  }
  saveInstalledAddons(addons);
  return addons;
}

export function removeInstalledAddon(installationId: string): InstalledAddon[] {
  const addons = loadInstalledAddons().filter((addon) => addon.installationId !== installationId);
  saveInstalledAddons(addons);
  return addons;
}

export function setInstalledAddonEnabled(installationId: string, enabled: boolean): InstalledAddon[] {
  const updatedAt = new Date().toISOString();
  const addons = loadInstalledAddons().map((addon) =>
    addon.installationId === installationId ? { ...addon, enabled, updatedAt } : addon
  );
  saveInstalledAddons(addons);
  return addons;
}

export function reorderInstalledAddons(installationIds: string[]): InstalledAddon[] {
  const addons = loadInstalledAddons();
  const requestedIds = new Set(installationIds);
  const byId = new Map(addons.map((addon) => [addon.installationId, addon]));
  const ordered = installationIds.flatMap((id) => {
    const addon = byId.get(id);
    return addon ? [addon] : [];
  });
  const remaining = addons.filter((addon) => !requestedIds.has(addon.installationId));
  const result = [...ordered, ...remaining];
  saveInstalledAddons(result);
  return result;
}

export function resourceSupportsRequest(
  manifest: AddonManifestSnapshot,
  resource: AddonResourceName,
  mediaType: AddonMediaType,
  contentId: string,
): boolean {
  return manifest.resources.some((declaredResource) => {
    if (typeof declaredResource === 'string') return declaredResource === resource;
    if (declaredResource.name !== resource) return false;
    if (declaredResource.types?.length && !declaredResource.types.includes(mediaType)) return false;
    if (declaredResource.idPrefixes?.length
      && !declaredResource.idPrefixes.some((prefix) => contentId.startsWith(prefix))) return false;
    return true;
  });
}

function resourceSupportsMediaType(
  manifest: AddonManifestSnapshot,
  resource: AddonResourceName,
  mediaType: AddonMediaType,
): boolean {
  return manifest.resources.some((declaredResource) => {
    if (typeof declaredResource === 'string') return declaredResource === resource;
    return declaredResource.name === resource
      && (!declaredResource.types?.length || declaredResource.types.includes(mediaType));
  });
}

export function getSupportedCatalogs(addon: InstalledAddon): AddonCatalogDescriptor[] {
  return (addon.manifest.catalogs || []).filter((catalog) =>
    resourceSupportsRequest(addon.manifest, 'catalog', catalog.type, catalog.id)
    && resourceSupportsMediaType(addon.manifest, 'meta', catalog.type)
  );
}

export function getEnabledCatalogAddons(
  includeAdult: boolean,
  addons = loadInstalledAddons(),
): InstalledAddon[] {
  return addons.filter((addon) => addon.enabled
    && (includeAdult || !addon.manifest.behaviorHints?.adult)
    && getSupportedCatalogs(addon).length > 0);
}

export function getEnabledStreamAddons(
  mediaType: AddonMediaType,
  contentId: string,
  addons = loadInstalledAddons(),
): InstalledAddon[] {
  return addons.filter((addon) => {
    if (!addon.enabled || !addon.manifest.types.includes(mediaType)) return false;
    if (addon.manifest.idPrefixes?.length
      && !addon.manifest.idPrefixes.some((prefix) => contentId.startsWith(prefix))) return false;
    return resourceSupportsRequest(addon.manifest, 'stream', mediaType, contentId);
  });
}

export function clearInstalledAddons(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(emptyRegistry()));
}

function retainSupportedCatalogs(addon: InstalledAddon): InstalledAddon {
  return {
    ...addon,
    manifest: {
      ...addon.manifest,
      catalogs: addon.manifest.catalogs?.filter(
        (catalog) => catalog.type === 'movie' || catalog.type === 'series',
      ),
    },
  };
}

export async function installAddonFromManifestUrl(manifestUrl: string): Promise<InstalledAddon> {
  const addon = await invoke<InstalledAddon>('install_addon', { manifestUrl });
  try {
    const supportedAddon = retainSupportedCatalogs(addon);
    upsertInstalledAddon(supportedAddon);
    return supportedAddon;
  } catch (error) {
    try {
      await invoke<void>('remove_addon', { installationId: addon.installationId });
    } catch (cleanupError) {
      console.error('Failed to roll back an add-on installation:', cleanupError);
    }
    throw error;
  }
}

export async function refreshInstalledAddon(installationId: string): Promise<InstalledAddon> {
  const current = loadInstalledAddons().find((addon) => addon.installationId === installationId);
  if (!current) throw new Error('The installed add-on is unavailable.');

  const manifest = retainSupportedCatalogs({
    ...current,
    manifest: await invoke<AddonManifestSnapshot>('refresh_addon_manifest', { installationId }),
  }).manifest;
  const updated: InstalledAddon = {
    ...current,
    addonId: manifest.id,
    manifest,
    updatedAt: new Date().toISOString(),
  };
  upsertInstalledAddon(updated);
  return updated;
}

export async function fetchInstalledAddonStreams(
  request: InstalledAddonStreamRequest,
): Promise<InstalledAddonStream[]> {
  return invoke<InstalledAddonStream[]>('fetch_addon_streams', { request });
}

export async function fetchInstalledAddonCatalog(
  request: InstalledAddonCatalogRequest,
): Promise<unknown> {
  return invoke<unknown>('fetch_addon_catalog', { request });
}

export async function fetchInstalledAddonMeta(
  request: InstalledAddonMetaRequest,
): Promise<unknown> {
  return invoke<unknown>('fetch_addon_meta', { request });
}

export async function probeInstalledAddonStreams(
  request: InstalledAddonStreamRequest,
): Promise<InstalledAddonStreamProbe[]> {
  return invoke<InstalledAddonStreamProbe[]>('probe_addon_streams', { request });
}

export async function uninstallAddon(installationId: string): Promise<InstalledAddon[]> {
  await invoke<void>('remove_addon', { installationId });
  return removeInstalledAddon(installationId);
}
