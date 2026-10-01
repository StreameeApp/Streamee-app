import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('advanced clock control is explicit, opt-in and playback scoped', async () => {
  const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [ui, guard, backend, ipc] = await Promise.all([
    read('src/renderer/features/settings/OptiflowClockSettings.tsx'),
    read('src-tauri/src/optiflow_clock_guard.ps1'),
    read('src-tauri/src/optiflow_clocks.rs'),
    read('src-tauri/src/mpv_ipc.rs'),
  ]);
  assert.match(ui, /Advanced GPU clock control \(experimental\)/);
  assert.match(ui, /whole NVIDIA GPU/);
  assert.match(ui, /not\s+previous custom locks/);
  assert.match(ui, /enabled: false/);
  assert.match(guard, /finally \{\s+try \{ Reset-Clocks/);
  assert.match(guard, /!\$parent.HasExited -and !\$player.HasExited/);
  assert.match(guard, /\$age -le 3/);
  assert.match(guard, /\$gpus.Count -ne 1/);
  assert.match(backend, /if !optiflow_enabled \|\| !settings.enabled \{\s+return;\s+\}/);
  assert.match(ipc, /optiflow_clocks::allowed\(&app_handle, mpv_pid\)/);
});

test('clock guard lifecycle predicates and reset retries', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('optiflow-clock-guard.tests.ps1', import.meta.url))],
  { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
