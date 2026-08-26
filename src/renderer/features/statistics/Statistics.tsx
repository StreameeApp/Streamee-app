import React, { useEffect, useMemo, useState } from 'react';
import {
  FiActivity,
  FiCalendar,
  FiClock,
  FiDownloadCloud,
  FiFilm,
  FiPlayCircle,
  FiTarget,
  FiTv,
  FiZap,
} from 'react-icons/fi';
import { useStore } from '../../store';
import {
  DailyStatistics,
  readStatisticsLedger,
  StatisticsLedger,
  subscribeToStatistics,
} from '../../services/statistics';
import './Statistics.css';

type Range = 'month' | 'year' | 'lifetime';
type ActivityMetric = 'watch' | 'titles' | 'data';

interface ActivityDay {
  key: string;
  date: Date;
  stats: DailyStatistics;
  titles: number;
}

const EMPTY_DAY: DailyStatistics = {
  secondsWatched: 0,
  movieSeconds: 0,
  seriesSeconds: 0,
  bytesDownloaded: 0,
  sourceBytes: {
    webtorrent: 0,
    qbittorrent: 0,
    addon: 0,
    local: 0,
  },
  addonSourceBytes: {},
  sessions: 0,
  moviesCompleted: 0,
  episodesCompleted: 0,
};

const formatDayKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDate = (value?: string | boolean) => {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
};

