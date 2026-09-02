import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasWatchedIntroDbSegmentOnce,
  introSegmentSourceLabel,
  normalizeIntroDbSkipMode,
  rememberWatchedIntroDbSegmentOnce,
  shouldAutoSkipIntroDbSegment,
  validateIntroDbSegment,
} from '../src/renderer/services/introdb.ts';

const segment = {
  start_ms: 10_000,
  end_ms: 70_000,
  start_sec: 10,
  end_sec: 70,
  confidence: 0.95,
  submission_count: 2,
  source: 'introdb' as const,
};

test('normalizes persisted skip modes safely', () => {
  assert.equal(normalizeIntroDbSkipMode('always-skip'), 'always-skip');
  assert.equal(normalizeIntroDbSkipMode('watch-once'), 'watch-once');
  assert.equal(normalizeIntroDbSkipMode('unexpected'), 'always-watch');
});

test('watch-once begins watching and skips only after it is remembered', () => {
  const imdbId = 'tt98765432';
  assert.equal(hasWatchedIntroDbSegmentOnce(imdbId, 'intro'), false);
  assert.equal(shouldAutoSkipIntroDbSegment('watch-once', imdbId, 'intro'), false);

  rememberWatchedIntroDbSegmentOnce(imdbId, 'intro');

  assert.equal(hasWatchedIntroDbSegmentOnce(imdbId, 'intro'), true);
  assert.equal(shouldAutoSkipIntroDbSegment('watch-once', imdbId, 'intro'), true);
  assert.equal(shouldAutoSkipIntroDbSegment('always-watch', imdbId, 'intro'), false);
  assert.equal(shouldAutoSkipIntroDbSegment('always-skip', imdbId, 'intro'), true);
});

test('accepts conservative early segment timing', () => {
  assert.deepEqual(validateIntroDbSegment('intro', segment, 2_400), {
    ...segment,
    type: 'intro',
  });
});

test('trusts remote confidence metadata but rejects implausibly placed actions', () => {
  const singleSubmission = {
    ...segment,
    confidence: 0.1,
    submission_count: 1,
  };
  assert.deepEqual(validateIntroDbSegment('intro', singleSubmission, 2_400), {
    ...singleSubmission,
    type: 'intro',
  });

  assert.equal(validateIntroDbSegment('outro', {
    ...segment,
    start_ms: 100_000,
    end_ms: 160_000,
    start_sec: 100,
    end_sec: 160,
  }, 2_400), null);
});

test('accepts a verified outro near the end of playback', () => {
  const outro = {
    ...segment,
    start_ms: 2_100_000,
    end_ms: 2_350_000,
    start_sec: 2_100,
    end_sec: 2_350,
  };

  assert.deepEqual(validateIntroDbSegment('outro', outro, 2_400), {
    ...outro,
    type: 'outro',
  });
});

test('accepts four-second remote outros from both providers', () => {
  const duration = 1_266.766;
  const shortTheIntroDbOutro = {
    ...segment,
    start_ms: 1_262_000,
    end_ms: 1_266_766,
    start_sec: 1_262,
    end_sec: duration,
    confidence: null,
    submission_count: null,
    source: 'theintrodb' as const,
  };

  assert.equal(
    validateIntroDbSegment('outro', shortTheIntroDbOutro, duration)?.source,
    'theintrodb',
  );
  assert.equal(validateIntroDbSegment('outro', {
    ...shortTheIntroDbOutro,
    start_ms: 1_263_000,
    start_sec: 1_263,
  }, duration), null);
  assert.equal(validateIntroDbSegment('outro', {
    ...shortTheIntroDbOutro,
    confidence: 0.95,
    submission_count: 2,
    source: 'introdb',
  }, duration)?.source, 'introdb');
});

test('accepts duration-matched and conservative local provider segments', () => {
  assert.equal(
    validateIntroDbSegment('intro', {
      ...segment,
      confidence: null,
      submission_count: null,
      source: 'theintrodb',
    }, 2_400)?.source,
    'theintrodb',
  );
  assert.equal(
    validateIntroDbSegment('intro', {
      ...segment,
      confidence: null,
      submission_count: null,
      source: 'intro-skipper',
    }, 2_400)?.source,
    'intro-skipper',
  );
  assert.equal(
    validateIntroDbSegment('intro', {
      ...segment,
      confidence: null,
      submission_count: null,
      source: 'chapter',
    }, 2_400)?.source,
    'chapter',
  );
  assert.equal(introSegmentSourceLabel({ source: 'chapter' }), 'Chapter');
  assert.equal(introSegmentSourceLabel({ source: 'intro-skipper' }), 'Intro Skipper');
});

test('bounds local fingerprint matches to the overlapping Part 2 search envelope', () => {
  const partTwoOpening = {
    ...segment,
    start_ms: 850_000,
    end_ms: 910_000,
    start_sec: 850,
    end_sec: 910,
    confidence: null,
    submission_count: null,
  };

  assert.equal(validateIntroDbSegment('intro', {
    ...partTwoOpening,
    source: 'intro-skipper',
  }, 2_400)?.source, 'intro-skipper');
  assert.equal(validateIntroDbSegment('intro', {
    ...partTwoOpening,
    start_ms: 901_000,
    end_ms: 961_000,
    start_sec: 901,
    end_sec: 961,
    source: 'intro-skipper',
  }, 2_400), null);
  assert.equal(validateIntroDbSegment('intro', {
    ...partTwoOpening,
    source: 'chapter',
  }, 2_400)?.source, 'chapter');
});

test('accepts only bounded local outro matches that reach the real end', () => {
  const localOutro = {
    ...segment,
    start_ms: 1_900_000,
    end_ms: 2_400_000,
    start_sec: 1_900,
    end_sec: 2_400,
    confidence: null,
    submission_count: null,
    source: 'intro-skipper-outro' as const,
  };

  assert.equal(validateIntroDbSegment('outro', localOutro, 2_400)?.source, 'intro-skipper-outro');
  assert.equal(validateIntroDbSegment('outro', {
    ...localOutro,
    start_ms: 1_000_000,
    start_sec: 1_000,
  }, 2_400), null);
  assert.equal(validateIntroDbSegment('outro', {
    ...localOutro,
    end_ms: 2_350_000,
    end_sec: 2_350,
  }, 2_400), null);
  assert.equal(validateIntroDbSegment('outro', {
    ...localOutro,
    start_ms: 2_390_000,
    start_sec: 2_390,
  }, 2_400)?.source, 'intro-skipper-outro');
  assert.equal(validateIntroDbSegment('outro', {
    ...localOutro,
    start_ms: 2_391_000,
    start_sec: 2_391,
  }, 2_400), null);
  assert.equal(introSegmentSourceLabel(localOutro), 'Intro Skipper');
});
