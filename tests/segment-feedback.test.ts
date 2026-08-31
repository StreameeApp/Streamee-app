import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detector = readFileSync('src-tauri/src/intro_skipper.rs', 'utf8');
const mpvIpc = readFileSync('src-tauri/src/mpv_ipc.rs', 'utf8');
const player = readFileSync('src/renderer/features/player/Player.tsx', 'utf8');
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
  assert.match(player, /SEGMENT_FEEDBACK_STORAGE_LIMIT = 400/);
  assert.match(player, /candidate\.kind === 'intro'[\s\S]*seekTime\(candidate\.end_sec/);
  assert.match(player, /const advanced = await handleSmartNextRequest\(active\.filename\)/);
});
