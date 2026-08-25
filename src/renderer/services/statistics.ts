type StatisticsMediaType = 'movie' | 'series';
type StatisticsSourceType = 'webtorrent' | 'qbittorrent' | 'addon' | 'local';

type SourceBytes = Record<StatisticsSourceType, number>;

export interface DailyStatistics {
  secondsWatched: number;
  movieSeconds: number;
  seriesSeconds: number;
  bytesDownloaded: number;
  sourceBytes: SourceBytes;
  sessions: number;
  moviesCompleted: number;
  episodesCompleted: number;
}

export interface StatisticsLedger {
  version: 1;
  firstRecordedAt: string | null;
  totalSecondsWatched: number;
  totalBytesDownloaded: number;
  totalSessions: number;
  sourceBytes: SourceBytes;
  days: Record<string, DailyStatistics>;
}

interface PlaybackSample {
  mediaKey: string;
  mediaType: StatisticsMediaType;
  playbackTime: number;
  recordedAt?: number;
}

interface PlaybackCursor {
  mediaKey: string;
  playbackTime: number;
  recordedAt: number;
}

const STORAGE_KEY = 'streamee-statistics-v1';
const CHANGE_EVENT = 'streamee:statistics-changed';
const MAX_CONTIGUOUS_SAMPLE_SECONDS = 30;
const SESSION_GAP_MS = 30 * 60 * 1000;
const STORAGE_FLUSH_MS = 15_000;
const UI_NOTIFY_MS = 10_000;

const createSourceBytes = (): SourceBytes => ({
  webtorrent: 0,
  qbittorrent: 0,
  addon: 0,
  local: 0,
});

const createEmptyDay = (): DailyStatistics => ({
  secondsWatched: 0,
  movieSeconds: 0,
  seriesSeconds: 0,
  bytesDownloaded: 0,
  sourceBytes: createSourceBytes(),
  sessions: 0,
  moviesCompleted: 0,
  episodesCompleted: 0,
});

const createEmptyLedger = (): StatisticsLedger => ({
  version: 1,
  firstRecordedAt: null,
  totalSecondsWatched: 0,
  totalBytesDownloaded: 0,
  totalSessions: 0,
  sourceBytes: createSourceBytes(),
  days: {},
});

let playbackCursor: PlaybackCursor | null = null;
let activeSessionLastAt: number | null = null;
let ledgerCache: StatisticsLedger | null = null;
let flushTimer: number | null = null;
let notifyTimer: number | null = null;
let ledgerDirty = false;

const getDayKey = (timestamp: number) => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const normalizeSourceBytes = (sourceBytes?: Partial<SourceBytes>): SourceBytes => ({
  webtorrent: Math.max(0, sourceBytes?.webtorrent || 0),
  qbittorrent: Math.max(0, sourceBytes?.qbittorrent || 0),
  addon: Math.max(0, sourceBytes?.addon || 0),
  local: Math.max(0, sourceBytes?.local || 0),
});

const normalizeDay = (day?: Partial<DailyStatistics>): DailyStatistics => ({
  secondsWatched: Math.max(0, day?.secondsWatched || 0),
  movieSeconds: Math.max(0, day?.movieSeconds || 0),
  seriesSeconds: Math.max(0, day?.seriesSeconds || 0),
  bytesDownloaded: Math.max(0, day?.bytesDownloaded || 0),
  sourceBytes: normalizeSourceBytes(day?.sourceBytes),
  sessions: Math.max(0, day?.sessions || 0),
  moviesCompleted: Math.max(0, day?.moviesCompleted || 0),
  episodesCompleted: Math.max(0, day?.episodesCompleted || 0),
});

const loadStatisticsLedger = (): StatisticsLedger => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyLedger();
    const stored = JSON.parse(raw) as Partial<StatisticsLedger>;
    return {
      ...createEmptyLedger(),
      ...stored,
      version: 1,
      totalSecondsWatched: Math.max(0, stored.totalSecondsWatched || 0),
      totalBytesDownloaded: Math.max(0, stored.totalBytesDownloaded || 0),
      totalSessions: Math.max(0, stored.totalSessions || 0),
      sourceBytes: normalizeSourceBytes(stored.sourceBytes),
      days: Object.fromEntries(
        Object.entries(stored.days || {}).map(([key, day]) => [key, normalizeDay(day)])
      ),
    };
  } catch (error) {
    console.warn('[Statistics] Failed to read ledger:', error);
    return createEmptyLedger();
  }
};

