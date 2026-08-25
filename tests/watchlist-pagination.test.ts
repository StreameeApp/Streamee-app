import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const watchlistSource = readFileSync(
  new URL('../src/renderer/features/watchlist/Watchlist.tsx', import.meta.url),
  'utf8'
);

test('Watchlist lazy loading advances from current state without resetting its listener each page', () => {
  assert.match(watchlistSource, /setPage\(currentPage => \{/);
  assert.match(watchlistSource, /Math\.min\(currentPage \+ 1, maxPage\)/);
  assert.match(
    watchlistSource,
    /\}, \[hasMore, filteredItems\.length, setWatchlistPage\]\);/
  );
  assert.doesNotMatch(
    watchlistSource,
    /\}, \[hasMore, page, setWatchlistPage, displayedItems\.length\]\);/
  );
});
