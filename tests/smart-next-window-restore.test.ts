import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

// Execute the component's actual Smart Next window-state closures.
const player = readFileSync(fileURLToPath(new URL('../src/renderer/features/player/Player.tsx', import.meta.url)), 'utf8');
const restoreStart = player.indexOf('      const restoreSmartNextWindowState = () => {');
const restoreEnd = player.indexOf('      const setCurrentMpvPid = (pid: number | null) => {', restoreStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, 'restore closures not found in Player.tsx');
const closures = player.slice(restoreStart, restoreEnd);

type Pending = { fullscreen: boolean | null; previousMpvPid: number; restoredMpvPid: number | null; attempts: number };
type Shared = {
  smartNextWindowRestoreRef: { current: Pending | null };
  smartNextWindowRestoreInFlightRef: { current: boolean };
  mpvPidRef: { current: number | null };
  restored: Array<[number, boolean | null]>;
  failNext: number;
};

function sharedState(fullscreen: boolean | null = true): Shared {
  return {
    smartNextWindowRestoreRef: { current: { fullscreen, previousMpvPid: 49056, restoredMpvPid: null, attempts: 0 } },
    smartNextWindowRestoreInFlightRef: { current: false },
    mpvPidRef: { current: null },
    restored: [],
    failNext: 0,
  };
}

// One playback launch (one run of the player effect). A failover to a backup
// add-on starts a new launch that shares the component's refs.
function launch(shared: Shared, sourceType: 'addon' | 'webtorrent' = 'addon') {
  const env = {
    ...shared,
    selectedStream: { sourceType },
    console: { log: () => {}, warn: () => {} },
    window: {
      electronAPI: {
        player: {
          restoreSmartNextWindowState: async (pid: number, fullscreen: boolean | null) => {
            if (shared.failNext > 0) {
              shared.failNext -= 1;
              throw new Error('MPV not connected');
            }
            shared.restored.push([pid, fullscreen]);
          },
        },
      },
    },
  };
  const source = `
    const { smartNextWindowRestoreRef, smartNextWindowRestoreInFlightRef, mpvPidRef, selectedStream,
      console, window } = env;
    let addonPlaybackStarted = false;
    ${closures}
    return {
      setPid: (pid) => { mpvPidRef.current = pid; if (pid != null) restoreSmartNextWindowState(); },
      progress: () => restoreSmartNextWindowState(),
      playbackStarted: () => { addonPlaybackStarted = true; settleSmartNextWindowRestore(); },
    };
  `;
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('env', compiled)(env) as {
    setPid: (pid: number | null) => void;
    progress: () => void;
    playbackStarted: () => void;
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a backup add-on player after a failed startup source is restored to fullscreen too', async () => {
  const shared = sharedState(true);
  const first = launch(shared);
  first.setPid(64040);
  await settle();
  first.progress();
  await settle();
  assert.deepEqual(shared.restored, [[64040, true]], 'the same player is not restored twice');

  // The first add-on source fails during startup and its player is stopped.
  shared.mpvPidRef.current = null;
  const backup = launch(shared);
  backup.setPid(26892);
  await settle();
  assert.deepEqual(shared.restored, [[64040, true], [26892, true]]);

  backup.playbackStarted();
  assert.equal(shared.smartNextWindowRestoreRef.current, null);
});

test('once add-on playback starts, a later player is not forced back to the saved state', async () => {
  const shared = sharedState(true);
  const current = launch(shared);
  current.setPid(64040);
  await settle();
  current.playbackStarted();
  current.setPid(70000);
  await settle();
  assert.deepEqual(shared.restored, [[64040, true]]);
});

test('a restore still in flight when add-on playback starts clears the state when it finishes', async () => {
  const shared = sharedState(false);
  const current = launch(shared);
  current.setPid(64040);
  current.playbackStarted();
  assert.notEqual(shared.smartNextWindowRestoreRef.current, null);
  await settle();
  assert.deepEqual(shared.restored, [[64040, false]]);
  assert.equal(shared.smartNextWindowRestoreRef.current, null);
});

test('a backup player whose first restore attempt fails is retried after playback starts', async () => {
  const shared = sharedState(true);
  const first = launch(shared);
  first.setPid(64040);
  await settle();
  shared.mpvPidRef.current = null;

  const backup = launch(shared);
  shared.failNext = 1;
  backup.setPid(26892);
  await settle();
  backup.playbackStarted();
  backup.progress();
  await settle();
  assert.deepEqual(shared.restored, [[64040, true], [26892, true]]);
  assert.equal(shared.smartNextWindowRestoreRef.current, null);
});

test('non-add-on sources clear the saved state after the first restore', async () => {
  const shared = sharedState(true);
  const current = launch(shared, 'webtorrent');
  current.setPid(64040);
  await settle();
  assert.equal(shared.smartNextWindowRestoreRef.current, null);
});
