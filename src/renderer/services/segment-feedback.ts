import type { SegmentFeedbackCandidate } from './tauri';

export const SEGMENT_FEEDBACK_STORAGE_KEY = 'streamee:segment-feedback:v1';
export const SEGMENT_FEEDBACK_PATTERN_STORAGE_KEY = 'streamee:segment-feedback-patterns:v1';
export const SEGMENT_FEEDBACK_STORAGE_LIMIT = 400;
export const SEGMENT_FEEDBACK_MIN_EPISODES = 2;
const SEGMENT_FEEDBACK_PATTERN_STORAGE_LIMIT = 100;

const INTRO_POSITION_TOLERANCE_SECONDS = 3;
const OUTRO_LEAD_TOLERANCE_SECONDS = 4;

export type SegmentFeedbackResponse = 'yes' | 'no' | 'not-sure';
export type SegmentFeedbackPatternSuspensionReason = 'automatic-cancelled' | 'intro-undone';

export type SegmentFeedbackContext = {
  seriesKey: string;
  season: number;
  episode: number;
  duration: number;
};

export type StoredSegmentFeedback = {
  key: string;
  response: SegmentFeedbackResponse;
  candidate: SegmentFeedbackCandidate;
  recordedAt: string;
  context?: SegmentFeedbackContext;
};

export type SegmentFeedbackShadowMatch = {
  status: 'insufficient' | 'shadow-promoted';
  kind: SegmentFeedbackCandidate['kind'];
  source: SegmentFeedbackCandidate['source'];
  episodeCount: number;
  episodeKeys: string[];
  positionSeconds: number;
  learnedPositionSeconds: number | null;
  toleranceSeconds: number;
};

export type SegmentFeedbackPatternState = {
  key: string;
  status: 'suspended';
  reason: SegmentFeedbackPatternSuspensionReason;
  recordedAt: string;
};

const roundedHalfSecond = (value: number): number => Math.round(value * 2) / 2;

const episodeKey = (context: SegmentFeedbackContext): string => (
  `${context.seriesKey.toLowerCase()}:${context.season}:${context.episode}`
);

export const buildSegmentFeedbackPatternKey = (
  context: SegmentFeedbackContext,
  candidate: SegmentFeedbackCandidate,
): string => [
  context.seriesKey.toLowerCase(),
  context.season,
  candidate.kind,
  candidate.source,
].join(':');

const candidatePosition = (
  context: SegmentFeedbackContext,
  candidate: SegmentFeedbackCandidate,
): number => (
  candidate.kind === 'outro'
    ? Math.max(0, context.duration - candidate.start_sec)
    : candidate.start_sec
);

const candidateTolerance = (candidate: SegmentFeedbackCandidate): number => (
  candidate.kind === 'outro'
    ? OUTRO_LEAD_TOLERANCE_SECONDS
    : INTRO_POSITION_TOLERANCE_SECONDS
);

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const parseLegacyContext = (entry: StoredSegmentFeedback): SegmentFeedbackContext | null => {
  const parts = entry.key.split(':');
  if (parts.length < 8) return null;
  const season = Number(parts.at(-7));
  const episode = Number(parts.at(-6));
  const seriesKey = parts.slice(0, -7).join(':');
  const duration = entry.candidate.end_sec;
  if (
    !seriesKey
    || !Number.isInteger(season)
    || season < 0
    || !Number.isInteger(episode)
    || episode <= 0
    || !Number.isFinite(duration)
    || duration <= 0
  ) {
    return null;
  }
  return { seriesKey, season, episode, duration };
};

const validContext = (context: SegmentFeedbackContext | undefined): context is SegmentFeedbackContext => (
  !!context
  && typeof context.seriesKey === 'string'
  && context.seriesKey.length > 0
  && Number.isInteger(context.season)
  && context.season >= 0
  && Number.isInteger(context.episode)
  && context.episode > 0
  && Number.isFinite(context.duration)
  && context.duration > 0
);

export const buildSegmentFeedbackKey = (
  context: SegmentFeedbackContext,
  candidate: SegmentFeedbackCandidate,
): string => [
  episodeKey(context),
  candidate.kind,
  candidate.source,
  candidate.reason,
  roundedHalfSecond(candidate.start_sec),
  roundedHalfSecond(candidate.end_sec),
].join(':');

