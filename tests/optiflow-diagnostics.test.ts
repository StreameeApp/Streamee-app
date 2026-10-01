import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('GPU profile rejects missing filters, fallback, wrong size and missing rendering',
  { skip: process.platform !== 'win32' }, () => {
    const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
    const result = spawnSync(path('../mpv/mpv.com'), ['--no-config', '--load-scripts=no',
      '--idle=yes', '--vo=null', '--ao=null', `--script=${path('optiflow-gpu-profile.lua')}`], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, STREAMEE_GPU_PROFILE_TEST_SCRIPT: path('../native/streamee-nvfruc-vs/tests/gpu-profile.lua') },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /GPU profile validation tests passed/);
  });

test('OptiFlow overlay distinguishes active, fallback, unknown, and disabled enhancements',
  { skip: process.platform !== 'win32' }, () => {
    const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
    const result = spawnSync(path('../mpv/mpv.exe'), ['--no-config', '--load-scripts=no',
      '--idle=yes', '--vo=null', '--ao=null', '--terminal=yes',
      `--script=${path('optiflow-diagnostics.lua')}`], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, STREAMEE_OPTIFLOW_TEST_SCRIPT: path('../mpv/scripts/streamee_optiflow_stats.lua') },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /OptiFlow diagnostics tests passed/);
  });
