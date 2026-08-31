import React, { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { FiClock, FiFilm, FiTv } from 'react-icons/fi';
import { useStore } from '../../store';
import XrelQualityBadge from '../../components/XrelQualityBadge';
import './History.css';

function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return '';
  
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  
  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffWeek < 4) return `${diffWeek}w ago`;
  return `${diffMonth}mo ago`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const ITEMS_PER_PAGE = 20;

interface HistoryItem {
  id: string;
  type: 'movie' | 'series';
  title: string;
  poster?: string;
  year?: string;
  date: string;
  season?: number;
  episode?: number;
  progress?: number;
  rating?: number;
  imdbId?: string;
  metadataSource?: 'tmdb' | 'addon';
  addonInstallationId?: string;
  isContinueWatching: boolean;
}

const History: React.FC = () => {
  const [filter, setFilter] = useState<'all' | 'movies' | 'shows'>('all');
  const loadingRef = useRef(false);
  const { continueWatching, watched, setSelectedMeta, historyScrollPosition, setHistoryScrollPosition, historyPage, setHistoryPage, view } = useStore();
  const [page, setPage] = useState(historyPage);
  const restoreFrameRef = useRef<number | null>(null);
  const restoreAttemptsRef = useRef(0);

  const allHistory = useMemo(() => {
    const items: HistoryItem[] = [];

    // Add watched items
    watched.forEach(w => {
      items.push({
        id: w.id,
        type: w.type,
        title: w.name,
        poster: w.poster,
        year: w.year,
        date: w.watchedAt || '',
        rating: w.rating,
        imdbId: w.imdbId,
        metadataSource: w.metadataSource,
        addonInstallationId: w.addonInstallationId,
        isContinueWatching: false
      });
    });

    // Add continue watching items
    continueWatching.forEach(c => {
      const existing = items.find(i => i.id === c.metaId);
      if (existing) {
        existing.date = c.pausedAt || existing.date;
        existing.progress = c.progress;
        existing.season = c.season;
        existing.episode = c.episode;
        existing.isContinueWatching = true;
        existing.metadataSource = c.metadataSource || existing.metadataSource;
        existing.addonInstallationId = c.addonInstallationId || existing.addonInstallationId;
        if (c.rating) existing.rating = c.rating;
      } else {
        items.push({
          id: c.metaId,
          type: c.type,
          title: c.title,
          poster: c.poster,
          date: c.pausedAt || '',
          season: c.season,
          episode: c.episode,
          progress: c.progress,
          rating: c.rating,
          metadataSource: c.metadataSource,
          addonInstallationId: c.addonInstallationId,
          isContinueWatching: true
        });
      }
    });

    // Sort by date (most recent first), items without dates go to end
    return items.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  }, [watched, continueWatching]);

  const filteredItems = useMemo(() => {
    if (filter === 'movies') {
      return allHistory.filter(i => i.type === 'movie');
    }
    if (filter === 'shows') {
      return allHistory.filter(i => i.type === 'series');
    }
    return allHistory;
  }, [allHistory, filter]);

  const displayedItems = filteredItems.slice(0, page * ITEMS_PER_PAGE);
  const hasMore = displayedItems.length < filteredItems.length;

  useEffect(() => {
    if (!hasMore || loadingRef.current) return;

    const checkScroll = () => {
      const container = document.querySelector('.main-content');
      if (!container) return;

      const scrollTop = container.scrollTop;
      const scrollHeight = container.scrollHeight;
      const clientHeight = container.clientHeight;

      const isNearBottom = scrollTop + clientHeight >= scrollHeight - 600;

      if (isNearBottom) {
        loadingRef.current = true;
        setPage(p => {
          const nextPage = p + 1;
          setHistoryPage(nextPage);
          return nextPage;
        });
        setTimeout(() => { loadingRef.current = false; }, 500);
      }
    };

    const container = document.querySelector('.main-content');
    if (container) {
      container.addEventListener('scroll', checkScroll);
    }

    const intervalId = setInterval(checkScroll, 1000);

    return () => {
      if (container) container.removeEventListener('scroll', checkScroll);
      clearInterval(intervalId);
    };
  }, [hasMore, filteredItems.length]);

  useEffect(() => {
    const nextPage = Math.max(1, historyPage);
    setPage(nextPage);
  }, [historyPage]);

  const handlePlay = (item: HistoryItem) => {
    const container = document.querySelector('.main-content');
    if (container) {
      setHistoryScrollPosition(container.scrollTop);
    }
    setHistoryPage(page);
    setSelectedMeta({
      id: item.id,
      type: item.type,
      name: item.title,
      poster: item.poster,
      year: item.year,
      rating: item.rating,
      metadataSource: item.metadataSource,
      addonInstallationId: item.addonInstallationId
    }, 'history');
  };

  const handleFilterChange = (nextFilter: 'all' | 'movies' | 'shows') => {
    setFilter(nextFilter);
    setPage(1);
    setHistoryPage(1);
    setHistoryScrollPosition(0);
    loadingRef.current = false;
  };

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredItems.length / ITEMS_PER_PAGE));
    const nextPage = Math.min(Math.max(historyPage, 1), maxPage);

    if (nextPage !== page) {
      setPage(nextPage);
    }

    if (historyPage !== nextPage) {
      setHistoryPage(nextPage);
    }
  }, [filteredItems.length, historyPage, page, setHistoryPage]);

  useLayoutEffect(() => {
    if (view !== 'history' || historyScrollPosition <= 0 || displayedItems.length === 0) {
      return;
    }

    const container = document.querySelector('.main-content');
    if (!container) {
      return;
    }

    if (restoreFrameRef.current) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }

    restoreAttemptsRef.current = 0;

    const attemptRestore = () => {
      const current = document.querySelector('.main-content');
      if (!current) {
        return;
      }

      current.scrollTo({ top: historyScrollPosition, behavior: 'auto' });

      if (Math.abs(current.scrollTop - historyScrollPosition) > 2 && restoreAttemptsRef.current < 6) {
        restoreAttemptsRef.current += 1;
        restoreFrameRef.current = window.requestAnimationFrame(attemptRestore);
      }
    };

    attemptRestore();

    return () => {
      if (restoreFrameRef.current) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };
  }, [view, historyPage, historyScrollPosition, displayedItems.length]);

  return (
    <div className="history">
      <header className="history-header">
        <div className="history-title-row">
          <h1>History</h1>
          <span className="history-count">{filteredItems.length} Items</span>
        </div>
      </header>

      <div className="history-filter">
        <button 
          className={`history-filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => handleFilterChange('all')}
        >
          All
        </button>
        <button 
          className={`history-filter-btn ${filter === 'movies' ? 'active' : ''}`}
          onClick={() => handleFilterChange('movies')}
        >
          <FiFilm /> Movies
        </button>
        <button 
          className={`history-filter-btn ${filter === 'shows' ? 'active' : ''}`}
          onClick={() => handleFilterChange('shows')}
        >
          <FiTv /> TV
        </button>
      </div>

      {displayedItems.length === 0 ? (
        <div className="history-empty">
          <FiClock className="history-empty-icon" />
          <p>No watch history yet</p>
          <p className="history-empty-sub">Start watching to see your progress here</p>
        </div>
      ) : (
        <>
          <div className="history-grid">
            {displayedItems.map((item) => (
              <div 
                key={item.id} 
                className="history-item"
                onClick={() => handlePlay(item)}
              >
                <div className="history-poster">
                  {item.poster ? (
                    <img src={item.poster} alt={item.title} />
                  ) : (
                    <div className="history-poster-placeholder" />
                  )}
                  <XrelQualityBadge
                    item={{
                      id: item.id,
                      type: item.type,
                      name: item.title,
                      year: item.year,
                      imdbId: item.imdbId,
                    }}
                    queuePriority="library"
                  />
                  {item.rating !== undefined && item.rating > 0 && (
                    <div className="poster-rating-badge">★ {item.rating.toFixed(1)}</div>
                  )}
                  {item.progress !== undefined && item.progress > 0 && (
                    <div className="history-progress" style={{ width: `${item.progress}%` }} />
                  )}
                  {item.type === 'series' && item.season && item.episode && (
                    <div className="history-episode">
                      S{item.season}:E{item.episode}
                    </div>
                  )}
                </div>
                <div className="history-info">
                  <h3 className="history-title">{item.title}</h3>
                  <span className="history-date">
                    {item.isContinueWatching && item.progress !== undefined
                      ? `${Math.round(item.progress)}% · ${formatRelativeTime(item.date)}`
                      : item.date
                        ? formatDate(item.date)
                        : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default History;
