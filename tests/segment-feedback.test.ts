import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const detector = readFileSync('src-tauri/src/intro_skipper.rs', 'utf8');
const mpvIpc = readFileSync('src-tauri/src/mpv_ipc.rs', 'utf8');
const player = readFileSync('src/renderer/features/player/Player.tsx', 'utf8');
const feedback = readFileSync('src/renderer/services/segment-feedback.ts', 'utf8');
const tauri = readFileSync('src/renderer/services/tauri.ts', 'utf8');
const osc = readFileSync('mpv/scripts/PlexOSC.lua', 'utf8');
const settings = readFileSync('src/renderer/features/settings/Settings.tsx', 'utf8');

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
  assert.match(osc, /respond_to_segment_feedback\('yes', 'user-response'\)/);
  assert.match(osc, /respond_to_segment_feedback\('no', 'user-response'\)/);
  assert.match(osc, /respond_to_segment_feedback\('not-sure', 'user-response'\)/);
  assert.match(osc, /automatic and 'automatic' or 'dismissed'/);
  assert.match(osc, /\[ Keep watching \]/);
  assert.match(osc, /streamee-segment-feedback-response-request/);
  assert.match(osc, /streamee-segment-feedback-rendered-request/);
  assert.match(osc, /streamee-segment-feedback-hidden-reason/);
  assert.match(mpvIpc, /"dismissed" \| "automatic"/);
  assert.match(mpvIpc, /player:\/\/segment-feedback/);
  assert.match(mpvIpc, /player:\/\/segment-feedback-rendered/);
  assert.match(tauri, /onSegmentFeedback/);
  assert.match(tauri, /onSegmentFeedbackRendered/);
});

test('active feedback prompts remain visible until their own terminal response', () => {
  assert.match(
    osc,
    /function mouse_leave\(\)[\s\S]{0,180}if not state\.segment_feedback_prompt and get_hidetimeout\(\) >= 0/,
  );
  assert.match(
    osc,
    /-- autohide[\s\S]{0,180}if not state\.segment_feedback_prompt and[\s\S]{0,100}get_hidetimeout\(\) >= 0/,
  );
  assert.match(osc, /automatic and 'countdown-completed' or 'timeout'/);
  assert.match(osc, /respond_to_segment_feedback\('dismissed', 'replaced'\)/);
});

test('T opens a manual keyboard-test prompt without replacing a real prompt', () => {
  assert.match(
    osc,
    /local function show_segment_feedback_test_prompt\(\)[\s\S]{0,120}if state\.segment_feedback_prompt then return end/,
  );
  assert.match(osc, /'intro',[\s\S]{0,80}'Keyboard test',[\s\S]{0,80}'manual'/);
  assert.match(
    osc,
    /mp\.add_key_binding\([\s\S]{0,60}'t',[\s\S]{0,100}'streamee-segment-feedback-test'/,
  );
});

test('feedback prompting is bounded and does not treat timeouts as negative feedback', () => {
  assert.match(player, /segmentFeedbackPromptedKeys\.has\(slotKey\)/);
  assert.match(player, /segmentFeedbackSeekSuppressedUntil = Date\.now\(\) \+ 10_000/);
  assert.match(player, /if \(payload\.response === 'dismissed'\)/);
  assert.match(feedback, /SEGMENT_FEEDBACK_STORAGE_LIMIT = 400/);
  assert.match(player, /candidate\.kind === 'intro'[\s\S]*seekTime\(candidate\.end_sec/);
  assert.match(player, /const advanced = await handleSmartNextRequest\(active\.filename\)/);
});

test('promoted patterns use cancellable automation with correlation-friendly diagnostics', () => {
  assert.match(player, /segment_feedback\.prompt_dispatched/);
  assert.match(player, /segment_feedback\.prompt_dispatch_failed/);
  assert.match(player, /segment_feedback\.prompt_rendered/);
  assert.match(player, /segment_feedback\.response_received/);
  assert.match(player, /hidden_reason: payload\.hidden_reason/);
  assert.match(player, /rendered: active\.renderedAt != null/);
  assert.match(player, /segment_feedback\.shadow_promoted/);
  assert.match(player, /segment_feedback\.shadow_would_act/);
  assert.match(player, /action: automatic \? 'automatic-countdown'/);
  assert.match(player, /segment_feedback\.auto_action_scheduled/);
  assert.match(player, /segment_feedback\.auto_action_completed/);
  assert.match(player, /segment_feedback\.auto_action_cancelled/);
  assert.match(player, /segment_feedback\.pattern_suspended/);
  assert.match(player, /request_id: payload\.request_id/);
  assert.match(player, /candidate_id: active\.key/);
  assert.match(player, /suspendSegmentFeedbackPattern\(active\.context, candidate, 'automatic-cancelled'\)/);
  assert.match(player, /Date\.now\(\) - recentAutomaticIntro\.completedAt <= 15_000/);
  assert.match(player, /reason: 'seek-back-undo'/);
});

test('clearing confirmation history also clears learned pattern state', () => {
  assert.match(settings, /removeItem\(SEGMENT_FEEDBACK_STORAGE_KEY\)/);
  assert.match(settings, /removeItem\(SEGMENT_FEEDBACK_PATTERN_STORAGE_KEY\)/);
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
