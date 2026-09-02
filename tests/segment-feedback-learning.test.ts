import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSegmentFeedbackPatternKey,
  buildSegmentFeedbackKey,
  evaluateSegmentFeedbackShadowMatch,
  isSegmentFeedbackPatternSuspended,
  mergeIntroDetectionCandidate,
  type SegmentFeedbackContext,
  type StoredSegmentFeedback,
} from '../src/renderer/services/segment-feedback.ts';
import type { IntroSkipperDetectionResult, SegmentFeedbackCandidate } from '../src/renderer/services/tauri.ts';

const introCandidate = (start: number, duration = 24): SegmentFeedbackCandidate => ({
  kind: 'intro',
  start_sec: start,
  end_sec: start + duration,
  source: 'intro-skipper',
  reason: 'short-fuzzy-fingerprint-match',
  score: 0.82,
});

const outroCandidate = (duration: number, lead: number): SegmentFeedbackCandidate => ({
  kind: 'outro',
  start_sec: duration - lead,
  end_sec: duration,
  source: 'chapter',
  reason: 'unlabeled-final-chapter',
  score: null,
});

const context = (
  episode: number,
  duration = 1_800,
  season = 1,
): SegmentFeedbackContext => ({
  seriesKey: 'tt-shadow-test',
  season,
  episode,
  duration,
});

const record = (
  episode: number,
  candidate: SegmentFeedbackCandidate,
  response: StoredSegmentFeedback['response'] = 'yes',
  duration = 1_800,
): StoredSegmentFeedback => {
  const feedbackContext = context(episode, duration);
  return {
    key: buildSegmentFeedbackKey(feedbackContext, candidate),
    response,
    candidate,
    context: feedbackContext,
    recordedAt: '2026-08-31T00:00:00.000Z',
  };
};

const detection = (
  status: IntroSkipperDetectionResult['status'],
  candidate: SegmentFeedbackCandidate | null,
): IntroSkipperDetectionResult => ({
  segment: null,
  candidate,
  status,
  reference_episode: null,
  reference_end_sec: null,
  cached_episode_count: 3,
  buffered_seconds: 420,
  required_buffer_seconds: 420,
});

test('Part 1 and Part 2 near misses retain only the highest-scoring candidate', () => {
  const partOneCandidate = { ...introCandidate(270), score: 0.91 };
  const weakerPartTwoCandidate = { ...introCandidate(700, 30), score: 0.84 };
  const partOne = mergeIntroDetectionCandidate(
    null,
    detection('near-miss', partOneCandidate),
  );
  const partTwo = mergeIntroDetectionCandidate(
    partOne.bestCandidate,
    detection('near-miss', weakerPartTwoCandidate),
  );
  assert.deepEqual(partTwo.bestCandidate, partOneCandidate);
  assert.deepEqual(partTwo.detection.candidate, partOneCandidate);

  const strongerPartTwoCandidate = { ...introCandidate(710), score: 0.96 };
  const strongerPartTwo = mergeIntroDetectionCandidate(
    partOne.bestCandidate,
    detection('near-miss', strongerPartTwoCandidate),
  );
  assert.deepEqual(strongerPartTwo.bestCandidate, strongerPartTwoCandidate);
  assert.deepEqual(strongerPartTwo.detection.candidate, strongerPartTwoCandidate);
});

test('Part 1 near miss survives Part 2 waiting and no-match without replacing a detection', () => {
  const partOneCandidate = { ...introCandidate(270), score: 0.91 };
  const waiting = mergeIntroDetectionCandidate(
    partOneCandidate,
    detection('waiting-for-local-cache', null),
  );
  assert.deepEqual(waiting.bestCandidate, partOneCandidate);
  assert.equal(waiting.detection.status, 'waiting-for-local-cache');
  assert.equal(waiting.detection.candidate, null);

  const noMatch = mergeIntroDetectionCandidate(
    waiting.bestCandidate,
    detection('no-match', null),
  );
  assert.equal(noMatch.detection.status, 'near-miss');
  assert.deepEqual(noMatch.detection.candidate, partOneCandidate);

  const detected = mergeIntroDetectionCandidate(partOneCandidate, {
    ...detection('detected', null),
    segment: {
      start_ms: 270_000,
      end_ms: 294_000,
      start_sec: 270,
      end_sec: 294,
      confidence: null,
      submission_count: null,
      source: 'intro-skipper',
    },
  });
  assert.equal(detected.detection.status, 'detected');
  assert.equal(detected.detection.candidate, null);
  assert.ok(detected.detection.segment);
});

