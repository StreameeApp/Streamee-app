import axios from 'axios';
import { getCachedRequest, invalidateRequestCache } from './request-cache';
import { getApiKey, setApiKey } from './api-keys';

const OMDB_BASE = 'https://www.omdbapi.com/';
const OMDB_RATING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface OmdbResponse {
  Title?: string;
  Year?: string;
  imdbRating?: string;
  imdbVotes?: string;
  Response: string;
  Error?: string;
}

export async function getOmdbRating(imdbId: string): Promise<number | null> {
  const apiKey = await getApiKey('omdb');
  if (!apiKey) {
    return null;
  }

  try {
    return await getCachedRequest(`omdb:rating:${imdbId}`, OMDB_RATING_CACHE_TTL_MS, async () => {
      const response = await axios.get<OmdbResponse>(OMDB_BASE, {
        params: {
          apikey: apiKey,
          i: imdbId,
          plot: 'short'
        }
      });

      if (response.data.Response === 'True' && response.data.imdbRating && response.data.imdbRating !== 'N/A') {
        const rating = parseFloat(response.data.imdbRating);
        if (!isNaN(rating)) {
          return rating;
        }
      }
      return null;
    });
  } catch (error) {
    console.error('Failed to fetch OMDb rating:', error);
    return null;
  }
}

export async function setOmdbSettings(settings: { apiKey: string }): Promise<void> {
  await setApiKey('omdb', settings.apiKey);
  invalidateRequestCache('omdb:');
}
