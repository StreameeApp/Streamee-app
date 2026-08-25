import type { MetaPreview } from '../store';

const SETTINGS_STORAGE_KEY = 'streamee-settings';
const ANIMATION_GENRE_ID = 16;
const JAPANESE_LANGUAGE_CODE = 'ja';

export const DISCOVERY_CONTENT_CHANGED_EVENT = 'streamee:discovery-content-changed';

export type DiscoveryContentMode = 'all' | 'anime-only' | 'exclude-anime';

export interface DiscoverySourcePage<T> {
  items: T[];
  hasMore: boolean;
}

export interface FilteredDiscoveryPageOptions {
  pageSize?: number;
  maxSourcePages?: number;
}

export function normalizeDiscoveryContentMode(value: unknown): DiscoveryContentMode {
  if (value === 'anime-only' || value === 'exclude-anime') {
    return value;
  }
  return 'all';
}

export function getDiscoveryContentMode(): DiscoveryContentMode {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) return 'all';
    const settings = JSON.parse(stored) as { discoveryContentMode?: unknown };
    return normalizeDiscoveryContentMode(settings.discoveryContentMode);
  } catch (error) {
    console.error('Failed to load discovery content preference:', error);
    return 'all';
  }
}

export function isAnimeContent(
  item: Pick<MetaPreview, 'genreIds' | 'originalLanguage'>
): boolean {
  return item.genreIds?.includes(ANIMATION_GENRE_ID) === true
    && item.originalLanguage === JAPANESE_LANGUAGE_CODE;
}

export function matchesDiscoveryContentMode(
  item: Pick<MetaPreview, 'genreIds' | 'originalLanguage'>,
  mode: DiscoveryContentMode = getDiscoveryContentMode()
): boolean {
  if (mode === 'all') return true;
  const anime = isAnimeContent(item);
  return mode === 'anime-only' ? anime : !anime;
}

export function filterDiscoveryItems<T extends Pick<MetaPreview, 'genreIds' | 'originalLanguage'>>(
  items: T[],
  mode: DiscoveryContentMode = getDiscoveryContentMode()
): T[] {
  return mode === 'all'
    ? items
    : items.filter((item) => matchesDiscoveryContentMode(item, mode));
}

export async function fetchFilteredDiscoveryPage<
  T extends Pick<MetaPreview, 'id' | 'genreIds' | 'originalLanguage'>
>(
  fetchSourcePage: (page: number) => Promise<DiscoverySourcePage<T>>,
  logicalPage: number,
  mode: DiscoveryContentMode,
  options: FilteredDiscoveryPageOptions = {}
): Promise<T[]> {
  const pageSize = options.pageSize ?? 20;
  const maxSourcePages = options.maxSourcePages ?? 500;
  const targetStart = (logicalPage - 1) * pageSize;
  const targetEnd = logicalPage * pageSize;
  const filtered: T[] = [];
  const seenIds = new Set<string>();

  for (let sourcePage = 1; sourcePage <= maxSourcePages; sourcePage += 1) {
    const source = await fetchSourcePage(sourcePage);

    for (const item of filterDiscoveryItems(source.items, mode)) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      filtered.push(item);
    }

    if (filtered.length >= targetEnd || !source.hasMore) break;
  }

  return filtered.slice(targetStart, targetEnd);
}

export function formatDiscoveryCatalogTitle(
  title: string,
  mode: DiscoveryContentMode = getDiscoveryContentMode()
): string {
  if (mode !== 'anime-only') return title;
  return title.replace(/\b(Movies|TV)$/, 'Anime $1');
}

export function announceDiscoveryContentModeChange(mode: DiscoveryContentMode): void {
  window.dispatchEvent(new CustomEvent<DiscoveryContentMode>(DISCOVERY_CONTENT_CHANGED_EVENT, {
    detail: mode,
  }));
}