test('shadow promotion requires matching Yes confirmations from two distinct episodes', () => {
  const candidate = introCandidate(400);
  const oneEpisode = evaluateSegmentFeedbackShadowMatch(
    [record(1, introCandidate(40)), record(1, introCandidate(240))],
    context(3),
    candidate,
  );
  assert.equal(oneEpisode.status, 'insufficient');
  assert.equal(oneEpisode.episodeCount, 1);

  const twoEpisodes = evaluateSegmentFeedbackShadowMatch(
    [record(1, introCandidate(40)), record(2, introCandidate(240))],
    context(3),
    candidate,
  );
  assert.equal(twoEpisodes.status, 'shadow-promoted');
  assert.equal(twoEpisodes.episodeCount, 2);
  assert.equal(twoEpisodes.metric, 'intro-duration');
  assert.equal(twoEpisodes.learnedValueSeconds, 24);
  assert.equal(twoEpisodes.candidateValueSeconds, 24);
});

test('intro confirmations must agree on duration even when each is close to the current candidate', () => {
  const result = evaluateSegmentFeedbackShadowMatch(
    [record(1, introCandidate(38, 20)), record(2, introCandidate(244, 28))],
    context(3),
    introCandidate(400, 24),
  );
  assert.equal(result.status, 'insufficient');
  assert.equal(result.episodeCount, 1);
});

test('No and Not sure answers never train a shadow pattern', () => {
  const result = evaluateSegmentFeedbackShadowMatch(
    [
      record(1, introCandidate(40), 'no'),
      record(2, introCandidate(41), 'not-sure'),
    ],
    context(3),
    introCandidate(42),
  );
  assert.equal(result.status, 'insufficient');
  assert.equal(result.episodeCount, 0);
});

test('intro learning is season and detector-source scoped', () => {
  const otherSource: SegmentFeedbackCandidate = {
    ...introCandidate(41),
    source: 'chapter',
  };
  const result = evaluateSegmentFeedbackShadowMatch(
    [
      record(1, introCandidate(40)),
      { ...record(2, introCandidate(41)), context: context(2, 1_800, 2) },
      record(3, otherSource),
    ],
    context(4),
    introCandidate(41),
  );
  assert.equal(result.status, 'insufficient');
  assert.equal(result.episodeCount, 1);
});

test('outros compare their lead time from EOF across different episode durations', () => {
  const result = evaluateSegmentFeedbackShadowMatch(
    [
      record(1, outroCandidate(1_800, 43), 'yes', 1_800),
      record(2, outroCandidate(2_400, 46), 'yes', 2_400),
    ],
    context(3, 2_100),
    outroCandidate(2_100, 45),
  );
  assert.equal(result.status, 'shadow-promoted');
  assert.equal(result.episodeCount, 2);
  assert.equal(result.metric, 'outro-lead');
  assert.equal(result.learnedValueSeconds, 44.5);
  assert.equal(result.toleranceSeconds, 4);
});

test('legacy Phase 1 records can contribute without being rewritten', () => {
  const candidate = outroCandidate(1_800, 45);
  const legacy = (episode: number, lead: number): StoredSegmentFeedback => {
    const storedCandidate = outroCandidate(1_800, lead);
    return {
      key: `tt-shadow-test:1:${episode}:outro:chapter:unlabeled-final-chapter:${storedCandidate.start_sec}:${storedCandidate.end_sec}`,
      response: 'yes',
      candidate: storedCandidate,
      recordedAt: '2026-08-30T00:00:00.000Z',
    };
  };
  const result = evaluateSegmentFeedbackShadowMatch(
    [legacy(1, 44), legacy(2, 46)],
    context(3),
    candidate,
  );
  assert.equal(result.status, 'shadow-promoted');
  assert.deepEqual(result.episodeKeys, ['tt-shadow-test:1:1', 'tt-shadow-test:1:2']);
});

test('automatic-action suspension is scoped to season, segment kind, and detector source', () => {
  const candidate = introCandidate(41);
  const feedbackContext = context(3);
  const state = {
    key: buildSegmentFeedbackPatternKey(feedbackContext, candidate),
    status: 'suspended' as const,
    reason: 'automatic-cancelled' as const,
    recordedAt: '2026-08-31T00:00:00.000Z',
  };

  assert.equal(
    isSegmentFeedbackPatternSuspended([state], feedbackContext, candidate),
    true,
  );
  assert.equal(
    isSegmentFeedbackPatternSuspended([state], context(3, 1_800, 2), candidate),
    false,
  );
  assert.equal(
    isSegmentFeedbackPatternSuspended(
      [state],
      feedbackContext,
      { ...candidate, source: 'chapter' },
    ),
    false,
  );
});
