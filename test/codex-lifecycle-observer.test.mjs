import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../windows/src/CodexScriptLoader.Windows/ManagedCodexLifecycleObserver.cs', import.meta.url), 'utf8')).split('"""')[1].replace('url => import(url)', 'loadModule');
function fixture(preflight = async () => ({restartRegistrationVerified: true}), install) {
  const calls = [], alerts = [];
  const original = {checkForUpdates() { assert.equal(this, original); return 9; }, async installUpdate(...args) {
    assert.equal(this, original);
    calls.push(['install', ...args]);
    return install ? install(...args) : 7;
  }};
  const services = {appUpdates: original};
  const exports = {appServices: services};
  const runtime = Object.assign(() => { throw Error('must not execute new app modules'); }, {c: {arbitraryId: {exports}}});
  let timer;
  const client = {connected: true, async request(command, payload) {
    if (command === 'codex_lifecycle_observer_status') return {};
    calls.push([command, payload.intent]);
    return payload.intent === 'restart' ? preflight() : {};
  }};
  vm.runInNewContext(source, {__codexScriptLoaderHostBridge: client,
    document: {querySelectorAll: () => [{src: 'app://-/assets/123.current.js'}]},
    loadModule: async () => ({__webpack_require__: runtime}),
    setTimeout: callback => {timer = callback; return 1;}, clearTimeout: () => {timer = null;},
    alert: text => alerts.push(text),
  });
  return {calls, alerts, original, services, exports, client, tick: () => timer?.()};
}

test('native updater waits for verified registration and preserves arguments, receiver and result', async () => {
  let release;
  const h = fixture(() => new Promise(resolve => {release = resolve;}));
  await new Promise(setImmediate);
  assert.equal(h.client.lifecycleObserver, 'attached');
  assert.equal(h.services.appUpdates.checkForUpdates(), 9);
  const first = h.services.appUpdates.installUpdate('fixture');
  const second = h.services.appUpdates.installUpdate('fixture');
  assert.equal(h.calls.length, 1, 'original update cannot begin before host acknowledgement');
  release({restartRegistrationVerified: true});
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  assert.deepEqual(h.calls, [['codex_lifecycle_intent', 'restart'], ['install', 'fixture']]);
  h.client.stopLifecycleObserver();
  assert.equal(h.services.appUpdates, h.original);
});

test('failed or unverified registration reports the failure without starting the updater', async () => {
  for (const preflight of [async () => {throw Error('registration failed');}, async () => ({accepted: true})]) {
    const h = fixture(preflight);
    await new Promise(setImmediate);
    await assert.rejects(h.services.appUpdates.installUpdate());
    assert.equal(h.calls.some(call => call[0] === 'install'), false);
    assert.equal(h.alerts.length, 1);
    h.client.stopLifecycleObserver();
  }
});

test('native updater rejection clears restart intent and preserves the original error', async () => {
  const failure = Error('native update rejected');
  const h = fixture(undefined, () => {throw failure;});
  await new Promise(setImmediate);
  await assert.rejects(h.services.appUpdates.installUpdate(), error => error === failure);
  assert.deepEqual(h.calls.at(-1), ['codex_lifecycle_intent', 'cancel-restart']);
  h.client.stopLifecycleObserver();
});

test('service replacement is reattached and disposal respects unrelated replacements', async () => {
  const h = fixture();
  await new Promise(setImmediate);
  const nextOriginal = {installUpdate: async () => 8};
  const next = {appUpdates: nextOriginal};
  h.exports.appServices = next;
  await h.tick();
  assert.equal(h.services.appUpdates, h.original);
  assert.equal(await next.appUpdates.installUpdate(), 8);
  const replacement = {};
  next.appUpdates = replacement;
  h.client.stopLifecycleObserver();
  assert.equal(next.appUpdates, replacement);
});

test('disposal during module import prevents a late attachment', async () => {
  let resolve;
  const original = {installUpdate() {}}, services = {appUpdates: original};
  const runtime = Object.assign(() => {}, {c: {one: {exports: {appServices: services}}}});
  const client = {connected: true};
  vm.runInNewContext(source, {__codexScriptLoaderHostBridge: client,
    document: {querySelectorAll: () => [{src: 'app://-/assets/123.current.js'}]},
    loadModule: () => new Promise(done => {resolve = done;}), setTimeout, clearTimeout});
  client.stopLifecycleObserver();
  resolve({__webpack_require__: runtime});
  await new Promise(setImmediate);
  assert.equal(services.appUpdates, original);
});
