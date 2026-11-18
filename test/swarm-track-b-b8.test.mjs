import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairCodelync } from '../src/codelync/discovery-pairing.mjs';
import { LocalSourceDiscovery } from '../src/codelync/discovery.mjs';
import { DesktopSourceSubscriptions, DESKTOP_SOURCE_APPS, parseEnabledDesktopApps } from '../src/codelync/source-subscriptions.mjs';
import { SourceSubscriptionCommands } from '../src/codelync/source-subscription-commands.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */

function deferred() {
  /** @type {(value?:any)=>void} */ let resolve = () => {};
  /** @type {(reason?:any)=>void} */ let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('R072: pairCodelync checks signal.aborted synchronously before arming long poll timer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-pair-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  let fetchCalls = 0;
  const started = Date.now();
  await assert.rejects(
    pairCodelync({
      accountPath: join(directory, 'account.json'),
      serverUrl: 'http://127.0.0.1:9999',
      pollMs: 60_000,
      signal: controller.signal,
      onLink: () => { controller.abort(Error('aborted-in-onLink')); },
      fetch: /** @type {typeof fetch} */ (async () => {
        fetchCalls++;
        return new Response(JSON.stringify({ state: 'requested' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    }),
    /aborted-in-onLink/,
  );
  assert.equal(fetchCalls, 1);
  assert.ok(Date.now() - started < 1000, 'should abort without waiting for pollMs timer');
});

test('R072: pairCodelync aborts active poll wait immediately and cancels timer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-pair-wait-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  let fetchCalls = 0;
  const started = Date.now();
  setTimeout(() => controller.abort(Error('aborted-while-waiting')), 15);
  await assert.rejects(
    pairCodelync({
      accountPath: join(directory, 'account.json'),
      serverUrl: 'http://127.0.0.1:9999',
      pollMs: 60_000,
      signal: controller.signal,
      fetch: /** @type {typeof fetch} */ (async () => {
        fetchCalls++;
        return new Response(JSON.stringify({ state: 'requested' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    }),
    /aborted-while-waiting/,
  );
  assert.equal(fetchCalls, 1);
  assert.ok(Date.now() - started < 1000);
});

test('R072: stale discoverAntigravity rejection across reconcileSubscriptions does not NPE or mutate replacement backend', async t => {
  const settings = new DesktopSourceSubscriptions({ path: '/fixture/source-choices.json', read: async () => null, write: async () => {} });
  await settings.reload();
  await settings.setEnabledApps(['antigravity']);
  const firstList = deferred();
  let created = 0;
  const backend1 = {
    list: async () => firstList.promise,
    activityInventoryComplete: true,
    inventoryComplete: true,
    residentCatalog: [{ app: 'antigravity', id: 'old-resident' }],
    dispose: async () => {},
  };
  const backend2 = {
    list: async () => [{ app: 'antigravity', kind: 'session', id: 'new-ag', hostId: 'local:antigravity:' + 'a'.repeat(64), protocol: 'antigravity-connect', runtimeGeneration: 'owner-2' }],
    activityInventoryComplete: true,
    inventoryComplete: true,
    residentCatalog: [{ app: 'antigravity', id: 'new-resident' }],
    dispose: async () => {},
  };
  const discovery = new LocalSourceDiscovery({
    sourceSubscriptions: settings,
    storage: { list: async () => [] },
    antigravityBackendFactory: () => (++created === 1 ? backend1 : backend2),
  });
  t.after(() => discovery.close());

  const scan1 = discovery.discover();
  await Promise.resolve();
  await settings.setEnabledApps([]);
  await discovery.reconcileSubscriptions();
  await settings.setEnabledApps(['antigravity']);
  const scan2 = await discovery.discover();
  assert.equal(scan2.sources.length, 1);
  assert.equal(backend2.inventoryComplete, true);

  firstList.reject(Object.assign(Error('stale-antigravity-failure'), { code: 'antigravity-unavailable' }));
  const stale = await scan1;
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.sources, []);
  assert.equal(backend2.inventoryComplete, true);
});

test('R072: deferred discover microtasks skip work when invalidated and concurrent reconcileSubscriptions shares disposal flight', async t => {
  const settings = new DesktopSourceSubscriptions({ path: '/fixture/source-choices.json', read: async () => null, write: async () => {} });
  await settings.reload();
  await settings.setEnabledApps(['codex']);
  let listCalls = 0, disposeCalls = 0;
  const disposeGate = deferred();
  const closedDiscovery = new LocalSourceDiscovery({
    sourceSubscriptions: settings,
    storage: { list: async () => { listCalls++; return [{ id: 'codex-1' }]; } },
    codexBackendFactory: () => ({ dispose: async () => {} }),
  });
  const staleScan = closedDiscovery.discover();
  const closing = closedDiscovery.close();
  const [staleResult] = await Promise.all([staleScan, closing]);
  assert.equal(staleResult.stale, true);
  assert.equal(listCalls, 0);

  const discovery = new LocalSourceDiscovery({
    sourceSubscriptions: settings,
    storage: { list: async () => { listCalls++; return [{ id: 'codex-1' }]; } },
    codexBackendFactory: () => ({ dispose: async () => { disposeCalls++; await disposeGate.promise; } }),
  });
  t.after(() => { disposeGate.resolve(); return discovery.close(); });

  const liveScan = await discovery.discover();
  assert.equal(liveScan.sources.length, 1);
  assert.equal(listCalls, 1);

  await settings.setEnabledApps([]);
  const r1 = discovery.reconcileSubscriptions();
  const r2 = discovery.reconcileSubscriptions();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(disposeCalls, 1);
  disposeGate.resolve();
  await Promise.all([r1, r2]);
  assert.equal(discovery.pendingProviderDisposals.size, 0);
});

test('R077: parseEnabledDesktopApps and DesktopSourceSubscriptions harden malformed configs and coalesce concurrent noop saves', async () => {
  // Sparse array check
  const sparse = ['codex', , 'antigravity'];
  assert.throws(() => parseEnabledDesktopApps(sparse), { code: 'invalid-source-subscriptions' });

  /** @type {unknown} */ let nextRead = null;
  let writes = 0;
  const settings = new DesktopSourceSubscriptions({
    path: '/fixture/source-choices.json',
    read: async () => nextRead,
    write: async () => { writes++; },
  });

  await settings.reload();
  assert.equal(settings.snapshot().known, true);
  await assert.rejects(settings.setEnabledApps(['unknown-app']), { code: 'invalid-source-subscriptions' });

  // Malformed objects: non-plain prototype, getter property, non-enumerable extra property
  const dateObj = Object.assign(new Date(), { version: 1, enabledApps: ['codex'] });
  const getterObj = { version: 1, get enabledApps() { return ['codex']; } };
  const hiddenExtra = Object.defineProperty({ version: 1, enabledApps: ['codex'] }, 'hidden', { value: 1, enumerable: false });
  for (const bad of [dateObj, getterObj, hiddenExtra, undefined]) {
    nextRead = bad;
    const snap = await settings.reload();
    assert.equal(snap.known, false);
    assert.deepEqual(snap.enabledApps, []);
  }

  // Concurrent identical saves write only once
  await Promise.all([settings.setEnabledApps(['codex']), settings.setEnabledApps(['codex']), settings.setEnabledApps(['codex'])]);
  assert.equal(writes, 1);
  assert.deepEqual(settings.snapshot().enabledApps, ['codex']);

  // Repeated noop after configured writes 0 additional times
  await settings.setEnabledApps(['codex']);
  assert.equal(writes, 1);
});

test('R077: SourceSubscriptionCommands coalesces noop sets, keeps retry on apply-pending, preserves save error code, and isolates tail errors', async () => {
  let writes = 0, fences = 0, reconciles = 0, changes = 0, failWrite = false, failApply = false, throwNotifyOnce = false;
  /** @type {Value[]} */ const messages = [];
  const settings = new DesktopSourceSubscriptions({
    path: '/fixture/source-choices.json',
    read: async () => ({ version: 1, enabledApps: ['codex'] }),
    write: async () => { writes++; if (failWrite) throw Error('disk-full'); },
  });
  await settings.reload();
  const daemon = {
    fenceSourceSubscriptions: () => { fences++; },
    reconcileSourceSubscriptions: async () => {
      reconciles++;
      if (failApply) throw new BridgeError('source-subscriptions-apply-pending', 'Fixture apply pending');
    },
  };
  const commands = new SourceSubscriptionCommands({
    settings,
    daemon: () => daemon,
    notify: msg => {
      if (throwNotifyOnce && msg.type === 'source-subscriptions-result') {
        throwNotifyOnce = false;
        throw Error('transient-pipe-error');
      }
      messages.push(msg);
    },
    changed: () => { changes++; },
  });

  // First set changes enabledApps -> reconciles
  assert.equal(commands.handle({ type: 'set-source-subscriptions', requestId: 'cmd-first-change', apps: ['antigravity'] }), true);
  await commands.idle();
  assert.equal(writes, 1);
  assert.equal(fences, 1);
  assert.equal(reconciles, 1);
  assert.equal(changes, 2);

  // Duplicate noop set on already-reconciled daemon -> coalesced (no redundant fence/reconcile/changed)
  assert.equal(commands.handle({ type: 'set-source-subscriptions', requestId: 'cmd-noop-coalesce', apps: ['antigravity'] }), true);
  await commands.idle();
  assert.equal(writes, 1);
  assert.equal(fences, 1);
  assert.equal(reconciles, 1);
  assert.equal(changes, 2);
  assert.deepEqual(messages.at(-1), { type: 'source-subscriptions-result', requestId: 'cmd-noop-coalesce', ok: true });

  // Failed apply keeps retryable reconcile even on noop save
  failApply = true;
  assert.equal(commands.handle({ type: 'set-source-subscriptions', requestId: 'cmd-fail-apply', apps: [] }), true);
  await commands.idle();
  assert.equal(writes, 2);
  assert.equal(reconciles, 2);
  assert.equal(messages.at(-1)?.code, 'source-subscriptions-apply-pending');

  failApply = false;
  assert.equal(commands.handle({ type: 'set-source-subscriptions', requestId: 'cmd-retry-apply', apps: [] }), true);
  await commands.idle();
  assert.equal(writes, 2);
  assert.equal(reconciles, 3);
  assert.equal(messages.at(-1)?.ok, true);

  // Save failure while snapshot is !known still reports source-subscriptions-save-failed
  const brokenSettings = new DesktopSourceSubscriptions({
    path: '/fixture/broken-choices.json',
    read: async () => ({ version: 99, enabledApps: [] }),
    write: async () => { if (failWrite) throw Error('disk-full'); },
  });
  await brokenSettings.reload();
  assert.equal(brokenSettings.snapshot().known, false);
  /** @type {Value[]} */ const brokenMessages = [];
  const brokenCommands = new SourceSubscriptionCommands({
    settings: brokenSettings,
    daemon: () => daemon,
    notify: msg => brokenMessages.push(msg),
  });
  failWrite = true;
  brokenCommands.handle({ type: 'set-source-subscriptions', requestId: 'cmd-save-while-unknown', apps: DESKTOP_SOURCE_APPS });
  await brokenCommands.idle();
  assert.equal(brokenMessages.at(-1)?.code, 'source-subscriptions-save-failed');
  failWrite = false;

  // Notify throw cannot poison command queue tail
  throwNotifyOnce = true;
  commands.handle({ type: 'set-source-subscriptions', requestId: 'cmd-notify-throws', apps: ['codex'] });
  await commands.idle();
  commands.handle({ type: 'set-source-subscriptions', requestId: 'cmd-after-throw', apps: ['codex'] });
  await commands.idle();
  assert.deepEqual(messages.at(-1), { type: 'source-subscriptions-result', requestId: 'cmd-after-throw', ok: true });
});
