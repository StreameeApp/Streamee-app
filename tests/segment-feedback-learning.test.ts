import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSegmentFeedbackPatternKey,
  buildSegmentFeedbackKey,
  evaluateSegmentFeedbackShadowMatch,
  isSegmentFeedbackPatternSuspended,
  type SegmentFeedbackContext,
  type StoredSegmentFeedback,
} from '../src/renderer/services/segment-feedback.ts';
import type { SegmentFeedbackCandidate } from '../src/renderer/services/tauri.ts';

const introCandidate = (start: number): SegmentFeedbackCandidate => ({
  kind: 'intro',
  start_sec: start,
  end_sec: start + 24,
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

test('shadow promotion requires matching Yes confirmations from two distinct episodes', () => {
  const candidate = introCandidate(41);
  const oneEpisode = evaluateSegmentFeedbackShadowMatch(
    [record(1, introCandidate(40)), record(1, introCandidate(41))],
    context(3),
    candidate,
  );
  assert.equal(oneEpisode.status, 'insufficient');
  assert.equal(oneEpisode.episodeCount, 1);

  const twoEpisodes = evaluateSegmentFeedbackShadowMatch(
    [record(1, introCandidate(40)), record(2, introCandidate(42))],
    context(3),
    candidate,
  );
  assert.equal(twoEpisodes.status, 'shadow-promoted');
  assert.equal(twoEpisodes.episodeCount, 2);
  assert.equal(twoEpisodes.learnedPositionSeconds, 41);
});

test('confirmations must agree with each other, not only straddle the current candidate', () => {
  const result = evaluateSegmentFeedbackShadowMatch(
    [record(1, introCandidate(38)), record(2, introCandidate(44))],
    context(3),
    introCandidate(41),
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
  assert.equal(result.learnedPositionSeconds, 44.5);
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
