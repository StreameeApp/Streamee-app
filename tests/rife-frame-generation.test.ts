import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settings = readFileSync('src/renderer/features/settings/Settings.tsx', 'utf8');
const player = readFileSync('src/renderer/features/player/Player.tsx', 'utf8');
const tauri = readFileSync('src/renderer/services/tauri.ts', 'utf8');
const backend = readFileSync('src-tauri/src/lib.rs', 'utf8');
const runtime = readFileSync('src-tauri/src/rife_runtime.rs', 'utf8');
const mpvIpc = readFileSync('src-tauri/src/mpv_ipc.rs', 'utf8');
const rife = readFileSync('mpv/scripts/streamee_rife.py', 'utf8');
const vsr = readFileSync('mpv/scripts/streamee_vsr.lua', 'utf8');

test('RIFE controls persist playback choices and use the managed runtime installer', () => {
  for (const key of [
    'mpvRifeEnabled',
    'mpvRifeModel',
    'mpvRifeMultiplier',
    'mpvRifeGpuStreams',
    'mpvRifeConcurrentFrames',
    'mpvRifeProcessingResolution',
    'mpvRifeScale',
    'mpvRifeBeforeUpscaling',
  ]) {
    assert.match(settings, new RegExp(`setSetting\\('${key}'`));
    assert.match(settings, new RegExp(`getSetting\\('${key}'`));
  }
  assert.match(settings, /Install RIFE Runtime/);
  assert.match(settings, /window\.electronAPI\.rife\.install/);
  assert.match(settings, /videoUpscaler !== 'rtx-vsr'/);
  assert.match(settings, /setRifeRuntimeInfo\(null\);[\s\S]*?setMpvRifeModel/);
  assert.doesNotMatch(settings, /setMpvRifeEnabled\(false\);\s*setMpvRifeModel/);
  assert.doesNotMatch(settings, /if \(!runtime\.ready\) \{\s*setMpvRifeEnabled\(false\)/);
  assert.match(runtime, /rife-runtime/);
  assert.match(runtime, /SHA-256 verification failed/);
  assert.match(runtime, /vsmlrt-cuda\.v15\.16\.7z\.001/);
  assert.doesNotMatch(settings, /Program Files \(x86\).*SVP 4.*rife/);
});

test('RIFE TensorRT engines can be prepared from Settings before playback', () => {
  assert.match(settings, /Prepare \{RIFE_PREPARATION_PROFILE_LABELS\[rifePreparationResolution\]\} engine/);
  assert.match(settings, /Engine preparation source/);
  assert.match(settings, /<details className="settings-advanced rife-advanced-settings">/);
  assert.match(settings, /Advanced tuning/);
  assert.match(settings, /Repair or reinstall RIFE/);
  assert.match(settings, /<label>Concurrent frames<\/label>/);
  assert.match(settings, /Auto \(recommended\)/);
  assert.match(settings, /window\.electronAPI\.rife\.prepareEngine/);
  assert.match(settings, /onEnginePreparationProgress/);
  assert.match(tauri, /invoke<RifeEnginePreparationResult>\('prepare_rife_engine'/);
  assert.match(tauri, /rife:\/\/engine-preparation-progress/);
  assert.match(backend, /async fn prepare_rife_engine/);
  assert.match(runtime, /av:\/\/lavfi:color=c=black/);
  assert.match(runtime, /Compiling and validating the TensorRT engine/);
  assert.match(runtime, /ENGINE_PREPARATION_TIMEOUT/);
  assert.match(runtime, /cancel_engine_preparation/);
  assert.match(runtime, /terminate_preparation_process/);
  assert.match(backend, /Stop playback before preparing a RIFE engine/);
  assert.match(backend, /cancel_rife_engine_preparation/);
});

test('RIFE playback is verified and cannot run alongside SVP', () => {
  assert.match(backend, /register_rife_expectation/);
  assert.match(backend, /ensure_svp_allowed/);
  assert.match(backend, /rife_session_active_or_expected/);
  assert.match(backend, /SVP cannot start while Streamee RIFE is enabled/);
  assert.match(backend, /RIFE is enabled; SVP was stopped and auto-start was suppressed/);
  assert.match(settings, /setSvpAutoStartEnabled\(false\)/);
  assert.match(settings, /setSvpAutoRestartOnPlaylistChange\(false\)/);
  assert.match(settings, /disabled=\{mpvRifeEnabled\}/);
  assert.match(player, /getSetting\('mpvRifeEnabled'\)/);
  assert.match(mpvIpc, /rife:\/\/playback-status/);
  assert.match(mpvIpc, /current_rife_playback_status/);
  assert.match(mpvIpc, /RIFE_HEALTH_REPORT_INTERVAL/);
  assert.match(mpvIpc, /rife\.session_ready/);
  assert.match(mpvIpc, /rife\.session_failed/);
  assert.match(mpvIpc, /estimated-vf-fps/);
  assert.match(mpvIpc, /video-out-params/);
});

test('RIFE compiled engines expose bounded cache maintenance', () => {
  assert.match(settings, /Clear compiled engines/);
  assert.match(settings, /getCacheInfo/);
  assert.match(settings, /clearCache/);
  assert.match(tauri, /get_rife_cache_info/);
  assert.match(tauri, /clear_rife_cache/);
  assert.match(runtime, /remove_invalid_cache_artifacts/);
  assert.match(runtime, /ends_with\("\.engine"\)/);
  assert.match(backend, /Stop playback before clearing compiled RIFE engines/);
  assert.match(backend, /register_spawned_player\(pid\)/);
  assert.match(mpvIpc, /SPAWNED_MPV_PID/);
});

test('backend validates and launches the standalone RIFE filter without SVP Manager', () => {
  assert.match(backend, /scripts"\)\.join\("streamee_rife\.py"\)/);
  assert.match(backend, /@streamee-rife:vapoursynth/);
  assert.match(backend, /rife_filter_concurrency/);
  assert.match(backend, /const RIFE_BUFFERED_FRAMES: u32 = 2/);
  assert.match(
    backend,
    /buffered-frames=\{\}:concurrent-frames=\{\}[\s\S]*?RIFE_BUFFERED_FRAMES,[\s\S]*?rife_filter_concurrency/,
  );
  assert.match(backend, /matches!\(explicit, 1 \| 2 \| 4 \| 6 \| 8 \| 12\)/);
  assert.match(backend, /STREAMEE_RIFE_RUNTIME/);
  assert.match(backend, /STREAMEE_RIFE_MODEL/);
  assert.match(backend, /STREAMEE_RIFE_MULTIPLIER/);
  assert.match(backend, /STREAMEE_RIFE_GPU_STREAMS/);
  assert.match(backend, /STREAMEE_RIFE_PROCESSING_MODE/);
  assert.match(backend, /STREAMEE_RIFE_SCALE/);
  assert.doesNotMatch(rife, /svpflow|SVPManager|SmoothFps/);
});

test('RIFE marks scene cuts and uses the selected TensorRT model', () => {
  assert.match(rife, /clip\.misc\.SCDetect\(threshold=0\.12\)/);
  assert.match(rife, /Backend\.TRT\(/);
  assert.match(rife, /multi=multiplier/);
  assert.match(rife, /model=model_number\(model_name\)/);
  assert.match(rife, /smooth\.std\.CropRel/);
  assert.match(rife, /processing_mode/);
  assert.match(rife, /STREAMEE_RIFE_SCALE/);
  assert.match(rife, /Fraction\(scale_setting\)/);
  assert.match(rife, /alignment_fraction = Fraction\(32, 1\) \/ rife_scale/);
  assert.match(rife, /is_4k_family = source_width >= 3500 or source_height >= 1800/);
  assert.match(rife, /static_shape=True/);
  assert.match(rife, /opt_shapes=\[padded_width, padded_height\]/);
  assert.doesNotMatch(rife, /static_shape=False/);
  assert.match(rife, /scale=rife_scale/);
  assert.match(rife, /smooth\.resize\.Spline36\(width=source_width, height=source_height\)/);
  assert.match(rife, /matrix_in_s=matrix_name/);
  assert.match(rife, /matrix_s=matrix_name/);
});

test('RTX VSR and RTX Video HDR remain separate and order around RIFE', () => {
  assert.match(vsr, /local RIFE_FILTER_LABEL = "streamee-rife"/);
  assert.match(vsr, /local HDR_FILTER_LABEL = "@streamee-rtx-hdr"/);
  assert.match(vsr, /rife_before_upscaling/);
  assert.match(vsr, /return not option_enabled\(o\.rife_before_upscaling\)/);
  assert.match(vsr, /rtx_hdr_active = run_vf\("add", hdr_filter\(\), true\)/);
  assert.match(vsr, /rtx_hdr_enabled and not native_hdr/);
  assert.match(vsr, /native_hdr and "vsr-native-hdr" or "vsr"/);
  assert.match(vsr, /local target = rtx_hdr_active and windows_hdr_enabled/);
  assert.doesNotMatch(vsr, /scaling-mode=nvidia"\s*\.\.\s*":nvidia-true-hdr/);
});
