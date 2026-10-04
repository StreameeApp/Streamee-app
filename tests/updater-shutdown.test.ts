import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = stripTypeScriptTypes(readFileSync('src/renderer/services/updater.ts', 'utf8'))
  .replace(/^import .*;\r?$/gm, '')
  .replace(/^export /gm, '')
  + '\nglobalThis.api = { checkForUpdates, downloadUpdate, installUpdate, getUpdaterSnapshot };';

function updater(check: () => Promise<unknown>, invoke: (command: string) => Promise<unknown>) {
  const context: any = { check, invoke, console, Error };
  vm.runInNewContext(source, context);
  return context.api;
}

test('installation waits for verified helper shutdown and prevents duplicate installs', async () => {
  const calls: string[] = [];
  let finishShutdown!: () => void;
  const api = updater(async () => ({ version: '2.0.23', download: async () => {},
    install: async () => { calls.push('install'); } }), async command => {
      calls.push(command);
      await new Promise<void>(resolve => { finishShutdown = resolve; });
    });
  await api.checkForUpdates();
  await api.downloadUpdate();
  const installing = api.installUpdate();
  await api.installUpdate();
  assert.deepEqual(calls, ['prepare_update_shutdown']);
  finishShutdown();
  await installing;
  assert.deepEqual(calls, ['prepare_update_shutdown', 'install']);
});

test('failed shutdown never launches the installer and restores the launch gate', async () => {
  const calls: string[] = [];
  const api = updater(async () => ({ version: '2.0.23', download: async () => {},
    install: async () => { calls.push('install'); } }), async command => {
      calls.push(command);
      if (command === 'prepare_update_shutdown') throw new Error('helper still running');
    });
  await api.checkForUpdates();
  await api.downloadUpdate();
  await api.installUpdate();
  assert.deepEqual(calls, ['prepare_update_shutdown', 'cancel_update_shutdown']);
  assert.equal(api.getUpdaterSnapshot().status, 'error');
  assert.equal(api.getUpdaterSnapshot().error, 'helper still running');
});

test('download completion event cannot enable installation before the update bytes are retained', async () => {
  let finishDownload!: () => void;
  let checks = 0;
  const calls: string[] = [];
  const api = updater(async () => {
    checks++;
    return { version: '2.0.23', install: async () => { calls.push('install'); },
      download: async (onEvent: (event: unknown) => void) => {
        onEvent({ event: 'Finished' });
        await new Promise<void>(resolve => { finishDownload = resolve; });
      } };
  }, async command => { calls.push(command); });
  await api.checkForUpdates();
  const download = api.downloadUpdate();
  assert.equal(api.getUpdaterSnapshot().status, 'downloading');
  await api.installUpdate();
  assert.deepEqual(calls, []);
  finishDownload();
  await download;
  await api.checkForUpdates();
  assert.equal(checks, 1);
  assert.equal(api.getUpdaterSnapshot().status, 'ready');
});
