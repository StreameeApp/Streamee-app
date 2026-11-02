import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRatingVotes, getDisplayRating, getTmdbRating, isTmdbRatingInRange, pickMetadataRating, parseOmdbRating, ratingDescription } from '../src/renderer/services/rating-policy.ts';

test('IMDb responses keep the score and full vote count', () => {
  assert.deepEqual(parseOmdbRating({ Response: 'True', imdbRating: '8.7', imdbVotes: '2,123,456' }), {
    rating: 8.7, votes: 2_123_456,
  });
  assert.deepEqual(parseOmdbRating({ Response: 'True', imdbRating: '7.1', imdbVotes: 'N/A' }), {
    rating: 7.1, votes: undefined,
  });
});

test('missing, failed and invalid scores never become real ratings', () => {
  for (const imdbRating of ['N/A', '', ' ', '0', '-1', '11', '8.2garbage', 'Infinity']) {
    assert.equal(parseOmdbRating({ Response: 'True', imdbRating }), null);
  }
  assert.equal(parseOmdbRating({ Response: 'False', imdbRating: '8.7' }), null);
  assert.equal(parseOmdbRating({}), null);
  assert.equal(parseOmdbRating({ Response: 'True', imdbRating: '8', imdbVotes: '1,2' })?.votes, undefined);
});

test('IMDb is preferred while TMDB and add-on fallbacks retain their source', () => {
  assert.deepEqual(getDisplayRating({ rating: 6.3 }, { rating: 8.1, votes: 1234 }), {
    source: 'imdb', rating: 8.1, votes: 1234,
  });
  assert.deepEqual(getDisplayRating({ rating: 6.3 }), { source: 'tmdb', rating: 6.3 });
  assert.deepEqual(getDisplayRating({ rating: 7.5, metadataSource: 'addon' }), { source: 'imdb', rating: 7.5 });
  assert.deepEqual(getDisplayRating({ rating: 7.2, ratingSource: 'trakt' }), { source: 'trakt', rating: 7.2 });
  assert.deepEqual(getDisplayRating({ tmdbRating: 6, imdbRating: 8, imdbVotes: 50 }), {
    source: 'imdb', rating: 8, votes: 50,
  });
  assert.equal(getDisplayRating({ rating: 0 }), null);
  assert.equal(getDisplayRating({}), null);
  assert.deepEqual(getDisplayRating({ id: 'tt1234567', rating: 7.5 }), { source: 'imdb', rating: 7.5 });
});

test('TMDB sorting and filters never consume IMDb or Trakt scores', () => {
  assert.equal(getTmdbRating({ rating: 7.1, imdbRating: 9.2 }), 7.1);
  assert.equal(getTmdbRating({ rating: 8.2, ratingSource: 'trakt' }), undefined);
  assert.equal(getTmdbRating({ rating: 8.2, metadataSource: 'addon' }), undefined);
  assert.equal(getTmdbRating({ rating: 8.2, id: 'tt1234567' }), undefined);
  assert.equal(getTmdbRating({ tmdbRating: 6.5, imdbRating: 8.2 }), 6.5);
});

test('compact vote counts retain the exact count in the accessible description', () => {
  assert.equal(formatRatingVotes(12345), '12.3K');
  assert.equal(ratingDescription({ source: 'imdb', rating: 8.1, votes: 12345 }), 'IMDb 8.1/10 · 12,345 votes');
  assert.equal(ratingDescription({ source: 'tmdb', rating: 6 }), 'TMDB 6.0/10');
});

test('score ranges compare precise TMDB scores without rounding titles across a boundary', () => {
  assert.equal(isTmdbRatingInRange({ rating: 6.9 }, 7, 8), false);
  assert.equal(isTmdbRatingInRange({ rating: 7 }, 7, 8), true);
  assert.equal(isTmdbRatingInRange({ rating: 8.1 }, 7, 8), false);
  assert.equal(isTmdbRatingInRange({ rating: 8.5, ratingSource: 'imdb' }, 7, 9), false);
});

test('saved ratings retain the source of the chosen score when metadata sources differ', () => {
  assert.deepEqual(pickMetadataRating(undefined, { rating: Number.NaN }, { rating: 7.5, ratingSource: 'trakt' }, { rating: 8.1 }), {
    source: 'trakt', rating: 7.5,
  });
  assert.deepEqual(pickMetadataRating({ rating: 8, ratingSource: 'trakt', tmdbRating: 6.5 }), { source: 'tmdb', rating: 6.5 });
  assert.deepEqual(pickMetadataRating({ rating: 7.5, metadataSource: 'addon' }), { source: 'imdb', rating: 7.5 });
});
