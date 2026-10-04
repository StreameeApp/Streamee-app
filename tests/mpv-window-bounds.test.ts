import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Execute the actual component helpers against independent native/DOM measurements.
const source = readFileSync(new URL('../src/renderer/features/player/Player.tsx', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('const getMpvDebugBounds ='), source.indexOf('const Player: React.FC'));
const trackingStart = source.indexOf('  useEffect(() => {\n    if (!mpvPid) return;');
const tracking = source.slice(trackingStart, source.indexOf('  }, [mpvPid]);', trackingStart) + '  }, [mpvPid]);'.length);
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function geometry({ scale = 1, viewport = [1280, 720], origin = [108, 139],
  rect = [241, 2, 1279, 720], visible = true, nativeSize = null as number[] | null } = {}) {
  const appWin = {
    innerPosition: async () => ({ x: origin[0], y: origin[1] }),
    innerSize: async () => ({ width: nativeSize?.[0] ?? viewport[0] * scale, height: nativeSize?.[1] ?? viewport[1] * scale }),
  };
  const window = { innerWidth: viewport[0], innerHeight: viewport[1] };
  const document = { querySelector: () => visible ? {
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }),
  } : null };
  return new Function('window', 'document', 'getCurrentWindow', compile(`${helper}\nreturn getMpvDebugBounds();`))(
    window, document, () => appWin,
  );
}

for (const [scale, expected] of [
  [1, [241, 2, 1038, 718]],
  [1.25, [301, 3, 1298, 897]],
  [1.5, [362, 3, 1557, 1077]],
  [2, [482, 4, 2076, 1436]],
] as const) {
  test(`player aligns with the client area at ${scale * 100}% display scale`, async () => {
    const bounds = await geometry({ scale });
    assert.deepEqual([bounds.offsetX, bounds.offsetY, bounds.width, bounds.height], [...expected]);
    assert.deepEqual([bounds.appX + bounds.offsetX, bounds.appY + bounds.offsetY], [108 + expected[0], 139 + expected[1]]);
  });
}

test('odd VM aspect ratio and a monitor left of the primary display use actual bounds', async () => {
  const bounds = await geometry({ viewport: [1000, 800], nativeSize: [1250, 1000], origin: [-1242, 39], rect: [241, 0, 1000, 800] });
  assert.deepEqual([bounds.appX + bounds.offsetX, bounds.appY + bounds.offsetY, bounds.width, bounds.height], [-941, 39, 949, 1000]);
});

test('WebView zoom uses the physical viewport and clips overflowing player edges', async () => {
  const bounds = await geometry({ viewport: [800, 600], nativeSize: [1600, 1200], rect: [240.25, -10, 810, 610] });
  assert.deepEqual([bounds.offsetX, bounds.offsetY, bounds.width, bounds.height], [481, 0, 1119, 1200]);
});

