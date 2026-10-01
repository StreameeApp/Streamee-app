import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const mpv = path('../mpv/mpv.exe');

test('Thumbfast recovers from decoder failures, EOF, and stale helper callbacks',
  { skip: process.platform !== 'win32' || !existsSync(mpv) }, () => {
    const result = spawnSync(mpv, ['--no-config', '--load-scripts=no', '--idle=yes',
      '--vo=null', '--ao=null', '--terminal=yes', `--script=${path('thumbfast-recovery.lua')}`], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, STREAMEE_THUMBFAST_TEST_SCRIPT: path('../mpv/scripts/thumbfast.lua') },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Thumbfast recovery tests passed/);
  });