export const readStoredSegmentFeedback = (): StoredSegmentFeedback[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEGMENT_FEEDBACK_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const hasStoredSegmentFeedback = (key: string): boolean => (
  readStoredSegmentFeedback().some((entry) => entry?.key === key)
);

export const readSegmentFeedbackPatternStates = (): SegmentFeedbackPatternState[] => {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(SEGMENT_FEEDBACK_PATTERN_STORAGE_KEY) || '[]',
    );
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const isSegmentFeedbackPatternSuspended = (
  states: SegmentFeedbackPatternState[],
  context: SegmentFeedbackContext,
  candidate: SegmentFeedbackCandidate,
): boolean => states.some((state) => (
  state?.key === buildSegmentFeedbackPatternKey(context, candidate)
  && state.status === 'suspended'
));

export const suspendSegmentFeedbackPattern = (
  context: SegmentFeedbackContext,
  candidate: SegmentFeedbackCandidate,
  reason: SegmentFeedbackPatternSuspensionReason,
): SegmentFeedbackPatternState => {
  const key = buildSegmentFeedbackPatternKey(context, candidate);
  const state: SegmentFeedbackPatternState = {
    key,
    status: 'suspended',
    reason,
    recordedAt: new Date().toISOString(),
  };
  const retained = readSegmentFeedbackPatternStates().filter((entry) => entry?.key !== key);
  retained.push(state);
  try {
    window.localStorage.setItem(
      SEGMENT_FEEDBACK_PATTERN_STORAGE_KEY,
      JSON.stringify(retained.slice(-SEGMENT_FEEDBACK_PATTERN_STORAGE_LIMIT)),
    );
  } catch {
    // Pattern automation is optional; storage failures leave the current playback untouched.
  }
  return state;
};

export const resumeSegmentFeedbackPattern = (
  context: SegmentFeedbackContext,
  candidate: SegmentFeedbackCandidate,
): boolean => {
  const key = buildSegmentFeedbackPatternKey(context, candidate);
  const current = readSegmentFeedbackPatternStates();
  const retained = current.filter((entry) => entry?.key !== key);
  if (retained.length === current.length) return false;
  try {
    window.localStorage.setItem(
      SEGMENT_FEEDBACK_PATTERN_STORAGE_KEY,
      JSON.stringify(retained),
    );
  } catch {
    return false;
  }
  return true;
};

export const storeSegmentFeedback = (
  key: string,
  response: SegmentFeedbackResponse,
  candidate: SegmentFeedbackCandidate,
  context: SegmentFeedbackContext,
): StoredSegmentFeedback[] => {
  const retained = readStoredSegmentFeedback().filter((entry) => entry?.key !== key);
  retained.push({ key, response, candidate, context, recordedAt: new Date().toISOString() });
  const next = retained.slice(-SEGMENT_FEEDBACK_STORAGE_LIMIT);
  try {
    window.localStorage.setItem(SEGMENT_FEEDBACK_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Feedback is optional; private/limited-storage sessions must not affect playback.
  }
  return next;
};

export const evaluateSegmentFeedbackShadowMatch = (
  records: StoredSegmentFeedback[],
  context: SegmentFeedbackContext,
  candidate: SegmentFeedbackCandidate,
): SegmentFeedbackShadowMatch => {
  const positionSeconds = candidatePosition(context, candidate);
  const toleranceSeconds = candidateTolerance(candidate);
  const matchingByEpisode = new Map<string, number>();

  for (const record of records) {
    if (
      record?.response !== 'yes'
      || record.candidate?.kind !== candidate.kind
      || record.candidate?.source !== candidate.source
    ) {
      continue;
    }
    const recordContext = validContext(record.context)
      ? record.context
      : parseLegacyContext(record);
    if (
      !recordContext
      || recordContext.seriesKey.toLowerCase() !== context.seriesKey.toLowerCase()
      || recordContext.season !== context.season
    ) {
      continue;
    }
    const recordPosition = candidatePosition(recordContext, record.candidate);
    if (Math.abs(recordPosition - positionSeconds) <= toleranceSeconds) {
      matchingByEpisode.set(episodeKey(recordContext), recordPosition);
    }
  }

  const ordered = [...matchingByEpisode.entries()]
    .sort((left, right) => left[1] - right[1]);
  let bestCluster: Array<[string, number]> = [];
  let windowStart = 0;
  for (let windowEnd = 0; windowEnd < ordered.length; windowEnd += 1) {
    while (ordered[windowEnd][1] - ordered[windowStart][1] > toleranceSeconds) {
      windowStart += 1;
    }
    const cluster = ordered.slice(windowStart, windowEnd + 1);
    const clusterMedian = median(cluster.map(([, position]) => position));
    const bestMedian = bestCluster.length > 0
      ? median(bestCluster.map(([, position]) => position))
      : Number.POSITIVE_INFINITY;
    if (
      cluster.length > bestCluster.length
      || (
        cluster.length === bestCluster.length
        && Math.abs(clusterMedian - positionSeconds) < Math.abs(bestMedian - positionSeconds)
      )
    ) {
      bestCluster = cluster;
    }
  }

  const episodeKeys = bestCluster.map(([key]) => key).sort();
  const positions = bestCluster.map(([, position]) => position);
  return {
    status: episodeKeys.length >= SEGMENT_FEEDBACK_MIN_EPISODES
      ? 'shadow-promoted'
      : 'insufficient',
    kind: candidate.kind,
    source: candidate.source,
    episodeCount: episodeKeys.length,
    episodeKeys,
    positionSeconds,
    learnedPositionSeconds: positions.length > 0 ? median(positions) : null,
    toleranceSeconds,
  };
};
