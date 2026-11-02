export interface ImdbRatingDetails {
  rating: number;
  votes?: number;
}

export interface RatingItem {
  id?: string;
  rating?: number;
  ratingSource?: 'tmdb' | 'imdb' | 'trakt';
  tmdbRating?: number;
  imdbRating?: number;
  imdbVotes?: number;
  metadataSource?: 'tmdb' | 'addon';
}

export interface DisplayRating extends ImdbRatingDetails {
  source: 'imdb' | 'tmdb' | 'trakt';
}

export function isValidRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10;
}

export function parseOmdbRating(response: {
  Response?: string;
  imdbRating?: string;
  imdbVotes?: string;
}): ImdbRatingDetails | null {
  if (response.Response !== 'True' || !response.imdbRating?.trim()) return null;
  const rating = Number(response.imdbRating);
  if (!isValidRating(rating)) return null;
  const rawVotes = response.imdbVotes?.trim() ?? '';
  const votes = /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(rawVotes)
    ? Number(rawVotes.replace(/,/g, ''))
    : undefined;
  return {
    rating,
    votes: Number.isSafeInteger(votes) ? votes : undefined,
  };
}

export function getDisplayRating(item: RatingItem, imdb?: ImdbRatingDetails | null): DisplayRating | null {
  if (imdb && isValidRating(imdb.rating)) return { ...imdb, source: 'imdb' };
  if (isValidRating(item.imdbRating)) {
    return { rating: item.imdbRating, votes: item.imdbVotes, source: 'imdb' };
  }
  if (isValidRating(item.tmdbRating)) return { rating: item.tmdbRating, source: 'tmdb' };
  const source = item.ratingSource
    ?? (item.metadataSource === 'addon' || /^tt\d+$/i.test(item.id ?? '') ? 'imdb'
      : item.id?.startsWith('trakt:') ? 'trakt' : 'tmdb');
  return isValidRating(item.rating) ? { rating: item.rating, source } : null;
}

export function getTmdbRating(item: RatingItem): number | undefined {
  if (isValidRating(item.tmdbRating)) return item.tmdbRating;
  const rating = getDisplayRating({ ...item, imdbRating: undefined });
  return rating?.source === 'tmdb' ? rating.rating : undefined;
}

export function isTmdbRatingInRange(item: RatingItem, minimum: number, maximum: number): boolean {
  const rating = getTmdbRating(item);
  return rating !== undefined && rating >= minimum && rating <= maximum;
}

export function pickMetadataRating(...items: Array<RatingItem | null | undefined>): DisplayRating | null {
  for (const item of items) {
    const rating = item ? getDisplayRating(item) : null;
    if (rating) return rating;
  }
  return null;
}

const compactVotes = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatRatingVotes(votes: number): string {
  return compactVotes.format(votes);
}

export function ratingDescription(rating: DisplayRating): string {
  const source = rating.source === 'imdb' ? 'IMDb' : rating.source === 'trakt' ? 'Trakt' : 'TMDB';
  const votes = rating.votes !== undefined ? ` · ${rating.votes.toLocaleString('en-US')} votes` : '';
  return `${source} ${rating.rating.toFixed(1)}/10${votes}`;
}
