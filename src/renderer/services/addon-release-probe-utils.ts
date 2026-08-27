import type { MetaPreview } from '../store';

export function addonReleaseProbeItemKey(item: MetaPreview): string {
  return `${item.type}:${item.imdbId || item.id}`;
}

export function dedupeAddonReleaseProbeItems(items: MetaPreview[]): MetaPreview[] {
  const unique = new Map<string, MetaPreview>();
  for (const item of items) unique.set(addonReleaseProbeItemKey(item), item);
  return [...unique.values()];
}