const formatDuration = (seconds: number) => {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours.toLocaleString()}h ${minutes}m`;
};

const formatBytes = (bytes: number) => {
  if (bytes <= 0) return '0 GB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
};

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const endOfMonth = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);

const endOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

const getLongestStreak = (keys: string[]) => {
  if (keys.length === 0) return 0;
  const unique = Array.from(new Set(keys)).sort();
  let longest = 1;
  let current = 1;
  for (let index = 1; index < unique.length; index += 1) {
    const previous = new Date(`${unique[index - 1]}T12:00:00`);
    const next = new Date(`${unique[index]}T12:00:00`);
    const difference = Math.round((next.getTime() - previous.getTime()) / 86_400_000);
    current = difference === 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
};

const getCurrentStreak = (keys: string[], now: Date) => {
  const active = new Set(keys);
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!active.has(formatDayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (active.has(formatDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
};

const Statistics: React.FC = () => {
  const watched = useStore((state) => state.watched);
  const watchedEpisodes = useStore((state) => state.watchedEpisodes);
  const continueWatching = useStore((state) => state.continueWatching);
  const [range, setRange] = useState<Range>('year');
  const [activityMetric, setActivityMetric] = useState<ActivityMetric>('watch');
  const [ledger, setLedger] = useState<StatisticsLedger>(() => readStatisticsLedger());
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const unsubscribe = subscribeToStatistics(() => setLedger(readStatisticsLedger()));
    const clock = window.setInterval(() => setNow(new Date()), 60_000);
    return () => {
      unsubscribe();
      window.clearInterval(clock);
    };
  }, []);

  const historyDays = useMemo(() => {
    const days = new Map<string, { movies: number; episodes: number }>();
    const add = (date: Date | null, type: 'movies' | 'episodes') => {
      if (!date) return;
      const key = formatDayKey(date);
      const current = days.get(key) || { movies: 0, episodes: 0 };
      current[type] += 1;
      days.set(key, current);
    };
    watched.forEach((item) => {
      if (item.type === 'movie') add(parseDate(item.watchedAt), 'movies');
    });
    Object.values(watchedEpisodes).forEach((value) => add(parseDate(value), 'episodes'));
    return days;
  }, [watched, watchedEpisodes]);

  const rangeBounds = useMemo(() => {
    const currentDay = startOfDay(now);
    if (range === 'month') {
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: endOfMonth(now),
      };
    }
    if (range === 'year') {
      return {
        start: new Date(now.getFullYear(), 0, 1),
        end: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
      };
    }
    const earliestKey = Array.from(
      new Set([...Object.keys(ledger.days), ...Array.from(historyDays.keys())])
    ).sort()[0];
    return {
      start: earliestKey ? new Date(`${earliestKey}T00:00:00`) : currentDay,
      end: endOfDay(currentDay),
    };
  }, [historyDays, ledger.days, now, range]);

  const rangeStartTime = rangeBounds.start.getTime();
  const rangeEndTime = rangeBounds.end.getTime();

  const activityBounds = useMemo(() => {
    if (range === 'lifetime') return rangeBounds;
    return {
      start: new Date(now.getFullYear(), 0, 1),
      end: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
    };
  }, [now, range, rangeBounds]);

  const activityGrid = useMemo(() => {
    const start = startOfDay(activityBounds.start);
    start.setDate(start.getDate() - start.getDay());
    const end = startOfDay(activityBounds.end);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const days: ActivityDay[] = [];
    const dayCount = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    for (let index = 0; index < dayCount; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = formatDayKey(date);
      const history = historyDays.get(key);
      const stats = ledger.days[key] || EMPTY_DAY;
      days.push({
        key,
        date,
        stats,
        titles: (history?.movies || 0) + (history?.episodes || 0),
      });
    }
    const weeks = Math.ceil(days.length / 7);
    const monthMarkers: Array<{ label: string; column: number }> = [];
    const monthCursor = new Date(activityBounds.start.getFullYear(), activityBounds.start.getMonth(), 1);
    while (monthCursor <= activityBounds.end) {
      const column = Math.floor((monthCursor.getTime() - start.getTime()) / (7 * 86_400_000)) + 1;
      monthMarkers.push({
        label: range === 'lifetime' && monthCursor.getMonth() === 0
          ? monthCursor.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
          : monthCursor.toLocaleDateString(undefined, { month: 'short' }),
        column: Math.max(1, column),
      });
      monthCursor.setMonth(monthCursor.getMonth() + 1);
    }
    return { days, weeks, monthMarkers };
  }, [activityBounds, historyDays, ledger.days, range]);

  const filteredDays = useMemo(
    () => Object.entries(ledger.days).filter(([key]) => {
      const timestamp = new Date(`${key}T12:00:00`).getTime();
      return timestamp >= rangeStartTime && timestamp <= rangeEndTime;
    }),
    [ledger.days, rangeEndTime, rangeStartTime]
  );
  const filteredSeconds = filteredDays.reduce((total, [, day]) => total + day.secondsWatched, 0);
  const filteredBytes = filteredDays.reduce((total, [, day]) => total + day.bytesDownloaded, 0);
  const filteredSessions = filteredDays.reduce((total, [, day]) => total + day.sessions, 0);

  const movieDates = watched.filter((item) => {
    const date = parseDate(item.watchedAt);
    const timestamp = date?.getTime();
    return item.type === 'movie' && (
      timestamp !== undefined
        ? timestamp >= rangeStartTime && timestamp <= rangeEndTime
        : range === 'lifetime'
    );
  });
  const filteredEpisodeEntries = Object.entries(watchedEpisodes).filter(([, value]) => {
    const date = parseDate(value);
    const timestamp = date?.getTime();
    return timestamp !== undefined
      ? timestamp >= rangeStartTime && timestamp <= rangeEndTime
      : range === 'lifetime';
  });
  const episodeDates = filteredEpisodeEntries.map(([, value]) => value);
  const showCount = new Set(filteredEpisodeEntries.map(([key]) => key.split(':')[0])).size;

  const activeKeys = useMemo(() => {
    const keys = new Set<string>();
    Object.entries(ledger.days).forEach(([key, day]) => {
      if (day.secondsWatched > 0 || day.sessions > 0) keys.add(key);
    });
    historyDays.forEach((value, key) => {
      if (value.movies + value.episodes > 0) keys.add(key);
    });
    return Array.from(keys);
  }, [historyDays, ledger.days]);

  const periodActiveKeys = activeKeys.filter((key) => {
    const timestamp = new Date(`${key}T12:00:00`).getTime();
    return timestamp >= rangeStartTime && timestamp <= rangeEndTime;
  });
  const currentStreak = getCurrentStreak(activeKeys, now);
  const longestStreak = getLongestStreak(periodActiveKeys);
  const maxActivity = Math.max(
    1,
    ...activityGrid.days.map((day) => {
      if (activityMetric === 'watch') return day.stats.secondsWatched;
      if (activityMetric === 'titles') return day.titles;
      return day.stats.bytesDownloaded;
    })
  );

  const trendTotals = useMemo(() => {
    if (range === 'month') {
      const count = endOfMonth(now).getDate();
      const days = Array.from({ length: count }, (_, index) => ({
        label: String(index + 1),
        seconds: 0,
      }));
      filteredDays.forEach(([key, day]) => {
        const date = new Date(`${key}T12:00:00`);
        days[date.getDate() - 1].seconds += day.secondsWatched;
      });
      return days;
    }
    if (range === 'year') {
      const months = Array.from({ length: 12 }, (_, index) => ({
        label: new Date(now.getFullYear(), index, 1).toLocaleDateString(undefined, { month: 'short' }),
        seconds: 0,
      }));
      filteredDays.forEach(([key, day]) => {
        const date = new Date(`${key}T12:00:00`);
        months[date.getMonth()].seconds += day.secondsWatched;
      });
      return months;
    }
    const startYear = rangeBounds.start.getFullYear();
    const years = Array.from(
      { length: now.getFullYear() - startYear + 1 },
      (_, index) => ({ label: String(startYear + index), seconds: 0 })
    );
    filteredDays.forEach(([key, day]) => {
      const year = new Date(`${key}T12:00:00`).getFullYear();
      years[year - startYear].seconds += day.secondsWatched;
    });
    return years;
  }, [filteredDays, now, range, rangeBounds.start]);
  const maxTrendSeconds = Math.max(1, ...trendTotals.map((item) => item.seconds));

  const movieSeconds = filteredDays.reduce((total, [, day]) => total + day.movieSeconds, 0);
  const seriesSeconds = filteredDays.reduce((total, [, day]) => total + day.seriesSeconds, 0);
  const mediaTotal = movieSeconds + seriesSeconds;
  const moviePercent = mediaTotal > 0 ? Math.round((movieSeconds / mediaTotal) * 100) : 0;
  const seriesPercent = mediaTotal > 0 ? 100 - moviePercent : 0;

  const weekdayTotals = useMemo(() => {
    const totals = Array(7).fill(0) as number[];
    Object.entries(ledger.days).forEach(([key, day]) => {
      const date = new Date(`${key}T12:00:00`);
      const timestamp = date.getTime();
      if (timestamp >= rangeStartTime && timestamp <= rangeEndTime) {
        totals[date.getDay()] += day.secondsWatched;
      }
    });
    return totals;
  }, [ledger.days, rangeEndTime, rangeStartTime]);
  const maxWeekday = Math.max(1, ...weekdayTotals);
  const bestDayIndex = weekdayTotals.indexOf(Math.max(...weekdayTotals));
  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const periodSourceBytes = filteredDays.reduce(
    (totals, [, day]) => {
      Object.entries(day.sourceBytes).forEach(([source, bytes]) => {
        totals[source as keyof typeof totals] += bytes;
      });
      return totals;
    },
    { webtorrent: 0, qbittorrent: 0, addon: 0, local: 0 }
  );
  const hasPeriodSourceData = Object.values(periodSourceBytes).some((bytes) => bytes > 0);
  const visibleSourceBytes =
    range === 'lifetime' && !hasPeriodSourceData ? ledger.sourceBytes : periodSourceBytes;
  const periodAddonSourceBytes = filteredDays.reduce(
    (totals, [, day]) => {
      Object.entries(day.addonSourceBytes).forEach(([installationId, source]) => {
        const current = totals[installationId] || { name: source.name, bytes: 0 };
        current.name = source.name;
        current.bytes += source.bytes;
        totals[installationId] = current;
      });
      return totals;
    },
    {} as StatisticsLedger['addonSourceBytes']
  );
  const visibleAddonSourceBytes =
    range === 'lifetime' && !hasPeriodSourceData
      ? ledger.addonSourceBytes
      : periodAddonSourceBytes;
  const namedAddonBytes = Object.values(visibleAddonSourceBytes)
    .reduce((total, source) => total + source.bytes, 0);
  const sourceEntries = [
    { name: 'WebTorrent', bytes: visibleSourceBytes.webtorrent },
    { name: 'External playback service', bytes: visibleSourceBytes.qbittorrent },
    { name: 'Local', bytes: visibleSourceBytes.local },
    ...Object.entries(visibleAddonSourceBytes).map(([installationId, source]) => ({
      name: ledger.addonSourceBytes[installationId]?.name || source.name,
      bytes: source.bytes,
    })),
    {
      name: 'Add-on',
      bytes: Math.max(0, visibleSourceBytes.addon - namedAddonBytes),
    },
  ]
    .filter((source) => source.bytes > 0)
    .sort((left, right) => right.bytes - left.bytes);
  const topSource = sourceEntries[0]?.name || 'No data yet';
  const averageSession = filteredSessions > 0 ? filteredSeconds / filteredSessions : 0;
  const activityRangeLabel =
    range === 'month'
      ? now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : range === 'year'
        ? String(now.getFullYear())
        : 'Lifetime';

  const overview = [
    { label: 'Watch time', value: formatDuration(filteredSeconds), detail: `${filteredSessions} tracked sessions`, icon: FiClock },
    { label: 'Movies', value: movieDates.length.toLocaleString(), detail: 'Marked watched', icon: FiFilm },
    { label: 'Episodes', value: episodeDates.length.toLocaleString(), detail: `${showCount} shows`, icon: FiTv },
    { label: 'In progress', value: continueWatching.length.toLocaleString(), detail: 'Ready to resume', icon: FiPlayCircle },
    { label: 'Data streamed', value: formatBytes(filteredBytes), detail: topSource === 'No data yet' ? topSource : `Mostly ${topSource}`, icon: FiDownloadCloud },
    { label: 'Current streak', value: `${currentStreak} ${currentStreak === 1 ? 'day' : 'days'}`, detail: `Longest: ${longestStreak} days`, icon: FiZap },
  ];

  const activityValue = (day: ActivityDay) => {
    if (activityMetric === 'watch') return day.stats.secondsWatched;
    if (activityMetric === 'titles') return day.titles;
    return day.stats.bytesDownloaded;
  };

  const activityTitle = (day: ActivityDay) => {
    const date = day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    if (activityMetric === 'watch') return `${date}: ${formatDuration(day.stats.secondsWatched)} watched`;
    if (activityMetric === 'titles') return `${date}: ${day.titles} titles completed`;
    return `${date}: ${formatBytes(day.stats.bytesDownloaded)} streamed`;
  };

  return (
    <div className="statistics">
      <header className="statistics-header">
        <div>
          <h1>Statistics</h1>
          <p>Your viewing history, habits, and streaming activity.</p>
        </div>
        <div className="statistics-range" aria-label="Statistics date range">
          {(['month', 'year', 'lifetime'] as Range[]).map((option) => (
            <button
              key={option}
              className={range === option ? 'active' : ''}
              aria-pressed={range === option}
              onClick={() => setRange(option)}
            >
              {option[0].toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </header>

      <section className="statistics-overview" aria-label="Overview">
        {overview.map(({ label, value, detail, icon: Icon }) => (
          <article className="statistics-stat" key={label}>
            <div className="statistics-stat-label"><Icon />{label}</div>
            <strong>{value}</strong>
            <span>{detail}</span>
          </article>
        ))}
      </section>

      <section className="statistics-panel statistics-activity">
        <div className="statistics-section-heading">
          <div>
            <h2>Viewing activity</h2>
            <span>{activityRangeLabel}</span>
          </div>
          <div className="statistics-metric" aria-label="Activity metric">
            {(['watch', 'titles', 'data'] as ActivityMetric[]).map((metric) => (
            <button
                key={metric}
                className={activityMetric === metric ? 'active' : ''}
                aria-pressed={activityMetric === metric}
                onClick={() => setActivityMetric(metric)}
              >
                {metric === 'watch' ? 'Watch time' : metric[0].toUpperCase() + metric.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="statistics-heatmap-wrap">
          <div
            className="statistics-heatmap-grid"
            style={{ minWidth: `${Math.max(720, activityGrid.weeks * 14 + 36)}px` }}
          >
            <div
              className="statistics-months"
              style={{ gridTemplateColumns: `repeat(${activityGrid.weeks}, minmax(9px, 1fr))` }}
            >
              {activityGrid.monthMarkers.map((marker, index) => (
                <span key={`${marker.label}-${index}`} style={{ gridColumn: marker.column }}>{marker.label}</span>
              ))}
            </div>
            <div className="statistics-heatmap-body">
              <div className="statistics-weekdays"><span>Mon</span><span>Wed</span><span>Fri</span></div>
              <div
                className="statistics-heatmap"
                style={{ gridTemplateColumns: `repeat(${activityGrid.weeks}, minmax(9px, 1fr))` }}
              >
                {activityGrid.days.map((day) => {
                  const value = activityValue(day);
                  const level = value <= 0 ? 0 : Math.min(5, Math.ceil((value / maxActivity) * 5));
                  const label = activityTitle(day);
                  return (
                    <span
                      key={day.key}
                      className={`level-${level}`}
                      title={label}
                      aria-label={label}
                      role="img"
                      tabIndex={0}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="statistics-legend"><span>Less</span>{[0, 1, 2, 3, 4, 5].map((level) => <i key={level} className={`level-${level}`} />)}<span>More</span></div>
      </section>

      <div className="statistics-two-column">
        <section className="statistics-panel">
          <div className="statistics-section-heading">
            <h2>Watch time by {range === 'month' ? 'day' : range === 'year' ? 'month' : 'year'}</h2>
            <span>Hours</span>
          </div>
          <div
            className={`statistics-bars ${trendTotals.length > 18 ? 'dense' : ''}`}
            style={{ gridTemplateColumns: `repeat(${trendTotals.length}, 1fr)` }}
          >
            {trendTotals.map((item) => (
              <div className="statistics-bar-column" key={item.label}>
                <div className="statistics-bar-track">
                  <i style={{ height: `${Math.max(2, (item.seconds / maxTrendSeconds) * 100)}%` }} title={formatDuration(item.seconds)} />
                </div>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="statistics-panel">
          <div className="statistics-section-heading"><h2>Movies vs TV</h2><span>Tracked watch time</span></div>
          <div className="statistics-media-split">
            <div className="statistics-split-bar">
              {mediaTotal > 0 ? (
                <>
                  <i className="movies" style={{ width: `${moviePercent}%` }}>{moviePercent > 12 ? `${moviePercent}%` : ''}</i>
                  <i className="series" style={{ width: `${seriesPercent}%` }}>{seriesPercent > 12 ? `${seriesPercent}%` : ''}</i>
                </>
              ) : <span>No tracked watch time yet</span>}
            </div>
            <div className="statistics-split-values">
              <div><span><i className="movie-dot" />Movies</span><strong>{formatDuration(movieSeconds)}</strong></div>
              <div><span><i className="series-dot" />TV</span><strong>{formatDuration(seriesSeconds)}</strong></div>
            </div>
          </div>
          <div className="statistics-inline-summary">
            <span>Average session</span><strong>{formatDuration(averageSession)}</strong>
          </div>
        </section>
      </div>

      <div className="statistics-three-column">
        <section className="statistics-panel statistics-habits">
          <div className="statistics-section-heading"><h2>Viewing habits</h2><span>By weekday</span></div>
          <div className="statistics-weekday-bars">
            {weekdayTotals.map((seconds, index) => (
              <div key={weekdayLabels[index]}>
                <span>{formatDuration(seconds)}</span>
                <i style={{ height: `${Math.max(2, (seconds / maxWeekday) * 100)}%` }} />
                <b>{weekdayLabels[index]}</b>
              </div>
            ))}
          </div>
        </section>

        <section className="statistics-panel statistics-records">
          <div className="statistics-section-heading"><h2>Personal records</h2><FiTarget /></div>
          <dl>
            <div><dt>Longest streak</dt><dd>{longestStreak} days</dd></div>
            <div><dt>Most active weekday</dt><dd>{weekdayLabels[bestDayIndex]}</dd></div>
            <div><dt>Total sessions</dt><dd>{ledger.totalSessions.toLocaleString()}</dd></div>
            <div><dt>Titles in progress</dt><dd>{continueWatching.length.toLocaleString()}</dd></div>
          </dl>
        </section>

        <section className="statistics-panel statistics-records">
          <div className="statistics-section-heading"><h2>Streaming summary</h2><FiActivity /></div>
          <dl>
            <div><dt>Lifetime data</dt><dd>{formatBytes(ledger.totalBytesDownloaded)}</dd></div>
            <div><dt>Top source</dt><dd>{topSource}</dd></div>
            <div><dt>Lifetime watch time</dt><dd>{formatDuration(ledger.totalSecondsWatched)}</dd></div>
            <div><dt>Tracking since</dt><dd>{ledger.firstRecordedAt ? new Date(ledger.firstRecordedAt).toLocaleDateString() : 'Today'}</dd></div>
          </dl>
        </section>
      </div>

      {!ledger.firstRecordedAt ? (
        <aside className="statistics-note"><FiCalendar />Detailed watch-time and bandwidth tracking starts with your next playback. Existing watched titles already appear in the activity grid.</aside>
      ) : null}
    </div>
  );
};

export default Statistics;
