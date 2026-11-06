import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const mpv = path('../mpv/mpv.exe');
const script = path('../mpv/scripts/streamee_playback_lifecycle.lua');
const available = process.platform === 'win32' && existsSync(mpv);
const args = ['--no-config', '--load-scripts=no', '--idle=yes', '--vo=null', '--ao=null', '--terminal=yes'];

test('MPV closes after a real failed load even with idle enabled', { skip: !available }, () => {
  const missing = path('missing-playback-lifecycle-media.mkv');
  assert.equal(existsSync(missing), false);
  const baseline = spawnSync(mpv, [...args, missing], { encoding: 'utf8', timeout: 1500, windowsHide: true });
  assert.equal(baseline.error?.code, 'ETIMEDOUT', 'baseline should reproduce the idle player surviving failure');
  const fixed = spawnSync(mpv, [...args, `--script=${script}`, missing], {
    encoding: 'utf8', timeout: 8000, windowsHide: true,
  });
  assert.equal(fixed.error, undefined, fixed.stdout + fixed.stderr);
  assert.notEqual(fixed.status, null);
  assert.match(fixed.stdout + fixed.stderr, /Closing MPV after failed playback returned to idle/);
});

test('MPV lifecycle distinguishes errors, prelaunch idle, EOF, and playlist transitions', { skip: !available }, () => {
  const result = spawnSync(mpv, [...args, `--script=${path('mpv-playback-lifecycle.lua')}`], {
    encoding: 'utf8', timeout: 8000, windowsHide: true,
    env: { ...process.env, STREAMEE_PLAYBACK_LIFECYCLE_SCRIPT: script },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Playback lifecycle tests passed/);
});

for (const failedFirst of [false, true]) {
  test(`real MPV preserves normal EOF${failedFirst ? ' after advancing past a failed playlist entry' : ''}`,
    { skip: !available }, () => {
      const files = failedFirst ? [path('missing-playback-lifecycle-media.mkv')] : [];
      files.push('av://lavfi:color=c=black:s=16x16');
      const result = spawnSync(mpv, [...args, `--script=${script}`, '--length=0.1', ...files], {
        encoding: 'utf8', timeout: 1600, windowsHide: true,
      });
      assert.equal(result.error?.code, 'ETIMEDOUT', 'normal EOF should retain the idle player');
      assert.match(result.stdout + result.stderr, /VO: \[null\]/);
      assert.doesNotMatch(result.stdout + result.stderr, /Closing MPV after failed playback/);
    });
}

// Execute the component's actual cleanup closure with controlled process races.
const player = readFileSync(path('../src/renderer/features/player/Player.tsx'), 'utf8');
const cleanup = player.slice(player.indexOf('    const handleStartupFailure ='), player.indexOf('    const startPlayback ='));
const prelaunchStart = player.lastIndexOf('          prelaunchMpvPromise = (async () => {');
const prelaunchEnd = player.indexOf('\n        }', prelaunchStart);
const prelaunch = player.slice(prelaunchStart, prelaunchEnd);
const listenerStart = player.indexOf('        startupStateUnlisten = keepListener(await');
// The registration is wrapped as keepListener(await on...(callback)); the extra
// opening parenthesis balances the wrapper's closing one.
const startupListener = player.slice(listenerStart, player.indexOf('        playerHdrRestartUnlisten =', listenerStart))
  .replace('startupStateUnlisten = keepListener(await window.electronAPI.torrent.onStartupState(', 'const onStartupState = ((');

function harness({ disposed = false, generation = 1, pid = 42 as number | null, prelaunchPid = null as number | null,
  session = 9 as number | null } = {}) {
  const stopped: number[] = [];
  const errors: string[] = [];
  const states: unknown[] = [];
  const activeStartupSessionRef = { current: session };
  const mpvPidRef = { current: pid as number | null };
  let resolvePrelaunch!: (value: { pid: number }) => void;
  const pending = new Promise<{ pid: number }>(resolve => { resolvePrelaunch = resolve; });
  const env = {
    disposed, playbackLaunchIdRef: { current: generation }, mpvPidRef,
    initInProgress: { current: true }, streamOpenedRef: { current: true },
    smartNextTransitionRef: { current: true },
    useStore: { getState: () => ({ setPlaybackTransitionActive: () => {} }) },
    setStartupError: (message: string) => errors.push(message), setIsLoading: () => {}, setMpvPid: () => {},
    window: { electronAPI: { stopMpvProcess: async (value: number) => { stopped.push(value); }, prelaunchMpv: () => pending } },
    getMpvDebugBounds: async () => ({}), setMpvDebugBounds: () => {}, getMpvLaunchSettings: async () => ({}),
    selectedMeta: {}, selectedStream: { title: 'Test media', sourceType: 'webtorrent' }, prelaunchPid,
    activeStartupSessionRef, setStartupState: (state: unknown) => states.push(state),
  };
  const source = `
    const { disposed, playbackLaunchIdRef, mpvPidRef, initInProgress, streamOpenedRef,
      smartNextTransitionRef, useStore, setStartupError, setIsLoading, setMpvPid, window,
      getMpvDebugBounds, setMpvDebugBounds, getMpvLaunchSettings, selectedMeta, selectedStream,
      activeStartupSessionRef, setStartupState } = env;
    const playbackLaunchId = 1;
    let startupFailureHandled = false;
    let prelaunchedMpvPid = env.prelaunchPid;
    let prelaunchMpvPromise;
    ${cleanup}
    const isCurrentPlaybackLaunch = () => !disposed && !startupFailureHandled && playbackLaunchIdRef.current === playbackLaunchId;
    const setCurrentMpvPid = (pid) => { if (!isCurrentPlaybackLaunch()) return false; mpvPidRef.current = pid; return true; };
    ${startupListener}
    return { fail: handleStartupFailure, onStartupState, launch: () => { ${prelaunch}; return prelaunchMpvPromise; } };
  `;
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return { ...new Function('env', compiled)(env), stopped, errors, states, activeStartupSessionRef, mpvPidRef, resolvePrelaunch };
}

test('late startup events from a replaced source preserve the selected player', async () => {
  const h = harness();
  for (const phase of ['failed', 'launching_mpv', 'mpv_started']) {
    h.onStartupState({ session_id: 7, phase, message: 'Old source' });
  }
  await Promise.resolve();
  assert.deepEqual(h.stopped, []);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.states, []);
  assert.equal(h.activeStartupSessionRef.current, 9);
  assert.equal(h.mpvPidRef.current, 42);
  h.onStartupState({ session_id: 9, phase: 'failed', message: 'Selected source failed' });
  await Promise.resolve();
  assert.deepEqual(h.stopped, [42]);
  assert.equal(h.mpvPidRef.current, null);
});

