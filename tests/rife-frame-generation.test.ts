import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settings = readFileSync('src/renderer/features/settings/Settings.tsx', 'utf8');
const backend = readFileSync('src-tauri/src/lib.rs', 'utf8');
const runtime = readFileSync('src-tauri/src/rife_runtime.rs', 'utf8');
const rife = readFileSync('mpv/scripts/streamee_rife.py', 'utf8');
const vsr = readFileSync('mpv/scripts/streamee_vsr.lua', 'utf8');

test('RIFE controls persist playback choices and use the managed runtime installer', () => {
  for (const key of [
    'mpvRifeEnabled',
    'mpvRifeModel',
    'mpvRifeMultiplier',
    'mpvRifeGpuStreams',
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
  assert.match(settings, /setRifeRuntimeInfo\(null\);\s*setMpvRifeModel/);
  assert.doesNotMatch(settings, /setMpvRifeEnabled\(false\);\s*setMpvRifeModel/);
  assert.match(runtime, /rife-runtime/);
  assert.match(runtime, /SHA-256 verification failed/);
  assert.match(runtime, /vsmlrt-cuda\.v15\.16\.7z\.001/);
  assert.doesNotMatch(settings, /Program Files \(x86\).*SVP 4.*rife/);
});

test('backend validates and launches the standalone RIFE filter without SVP Manager', () => {
  assert.match(backend, /scripts"\)\.join\("streamee_rife\.py"\)/);
  assert.match(backend, /@streamee-rife:vapoursynth/);
  assert.match(backend, /rife_filter_concurrency/);
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
  assert.match(rife, /opt_shapes=\[profile_opt_width, profile_opt_height\]/);
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
