import axios from 'axios';
import { getCachedRequest, invalidateRequestCache } from './request-cache';

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

function getOmdbSettings(): { apiKey: string } {
  try {
    const stored = localStorage.getItem('streamee-omdb');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load OMDB settings:', e);
  }
  return { apiKey: '' };
}

export async function getOmdbRating(imdbId: string): Promise<number | null> {
  const settings = getOmdbSettings();
  if (!settings.apiKey) {
    return null;
  }

  try {
    return await getCachedRequest(`omdb:rating:${imdbId}`, OMDB_RATING_CACHE_TTL_MS, async () => {
      const response = await axios.get<OmdbResponse>(OMDB_BASE, {
        params: {
          apikey: settings.apiKey,
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
    console.error('Failed to fetch OMDB rating:', error);
    return null;
  }
}

export function setOmdbSettings(settings: { apiKey: string }): void {
  localStorage.setItem('streamee-omdb', JSON.stringify(settings));
  invalidateRequestCache('omdb:');
}
