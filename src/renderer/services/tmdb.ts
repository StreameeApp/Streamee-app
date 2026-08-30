import axios from 'axios';
import { CastMember, MetaPreview } from '../store';
import {
  fetchFilteredDiscoveryPage,
  filterDiscoveryItems,
  getDiscoveryContentMode,
  type DiscoveryContentMode,
  type DiscoverySourcePage,
} from './discovery-content';
import {
  deleteCachedRequest,
  getCachedRequest,
  getPersistentlyCachedRequest,
  readPersistentlyCachedValue,
  writePersistentlyCachedValue,
  writePersistentlyCachedValues,
} from './request-cache';
import { isTmdbServiceConfigured, tmdbClient } from './tmdb-api';
import { getTmdbEpisodeCacheTtlMs } from './tmdb-request-policy';

const TMDB_DETAIL_CONCURRENCY = 4;
const TMDB_DETAIL_MAX_RETRIES = 3;
const TMDB_PREVIEW_BATCH_SIZE = 20;
const TMDB_CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;
const TMDB_SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
const TMDB_DETAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TMDB_IDENTITY_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TMDB_SEASON_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TMDB_CATALOG_PAGE_SIZE = 20;
const TMDB_MAX_RESULT_PAGES = 500;
const TMDB_ANIMATION_GENRE_ID = 16;
const TMDB_JAPANESE_LANGUAGE_CODE = 'ja';
const TMDB_DEFAULT_WATCH_REGION = 'US';
let activeTmdbDetailRequests = 0;
const tmdbDetailRequestQueue: Array<() => void> = [];

async function withTmdbDetailSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeTmdbDetailRequests >= TMDB_DETAIL_CONCURRENCY) {
    await new Promise<void>((resolve) => tmdbDetailRequestQueue.push(resolve));
  }

  activeTmdbDetailRequests += 1;
  try {
    return await operation();
  } finally {
    activeTmdbDetailRequests -= 1;
    tmdbDetailRequestQueue.shift()?.();
  }
}

const waitForTmdbRetry = (attempt: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, 300 * 2 ** attempt);
});

export function isTmdbConfigured(): boolean {
  return isTmdbServiceConfigured;
}

export function detectSystemTmdbWatchRegion(): string {
  try {
    const region = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).region?.toUpperCase();
    if (region && /^[A-Z]{2}$/.test(region)) return region;
  } catch (error) {
    console.warn('Failed to detect the system streaming region:', error);
  }

  return TMDB_DEFAULT_WATCH_REGION;
}

export function getTmdbWatchRegion(): string {
  try {
    const stored = localStorage.getItem('streamee-settings');
    if (stored) {
      const region = JSON.parse(stored)?.watchRegion;
      if (typeof region === 'string' && /^[A-Z]{2}$/i.test(region.trim())) {
        return region.trim().toUpperCase();
      }
    }
  } catch (error) {
    console.warn('Failed to load the streaming region:', error);
  }

  return detectSystemTmdbWatchRegion();
}

interface TmdbSearchResult {
  id: number;
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  genre_ids?: number[];
  original_language?: string;
  genres?: Array<{ id: number; name?: string }>;
}

interface TmdbPersonSearchResult {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department?: string;
}

interface TmdbPersonCredit {
  id: number;
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  character?: string;
  popularity?: number;
}

interface TmdbMovie {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  genre_ids?: number[];
  original_language?: string;
  genres?: Array<{ id: number }>;
}

interface TmdbTv {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  genre_ids?: number[];
  original_language?: string;
  genres?: Array<{ id: number }>;
}

interface TmdbResponse<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

interface TmdbDetail {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  genre_ids?: number[];
  original_language?: string;
  genres?: Array<{ id: number; name?: string }>;
  imdb_id?: string;
  external_ids?: { imdb_id?: string };
  original_title?: string;
  original_name?: string;
}

interface TmdbDiscoverParams {
  page: number;
  with_genres?: string;
  primary_release_year?: number;
  first_air_date_year?: number;
  with_original_language?: string;
}

interface TmdbLanguage {
  iso_639_1: string;
  english_name: string;
  name: string;
}

interface TmdbDiscoverOptions {
  genreId?: number | null;
  year?: number | null;
  language?: string | null;
}

interface TmdbMetaData extends TmdbDetail {
  original_title?: string;
  original_name?: string;
  overview?: string;
  runtime?: number;
  episode_run_time?: number[];
  imdb_id?: string;
  credits?: {
    cast?: TmdbCastCredit[];
    crew?: Array<{ job: string; name: string }>;
  };
  aggregate_credits?: { cast?: TmdbCastCredit[] };
  external_ids?: { imdb_id?: string };
  alternative_titles?: {
    titles?: Array<{ title?: string }>;
    results?: Array<{ title?: string }>;
  };
  seasons?: TmdbSeasonData[];
  status?: string | null;
  in_production?: boolean;
  next_episode_to_air?: {
    air_date?: string | null;
    episode_number?: number;
    season_number?: number;
  } | null;
  last_air_date?: string | null;
  images?: { logos?: Array<{ file_path: string; iso_639_1: string | null; vote_average: number }> };
  videos?: { results?: TmdbVideo[] };
}

interface TmdbCastCredit {
  id: number;
  name: string;
  character?: string;
  profile_path: string | null;
  roles?: Array<{ character?: string }>;
  total_episode_count?: number;
}

interface TmdbSeasonData {
  id: number;
  season_number: number;
  name: string;
  overview: string;
  poster_path: string | null;
  air_date: string | null;
  episode_count: number;
}

interface TmdbBoardBundleResponse {
  trendingMovies: TmdbResponse<TmdbMovie> | null;
  popularMovies: TmdbResponse<TmdbMovie> | null;
  trendingTv: TmdbResponse<TmdbTv> | null;
  popularTv: TmdbResponse<TmdbTv> | null;
}

interface TmdbDiscoveryBundleResponse {
  movies: TmdbResponse<TmdbMovie> | null;
  tv: TmdbResponse<TmdbTv> | null;
}

export interface TmdbPerson {
  id: number;
  name: string;
  profile?: string;
  knownForDepartment?: string;
}

export interface TmdbPersonCreditPreview extends MetaPreview {
  character?: string;
  popularity?: number;
}

export interface TmdbWatchProvider {
  id: number;
  name: string;
  logoUrl: string;
  availability: Array<'Subscription' | 'Free' | 'With ads'>;
}

interface TmdbWatchProviderResult {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
  display_priority: number;
}

interface TmdbWatchProviderRegion {
  flatrate?: TmdbWatchProviderResult[];
  free?: TmdbWatchProviderResult[];
  ads?: TmdbWatchProviderResult[];
}

