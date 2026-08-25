import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FiTrash2, FiFilm, FiTv } from 'react-icons/fi';
import { useStore, MetaPreview } from '../../store';
import { getContinueWatchingProgress } from '../../services/progress';
import { pushWatchlistToTrakt } from '../../services/trakt-sync';
import XrelQualityBadge from '../../components/XrelQualityBadge';
import './Watchlist.css';

const ITEMS_PER_PAGE = 20;

function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffWeek < 4) return `${diffWeek}w ago`;
  return `${diffMonth}mo ago`;
}

const Watchlist: React.FC = () => {
  const { watchlist, removeFromWatchlist, setSelectedMeta, continueWatching, watchlistScrollPosition, setWatchlistScrollPosition, watchlistPage, setWatchlistPage, view, traktConnected } = useStore();
  const [page, setPage] = useState(watchlistPage);
  const [filter, setFilter] = useState<'all' | 'movies' | 'shows'>('all');
  const loadingRef = useRef(false);

  // Sort by listedAt (most recent first), then filter
  const sortedWatchlist = useMemo(() => {
    return [...watchlist].sort((a, b) => {
      if (!a.listedAt && !b.listedAt) return 0;
      if (!a.listedAt) return 1;
      if (!b.listedAt) return -1;
      return new Date(b.listedAt).getTime() - new Date(a.listedAt).getTime();
    });
  }, [watchlist]);

  const filteredItems = useMemo(() => {
    if (filter === 'movies') return sortedWatchlist.filter(i => i.type === 'movie');
    if (filter === 'shows') return sortedWatchlist.filter(i => i.type === 'series');
    return sortedWatchlist;
  }, [sortedWatchlist, filter]);

  const displayedItems = useMemo(() => filteredItems.slice(0, page * ITEMS_PER_PAGE), [filteredItems, page]);
  const hasMore = displayedItems.length < filteredItems.length;

  const handlePlay = (item: MetaPreview) => {
    const container = document.querySelector('.main-content');
    if (container) {
      setWatchlistScrollPosition(container.scrollTop);
    }
    setWatchlistPage(page);
    setSelectedMeta({
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster,
      year: item.year,
      rating: item.rating
    }, 'watchlist');
  };

  const handleRemove = (item: MetaPreview) => {
    removeFromWatchlist(item.id);
    if (traktConnected) {
      pushWatchlistToTrakt(item, 'remove').catch(console.error);
    }
  };

  const handleFilterChange = (nextFilter: 'all' | 'movies' | 'shows') => {
    setFilter(nextFilter);
    setPage(1);
    setWatchlistPage(1);
    setWatchlistScrollPosition(0);
    loadingRef.current = false;
  };

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredItems.length / ITEMS_PER_PAGE));
    const nextPage = Math.min(Math.max(watchlistPage, 1), maxPage);

    setPage(nextPage);
    if (watchlistPage !== nextPage) {
      setWatchlistPage(nextPage);
    }
  }, [filteredItems.length, watchlistPage, setWatchlistPage]);

  useEffect(() => {
    if (!hasMore || loadingRef.current) {
      return;
    }

    const checkScroll = () => {
      if (loadingRef.current) return;

      const container = document.querySelector('.main-content');
      if (!container) return;

      const scrollTop = container.scrollTop;
      const scrollHeight = container.scrollHeight;
      const clientHeight = container.clientHeight;

      if (scrollTop + clientHeight >= scrollHeight - 600) {
        loadingRef.current = true;
        setPage(currentPage => {
          const maxPage = Math.max(1, Math.ceil(filteredItems.length / ITEMS_PER_PAGE));
          const nextPage = Math.min(currentPage + 1, maxPage);
          if (nextPage !== currentPage) {
            setWatchlistPage(nextPage);
          }
          return nextPage;
        });
        setTimeout(() => {
          loadingRef.current = false;
        }, 500);
      }
    };

    const container = document.querySelector('.main-content');
    if (container) {
      container.addEventListener('scroll', checkScroll);
    }

    const intervalId = setInterval(checkScroll, 1000);

    return () => {
      if (container) {
        container.removeEventListener('scroll', checkScroll);
      }
      clearInterval(intervalId);
    };
  }, [hasMore, filteredItems.length, setWatchlistPage]);

  useEffect(() => {
    if (view !== 'watchlist' || watchlistScrollPosition <= 0 || displayedItems.length === 0) {
      return;
    }

    const container = document.querySelector('.main-content');
    if (!container) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      container.scrollTop = watchlistScrollPosition;
    }, 100);

    return () => window.clearTimeout(timeoutId);
  }, [view, watchlistScrollPosition, displayedItems.length, page]);

  return (
    <div className="watchlist">
      <header className="watchlist-header">
        <div className="watchlist-title-row">
          <h1>Watchlist</h1>
          <span className="watchlist-count">{filteredItems.length} Items</span>
        </div>
      </header>

      <div className="watchlist-filter">
        <button
          className={`watchlist-filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => handleFilterChange('all')}
        >
          All
        </button>
        <button
          className={`watchlist-filter-btn ${filter === 'movies' ? 'active' : ''}`}
          onClick={() => handleFilterChange('movies')}
        >
          <FiFilm /> Movies
        </button>
        <button
          className={`watchlist-filter-btn ${filter === 'shows' ? 'active' : ''}`}
          onClick={() => handleFilterChange('shows')}
        >
          <FiTv /> TV
        </button>
      </div>

      {filteredItems.length === 0 ? (
        <div className="watchlist-empty">
          <p>{filter === 'all' ? 'Your watchlist is empty' : `No ${filter === 'movies' ? 'movies' : 'TV shows'} in watchlist`}</p>
        </div>
      ) : (
        <div className="watchlist-grid">
          {displayedItems.map((item) => (
            <div key={item.id} className="watchlist-item">
              <div className="watchlist-poster" onClick={() => handlePlay(item)}>
                {item.poster ? (
                  <img src={item.poster} alt={item.name} />
                ) : (
                  <div className="watchlist-poster-placeholder" />
                )}
                <XrelQualityBadge item={item} queuePriority="library" />
                {item.rating !== undefined && item.rating > 0 && (
                  <div className="poster-rating-badge">★ {item.rating.toFixed(1)}</div>
                )}
                {getContinueWatchingProgress(continueWatching, item.id) !== null && (
                  <div
                    className="poster-progress"
                    style={{ width: `${getContinueWatchingProgress(continueWatching, item.id)}%` }}
                  />
                )}
              </div>
              <div className="watchlist-info">
                <h3 className="watchlist-title">{item.name}</h3>
                <span className="watchlist-year">
                  {item.listedAt ? formatRelativeTime(item.listedAt) : (item.year || '')}
                </span>
              </div>
              <button
                className="watchlist-remove"
                onClick={() => handleRemove(item)}
                title="Remove from watchlist"
              >
                <FiTrash2 />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Watchlist;
