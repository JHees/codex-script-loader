import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const file = await readFile(new URL('../windows/src/CodexScriptLoader.Windows/ManagedCodexLifecycleObserver.cs', import.meta.url), 'utf8');
const source = file.split('"""')[1].replace('url => import(url)', 'loadModule');

test('native update RPC reports intent first, preserves arguments and cleans up on reconnect', async () => {
  const calls = [];
  const original = { checkForUpdates() {}, async installUpdate(...args) {
    assert.equal(this, original);
    calls.push(['install', ...args]);
    return 7;
  } };
  const services = { appUpdates: original };
  const client = { connected: true, async request(command, payload) { calls.push([command, payload.intent]); } };
  const context = vm.createContext({ __codexScriptLoaderHostBridge: client,
    document: { readyState: 'complete', querySelectorAll: () => [{ href: 'app://-/assets/app-shared-fixture.js' }], removeEventListener() {} },
    loadModule: async () => ({ renamedExport: services }), setTimeout,
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  assert.equal(client.lifecycleObserver, 'attached');
  assert.equal(services.appUpdates.checkForUpdates, original.checkForUpdates);
  assert.equal(await services.appUpdates.installUpdate('fixture'), 7);
  assert.deepEqual(calls, [['codex_lifecycle_intent', 'restart'], ['install', 'fixture']]);
  client.stopLifecycleObserver();
  assert.equal(services.appUpdates, original);
  const failure = new Error('native update rejected');
  original.installUpdate = async () => { throw failure; };
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  await assert.rejects(services.appUpdates.installUpdate(), error => error === failure);
  assert.deepEqual(calls.at(-1), ['codex_lifecycle_intent', 'cancel-restart']);
  const replacement = {};
  services.appUpdates = replacement;
  client.stopLifecycleObserver();
  assert.equal(services.appUpdates, replacement, 'cleanup respects another runtime replacing the service');
});

test('disposal while the native module is loading prevents a late wrapper', async () => {
  let resolve;
  const original = { installUpdate() {} }, services = { appUpdates: original };
  const client = { connected: true, request() { throw Error('must not report'); } };
  vm.runInNewContext(source, { __codexScriptLoaderHostBridge: client,
    document: { readyState: 'complete', querySelectorAll: () => [{ href: 'app://-/assets/app-shared-fixture.js' }], removeEventListener() {} },
    loadModule: () => new Promise(done => { resolve = done; }), setTimeout,
  });
  client.stopLifecycleObserver();
  resolve({ service: services });
  await Promise.resolve();
  assert.equal(services.appUpdates, original);
});
