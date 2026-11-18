import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveObserverCheckpointPayload, readArchivedObserverRows, readObserverHistoryArchives } from '../src/codelync/observer-history.mjs';
import { DesktopSourceSubscriptions, DESKTOP_SOURCE_APPS } from '../src/codelync/source-subscriptions.mjs';
import { CodelyncMacDaemon } from '../src/codelync/mac-daemon.mjs';
import { SourceRegistry, sourceKey } from '../src/codelync/source-registry.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */

function deferred() {
  /** @type {(value?:unknown)=>void} */ let resolve = () => {};
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

/** @param {Value} identity @param {Value[]} events @param {Value[]} rows @param {Uint8Array} key */
function buildSignedArchive(identity, events, rows, key) {
  const identityStr = JSON.stringify([
    identity.happySessionId, identity.nativeId, identity.bindingId,
    identity.source?.app, identity.source?.id, identity.source?.hostId, identity.keyFingerprint,
  ]);
  const digest = createHmac('sha256', key)
    .update(identityStr).update('\n')
    .update(JSON.stringify(events)).update('\n')
    .update(JSON.stringify(rows)).digest('hex');
  const plain = Buffer.from(JSON.stringify({ identity, events, rows }));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const ciphertext = Buffer.concat([Buffer.from([0]), nonce, encrypted, cipher.getAuthTag()]).toString('base64');
  return { digest, envelope: { format: 'codelync-observer-history-v1', ciphertext } };
}

test('R071: readArchivedObserverRows restores 3,100 rows across multiple archive segments in linear time without keeping historyRef', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-b8-r071-scale-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'projection.json');
  const key = new Uint8Array(32).fill(9);
  const identity = {
    happySessionId: 'b8-history-session',
    nativeId: 'b8-native-id',
    bindingId: 'b8-binding',
    source: { app: 'codex', id: 'b8-native-id', hostId: 'local' },
    keyFingerprint: 'b8-fp',
  };
  /** @type {Value[]} */ const originalRowsA = Array.from({ length: 1500 }, (_, i) => ({
    id: `row-a-${i}`, text: `archived body A ${i}`, revision: i, digest: `d-a-${i}`,
  }));
  /** @type {Value[]} */ const originalRowsB = Array.from({ length: 1600 }, (_, i) => ({
    id: `row-b-${i}`, output: `archived output B ${i}`, revision: i, digest: `d-b-${i}`,
  }));
  /** @type {Value} */ const state = {
    identity,
    activeRowIds: ['active-tail'],
    rows: [...structuredClone(originalRowsA), { id: 'active-tail', text: 'live tail' }],
    events: [{ id: 'evt-a', sent: true, ciphertext: 'cipher-a' }],
  };

  assert.equal(await archiveObserverCheckpointPayload(state, path, key, 0), true);
  state.rows.push(...structuredClone(originalRowsB));
  state.events.push({ id: 'evt-b', sent: true, ciphertext: 'cipher-b' });
  assert.equal(await archiveObserverCheckpointPayload(state, path, key, 0), true);
  assert.equal(state.observerHistoryArchives.length, 2);

  const activeIds = new Set([
    ...originalRowsA.map((/** @type {Value} */ r) => r.id),
    ...originalRowsB.map((/** @type {Value} */ r) => r.id),
  ]);
  const startedAt = performance.now();
  const restored = await readArchivedObserverRows(state, path, key, activeIds);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(restored.size, 3100);
  assert.ok(elapsedMs < 2000, `expected linear restoration to finish promptly, got ${elapsedMs}ms`);
  for (const row of [originalRowsA[0], originalRowsA[1499], originalRowsB[0], originalRowsB[1599]]) {
    const saved = restored.get(row.id);
    assert.ok(saved);
    assert.equal(Object.hasOwn(saved, 'historyRef'), false);
    assert.deepEqual(saved, row);
  }
  const empty = await readArchivedObserverRows(state, path, key, new Set());
  assert.equal(empty.size, 0);
});

