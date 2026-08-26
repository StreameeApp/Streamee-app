import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { FiChevronLeft, FiChevronRight, FiCalendar, FiFilm, FiTv } from 'react-icons/fi';
import { getCalendarShows, getCalendarMovies, getCalendarFinales, TraktCalendarShow, TraktCalendarMovie } from '../../services/trakt';
import { enrichTmdbItemsById } from '../../services/tmdb';
import { useStore } from '../../store';
import { getContinueWatchingProgressForTmdb } from '../../services/progress';
import './Calendar.css';

type CalendarFilter = 'all' | 'shows' | 'movies' | 'finales';
type FinaleType = 'mid_season_finale' | 'season_finale' | 'series_finale';

interface CalendarItem {
  id: string;
  type: 'show' | 'movie';
  title: string;
  poster?: string;
  rating?: number;
  date: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  overview?: string;
  tmdbId: number;
  finaleType?: FinaleType;
}

interface DateGroup {
  date: string;
  dayName: string;
  dayNum: string;
  month: string;
  items: CalendarItem[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateString(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function toDateString(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(value: string, amount: number): string {
  const next = parseDateString(value);
  next.setDate(next.getDate() + amount);
  return toDateString(next);
}

function getWindowDays(filter: CalendarFilter): number {
  return filter === 'finales' ? 30 : 7;
}

function isFinaleType(value: TraktCalendarShow['episode']['episode_type']): value is FinaleType {
  return value === 'mid_season_finale' || value === 'season_finale' || value === 'series_finale';
}

function getFinaleLabel(finaleType: FinaleType): string {
  if (finaleType === 'mid_season_finale') return 'Mid-season finale';
  if (finaleType === 'series_finale') return 'Series finale';
  return 'Season finale';
}

function getDefaultStartDate(): string {
  return toDateString(new Date());
}

const Calendar: React.FC = () => {
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<CalendarFilter>('all');
  const [startDate, setStartDate] = useState(() => getDefaultStartDate());
  const calendarRequestIdRef = useRef(0);

  const { traktConnected, setSelectedMeta, watched, watchedEpisodes, continueWatching, calendarScrollPosition, setCalendarScrollPosition } = useStore();

  const fetchCalendar = useCallback(async () => {
    if (!traktConnected) return;

    const requestId = ++calendarRequestIdRef.current;
    const isCurrentRequest = () => calendarRequestIdRef.current === requestId;

    setLoading(true);
    try {
      const days = getWindowDays(filter);
      const [shows, movies] = await Promise.all([
        filter === 'finales'
          ? getCalendarFinales(startDate, days)
          : filter !== 'movies'
            ? getCalendarShows(startDate, days)
            : Promise.resolve([]),
        filter !== 'shows' && filter !== 'finales'
          ? getCalendarMovies(startDate, days)
          : Promise.resolve([])
      ]);

      if (!isCurrentRequest()) return;

      const allItems: CalendarItem[] = [];

      if (filter !== 'movies') {
        shows.forEach((item: TraktCalendarShow) => {
          const finaleType = item.episode.episode_type;

          if (filter === 'finales') {
            const finaleKey = `${item.show.ids.tmdb}:${item.episode.season}:${item.episode.number}`;
            if (!isFinaleType(finaleType) || watchedEpisodes[finaleKey]) {
              return;
            }
          }

          allItems.push({
            id: `show:${item.show.ids.tmdb}:${item.first_aired}`,
            type: 'show',
            title: item.show.title,
            poster: item.show.poster,
            rating: item.show.rating,
            date: item.first_aired,
            season: item.episode.season,
            episode: item.episode.number,
            episodeTitle: item.episode.title,
            overview: item.overview,
            tmdbId: item.show.ids.tmdb,
            finaleType: isFinaleType(finaleType) ? finaleType : undefined
          });
        });
      }

      if (filter !== 'shows' && filter !== 'finales') {
        movies.forEach((item: TraktCalendarMovie) => {
          allItems.push({
            id: `movie:${item.movie.ids.tmdb}:${item.released}`,
            type: 'movie',
            title: item.movie.title,
            poster: item.movie.poster,
            rating: item.movie.rating,
            date: item.released,
            overview: item.overview,
            tmdbId: item.movie.ids.tmdb
          });
        });
      }

      allItems.sort((a, b) => {
        const left = new Date(a.date).getTime();
        const right = new Date(b.date).getTime();
        return filter === 'finales' ? right - left : left - right;
      });

      const itemsNeedingMetadata = allItems.filter((item) => !item.poster || item.rating === undefined);
      const enrichedItems = await enrichTmdbItemsById(itemsNeedingMetadata.map((item) => ({
        tmdbId: item.tmdbId,
        mediaType: item.type === 'show' ? 'tv' as const : 'movie' as const,
        name: item.title,
        releaseDate: item.date,
      })));
      if (!isCurrentRequest()) return;
      const enrichedById = new Map(enrichedItems.map((item) => [item.id, item]));
      for (const item of itemsNeedingMetadata) {
        const metadataId = `${item.type === 'show' ? 'tv' : 'movie'}:${item.tmdbId}`;
        const metadata = enrichedById.get(metadataId);
        if (!metadata) continue;
        item.poster ||= metadata.poster;
        item.rating ??= metadata.rating;
      }

      if (isCurrentRequest()) {
        setItems(allItems);
      }
    } catch (e) {
      if (isCurrentRequest()) {
        console.error('Failed to fetch calendar:', e);
      }
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
      }
    }
  }, [filter, startDate, traktConnected, watchedEpisodes]);

  useEffect(() => {
    fetchCalendar();
  }, [fetchCalendar]);

  const navigatePrev = () => {
    calendarRequestIdRef.current += 1;
    setCalendarScrollPosition(0);
    setStartDate(addDays(startDate, -getWindowDays(filter)));
  };

  const navigateNext = () => {
    calendarRequestIdRef.current += 1;
    setCalendarScrollPosition(0);
    setStartDate(addDays(startDate, getWindowDays(filter)));
  };

  const handleFilterChange = (nextFilter: CalendarFilter) => {
    const nextStartDate = getDefaultStartDate();
    if (nextFilter === filter && nextStartDate === startDate) return;

    calendarRequestIdRef.current += 1;
    setCalendarScrollPosition(0);
    setFilter(nextFilter);
    setStartDate(nextStartDate);
  };

  const handleDateChange = (value: string) => {
    if (value === startDate) return;

    calendarRequestIdRef.current += 1;
    setCalendarScrollPosition(0);
    setStartDate(value);
  };

  const handleItemClick = (item: CalendarItem) => {
    if (item.type === 'show') {
      const parts = item.id.split(':');
      const tmdbId = parseInt(parts[1], 10);
      setSelectedMeta({ id: `tv:${tmdbId}`, type: 'series', name: item.title, poster: item.poster, rating: item.rating }, 'calendar');
    } else {
      const parts = item.id.split(':');
      const tmdbId = parseInt(parts[1], 10);
      setSelectedMeta({ id: `movie:${tmdbId}`, type: 'movie', name: item.title, poster: item.poster, rating: item.rating }, 'calendar');
    }
  };

  const groupByDate = (): DateGroup[] => {
    const groups: Map<string, DateGroup> = new Map();

    items.forEach(item => {
      const dateObj = new Date(item.date);
      const dateKey = dateObj.toDateString();

      if (!groups.has(dateKey)) {
        groups.set(dateKey, {
          date: dateKey,
          dayName: dateObj.toLocaleDateString('en-US', { weekday: 'long' }),
          dayNum: dateObj.getDate().toString(),
          month: dateObj.toLocaleDateString('en-US', { month: 'short' }),
          items: []
        });
      }

      groups.get(dateKey)!.items.push(item);
    });

    return Array.from(groups.values());
  };

  const dateGroups = groupByDate();

  const isWatched = (item: CalendarItem) => {
    if (item.type === 'show') {
      if (item.season === undefined || item.episode === undefined) {
        return false;
      }
      return !!watchedEpisodes[`${item.tmdbId}:${item.season}:${item.episode}`];
    }

    return watched.some(w => w.id === `movie:${item.tmdbId}`);
  };

  useEffect(() => {
    const container = document.querySelector('.main-content');
    if (!(container instanceof HTMLElement)) {
      return;
    }

    const handleScroll = () => {
      setCalendarScrollPosition(container.scrollTop);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [setCalendarScrollPosition]);

  useLayoutEffect(() => {
    if (loading || calendarScrollPosition <= 0) {
      return;
    }

    const container = document.querySelector('.main-content');
    if (!(container instanceof HTMLElement)) {
      return;
    }

    container.scrollTo({ top: calendarScrollPosition, behavior: 'auto' });
  }, [loading, calendarScrollPosition, items.length, filter, startDate]);

  if (!traktConnected) {
    return (
      <div className="calendar calendar-empty">
        <FiCalendar className="empty-icon" />
        <h2>Calendar</h2>
        <p>Connect to Trakt to see your upcoming shows and movies.</p>
      </div>
    );
  }

  const days = getWindowDays(filter);
  const endDateLabel = new Date(parseDateString(startDate).getTime() + (days - 1) * DAY_MS).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });

  return (
    <div className="calendar">
      <header className="calendar-header">
        <div className="calendar-title-row">
          <h1>{filter === 'finales' ? 'Calendar Finales' : 'Calendar'}</h1>
          <span className="calendar-count">
            {items.length} Items
            {filter === 'finales' ? ` • through ${endDateLabel}` : ''}
          </span>
        </div>
      </header>

      <div className="calendar-filter">
        <button
          className={`calendar-filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => handleFilterChange('all')}
        >
          All
        </button>
        <button
          className={`calendar-filter-btn ${filter === 'movies' ? 'active' : ''}`}
          onClick={() => handleFilterChange('movies')}
        >
          <FiFilm /> Movies
        </button>
        <button
          className={`calendar-filter-btn ${filter === 'shows' ? 'active' : ''}`}
          onClick={() => handleFilterChange('shows')}
        >
          <FiTv /> TV
        </button>
        <button
          className={`calendar-filter-btn ${filter === 'finales' ? 'active' : ''}`}
          onClick={() => handleFilterChange('finales')}
        >
          <FiTv /> Finales
        </button>
      </div>

      <div className="calendar-controls">
        <div className="calendar-nav">
          <button className="calendar-nav-btn" onClick={navigatePrev}>
            <FiChevronLeft />
          </button>
          <input
            type="date"
            className="calendar-date-picker"
            value={startDate}
            onChange={(e) => handleDateChange(e.target.value)}
          />
          <button className="calendar-nav-btn" onClick={navigateNext}>
            <FiChevronRight />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="calendar-loading">
          <div className="loading-spinner" />
        </div>
      ) : items.length === 0 ? (
        <div className="calendar-empty-results">
          <p>{filter === 'finales' ? 'No unwatched season finales or mid-season finales in this period' : 'No items in this period'}</p>
        </div>
      ) : (
        <div className="calendar-groups">
          {dateGroups.map(group => (
            <div key={group.date} className="calendar-date-group">
              <div className="date-group-header">
                <div className="date-badge">
                  <span className="date-month">{group.month}</span>
                  <span className="date-day">{group.dayNum}</span>
                </div>
                <div className="date-info">
                  <span className="date-day-name">{group.dayName}</span>
                  <span className="date-items-count">{group.items.length} {group.items.length === 1 ? 'item' : 'items'}</span>
                </div>
              </div>

              <div className="date-items">
                {group.items.map(item => {
                  const continueProgress = getContinueWatchingProgressForTmdb(
                    continueWatching,
                    item.type === 'movie' ? 'movie' : 'series',
                    item.tmdbId
                  );

                  return (
                    <div
                      key={item.id}
                      className={`calendar-item-trakt ${isWatched(item) ? 'watched' : ''}`}
                      onClick={() => handleItemClick(item)}
                    >
                      <div className="item-poster">
                        {item.poster ? (
                          <img src={item.poster} alt={item.title} />
                        ) : (
                          <div className="poster-placeholder-trakt">
                            {item.type === 'show' ? <FiTv /> : <FiFilm />}
                          </div>
                        )}
                        {continueProgress !== null && (
                          <div
                            className="poster-progress"
                            style={{ width: `${continueProgress}%` }}
                          />
                        )}
                        {item.rating !== undefined && item.rating > 0 && (
                          <div className="poster-rating-badge">★ {item.rating.toFixed(1)}</div>
                        )}
                      </div>

                      <div className="item-content">
                        <div className="item-meta">
                          <span className={`item-type ${item.type}`}>
                            {item.type === 'show' ? <FiTv /> : <FiFilm />}
                            {item.type === 'show' ? 'Show' : 'Movie'}
                          </span>
                          <span className="item-time">
                            {new Date(item.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          </span>
                        </div>

                        <h3 className="item-title">{item.title}</h3>

                        {item.type === 'show' && item.season && item.episode && (
                          <p className="item-episode">
                            <span className="episode-num">S{item.season}:E{item.episode}</span>
                            {item.finaleType && (
                              <span className="episode-title">
                                {getFinaleLabel(item.finaleType)}
                              </span>
                            )}
                            {item.episodeTitle && <span className="episode-title">{item.episodeTitle}</span>}
                          </p>
                        )}

                        {item.overview && (
                          <p className="item-overview">{item.overview.slice(0, 120)}{item.overview.length > 120 ? '...' : ''}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Calendar;
