import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchFilteredDiscoveryPage,
  filterDiscoveryItems,
  isAnimeContent,
  matchesDiscoveryContentMode,
  normalizeDiscoveryContentMode,
} from '../src/renderer/services/discovery-content.ts';

type DiscoveryFixture = {
  id: string;
  name: string;
  genreIds?: number[];
  originalLanguage?: string;
};

const fixtures: DiscoveryFixture[] = [
  {
    id: 'japanese-anime',
    name: 'Japanese anime',
    genreIds: [16, 28],
    originalLanguage: 'ja',
  },
  {
    id: 'japanese-live-action',
    name: 'Japanese live action',
    genreIds: [18, 53],
    originalLanguage: 'ja',
  },
  {
    id: 'western-animation',
    name: 'Western animation',
    genreIds: [16, 35],
    originalLanguage: 'en',
  },
  {
    id: 'chinese-animation',
    name: 'Chinese animation',
    genreIds: [16, 14],
    originalLanguage: 'zh',
  },
  {
    id: 'missing-metadata',
    name: 'Missing classifier metadata',
  },
];

test('anime requires both Japanese original language and Animation genre', () => {
  assert.equal(isAnimeContent(fixtures[0]), true);
  assert.equal(isAnimeContent(fixtures[1]), false);
  assert.equal(isAnimeContent(fixtures[2]), false);
  assert.equal(isAnimeContent(fixtures[3]), false);
  assert.equal(isAnimeContent(fixtures[4]), false);
});

test('Exclude anime removes only Japanese animation', () => {
  const visibleIds = filterDiscoveryItems(fixtures, 'exclude-anime').map((item) => item.id);

  assert.deepEqual(visibleIds, [
    'japanese-live-action',
    'western-animation',
    'chinese-animation',
    'missing-metadata',
  ]);
});

test('Anime only retains only Japanese animation', () => {
  const visibleIds = filterDiscoveryItems(fixtures, 'anime-only').map((item) => item.id);

  assert.deepEqual(visibleIds, ['japanese-anime']);
});

test('All titles preserves every fixture and its ordering', () => {
  assert.deepEqual(filterDiscoveryItems(fixtures, 'all'), fixtures);
});

test('mode matching is complementary for classified anime', () => {
  const anime = fixtures[0];

  assert.equal(matchesDiscoveryContentMode(anime, 'anime-only'), true);
  assert.equal(matchesDiscoveryContentMode(anime, 'exclude-anime'), false);
  assert.equal(matchesDiscoveryContentMode(anime, 'all'), true);
});

test('unknown persisted values safely normalize to All titles', () => {
  assert.equal(normalizeDiscoveryContentMode('anime-only'), 'anime-only');
  assert.equal(normalizeDiscoveryContentMode('exclude-anime'), 'exclude-anime');
  assert.equal(normalizeDiscoveryContentMode('unexpected-value'), 'all');
  assert.equal(normalizeDiscoveryContentMode(undefined), 'all');
});

test('filtered pagination scans beyond eight sparse source pages', async () => {
  const requestedPages: number[] = [];
  const result = await fetchFilteredDiscoveryPage(async (page) => {
    requestedPages.push(page);
    const anime = page >= 9;
    return {
      items: [{
        id: `page-${page}`,
        name: `Page ${page}`,
        genreIds: anime ? [16] : [18],
        originalLanguage: anime ? 'ja' : 'en',
      }],
      hasMore: page < 10,
    };
  }, 1, 'anime-only', { pageSize: 2, maxSourcePages: 20 });

  assert.deepEqual(result.map((item) => item.id), ['page-9', 'page-10']);
  assert.equal(requestedPages.at(-1), 10);
});

test('exclude anime skips fully filtered intermediate source pages', async () => {
  const result = await fetchFilteredDiscoveryPage(async (page) => ({
    items: page === 1
      ? [
          { id: 'anime-1', name: 'Anime 1', genreIds: [16], originalLanguage: 'ja' },
          { id: 'anime-2', name: 'Anime 2', genreIds: [16], originalLanguage: 'ja' },
        ]
      : [
          { id: 'drama-1', name: 'Drama 1', genreIds: [18], originalLanguage: 'ja' },
          { id: 'animation-1', name: 'Animation 1', genreIds: [16], originalLanguage: 'en' },
        ],
    hasMore: page < 2,
  }), 1, 'exclude-anime', { pageSize: 2 });

  assert.deepEqual(result.map((item) => item.id), ['drama-1', 'animation-1']);
});

test('logical filtered pages do not overlap', async () => {
  const sourcePages = [
    [
      { id: 'anime-1', name: 'Anime 1', genreIds: [16], originalLanguage: 'ja' },
      { id: 'drama-1', name: 'Drama 1', genreIds: [18], originalLanguage: 'en' },
    ],
    [
      { id: 'anime-2', name: 'Anime 2', genreIds: [16], originalLanguage: 'ja' },
      { id: 'anime-3', name: 'Anime 3', genreIds: [16], originalLanguage: 'ja' },
    ],
    [
      { id: 'anime-4', name: 'Anime 4', genreIds: [16], originalLanguage: 'ja' },
    ],
  ];
  const fetchPage = async (page: number) => ({
    items: sourcePages[page - 1] ?? [],
    hasMore: page < sourcePages.length,
  });

  const first = await fetchFilteredDiscoveryPage(fetchPage, 1, 'anime-only', { pageSize: 2 });
  const second = await fetchFilteredDiscoveryPage(fetchPage, 2, 'anime-only', { pageSize: 2 });

  assert.deepEqual(first.map((item) => item.id), ['anime-1', 'anime-2']);
  assert.deepEqual(second.map((item) => item.id), ['anime-3', 'anime-4']);
});

test('filtered pagination propagates provider failures', async () => {
  const providerError = new Error('provider unavailable');

  await assert.rejects(
    fetchFilteredDiscoveryPage(async () => {
      throw providerError;
    }, 1, 'exclude-anime'),
    providerError
  );
});