test('R071: archive consistency checks reject duplicate rows, missing files without path leaks, and malformed inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-b8-r071-errors-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'projection.json');
  const key = new Uint8Array(32).fill(12);
  const identity = {
    happySessionId: 'b8-err-session',
    nativeId: 'b8-err-native',
    bindingId: 'b8-err-binding',
    source: { app: 'codex', id: 'b8-err-native', hostId: 'local' },
    keyFingerprint: 'b8-err-fp',
  };

  // Invalid identity / input structures fail with typed BridgeError
  await assert.rejects(
    readArchivedObserverRows({ identity, rows: 'not-an-array' }, path, key, new Set(['r1'])),
    (/** @type {unknown} */ e) => e instanceof BridgeError && e.code === 'observer-history-invalid',
  );
  await assert.rejects(
    readObserverHistoryArchives({ identity: ['invalid'], rows: [], events: [] }, path, key),
    (/** @type {unknown} */ e) => e instanceof BridgeError && e.code === 'observer-history-invalid',
  );

  // Duplicate archived row ID inside a signed archive rejects explicitly
  const dupRows = [{ id: 'dup-row', text: 'first' }, { id: 'dup-row', text: 'second' }];
  const dupSigned = buildSignedArchive(identity, [], dupRows, key);
  const dupState = {
    identity,
    observerHistoryArchives: [{ digest: dupSigned.digest, count: 0, rowCount: 2 }],
    rows: [{ id: 'dup-row', historyRef: dupSigned.digest }],
    events: [],
  };
  const goodState = {
    identity,
    activeRowIds: [],
    rows: [{ id: 'r1', text: 'alpha' }],
    events: [],
  };
  await archiveObserverCheckpointPayload(goodState, path, key, 0);
  const validDigest = /** @type {Value} */ (goodState).observerHistoryArchives[0].digest;
  await writeFile(join(path + '.history', `${dupSigned.digest}.json`), JSON.stringify(dupSigned.envelope));
  await assert.rejects(
    readArchivedObserverRows(dupState, path, key, new Set(['dup-row'])),
    (/** @type {unknown} */ e) => e instanceof BridgeError && e.code === 'observer-history-invalid',
  );

  // Duplicate reference digests reject explicitly
  const dupIndexState = {
    ...goodState,
    observerHistoryArchives: [
      /** @type {Value} */ (goodState).observerHistoryArchives[0],
      { .../** @type {Value} */ (goodState).observerHistoryArchives[0] },
    ],
  };
  await assert.rejects(
    readArchivedObserverRows(dupIndexState, path, key, new Set(['r1'])),
    (/** @type {unknown} */ e) => e instanceof BridgeError && e.code === 'observer-history-invalid',
  );

  // Missing archive file raises observer-history-unavailable without leaking raw tmpdir path
  await unlink(join(path + '.history', `${validDigest}.json`));
  await assert.rejects(
    readArchivedObserverRows(goodState, path, key, new Set(['r1'])),
    (/** @type {unknown} */ e) => e instanceof BridgeError && e.code === 'observer-history-unavailable' && !e.message.includes(directory),
  );
  await assert.rejects(
    readObserverHistoryArchives(goodState, path, key),
    (/** @type {unknown} */ e) => e instanceof BridgeError && e.code === 'observer-history-unavailable' && !e.message.includes(directory),
  );
});