test('a terminal event cannot adopt an unknown startup session', async () => {
  const h = harness({ session: null });
  h.onStartupState({ session_id: 7, phase: 'failed', message: 'Old source' });
  await Promise.resolve();
  assert.deepEqual(h.stopped, []);
  assert.equal(h.activeStartupSessionRef.current, null);
  h.onStartupState({ session_id: 9, phase: 'starting_sidecar', message: 'Selected source' });
  h.onStartupState({ session_id: 9, phase: 'failed', message: 'Selected source failed' });
  await Promise.resolve();
  assert.deepEqual(h.stopped, [42]);
});

test('startup cleanup closes loaded MPV once and prefers its owned prelaunch PID', async () => {
  for (const prelaunchPid of [null, 73]) {
    const h = harness({ prelaunchPid });
    await h.fail('Load failed');
    await h.fail('Duplicate failure');
    assert.deepEqual(h.stopped, [prelaunchPid ?? 42]);
    assert.deepEqual(h.errors, ['Load failed']);
    assert.equal(h.mpvPidRef.current, null);
  }
});

test('disposed and replaced startup callbacks preserve the current player', async () => {
  for (const options of [{ disposed: true }, { generation: 2 }]) {
    const h = harness(options);
    await h.fail('Stale failure');
    assert.deepEqual(h.stopped, []);
    assert.deepEqual(h.errors, []);
    assert.equal(h.mpvPidRef.current, 42);
  }
});

test('prelaunch finishing after startup failure closes its late process', async () => {
  for (const pid of [null, 42]) {
    const h = harness({ pid });
    const launch = h.launch();
    await h.fail('Source failed during prelaunch');
    h.resolvePrelaunch({ pid: 73 });
    assert.equal(await launch, null);
    assert.deepEqual(h.stopped, pid == null ? [73] : [pid, 73]);
    assert.equal(h.mpvPidRef.current, null);
  }
});

// Execute the component's actual player-closed handler.
const closedStart = player.indexOf('        playerClosedUnlisten = keepListener(await');
const closedListener = player.slice(closedStart, player.indexOf('        playerEofUnlisten =', closedStart))
  .replace('playerClosedUnlisten = keepListener(await window.electronAPI.playerEvents.onClosed(', 'const onClosed = ((');

