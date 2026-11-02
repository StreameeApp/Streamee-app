import { getImdbDatasetSnapshot, getLocalImdbRating, initializeImdbDataset } from './imdb-dataset.ts';
import { canFetchOmdbRatings, getOmdbRatingDetails } from './omdb.ts';
import type { ImdbRatingDetails } from './rating-policy.ts';

export async function canFetchImdbRatings(): Promise<boolean> {
  await initializeImdbDataset();
  const dataset = getImdbDatasetSnapshot();
  return (dataset.enabled && dataset.ready) || await canFetchOmdbRatings();
}

export async function getImdbRatingDetails(imdbId: string): Promise<ImdbRatingDetails | null> {
  return await getLocalImdbRating(imdbId) ?? await getOmdbRatingDetails(imdbId);
}