/** @param {import('node:test').TestContext} t */
async function daemonFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-b8-daemon-'));
  const settings = new DesktopSourceSubscriptions({ path: join(directory, 'source-choices.json') });
  await settings.reload();
  const sources = [
    { app: 'codex', id: 'b8-codex-1', hostId: 'local', kind: 'session', workspace: '/fixture/project' },
  ];
  /** @param {Value} source @returns {Value} */
  const makeBinding = source => ({
    source,
    machineId: 'b8-machine',
    happySessionId: 'relay-' + source.id,
    sessionKey: randomBytes(32).toString('base64'),
    metadata: {
      client: { id: 'noninvasive-bridge' },
      machineId: 'b8-machine',
      path: source.workspace,
      bridge: { source, controlMode: 'session', sourceStatus: 'connected' },
      nativeSession: { title: source.id, updatedAt: 1, parentId: null, agentName: '', catalogueAvailable: true, archived: false },
      capabilities: { steering: true, abort: true, rpcMethods: ['abort'] },
    },
  });
  const bindings = new Map(sources.map(s => [sourceKey(s), makeBinding(s)]));
  const events = /** @type {string[]} */ ([]);
  const controls = /** @type {Value} */ ({ startGate: null, factoryGate: null, closeGate: null, failNextClose: 0 });
  const counts = { created: 0, started: 0, closed: 0, closeAttempts: 0 };
  const actors = /** @type {Value[]} */ ([]);
  const connection = { socket: { connected: true }, registerRpc() {}, waitForConnect: async () => {}, close() {} };
  const registry = /** @type {Value} */ ({
    machine: async () => ({ id: 'b8-machine', metadata: {} }),
    savedBindings: async () => [...bindings.values()],
    register: async (/** @type {Value} */ s) => bindings.get(sourceKey(s)) ?? makeBinding(s),
    queueMetadata: async (/** @type {Value} */ b, /** @type {Value} */ _sock, /** @type {(v:Value)=>Value} */ fn) => { b.metadata = fn(b.metadata); },
    markDisabled: async (/** @type {Value} */ b, /** @type {Value} */ sock) => SourceRegistry.prototype.markDisabled.call(/** @type {any} */ (registry), b, /** @type {any} */ (sock)),
    markEnabled: async (/** @type {Value} */ b, /** @type {Value} */ sock) => SourceRegistry.prototype.markEnabled.call(/** @type {any} */ (registry), b, /** @type {any} */ (sock)),
  });
  const makeOptions = () => ({
    directory: join(directory, 'connector'),
    leaseDirectory: join(directory, 'leases'),
    sourceSubscriptions: settings,
    account: { serverUrl: 'http://127.0.0.1:9', token: 'b8-token', secret: randomBytes(32).toString('base64url') },
    registry,
    machineConnection: () => connection,
    activityFactory: () => ({ intrinsicRefresh() {}, close() {} }),
    discovery: {
      discover: async () => ({
        sources: sources.filter(s => settings.isEnabled(s.app)),
        inventoryApps: DESKTOP_SOURCE_APPS.filter(a => settings.isEnabled(a)),
        activityInventoryApps: DESKTOP_SOURCE_APPS.filter(a => settings.isEnabled(a)),
        errors: [],
      }),
      adapter: () => ({}),
      reconcileSubscriptions: async () => {},
    },
    sourceFactory: async (/** @type {Value} */ input) => {
      if (controls.factoryGate) await controls.factoryGate;
      counts.created++;
      const index = counts.created;
      events.push(`create:${index}`);
      const actor = {
        index,
        sourceApp: input.binding.source.app,
        lease: input.assertHostLease,
        closed: false,
        openDesktop: async () => {},
        start: async () => {
          counts.started++;
          events.push(`start:${index}`);
          if (controls.startGate) await controls.startGate;
        },
        close: async () => {
          counts.closeAttempts++;
          events.push(`close-begin:${index}`);
          if (controls.closeGate) await controls.closeGate;
          if (controls.failNextClose > 0) {
            controls.failNextClose--;
            throw new Error('simulated close error');
          }
          if (!actor.closed) {
            actor.closed = true;
            counts.closed++;
          }
          events.push(`close-end:${index}`);
        },
        status: () => ({ sourceStatus: actor.closed ? 'disconnected' : 'connected' }),
      };
      actors.push(actor);
      return actor;
    },
  });
  const daemon = new CodelyncMacDaemon(makeOptions());
  await daemon.start();
  t.after(async () => {
    await daemon.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, settings, daemon, makeOptions, key: sourceKey(sources[0]), counts, actors, controls, events };
}