function closedHarness(currentPid: number | null) {
  const exits: string[] = [];
  const noop = () => {};
  const env = {
    disposed: false, smartNextTransitionRef: { current: false }, mpvPidRef: { current: currentPid },
    selectedStream: { sourceType: 'webtorrent' }, lastKnownPlaybackTimeRef: { current: 600 },
    stopSubtitleTranscription: async () => {}, stopSvpAfterMpvClose: async () => {},
    scheduleQbitRetry: noop, setSubtitleStatus: noop, setSubtitleMessage: noop, clearSubtitleAssist: noop,
    setRetryWhisperAction: noop, setRetryAudioNormalizerAction: noop, setAudioNormalizerActive: noop,
    setAudioNormalizerConnected: noop, setAudioNormalizerReason: noop,
    exitToMetaDetails: () => exits.push('exit'),
  };
  const source = `
    const { disposed, smartNextTransitionRef, mpvPidRef, selectedStream, lastKnownPlaybackTimeRef,
      stopSubtitleTranscription, stopSvpAfterMpvClose, scheduleQbitRetry, setSubtitleStatus,
      setSubtitleMessage, clearSubtitleAssist, setRetryWhisperAction, setRetryAudioNormalizerAction,
      setAudioNormalizerActive, setAudioNormalizerConnected, setAudioNormalizerReason,
      exitToMetaDetails } = env;
    ${closedListener}
    return onClosed;
  `;
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return { onClosed: new Function('env', compiled)(env), exits };
}

test('closing a player this launch no longer uses does not end playback', async () => {
  const h = closedHarness(42);
  const payload = { percent_pos: 40, playback_time: 600, duration: 1500, filename: 'Example.mkv' };
  await h.onClosed({ ...payload, mpv_pid: 17 });
  assert.deepEqual(h.exits, []);
  await h.onClosed({ ...payload, mpv_pid: 42 });
  assert.deepEqual(h.exits, ['exit']);
});

// Execute the component's actual end-of-file handler.
const eofStart = player.indexOf('        playerEofUnlisten = keepListener(await');
const eofListener = player.slice(eofStart, player.indexOf('        playerReconnectedUnlisten =', eofStart))
  .replace('playerEofUnlisten = keepListener(await window.electronAPI.playerEvents.onEof(', 'const onEof = ((');

function eofHarness(playlist: { playlistActive: boolean; playlistCurrentIndex: number; playlistFiles: unknown[] }) {
  const exits: string[] = [];
  const noop = () => {};
  const env = {
    disposed: false, smartNextTransitionRef: { current: false }, mpvPidRef: { current: 42 },
    selectedStream: { sourceType: 'webtorrent' }, lastKnownPlaybackTimeRef: { current: 600 },
    stopSubtitleTranscription: async () => {}, scheduleQbitRetry: noop, setSubtitleStatus: noop,
    setSubtitleMessage: noop, clearSubtitleAssist: noop, setRetryWhisperAction: noop,
    setRetryAudioNormalizerAction: noop, setAudioNormalizerActive: noop, setAudioNormalizerConnected: noop,
    setAudioNormalizerReason: noop, exitToMetaDetails: () => exits.push('exit'),
    useStore: { getState: () => playlist },
  };
  const source = `
    const { disposed, smartNextTransitionRef, mpvPidRef, selectedStream, lastKnownPlaybackTimeRef,
      stopSubtitleTranscription, scheduleQbitRetry, setSubtitleStatus, setSubtitleMessage,
      clearSubtitleAssist, setRetryWhisperAction, setRetryAudioNormalizerAction, setAudioNormalizerActive,
      setAudioNormalizerConnected, setAudioNormalizerReason, exitToMetaDetails, useStore } = env;
    ${eofListener}
    return onEof;
  `;
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return { onEof: new Function('env', compiled)(env), exits };
}

test('end of file leaves the player only after the last playlist item', async () => {
  const payload = { percent_pos: 99, playback_time: 1490, duration: 1500, filename: 'Episode.mkv', mpv_pid: 42 };
  const files = [{}, {}, {}];
  const middle = eofHarness({ playlistActive: true, playlistCurrentIndex: 1, playlistFiles: files });
  await middle.onEof(payload);
  assert.deepEqual(middle.exits, []);
  const last = eofHarness({ playlistActive: true, playlistCurrentIndex: 2, playlistFiles: files });
  await last.onEof(payload);
  assert.deepEqual(last.exits, ['exit']);
  const single = eofHarness({ playlistActive: false, playlistCurrentIndex: 0, playlistFiles: [] });
  await single.onEof(payload);
  assert.deepEqual(single.exits, ['exit']);
});
