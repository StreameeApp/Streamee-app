import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detector = readFileSync('src-tauri/src/intro_skipper.rs', 'utf8');
const mpvIpc = readFileSync('src-tauri/src/mpv_ipc.rs', 'utf8');
const player = readFileSync('src/renderer/features/player/Player.tsx', 'utf8');
const feedback = readFileSync('src/renderer/services/segment-feedback.ts', 'utf8');
const tauri = readFileSync('src/renderer/services/tauri.ts', 'utf8');
const osc = readFileSync('mpv/scripts/PlexOSC.lua', 'utf8');

test('soft segment rejections remain separate from accepted segments', () => {
  assert.match(detector, /pub struct SegmentFeedbackCandidate/);
  assert.match(detector, /short-exact-fingerprint-match/);
  assert.match(detector, /short-fuzzy-fingerprint-match/);
  assert.match(detector, /short-outro-fingerprint-match/);
  assert.match(detector, /visual-credit-near-match/);
  assert.match(detector, /unlabeled-final-chapter/);
  assert.match(tauri, /candidate: SegmentFeedbackCandidate \| null/);
});

test('segment feedback prompt is interactive and uses a durable MPV response property', () => {
  assert.match(osc, /Is this the intro\?/);
  assert.match(osc, /Does the outro start here\?/);
  assert.match(osc, /respond_to_segment_feedback\('yes'\)/);
  assert.match(osc, /respond_to_segment_feedback\('no'\)/);
  assert.match(osc, /respond_to_segment_feedback\('not-sure'\)/);
  assert.match(osc, /streamee-segment-feedback-response-request/);
  assert.match(mpvIpc, /player:\/\/segment-feedback/);
  assert.match(tauri, /onSegmentFeedback/);
});

test('feedback prompting is bounded and does not treat timeouts as negative feedback', () => {
  assert.match(player, /segmentFeedbackPromptedKeys\.has\(slotKey\)/);
  assert.match(player, /segmentFeedbackSeekSuppressedUntil = Date\.now\(\) \+ 10_000/);
  assert.match(player, /if \(payload\.response === 'dismissed'\) return;/);
  assert.match(feedback, /SEGMENT_FEEDBACK_STORAGE_LIMIT = 400/);
  assert.match(player, /candidate\.kind === 'intro'[\s\S]*seekTime\(candidate\.end_sec/);
  assert.match(player, /const advanced = await handleSmartNextRequest\(active\.filename\)/);
});

test('shadow learning stays non-acting and emits correlation-friendly diagnostics', () => {
  assert.match(player, /segment_feedback\.prompt_shown/);
  assert.match(player, /segment_feedback\.response_received/);
  assert.match(player, /segment_feedback\.shadow_promoted/);
  assert.match(player, /segment_feedback\.shadow_would_act/);
  assert.match(player, /action: 'none-shadow-only'/);
  assert.match(player, /request_id: payload\.request_id/);
  assert.match(player, /candidate_id: active\.key/);
  assert.doesNotMatch(player, /shadow_would_act[\s\S]{0,1200}(seekTime|handleSmartNextRequest)/);
});

test('chapter fallback decision is logged only when a real scan starts', () => {
  assert.equal(
    player.match(/Remote data incomplete; local chapter scan started/g)?.length,
    1,
  );
  assert.match(
    player,
    /if \(chapterLookupKey !== key \|\| !chapterLookupPromise\)[\s\S]{0,400}Remote data incomplete; local chapter scan started/,
  );
});