test('R076: observeSource durably persists active-sources.json before resolving, survives restart, and rolls back on disable', async t => {
  const f = await daemonFixture(t);
  const heldStart = deferred();
  f.controls.startGate = heldStart.promise;

  // observeSource resolves with syncStarting:true BEFORE actor.start() finishes, yet active-sources.json is already written.
  const response = await f.daemon.observeSource({ sourceKey: f.key, commandId: 'b8-observe-cmd-1' });
  assert.equal(response.ok, true);
  assert.equal(f.daemon.restored.has(f.key), true);
  const persisted = JSON.parse(await readFile(join(f.directory, 'connector', 'active-sources.json'), 'utf8'));
  assert.deepEqual(persisted.keys, [f.key]);

  heldStart.resolve();
  await Promise.all([...f.daemon.starts.values()]);
  await f.daemon.close();

  // Reconstruct a new daemon on the same directory and verify automatic restoration of observed source.
  f.controls.startGate = null;
  const restarted = new CodelyncMacDaemon(f.makeOptions());
  t.after(async () => restarted.close().catch(() => {}));
  await restarted.start();
  await flush();
  await Promise.allSettled([...restarted.activating.values(), ...restarted.starts.values()]);
  assert.equal(restarted.restored.has(f.key), true);
  assert.equal(restarted.actors.has(f.key), true);
  assert.equal(f.counts.created, 2);

  // Verify rollback if source is disabled mid-saveRestored inside observeSource.
  await restarted.close();
  const f2 = await daemonFixture(t);
  const heldSave = deferred();
  const originalSave = f2.daemon.saveRestored.bind(f2.daemon);
  f2.daemon.saveRestored = async () => {
    await heldSave.promise;
    return originalSave();
  };
  const observing = f2.daemon.observeSource({ sourceKey: f2.key, commandId: 'b8-observe-rollback-1' });
  await flush();
  await f2.settings.setEnabledApps(['antigravity', 'claude-desktop']);
  f2.daemon.fenceSourceSubscriptions();
  heldSave.resolve();
  await assert.rejects(observing, { code: 'source-unavailable' });
  assert.equal(f2.daemon.restored.has(f2.key), false);
  const afterRollback = JSON.parse(await readFile(join(f2.directory, 'connector', 'active-sources.json'), 'utf8'));
  assert.deepEqual(afterRollback.keys, []);
});

test('R076: sourceClosures blocks new actor creation until prior actor finishes closing and retains/retries failed closures', async t => {
  const f = await daemonFixture(t);
  await f.daemon.observeSource({ sourceKey: f.key, commandId: 'b8-closure-obs-1' });
  await Promise.all([...f.daemon.starts.values()]);
  assert.equal(f.counts.created, 1);

  // Disable codex while actor 1 close is held in flight.
  const heldClose = deferred();
  f.controls.closeGate = heldClose.promise;
  await f.settings.setEnabledApps(['antigravity', 'claude-desktop']);
  f.daemon.fenceSourceSubscriptions();
  await flush();
  assert.equal(f.daemon.actors.size, 0);
  assert.equal(f.daemon.sourceClosures.get(f.key)?.size, 1);

  // Re-enable codex and rescan so daemon.sources has the descriptor while actor 1 close is still pending.
  await f.settings.setEnabledApps(DESKTOP_SOURCE_APPS);
  f.daemon.fenceSourceSubscriptions();
  await f.daemon.scan();
  const prepPromise = f.daemon.prepareSource(f.key);
  await flush();
  // Critical invariant: actor 2 must NOT be created while actor 1 close is still running.
  assert.equal(f.counts.created, 1);
  assert.equal(f.actors[0].closed, false);

  f.controls.closeGate = null;
  heldClose.resolve();
  const actor2 = await prepPromise;
  assert.equal(actor2.index, 2);
  assert.equal(f.actors[0].closed, true);
  assert.equal(f.daemon.sourceClosures.has(f.key), false);
  assert.ok(f.events.indexOf('close-end:1') < f.events.indexOf('create:2'));

  // Failure during initial close retains entry in sourceClosures, reconcileSourceSubscriptions retries & recovers cleanly.
  f.controls.failNextClose = 1;
  await f.settings.setEnabledApps([]);
  f.daemon.fenceSourceSubscriptions();
  await flush();
  assert.equal(f.actors[1].closed, false);
  assert.equal(f.daemon.sourceClosures.get(f.key)?.size, 1);

  await assert.rejects(f.daemon.reconcileSourceSubscriptions(), { code: 'source-subscriptions-apply-pending' });
  await flush();
  assert.equal(f.actors[1].closed, true);
  assert.equal(f.daemon.sourceClosures.has(f.key), false);

  // Clean follow-up reconcile succeeds once closure retry completed.
  const status = await f.daemon.reconcileSourceSubscriptions();
  assert.equal(status.running, true);
});