interface TmdbWatchProviderResponse {
  results?: Record<string, TmdbWatchProviderRegion>;
}

function tmdbMediaTypeFor(type: 'movie' | 'series'): 'movie' | 'tv' {
  return type === 'movie' ? 'movie' : 'tv';
}

function titleDetailCacheKey(mediaType: 'movie' | 'tv', tmdbId: number | string): string {
  return `tmdb:title-detail:${mediaType}:${tmdbId}`;
}

function previewDetailCacheKey(mediaType: 'movie' | 'tv', tmdbId: number | string): string {
  return `tmdb:preview-detail:${mediaType}:${tmdbId}`;
}

function identityCacheKey(mediaType: 'movie' | 'tv', tmdbId: number | string): string {
  return `tmdb:external-id:${mediaType}:${tmdbId}`;
}

function readTmdbImdbId(detail: TmdbDetail): string | undefined {
  const imdbId = detail.external_ids?.imdb_id ?? detail.imdb_id;
  return imdbId && /^tt\d+$/.test(imdbId) ? imdbId : undefined;
}

function buildPosterUrl(path: string | null, size: string = 'w342'): string {
  if (!path) return '';
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function buildBackdropUrl(path: string | null, size: string = 'w780'): string {
  if (!path) return '';
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function mapTmdbItemToPreview(
  item: TmdbMovie | TmdbTv | TmdbSearchResult | TmdbDetail,
  mediaType: 'movie' | 'tv',
  overrides?: Partial<MetaPreview>
): MetaPreview {
  const releaseDate = overrides?.releaseDate || item.release_date || item.first_air_date;
  const displayName = overrides?.name || item.title || item.name || '';
  const externalIds = item as {
    imdb_id?: string;
    external_ids?: { imdb_id?: string };
    original_title?: string;
    original_name?: string;
  };
  const originalName = overrides?.originalName
    ?? externalIds.original_title
    ?? externalIds.original_name;
  return {
    id: `${mediaType}:${item.id}`,
    type: mediaType === 'movie' ? ('movie' as const) : ('series' as const),
    name: displayName,
    originalName: originalName && originalName !== displayName ? originalName : undefined,
    aliases: overrides?.aliases,
    poster: overrides?.poster ?? buildPosterUrl(item.poster_path),
    background: overrides?.background ?? buildBackdropUrl(item.backdrop_path),
    year: overrides?.year ?? (releaseDate ? releaseDate.split('-')[0] : undefined),
    releaseDate,
    imdbId: overrides?.imdbId ?? externalIds.external_ids?.imdb_id ?? externalIds.imdb_id,
    watchedAt: overrides?.watchedAt,
    listedAt: overrides?.listedAt,
    rating: overrides?.rating ?? item.vote_average,
    genreIds: overrides?.genreIds ?? item.genre_ids ?? item.genres?.map((genre) => genre.id),
    originalLanguage: overrides?.originalLanguage ?? item.original_language
  };
}

function buildDiscoverParams(
  page: number,
  options: TmdbDiscoverOptions,
  yearParamName: 'primary_release_year' | 'first_air_date_year',
  contentMode: DiscoveryContentMode
): TmdbDiscoverParams {
  const genreIds = options.genreId !== null && options.genreId !== undefined
    ? [options.genreId]
    : [];
  if (contentMode === 'anime-only' && !genreIds.includes(TMDB_ANIMATION_GENRE_ID)) {
    genreIds.push(TMDB_ANIMATION_GENRE_ID);
  }
  const originalLanguage = contentMode === 'anime-only' && !options.language
    ? TMDB_JAPANESE_LANGUAGE_CODE
    : options.language;

  return {
    page,
    ...(genreIds.length > 0 ? { with_genres: genreIds.join(',') } : {}),
    ...(options.year !== null && options.year !== undefined ? { [yearParamName]: options.year } : {}),
    ...(originalLanguage ? { with_original_language: originalLanguage } : {})
  };
}

async function fetchDiscoverMovies(
  page: number,
  options: TmdbDiscoverOptions,
  contentMode: DiscoveryContentMode = getDiscoveryContentMode()
): Promise<MetaPreview[]> {
  const sourceMode = contentMode === 'exclude-anime' ? 'all' : contentMode;
  const fetchSourcePage = (sourcePage: number): Promise<DiscoverySourcePage<MetaPreview>> => {
    const cacheKey = [
      'tmdb:discover:raw-v2:movie',
      sourceMode,
      sourcePage,
      options.genreId ?? 'any',
      options.year ?? 'any',
      options.language ?? 'any',
    ].join(':');

    return getPersistentlyCachedRequest(cacheKey, TMDB_CATALOG_CACHE_TTL_MS, async () => {
      const response = await tmdbClient.get<TmdbResponse<TmdbMovie>>('/discover/movie', {
        params: buildDiscoverParams(sourcePage, options, 'primary_release_year', sourceMode)
      });

      return {
        items: response.data.results.map((movie) => mapTmdbItemToPreview(movie, 'movie')),
        hasMore: response.data.page < response.data.total_pages,
      };
    });
  };

  try {
    if (contentMode === 'exclude-anime') {
      return await getPersistentlyCachedRequest(
        `tmdb:discover:filtered-v3:movie:${page}:${options.genreId ?? 'any'}:${options.year ?? 'any'}:${options.language ?? 'any'}`,
        TMDB_CATALOG_CACHE_TTL_MS,
        () => fetchFilteredDiscoveryPage(fetchSourcePage, page, contentMode, {
          pageSize: TMDB_CATALOG_PAGE_SIZE,
          maxSourcePages: TMDB_MAX_RESULT_PAGES,
        })
      );
    }

    const source = await fetchSourcePage(page);
    return filterDiscoveryItems(source.items, contentMode);
  } catch (error) {
    console.error('Failed to fetch TMDB movie discover results:', error);
    throw error;
  }
}

async function fetchDiscoverTv(
  page: number,
  options: TmdbDiscoverOptions,
  contentMode: DiscoveryContentMode = getDiscoveryContentMode()
): Promise<MetaPreview[]> {
  const sourceMode = contentMode === 'exclude-anime' ? 'all' : contentMode;
  const fetchSourcePage = (sourcePage: number): Promise<DiscoverySourcePage<MetaPreview>> => {
    const cacheKey = [
      'tmdb:discover:raw-v2:tv',
      sourceMode,
      sourcePage,
      options.genreId ?? 'any',
      options.year ?? 'any',
      options.language ?? 'any',
    ].join(':');

    return getPersistentlyCachedRequest(cacheKey, TMDB_CATALOG_CACHE_TTL_MS, async () => {
      const response = await tmdbClient.get<TmdbResponse<TmdbTv>>('/discover/tv', {
        params: buildDiscoverParams(sourcePage, options, 'first_air_date_year', sourceMode)
      });

      return {
        items: response.data.results.map((show) => mapTmdbItemToPreview(show, 'tv')),
        hasMore: response.data.page < response.data.total_pages,
      };
    });
  };

  try {
    if (contentMode === 'exclude-anime') {
      return await getPersistentlyCachedRequest(
        `tmdb:discover:filtered-v3:tv:${page}:${options.genreId ?? 'any'}:${options.year ?? 'any'}:${options.language ?? 'any'}`,
        TMDB_CATALOG_CACHE_TTL_MS,
        () => fetchFilteredDiscoveryPage(fetchSourcePage, page, contentMode, {
          pageSize: TMDB_CATALOG_PAGE_SIZE,
          maxSourcePages: TMDB_MAX_RESULT_PAGES,
        })
      );
    }

    const source = await fetchSourcePage(page);
    return filterDiscoveryItems(source.items, contentMode);
  } catch (error) {
    console.error('Failed to fetch TMDB TV discover results:', error);
    throw error;
  }
}

async function fetchTmdbMovieCatalogPage(list: string, page: number): Promise<DiscoverySourcePage<MetaPreview>> {
  try {
    const url = list === 'trending'
      ? '/trending/movie/week'
      : `/movie/${list}`;
    return await getPersistentlyCachedRequest(`tmdb:catalog:raw:movie:${list}:${page}`, TMDB_CATALOG_CACHE_TTL_MS, async () => {
      const response = await tmdbClient.get<TmdbResponse<TmdbMovie>>(url, {
        params: { page }
      });

      return {
        items: response.data.results.map((movie) => mapTmdbItemToPreview(movie, 'movie')),
        hasMore: response.data.page < response.data.total_pages,
      };
    });
  } catch (error) {
    console.error('Failed to fetch TMDB movies:', error);
    throw error;
  }
}

async function fetchTmdbTvCatalogPage(list: string, page: number): Promise<DiscoverySourcePage<MetaPreview>> {
  try {
    const url = list === 'trending'
      ? '/trending/tv/week'
      : `/tv/${list}`;
    return await getPersistentlyCachedRequest(`tmdb:catalog:raw:tv:${list}:${page}`, TMDB_CATALOG_CACHE_TTL_MS, async () => {
      const response = await tmdbClient.get<TmdbResponse<TmdbTv>>(url, {
        params: { page }
      });

      return {
        items: response.data.results.map((show) => mapTmdbItemToPreview(show, 'tv')),
        hasMore: response.data.page < response.data.total_pages,
      };
    });
  } catch (error) {
    console.error('Failed to fetch TMDB TV:', error);
    throw error;
  }
}

export async function getTmdbMoviesDiscover(
  options: TmdbDiscoverOptions,
  page: number = 1
): Promise<MetaPreview[]> {
  return fetchDiscoverMovies(page, options);
}

export async function getTmdbTvDiscover(
  options: TmdbDiscoverOptions,
  page: number = 1
): Promise<MetaPreview[]> {
  return fetchDiscoverTv(page, options);
}

export async function getTmdbDiscovery(
  options: TmdbDiscoverOptions,
  page: number = 1,
  mediaType: 'all' | 'movie' | 'tv' = 'all',
): Promise<MetaPreview[]> {
  const contentMode = getDiscoveryContentMode();
  const cacheKey = [
    'tmdb:aggregate:discovery:v1',
    contentMode,
    mediaType,
    page,
    options.genreId ?? 'any',
    options.year ?? 'any',
    options.language ?? 'any',
  ].join(':');

  return getPersistentlyCachedRequest(cacheKey, TMDB_CATALOG_CACHE_TTL_MS, async () => {
    const response = await tmdbClient.get<TmdbDiscoveryBundleResponse>('/aggregate/discovery', {
      params: {
        content_mode: contentMode,
        media_type: mediaType,
        page,
        ...(options.genreId !== null && options.genreId !== undefined ? { genre_id: options.genreId } : {}),
        ...(options.year !== null && options.year !== undefined ? { year: options.year } : {}),
        ...(options.language ? { language: options.language } : {}),
      },
    });
    return [
      ...(response.data.movies?.results.map((movie) => mapTmdbItemToPreview(movie, 'movie')) ?? []),
      ...(response.data.tv?.results.map((show) => mapTmdbItemToPreview(show, 'tv')) ?? []),
    ];
  });
}

export async function getTmdbLanguages(): Promise<TmdbLanguage[]> {
  try {
    return await getPersistentlyCachedRequest('tmdb:configuration:languages', 30 * 24 * 60 * 60 * 1000, async () => {
      const response = await tmdbClient.get<TmdbLanguage[]>('/configuration/languages');
      return response.data;
    });
  } catch (error) {
    console.error('Failed to fetch TMDB languages:', error);
    return [];
  }
}

export const TMDB_GENRES = {
  movie: [
    { id: 28, name: 'Action' },
    { id: 12, name: 'Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 14, name: 'Fantasy' },
    { id: 36, name: 'History' },
    { id: 27, name: 'Horror' },
    { id: 10402, name: 'Music' },
    { id: 9648, name: 'Mystery' },
    { id: 10749, name: 'Romance' },
    { id: 878, name: 'Science Fiction' },
    { id: 10770, name: 'TV Movie' },
    { id: 53, name: 'Thriller' },
    { id: 10752, name: 'War' },
    { id: 37, name: 'Western' }
  ],
  tv: [
    { id: 10759, name: 'Action & Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 10762, name: 'Kids' },
    { id: 9648, name: 'Mystery' },
    { id: 10763, name: 'News' },
    { id: 10764, name: 'Reality' },
    { id: 10765, name: 'Sci-Fi & Fantasy' },
    { id: 10766, name: 'Soap' },
    { id: 10767, name: 'Talk' },
    { id: 10768, name: 'War & Politics' },
    { id: 37, name: 'Western' }
  ]
};

async function fetchTmdbSearchPage(
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<DiscoverySourcePage<MetaPreview>> {
  try {
    return await getPersistentlyCachedRequest(`tmdb:search:raw:${query.toLowerCase()}:${page}`, TMDB_SEARCH_CACHE_TTL_MS, async () => {
      const response = await tmdbClient.get<TmdbResponse<TmdbSearchResult>>('/search/multi', {
        params: {
          query,
          page
        },
        signal,
      });

      return {
        items: response.data.results
          .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
          .map((item) => mapTmdbItemToPreview(item, item.media_type)),
        hasMore: response.data.page < response.data.total_pages,
      };
    });
  } catch (error) {
    if (axios.isCancel(error)) throw error;
    console.error('Failed to search TMDB:', error);
    throw error;
  }
}

export async function getTmdbSearch(
  query: string,
  page: number = 1,
  signal?: AbortSignal,
): Promise<MetaPreview[]> {
  const contentMode = getDiscoveryContentMode();
  if (contentMode === 'all') {
    return (await fetchTmdbSearchPage(query, page, signal)).items;
  }

  return getPersistentlyCachedRequest(
    `tmdb:search:filtered-v3:${contentMode}:${query.toLowerCase()}:${page}`,
    TMDB_SEARCH_CACHE_TTL_MS,
    () => fetchFilteredDiscoveryPage(
      (sourcePage) => fetchTmdbSearchPage(query, sourcePage, signal),
      page,
      contentMode,
      { pageSize: TMDB_CATALOG_PAGE_SIZE, maxSourcePages: TMDB_MAX_RESULT_PAGES }
    )
  );
}

export async function getTmdbMovies(list: string, page: number = 1): Promise<MetaPreview[]> {
  const contentMode = getDiscoveryContentMode();
  if (contentMode === 'all') {
    return (await fetchTmdbMovieCatalogPage(list, page)).items;
  }
  if (contentMode === 'anime-only' && list === 'popular') {
    return fetchDiscoverMovies(page, {}, contentMode);
  }

  return getPersistentlyCachedRequest(
    `tmdb:catalog:filtered-v3:movie:${list}:${contentMode}:${page}`,
    TMDB_CATALOG_CACHE_TTL_MS,
    () => fetchFilteredDiscoveryPage(
      (sourcePage) => fetchTmdbMovieCatalogPage(list, sourcePage),
      page,
      contentMode,
      { pageSize: TMDB_CATALOG_PAGE_SIZE, maxSourcePages: TMDB_MAX_RESULT_PAGES }
    )
  );
}

export async function getTmdbTv(list: string, page: number = 1): Promise<MetaPreview[]> {
  const contentMode = getDiscoveryContentMode();
  if (contentMode === 'all') {
    return (await fetchTmdbTvCatalogPage(list, page)).items;
  }
  if (contentMode === 'anime-only' && list === 'popular') {
    return fetchDiscoverTv(page, {}, contentMode);
  }

  return getPersistentlyCachedRequest(
    `tmdb:catalog:filtered-v3:tv:${list}:${contentMode}:${page}`,
    TMDB_CATALOG_CACHE_TTL_MS,
    () => fetchFilteredDiscoveryPage(
      (sourcePage) => fetchTmdbTvCatalogPage(list, sourcePage),
      page,
      contentMode,
      { pageSize: TMDB_CATALOG_PAGE_SIZE, maxSourcePages: TMDB_MAX_RESULT_PAGES }
    )
  );
}

export async function getTmdbBoardCatalogs(
  contentMode: DiscoveryContentMode = getDiscoveryContentMode(),
): Promise<{
  trendingMovies: MetaPreview[];
  popularMovies: MetaPreview[];
  trendingTv: MetaPreview[];
  popularTv: MetaPreview[];
}> {
  return getPersistentlyCachedRequest(
    `tmdb:aggregate:board:${contentMode}`,
    TMDB_CATALOG_CACHE_TTL_MS,
    async () => {
      const response = await tmdbClient.get<TmdbBoardBundleResponse>('/aggregate/board', {
        params: { content_mode: contentMode },
      });
      return {
        trendingMovies: response.data.trendingMovies?.results.map((item) => mapTmdbItemToPreview(item, 'movie')) ?? [],
        popularMovies: response.data.popularMovies?.results.map((item) => mapTmdbItemToPreview(item, 'movie')) ?? [],
        trendingTv: response.data.trendingTv?.results.map((item) => mapTmdbItemToPreview(item, 'tv')) ?? [],
        popularTv: response.data.popularTv?.results.map((item) => mapTmdbItemToPreview(item, 'tv')) ?? [],
      };
    },
  );
}

export async function searchTmdbPeople(
  query: string,
  page: number = 1,
  signal?: AbortSignal,
): Promise<TmdbPerson[]> {
  try {
    return await getPersistentlyCachedRequest(
      `tmdb:person-search:${query.toLowerCase()}:${page}`,
      TMDB_SEARCH_CACHE_TTL_MS,
      async () => {
        const response = await tmdbClient.get<TmdbResponse<TmdbPersonSearchResult>>('/search/person', {
          params: { query, page },
          signal,
        });
        return response.data.results.map((person) => ({
          id: person.id,
          name: person.name,
          profile: buildPosterUrl(person.profile_path, 'w185'),
          knownForDepartment: person.known_for_department,
        }));
      },
    );
  } catch (error) {
    if (axios.isCancel(error)) return [];
    console.error('Failed to search TMDB people:', error);
    return [];
  }
}

export async function getTmdbPersonCredits(personId: number): Promise<TmdbPersonCreditPreview[]> {
  try {
    return await getPersistentlyCachedRequest(`tmdb:person-credits:${personId}`, TMDB_DETAIL_CACHE_TTL_MS, async () => {
      const response = await tmdbClient.get<{ cast?: TmdbPersonCredit[] }>(`/person/${personId}/combined_credits`);
      const seen = new Set<string>();
      return (response.data.cast || [])
        .filter((credit) => credit.media_type === 'movie' || credit.media_type === 'tv')
        .map((credit) => ({
          ...mapTmdbItemToPreview(credit, credit.media_type),
          character: credit.character,
          popularity: credit.popularity,
        }))
        .filter((credit) => {
          const key = credit.id;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => {
          const bDate = Date.parse(b.releaseDate || '0000-01-01');
          const aDate = Date.parse(a.releaseDate || '0000-01-01');
          if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) {
            return bDate - aDate;
          }
          return (b.popularity || 0) - (a.popularity || 0);
        });
    });
  } catch (error) {
    console.error('Failed to fetch TMDB person credits:', error);
    return [];
  }
}

async function getTmdbItemById(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  overrides?: Partial<MetaPreview>
): Promise<MetaPreview | null> {
  const cacheKey = `${mediaType}:${tmdbId}`;
  const persistentDetailKey = previewDetailCacheKey(mediaType, tmdbId);
  const persistentDetail = await readPersistentlyCachedValue<TmdbDetail>(persistentDetailKey);
  if (persistentDetail) {
    return mapTmdbItemToPreview(persistentDetail, mediaType, overrides);
  }
  const requestCacheKey = `tmdb:preview:${cacheKey}`;
  const detail = await getCachedRequest(requestCacheKey, TMDB_DETAIL_CACHE_TTL_MS, () =>
    withTmdbDetailSlot(async () => {
      for (let attempt = 0; attempt < TMDB_DETAIL_MAX_RETRIES; attempt += 1) {
        try {
          const response = await tmdbClient.get<TmdbDetail>(`/${mediaType}/${tmdbId}`, {
            params: {
              append_to_response: 'external_ids',
            }
          });
          return response.data;
        } catch (error) {
          const status = axios.isAxiosError(error) ? error.response?.status : undefined;
          const canRetry = status === 429 || (status !== undefined && status >= 500);
          if (!canRetry || attempt === TMDB_DETAIL_MAX_RETRIES - 1) {
            console.error(`Failed to fetch TMDB ${mediaType} ${tmdbId}:`, error);
            return null;
          }
          await waitForTmdbRetry(attempt);
        }
      }
      return null;
    })
  );
  if (!detail) {
    deleteCachedRequest(requestCacheKey);
    return null;
  }
  await Promise.all([
    writePersistentlyCachedValue(persistentDetailKey, detail, TMDB_DETAIL_CACHE_TTL_MS),
    ...(readTmdbImdbId(detail)
      ? [writePersistentlyCachedValue(
          identityCacheKey(mediaType, tmdbId),
          readTmdbImdbId(detail),
          TMDB_IDENTITY_CACHE_TTL_MS,
        )]
      : []),
  ]);
  return mapTmdbItemToPreview(detail, mediaType, overrides);
}

export async function enrichTmdbItemsById(
  items: Array<{
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    releaseDate?: string;
    name?: string;
  }>
): Promise<MetaPreview[]> {
  const enrichBatch = async (batch: typeof items): Promise<Array<MetaPreview | null>> => {
    const uniqueItems = [...new Map(
      batch.map((item) => [`${item.mediaType}:${item.tmdbId}`, item]),
    ).values()];
    const cachedDetails = await Promise.all(uniqueItems.map(async (item) => ({
      item,
      detail: await readPersistentlyCachedValue<TmdbDetail>(
        previewDetailCacheKey(item.mediaType, item.tmdbId),
      ),
    })));
    const missingItems = cachedDetails
      .filter((entry) => !entry.detail)
      .map((entry) => entry.item);
    const detailsById = new Map(
      cachedDetails.flatMap(({ item, detail }) => detail
        ? [[`${item.mediaType}:${item.tmdbId}`, detail] as const]
        : []),
    );

    try {
      if (missingItems.length > 0) {
        const missingCanonicalItems = missingItems
          .map((item) => `${item.mediaType}:${item.tmdbId}`)
          .sort();
        const responseItems = await getPersistentlyCachedRequest(
          `tmdb:aggregate:previews:${missingCanonicalItems.join(',')}`,
          TMDB_DETAIL_CACHE_TTL_MS,
          async () => {
            const response = await tmdbClient.get<{
              items: Array<{ mediaType: 'movie' | 'tv'; tmdbId: number; detail: TmdbDetail }>;
            }>('/aggregate/previews', {
              params: { items: missingCanonicalItems.join(',') },
            });
            return response.data.items;
          },
        );
        for (const item of responseItems) {
          detailsById.set(`${item.mediaType}:${item.tmdbId}`, item.detail);
        }
        await writePersistentlyCachedValues(
          responseItems.map((item) => ({
            key: previewDetailCacheKey(item.mediaType, item.tmdbId),
            value: item.detail,
          })),
          TMDB_DETAIL_CACHE_TTL_MS,
        );
        await writePersistentlyCachedValues(
          responseItems.flatMap((item) => {
            const imdbId = readTmdbImdbId(item.detail);
            return imdbId
              ? [{ key: identityCacheKey(item.mediaType, item.tmdbId), value: imdbId }]
              : [];
          }),
          TMDB_IDENTITY_CACHE_TTL_MS,
        );
      }

      return Promise.all(batch.map(async (item) => {
        const detail = detailsById.get(`${item.mediaType}:${item.tmdbId}`);
        if (detail) {
          return mapTmdbItemToPreview(detail, item.mediaType, {
            name: item.name,
            releaseDate: item.releaseDate,
          });
        }
        return getTmdbItemById(item.mediaType, item.tmdbId, {
          name: item.name,
          releaseDate: item.releaseDate,
        });
      }));
    } catch (error) {
      console.warn('TMDB preview batch failed; falling back to individual requests:', error);
      return Promise.all(batch.map((item) => getTmdbItemById(item.mediaType, item.tmdbId, {
        name: item.name,
        releaseDate: item.releaseDate,
      })));
    }
  };

  const batches: Array<Promise<Array<MetaPreview | null>>> = [];
  for (let index = 0; index < items.length; index += TMDB_PREVIEW_BATCH_SIZE) {
    batches.push(enrichBatch(items.slice(index, index + TMDB_PREVIEW_BATCH_SIZE)));
  }
  const enriched = (await Promise.all(batches)).flat();

  return enriched.filter((item): item is MetaPreview => !!item);
}

function mapTmdbMetaData(type: 'movie' | 'series', data: TmdbMetaData) {
  const castCredits = type === 'series' ? data.aggregate_credits?.cast : data.credits?.cast;
  const releaseDate = data.release_date || data.first_air_date;
  const originalName = data.original_title || data.original_name;
  const alternativeTitles = [
    ...(data.alternative_titles?.titles || []),
    ...(data.alternative_titles?.results || []),
  ]
    .map((entry) => entry.title)
    .filter((title): title is string => typeof title === 'string' && title.trim().length > 0);
  const aliases = [...new Set([originalName, ...alternativeTitles])]
    .filter((title): title is string => typeof title === 'string' && title !== (data.title || data.name))
    .slice(0, 12);
  return {
    meta: {
      id: `${type === 'movie' ? 'movie' : 'tv'}:${data.id}`,
      type,
      name: data.title || data.name || '',
      originalName,
      aliases,
      poster: buildPosterUrl(data.poster_path, 'w500'),
      background: buildBackdropUrl(data.backdrop_path, 'w1280'),
      year: releaseDate?.split('-')[0],
      description: data.overview,
      runtime: data.runtime ? `${data.runtime} min` : (data.episode_run_time?.[0] ? `${data.episode_run_time[0]} min` : undefined),
      genre: data.genres
        ?.map((genre) => genre.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
      director: data.credits?.crew?.filter((person) => person.job === 'Director').map((person) => person.name),
      cast: castCredits?.map((person): CastMember => ({
        id: person.id,
        name: person.name,
        character: person.character || person.roles?.[0]?.character,
        profile: buildPosterUrl(person.profile_path, 'w185'),
        episodeCount: type === 'series' ? person.total_episode_count : undefined,
      })),
      tmdbRating: data.vote_average ? Math.round(data.vote_average * 10) / 10 : undefined,
      imdbId: data.external_ids?.imdb_id || data.imdb_id,
      releaseDate,
      originalLanguage: data.original_language,
    },
    seasons: mapTmdbSeasons(data.seasons || []),
    logoUrl: selectTmdbLogoUrl(data.images?.logos || []),
    tmdbTrailerSources: mapTmdbVideosToTrailers(data.videos?.results || []),
  };
}

async function persistSharedTitleData(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  details: TmdbMetaData,
): Promise<void> {
  const imdbId = readTmdbImdbId(details);
  await Promise.all([
    writePersistentlyCachedValues<TmdbDetail>([
      { key: titleDetailCacheKey(mediaType, tmdbId), value: details },
      { key: previewDetailCacheKey(mediaType, tmdbId), value: details },
    ], TMDB_DETAIL_CACHE_TTL_MS),
    ...(imdbId
      ? [writePersistentlyCachedValue(
          identityCacheKey(mediaType, tmdbId),
          imdbId,
          TMDB_IDENTITY_CACHE_TTL_MS,
        )]
      : []),
    ...(mediaType === 'tv' && details.seasons
      ? [writePersistentlyCachedValue(
          `tmdb:seasons:${tmdbId}`,
          mapTmdbSeasons(details.seasons),
          TMDB_SEASON_LIST_CACHE_TTL_MS,
        )]
      : []),
  ]);
}

export async function getTmdbMeta(type: 'movie' | 'series', tmdbId: number) {
  try {
    const endpoint = tmdbMediaTypeFor(type);
    return await getPersistentlyCachedRequest(`tmdb:meta:${type}:${tmdbId}`, TMDB_DETAIL_CACHE_TTL_MS, async () => {
      const cachedDetails = await readPersistentlyCachedValue<TmdbMetaData>(
        titleDetailCacheKey(endpoint, tmdbId),
      );
      if (cachedDetails) return mapTmdbMetaData(type, cachedDetails);
      const bundle = await getTmdbTitleBundle(type, tmdbId, false);
      return bundle ? {
        meta: bundle.meta,
        seasons: bundle.seasons,
        logoUrl: bundle.logoUrl,
        tmdbTrailerSources: bundle.tmdbTrailerSources,
      } : null;
    });
  } catch (error) {
    console.error('Failed to fetch TMDB meta:', error);
    return null;
  }
}

type TmdbVideo = {
  key: string;
  site: string;
  type: string;
  name?: string;
  official?: boolean;
  iso_639_1?: string;
  published_at?: string;
};

type KinoCheckVideo = {
  id?: string;
  youtube_video_id?: string;
  title?: string;
  url?: string;
  language?: string;
  categories?: string[];
  published?: string;
};

export type TrailerProvider = 'YouTube' | 'Vimeo' | 'KinoCheck';

export interface TrailerSource {
  provider: TrailerProvider;
  key: string;
  title?: string;
  type: string;
  official: boolean;
  url: string;
  embedUrl: string | null;
  source: 'tmdb' | 'kinocheck';
}

function mapTmdbWatchProviderResponse(
  data: { results?: Record<string, TmdbWatchProviderRegion> },
  normalizedRegion: string,
): TmdbWatchProvider[] {
  const providers = new Map<number, TmdbWatchProvider & { displayPriority: number }>();
  const availabilityGroups = [
    ['flatrate', 'Subscription'],
    ['free', 'Free'],
    ['ads', 'With ads'],
  ] as const;

  const region = data.results?.[normalizedRegion];
  availabilityGroups.forEach(([key, label]) => {
    (region?.[key] ?? []).forEach((provider) => {
      const existing = providers.get(provider.provider_id);
      if (existing) {
        if (!existing.availability.includes(label)) existing.availability.push(label);
        existing.displayPriority = Math.min(existing.displayPriority, provider.display_priority);
        return;
      }

      providers.set(provider.provider_id, {
        id: provider.provider_id,
        name: provider.provider_name,
        logoUrl: buildPosterUrl(provider.logo_path, 'original'),
        availability: [label],
        displayPriority: provider.display_priority,
      });
    });
  });

  return [...providers.values()]
    .sort((a, b) => a.displayPriority - b.displayPriority || a.name.localeCompare(b.name))
    .map(({ displayPriority: _displayPriority, ...provider }) => provider);
}

export async function getTmdbTitleBundle(
  type: 'movie' | 'series',
  tmdbId: number,
  includeWatchProviders: boolean,
  watchRegion: string = getTmdbWatchRegion(),
) {
  const endpoint = tmdbMediaTypeFor(type);
  const normalizedRegion = /^[A-Z]{2}$/i.test(watchRegion.trim())
    ? watchRegion.trim().toUpperCase()
    : detectSystemTmdbWatchRegion();
  const providersCacheKey = `tmdb:watch-providers-raw:${endpoint}:${tmdbId}`;

  try {
    const bundle = await getPersistentlyCachedRequest(
      `tmdb:title-bundle:${type}:${tmdbId}:${includeWatchProviders ? 'with-providers' : 'details-only'}`,
      TMDB_DETAIL_CACHE_TTL_MS,
      async () => {
        let details = await readPersistentlyCachedValue<TmdbMetaData>(
          titleDetailCacheKey(endpoint, tmdbId),
        );
        let watchProviders = includeWatchProviders
          ? await readPersistentlyCachedValue<TmdbWatchProviderResponse>(providersCacheKey)
          : null;

        if (details && (!includeWatchProviders || watchProviders)) {
          return { details, watchProviders };
        }

        if (details && includeWatchProviders && !watchProviders) {
          const response = await tmdbClient.get<TmdbWatchProviderResponse>(
            `/${endpoint}/${tmdbId}/watch/providers`,
          );
          watchProviders = response.data;
          await writePersistentlyCachedValue(
            providersCacheKey,
            watchProviders,
            TMDB_DETAIL_CACHE_TTL_MS,
          );
          return { details, watchProviders };
        }

        const response = await tmdbClient.get<{
          details: TmdbMetaData;
          watchProviders: TmdbWatchProviderResponse | null;
        }>(`/aggregate/title/${endpoint}/${tmdbId}`, {
          params: { include_watch_providers: includeWatchProviders ? '1' : '0' },
        });
        details = response.data.details;
        watchProviders = response.data.watchProviders;
        await persistSharedTitleData(endpoint, tmdbId, details);
        if (watchProviders) {
          await writePersistentlyCachedValue(
            providersCacheKey,
            watchProviders,
            TMDB_DETAIL_CACHE_TTL_MS,
          );
        }
        return { details, watchProviders };
      },
    );
    await persistSharedTitleData(endpoint, tmdbId, bundle.details);
    return {
      ...mapTmdbMetaData(type, bundle.details),
      watchProviders: bundle.watchProviders
        ? mapTmdbWatchProviderResponse(bundle.watchProviders, normalizedRegion)
        : [],
    };
  } catch (error) {
    console.error('Failed to fetch TMDB title bundle:', error);
    return null;
  }
}

export async function getTmdbWatchProviders(
  type: 'movie' | 'series',
  tmdbId: number,
  watchRegion: string = getTmdbWatchRegion(),
): Promise<TmdbWatchProvider[]> {
  const endpoint = tmdbMediaTypeFor(type);
  const normalizedRegion = /^[A-Z]{2}$/i.test(watchRegion.trim())
    ? watchRegion.trim().toUpperCase()
    : detectSystemTmdbWatchRegion();

  try {
    const response = await getPersistentlyCachedRequest(
      `tmdb:watch-providers-raw:${endpoint}:${tmdbId}`,
      TMDB_DETAIL_CACHE_TTL_MS,
      async () => {
        const response = await tmdbClient.get<TmdbWatchProviderResponse>(
          `/${endpoint}/${tmdbId}/watch/providers`,
        );
        return response.data;
      },
    );
    return mapTmdbWatchProviderResponse(response, normalizedRegion);
  } catch (error) {
    console.error('Failed to fetch TMDB watch providers:', error);
    return [];
  }
}

function getTrailerUrl(provider: TrailerProvider, key: string): string {
  if (provider === 'Vimeo') return `https://vimeo.com/${key}`;
  if (provider === 'KinoCheck') return `https://kinocheck.com/trailer/${key}`;
  return `https://www.youtube.com/watch?v=${key}`;
}

function getTrailerEmbedUrl(provider: TrailerProvider, key: string): string | null {
  if (provider === 'Vimeo') return `https://player.vimeo.com/video/${key}?autoplay=1`;
  if (provider === 'YouTube') return `https://www.youtube.com/embed/${key}?autoplay=1&enablejsapi=1`;
  return null;
}

function rankTmdbVideo(video: TmdbVideo): number {
  const providerScore = video.site === 'Vimeo' ? 10 : video.site === 'YouTube' ? 5 : 0;
  const typeScore = video.type === 'Trailer' ? 100 : video.type === 'Teaser' ? 50 : 10;
  const officialScore = video.official ? 75 : 0;
  const languageScore = video.iso_639_1 === 'en' ? 15 : 0;
  const publishedTime = video.published_at ? new Date(video.published_at).getTime() : 0;
  const publishedScore = Number.isFinite(publishedTime) ? Math.min(publishedTime / 100000000000, 20) : 0;

  return typeScore + officialScore + languageScore + providerScore + publishedScore;
}

function mapTmdbVideoToTrailer(video: TmdbVideo): TrailerSource {
  const provider = video.site === 'Vimeo' ? 'Vimeo' : 'YouTube';

  return {
    provider,
    key: video.key,
    title: video.name,
    type: video.type,
    official: Boolean(video.official),
    url: getTrailerUrl(provider, video.key),
    embedUrl: getTrailerEmbedUrl(provider, video.key),
    source: 'tmdb'
  };
}

function mapTmdbVideosToTrailers(videos: TmdbVideo[]): TrailerSource[] {
  return videos
    .filter(video => ['YouTube', 'Vimeo'].includes(video.site) && video.key)
    .sort((a, b) => rankTmdbVideo(b) - rankTmdbVideo(a))
    .map(mapTmdbVideoToTrailer);
}

function selectTmdbLogoUrl(
  logos: Array<{ file_path: string; iso_639_1: string | null; vote_average: number }>
): string | null {
  if (logos.length === 0) return null;

  const sorted = [...logos].sort((a, b) => {
    const aEn = a.iso_639_1 === 'en' ? 1 : 0;
    const bEn = b.iso_639_1 === 'en' ? 1 : 0;
    if (aEn !== bEn) return bEn - aEn;
    return b.vote_average - a.vote_average;
  });

  return `https://image.tmdb.org/t/p/w500${sorted[0].file_path}`;
}

async function getKinoCheckTrailer(type: 'movie' | 'series', tmdbId: number): Promise<TrailerSource[]> {
  try {
    const trailer = await window.electronAPI.fetchKinoCheckTrailer(type, tmdbId) as KinoCheckVideo | null;
    if (!trailer) return [];

    const sources: TrailerSource[] = [];

    if (trailer.id && trailer.url) {
      sources.push({
        provider: 'KinoCheck',
        key: trailer.id,
        title: trailer.title,
        type: 'Trailer',
        official: true,
        url: trailer.url,
        embedUrl: null,
        source: 'kinocheck'
      });
    }

    if (trailer.youtube_video_id) {
      sources.push({
        provider: 'YouTube',
        key: trailer.youtube_video_id,
        title: trailer.title,
        type: 'Trailer',
        official: true,
        url: getTrailerUrl('YouTube', trailer.youtube_video_id),
        embedUrl: getTrailerEmbedUrl('YouTube', trailer.youtube_video_id),
        source: 'kinocheck'
      });
    }

    return sources;
  } catch (error) {
    console.error('Failed to fetch KinoCheck trailer:', error);
    return [];
  }
}

function dedupeTrailerSources(sources: TrailerSource[]): TrailerSource[] {
  const seen = new Set<string>();
  return sources.filter(source => {
    const key = `${source.provider}:${source.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getTrailerSources(
  type: 'movie' | 'series',
  tmdbId: number,
  initialTmdbSources: TrailerSource[] = []
): Promise<TrailerSource[]> {
  return getCachedRequest(`tmdb:trailers:${type}:${tmdbId}`, TMDB_DETAIL_CACHE_TTL_MS, async () => {
    const tmdbSources: TrailerSource[] = [...initialTmdbSources];
    const kinoCheckSourcesPromise = getKinoCheckTrailer(type, tmdbId);

    if (tmdbSources.length === 0) {
      try {
        const endpoint = tmdbMediaTypeFor(type);
        const cachedDetails = await readPersistentlyCachedValue<TmdbMetaData>(
          titleDetailCacheKey(endpoint, tmdbId),
        );
        tmdbSources.push(...mapTmdbVideosToTrailers(cachedDetails?.videos?.results ?? []));
        if (tmdbSources.length === 0) {
          const response = await tmdbClient.get(`/${endpoint}/${tmdbId}/videos`);
          tmdbSources.push(...mapTmdbVideosToTrailers(response.data.results ?? []));
        }
      } catch (error) {
        console.error('Failed to fetch TMDB trailer:', error);
      }
    }

    const kinoCheckSources = await kinoCheckSourcesPromise;
    const tmdbVimeoSources = tmdbSources.filter(source => source.provider === 'Vimeo');
    const tmdbYouTubeSources = tmdbSources.filter(source => source.provider === 'YouTube');
    const kinoCheckPageSources = kinoCheckSources.filter(source => source.provider === 'KinoCheck');
    const kinoCheckYouTubeSources = kinoCheckSources.filter(source => source.provider === 'YouTube');

    return dedupeTrailerSources([
      ...tmdbVimeoSources,
      ...tmdbYouTubeSources,
      ...kinoCheckYouTubeSources,
      ...kinoCheckPageSources
    ]);
  });
}

export async function getTmdbPoster(type: 'movie' | 'tv', tmdbId: number): Promise<string | null> {
  try {
    return await getPersistentlyCachedRequest(`tmdb:poster:${type}:${tmdbId}`, TMDB_DETAIL_CACHE_TTL_MS, async () => {
      const cachedDetail = await readPersistentlyCachedValue<TmdbDetail>(
        previewDetailCacheKey(type, tmdbId),
      ) ?? await readPersistentlyCachedValue<TmdbDetail>(
        titleDetailCacheKey(type, tmdbId),
      );
      if (cachedDetail) return cachedDetail.poster_path ? buildPosterUrl(cachedDetail.poster_path, 'w342') : null;
      const response = await tmdbClient.get(`/${type}/${tmdbId}`);
      const posterPath = response.data.poster_path;
      return posterPath ? buildPosterUrl(posterPath, 'w342') : null;
    });
  } catch (error) {
    console.error('Failed to fetch TMDB poster:', error);
    return null;
  }
}

export interface Season {
  id: number;
  season_number: number;
  name: string;
  overview: string;
  poster_path: string | null;
  air_date: string | null;
  episode_count: number;
}

export interface EpisodeDetail {
  id: number;
  name: string;
  overview: string;
  still_path: string | null;
  episode_number: number;
  season_number: number;
  air_date: string | null;
  runtime: number | null;
  vote_average: number;
}

export interface TmdbSeriesSchedule {
  seasons: Season[];
  status: string | null;
  inProduction: boolean;
  nextEpisodeAirDate: string | null;
  lastAirDate: string | null;
}

function mapTmdbSeasons(seasons: Array<{
  id: number;
  season_number: number;
  name: string;
  overview: string;
  poster_path: string | null;
  air_date: string | null;
  episode_count: number;
}>): Season[] {
  return seasons
    .filter((season) => season.season_number > 0)
    .map((season) => ({
      id: season.id,
      season_number: season.season_number,
      name: season.name,
      overview: season.overview || '',
      poster_path: season.poster_path,
      air_date: season.air_date || null,
      episode_count: season.episode_count
    }));
}

function mapTmdbSeriesSchedule(details: TmdbMetaData): TmdbSeriesSchedule {
  return {
    seasons: mapTmdbSeasons(details.seasons || []),
    status: typeof details.status === 'string' ? details.status : null,
    inProduction: details.in_production === true,
    nextEpisodeAirDate: details.next_episode_to_air?.air_date || null,
    lastAirDate: details.last_air_date || null,
  };
}

export async function getTmdbSeriesSchedule(
  tmdbId: number,
  options: { throwOnError?: boolean } = {},
): Promise<TmdbSeriesSchedule> {
  try {
    return await getPersistentlyCachedRequest(
      `tmdb:series-schedule:v1:${tmdbId}`,
      TMDB_SEASON_LIST_CACHE_TTL_MS,
      async () => {
        const cachedDetails = await readPersistentlyCachedValue<TmdbMetaData>(
          titleDetailCacheKey('tv', tmdbId),
        );
        if (cachedDetails?.seasons) return mapTmdbSeriesSchedule(cachedDetails);

        const response = await tmdbClient.get<TmdbMetaData>(`/tv/${tmdbId}`);
        await persistSharedTitleData('tv', tmdbId, response.data);
        return mapTmdbSeriesSchedule(response.data);
      },
    );
  } catch (error) {
    console.error('Failed to fetch TMDB series schedule:', error);
    if (options.throwOnError) throw error;
    return {
      seasons: [],
      status: null,
      inProduction: false,
      nextEpisodeAirDate: null,
      lastAirDate: null,
    };
  }
}

export async function getTmdbSeasons(
  tmdbId: number,
  options: { throwOnError?: boolean } = {},
): Promise<Season[]> {
  try {
    return await getPersistentlyCachedRequest(`tmdb:seasons:${tmdbId}`, TMDB_SEASON_LIST_CACHE_TTL_MS, async () => {
      const cachedDetails = await readPersistentlyCachedValue<TmdbMetaData>(
        titleDetailCacheKey('tv', tmdbId),
      );
      if (cachedDetails?.seasons) return mapTmdbSeasons(cachedDetails.seasons);
      const response = await tmdbClient.get(`/tv/${tmdbId}`);

      return mapTmdbSeasons(response.data.seasons || []);
    });
  } catch (error) {
    console.error('Failed to fetch TMDB seasons:', error);
    if (options.throwOnError) throw error;
    return [];
  }
}

export async function getTmdbEpisodes(
  tmdbId: number,
  seasonNumber: number,
  options: { throwOnError?: boolean } = {},
): Promise<EpisodeDetail[]> {
  try {
    return await getPersistentlyCachedRequest(
      `tmdb:episodes:${tmdbId}:${seasonNumber}`,
      (episodes: EpisodeDetail[]) => getTmdbEpisodeCacheTtlMs(episodes),
      async () => {
        const response = await tmdbClient.get(`/tv/${tmdbId}/season/${seasonNumber}`);

        const episodes = response.data.episodes || [];
        return episodes.map((e: { id: number; name: string; overview: string; still_path: string | null; episode_number: number; season_number: number; air_date: string | null; runtime: number | null; vote_average: number }) => ({
          id: e.id,
          name: e.name,
          overview: e.overview || '',
          still_path: e.still_path,
          episode_number: e.episode_number,
          season_number: e.season_number,
          air_date: e.air_date || null,
          runtime: e.runtime,
          vote_average: e.vote_average
        }));
      },
    );
  } catch (error) {
    console.error('Failed to fetch TMDB episodes:', error);
    if (options.throwOnError) throw error;
    return [];
  }
}
