import type { MetaDetails, MetaPreview } from '../store';
import {
  fetchInstalledAddonCatalog,
  fetchInstalledAddonMeta,
  resourceSupportsRequest,
  type AddonCatalogDescriptor,
  type AddonMediaType,
  type InstalledAddon,
} from './installed-addons';

export interface AddonCatalogPage {
  items: MetaPreview[];
  sourceCount: number;
}

interface StremioMeta {
  id: string;
  type: AddonMediaType;
  name: string;
  title?: string;
  description?: string;
  poster?: string;
  background?: string;
  logo?: string;
  releaseInfo?: string;
  year?: string | number;
  runtime?: string;
  genres?: string[];
  imdbRating?: string | number;
  videos?: StremioVideo[];
}

interface StremioVideo {
  id: string;
  title: string;
  season: number;
  episode: number;
  thumbnail?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeMeta(value: unknown): StremioMeta | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const type = value.type === 'movie' || value.type === 'series' ? value.type : null;
  const name = optionalString(value.name) || optionalString(value.title);
  if (!id || !type || !name) return null;
  const genres = Array.isArray(value.genres)
    ? value.genres.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : undefined;
  const videos = Array.isArray(value.videos)
    ? value.videos.flatMap((video): StremioVideo[] => {
        if (!isRecord(video)) return [];
        const videoId = optionalString(video.id);
        const title = optionalString(video.title) || optionalString(video.name);
        const season = Number(video.season);
        const episode = Number(video.episode);
        if (!videoId || !title || !Number.isInteger(season) || !Number.isInteger(episode)) return [];
        return [{
          id: videoId,
          title,
          season,
          episode,
          thumbnail: optionalString(video.thumbnail),
        }];
      })
    : undefined;
  return {
    id,
    type,
    name,
    title: optionalString(value.title),
    description: optionalString(value.description),
    poster: optionalString(value.poster),
    background: optionalString(value.background),
    logo: optionalString(value.logo),
    releaseInfo: optionalString(value.releaseInfo),
    year: typeof value.year === 'string' || typeof value.year === 'number' ? value.year : undefined,
    runtime: optionalString(value.runtime),
    genres,
    imdbRating: typeof value.imdbRating === 'string' || typeof value.imdbRating === 'number'
      ? value.imdbRating
      : undefined,
    videos,
  };
}

function metaYear(meta: StremioMeta): string | undefined {
  if (meta.year !== undefined) return String(meta.year);
  const match = meta.releaseInfo?.match(/\b(19|20)\d{2}\b/);
  return match?.[0];
}

function metaRating(meta: StremioMeta): number | undefined {
  const rating = Number(meta.imdbRating);
  return Number.isFinite(rating) ? rating : undefined;
}

function toPreview(meta: StremioMeta, installationId: string): MetaPreview {
  return {
    id: meta.id,
    type: meta.type,
    name: meta.name,
    poster: meta.poster,
    background: meta.background,
    year: metaYear(meta),
    imdbId: /^tt\d+$/i.test(meta.id) ? meta.id : undefined,
    rating: metaRating(meta),
    metadataSource: 'addon',
    addonInstallationId: installationId,
  };
}

export async function fetchAddonCatalogBatch(
  addon: InstalledAddon,
  catalog: AddonCatalogDescriptor,
  options: { skip?: number; search?: string; genre?: string } = {},
): Promise<AddonCatalogPage> {
  const response = await fetchInstalledAddonCatalog({
    installationId: addon.installationId,
    mediaType: catalog.type,
    catalogId: catalog.id,
    ...options,
  });
  if (!isRecord(response) || !Array.isArray(response.metas)) {
    throw new Error(`${addon.manifest.name} returned an invalid catalog response.`);
  }
  const items = response.metas
    .map(normalizeMeta)
    .filter((meta): meta is StremioMeta => !!meta)
    .filter((meta) => resourceSupportsRequest(addon.manifest, 'meta', meta.type, meta.id))
    .map((meta) => toPreview(meta, addon.installationId));
  return { items, sourceCount: response.metas.length };
}

export async function fetchAddonCatalogPage(
  addon: InstalledAddon,
  catalog: AddonCatalogDescriptor,
  options: { skip?: number; search?: string; genre?: string } = {},
): Promise<MetaPreview[]> {
  return (await fetchAddonCatalogBatch(addon, catalog, options)).items;
}

export async function fetchAddonMetaDetails(
  installationId: string,
  mediaType: AddonMediaType,
  contentId: string,
): Promise<MetaDetails> {
  const response = await fetchInstalledAddonMeta({ installationId, mediaType, contentId });
  if (!isRecord(response)) throw new Error('The add-on returned an invalid metadata response.');
  const meta = normalizeMeta(response.meta);
  if (!meta) throw new Error('The add-on returned incomplete metadata.');
  return {
    ...toPreview(meta, installationId),
    description: meta.description,
    runtime: meta.runtime,
    genre: meta.genres,
    imdbRating: metaRating(meta),
    episodes: meta.videos?.map((video) => ({
      id: video.id,
      title: video.title,
      season: video.season,
      episode: video.episode,
      thumbnail: video.thumbnail,
    })),
  };
}