test('minimized, missing, or offscreen player areas never produce invalid native sizes', async () => {
  await assert.rejects(geometry({ nativeSize: [0, 0] }), /not available/);
  await assert.rejects(geometry({ visible: false }), /not available/);
  await assert.rejects(geometry({ rect: [1400, 0, 1500, 720] }), /no visible bounds/);
});

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function trackingHarness() {
  const events = new Map<string, () => void>();
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const moves: number[][] = [];
  const unlistened: string[] = [];
  let nextFrame = 0;
  let nextTimer = 0;
  let appX = -1242;
  let cleanup!: () => void;
  let fullscreen = false;
  let resolveInfo: (() => void) | null = null;
  let blockInfo = false;
  const listen = async (name: string, handler: () => void) => {
    events.set(name, handler);
    return () => { events.delete(name); unlistened.push(name); };
  };
  const appWin = {
    onMoved: (handler: () => void) => listen('move', handler),
    onResized: (handler: () => void) => listen('resize', handler),
    onScaleChanged: (handler: () => void) => listen('scale', handler),
  };
  const player = {
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
    removeEventListener: (name: string) => events.delete(name),
  };
  const window = {
    requestAnimationFrame: (handler: () => void) => { frames.set(++nextFrame, handler); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (handler: () => void) => { timers.set(++nextTimer, handler); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (_name: string, handler: () => void) => events.set('dom-resize', handler),
    removeEventListener: () => events.delete('dom-resize'),
    electronAPI: {
      getPlayerInfo: async () => {
        if (blockInfo) await new Promise<void>(resolve => { resolveInfo = resolve; });
        return { fullscreen };
      },
      moveMpvWindow: async (...args: number[]) => { moves.push(args); },
    },
  };
  class ResizeObserver {
    constructor(handler: () => void) { events.set('layout', handler); }
    observe() {}
    disconnect() { events.delete('layout'); }
  }
  const env = {
    window, ResizeObserver, containerRef: { current: player }, mpvPid: 42,
    getCurrentWindow: () => appWin,
    getMpvDebugBounds: async () => ({ appX, appY: 39, offsetX: 301, offsetY: 0, width: 949, height: 1000 }),
    setMpvDebugBounds: () => {},
    useEffect: (effect: () => () => void) => { cleanup = effect(); },
  };
  new Function('env', compile(`const { window, ResizeObserver, containerRef, mpvPid, getCurrentWindow,
    getMpvDebugBounds, setMpvDebugBounds, useEffect } = env; ${tracking}`))(env);
  return {
    moves, frames, timers, events, unlistened, cleanup,
    moveApp: (value: number) => { appX = value; events.get('move')!(); },
    setFullscreen: (value: boolean) => { fullscreen = value; },
    blockInfo: () => { blockInfo = true; },
    releaseInfo: () => { blockInfo = false; resolveInfo?.(); },
    retry: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(handler => handler()); },
    flush: async () => {
      const pending = [...frames.values()]; frames.clear(); pending.forEach(handler => handler()); await settle();
    },
  };
}

test('initial attachment and coalesced display/layout changes align MPV; fullscreen is preserved', async () => {
  const h = trackingHarness();
  await settle();
  await h.flush();
  assert.deepEqual(h.moves, [[42, -941, 39, 949, 1000]]);
  for (const event of ['move', 'resize', 'scale', 'layout', 'animationend', 'dom-resize']) {
    assert.ok(h.events.has(event), `${event} must update alignment`);
    h.events.get(event)!();
  }
  assert.equal(h.frames.size, 1);
  await h.flush();
  assert.equal(h.moves.length, 2);
  h.setFullscreen(true);
  h.events.get('scale')!();
  await h.flush();
  assert.equal(h.moves.length, 2);
  h.cleanup();
  assert.equal(h.events.size, 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.unlistened, ['move', 'resize', 'scale']);
});

test('fullscreen exit restores changed app bounds without another app event or playback progress', async () => {
  const h = trackingHarness();
  await settle();
  await h.flush();
  h.setFullscreen(true);
  h.moveApp(900);
  await h.flush();
  assert.equal(h.moves.length, 1);
  assert.equal(h.timers.size, 1);
  // A retry must preserve fullscreen and retain only one pending check.
  h.retry();
  await h.flush();
  assert.equal(h.moves.length, 1);
  assert.equal(h.timers.size, 1);
  h.setFullscreen(false);
  h.retry();
  await h.flush();
  assert.deepEqual(h.moves.at(-1), [42, 1201, 39, 949, 1000]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.size, 0);
  h.cleanup();
});

test('closing a fullscreen player cancels alignment retries and ignores an already queued retry', async () => {
  const h = trackingHarness();
  h.setFullscreen(true);
  await settle();
  await h.flush();
  const queuedRetry = [...h.timers.values()][0];
  assert.ok(queuedRetry);
  h.cleanup();
  assert.equal(h.timers.size, 0);
  queuedRetry();
  await h.flush();
  assert.deepEqual(h.moves, []);
  assert.equal(h.frames.size, 0);
});

test('closing the player during an async alignment prevents a stale native move', async () => {
  const h = trackingHarness();
  await settle();
  h.blockInfo();
  await h.flush();
  h.cleanup();
  h.releaseInfo();
  await settle();
  assert.deepEqual(h.moves, []);
  assert.equal(h.frames.size, 0);
});