const getLedger = () => {
  if (!ledgerCache) ledgerCache = loadStatisticsLedger();
  return ledgerCache;
};

export const readStatisticsLedger = (): StatisticsLedger => {
  const ledger = getLedger();
  return {
    ...ledger,
    sourceBytes: { ...ledger.sourceBytes },
    days: Object.fromEntries(
      Object.entries(ledger.days).map(([key, day]) => [
        key,
        { ...day, sourceBytes: { ...day.sourceBytes } },
      ])
    ),
  };
};

export const flushStatistics = () => {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!ledgerDirty) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getLedger()));
    ledgerDirty = false;
  } catch (error) {
    console.warn('[Statistics] Failed to persist ledger:', error);
  }
};

const scheduleLedgerUpdate = () => {
  ledgerDirty = true;
  if (flushTimer === null) {
    flushTimer = window.setTimeout(flushStatistics, STORAGE_FLUSH_MS);
  }
  if (notifyTimer === null) {
    notifyTimer = window.setTimeout(() => {
      notifyTimer = null;
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    }, UI_NOTIFY_MS);
  }
};

const updateLedger = (updater: (ledger: StatisticsLedger) => void) => {
  const ledger = getLedger();
  updater(ledger);
  if (!ledger.firstRecordedAt) ledger.firstRecordedAt = new Date().toISOString();
  scheduleLedgerUpdate();
};

const updateDay = (
  ledger: StatisticsLedger,
  timestamp: number,
  updater: (day: DailyStatistics) => void
) => {
  const key = getDayKey(timestamp);
  const day = normalizeDay(ledger.days[key] || createEmptyDay());
  updater(day);
  ledger.days[key] = day;
};

export const recordPlaybackSample = ({
  mediaKey,
  mediaType,
  playbackTime,
  recordedAt = Date.now(),
}: PlaybackSample) => {
  if (!Number.isFinite(playbackTime) || playbackTime < 0) return;

  const startsSession =
    activeSessionLastAt === null || recordedAt - activeSessionLastAt > SESSION_GAP_MS;
  activeSessionLastAt = recordedAt;

  if (startsSession) {
    updateLedger((ledger) => {
      ledger.totalSessions += 1;
      updateDay(ledger, recordedAt, (day) => {
        day.sessions += 1;
      });
    });
  }

  if (!playbackCursor || playbackCursor.mediaKey !== mediaKey || startsSession) {
    playbackCursor = { mediaKey, playbackTime, recordedAt };
    return;
  }

  const playbackDelta = playbackTime - playbackCursor.playbackTime;
  const wallDelta = Math.max(0, (recordedAt - playbackCursor.recordedAt) / 1000);
  playbackCursor.playbackTime = playbackTime;
  playbackCursor.recordedAt = recordedAt;

  if (
    playbackDelta <= 0 ||
    playbackDelta > MAX_CONTIGUOUS_SAMPLE_SECONDS ||
    wallDelta > MAX_CONTIGUOUS_SAMPLE_SECONDS * 2
  ) {
    return;
  }

  const seconds = Math.min(playbackDelta, wallDelta + 2);
  updateLedger((ledger) => {
    ledger.totalSecondsWatched += seconds;
    updateDay(ledger, recordedAt, (day) => {
      day.secondsWatched += seconds;
      if (mediaType === 'movie') day.movieSeconds += seconds;
      else day.seriesSeconds += seconds;
    });
  });
};

export const endPlaybackSession = () => {
  playbackCursor = null;
  activeSessionLastAt = null;
  flushStatistics();
};

export const recordMediaCompleted = (
  mediaType: StatisticsMediaType,
  completedAt = Date.now()
) => {
  updateLedger((ledger) => {
    updateDay(ledger, completedAt, (day) => {
      if (mediaType === 'movie') day.moviesCompleted += 1;
      else day.episodesCompleted += 1;
    });
  });
};

export const recordTransferredBytes = (
  bytes: number,
  sourceType: StatisticsSourceType,
  recordedAt = Date.now()
) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  updateLedger((ledger) => {
    ledger.totalBytesDownloaded += bytes;
    ledger.sourceBytes[sourceType] += bytes;
    updateDay(ledger, recordedAt, (day) => {
      day.bytesDownloaded += bytes;
      day.sourceBytes[sourceType] += bytes;
    });
  });
};

export const subscribeToStatistics = (listener: () => void) => {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
};
