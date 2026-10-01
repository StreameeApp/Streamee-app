import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('OptiFlow launch has no imported FRUC or software-adapter fallback', async () => {
  const [backend, ui, pipeline] = await Promise.all([
    read('src-tauri/src/lib.rs'), read('src/renderer/features/settings/Settings.tsx'),
    read('native/streamee-nvfruc-d3d11/src/pipeline.cpp'),
  ]);
  assert.doesNotMatch(backend, /NvOFFRUC|STREAMEE_NVFRUC|import_nvfruc|nvfruc_runtime::/);
  assert.doesNotMatch(ui, /Import SDK folder|importRuntime/);
  assert.doesNotMatch(pipeline, /NvOFFRUC|nvfruc_abi/);
  assert.match(pipeline, /LoadLibraryExW\(L"nvofapi64.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32\)/);
  assert.match(backend, /--vf-add=@streamee-optiflow:streamee-optiflow/);
  assert.match(backend, /or_else\(\|\| find_mpv\(app\)\)/);
  for (const path of ['mpv/scripts/streamee_nvfruc.py', 'mpv/vs-plugins/streamee_nvfruc.dll']) {
    await assert.rejects(access(new URL(`../${path}`, import.meta.url)));
  }
});

test('OptiFlow enhanced playback gates HDR and P010 without changing preferences',
  { skip: process.platform !== 'win32' }, () => {
    const path = (s: string) => fileURLToPath(new URL(s, import.meta.url));
    const result = spawnSync(path('../mpv/mpv.com'), ['--no-config', '--load-scripts=no',
      '--idle=yes', '--vo=null', '--ao=null', `--script=${path('rtx-hdr-gating.lua')}`], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, STREAMEE_VSR_TEST_SCRIPT: path('../mpv/scripts/streamee_vsr.lua') },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /all display\/source transition checks passed/);
});

test('OptiFlow keeps source-clock timing and a versioned native contract', async () => {
  const [header, native, metadata] = await Promise.all([
    read('native/streamee-nvfruc-d3d11/include/bridge.h'),
    read('native/streamee-nvfruc-d3d11/mpv/vf_streamee_optiflow.c'),
    read('native/streamee-nvfruc-d3d11/mpv/optiflow_metadata.h'),
  ]);
  assert.match(header, /STREAMEE_OPTIFLOW_D3D11_ABI 3u/);
  assert.match(native, /img->pts-original->pts/);
  assert.match(metadata, /pl_hdr_metadata_equal/);
  assert.match(metadata, /av_dynamic_hdr_plus_to_t35/);
  assert.match(native, /mp_image_new_ref\(original\)/);
  assert.match(native, /MP_FILTER_COMMAND_GET_META/);
});
