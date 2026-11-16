import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeProjectActivityService } from '../src/happy/project-activity.mjs';
import { CodexActivityObserver } from '../src/adapters/codex-activity.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {number} index @param {Value} [extra] */
function source(index, extra = {}) { return { app: 'codex', kind: 'session', id: `thread-${index}`, relayId: `phone-${index}`, hostId: 'local', workspace: '/project', updatedAt: index, ...extra }; }
const group = { id: 'project', projectKey: '/project', hostId: 'local' };
async function flush() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }
/** @param {NativeProjectActivityService} service @param {number} requestSeq @param {Value[]} [groups] */
function poll(service, requestSeq, groups = [group]) { return service.poll({ clientId: 'phone', requestSeq, groups: /** @type {any} */ (groups) }); }

class NativeIpc {
  socket = { destroyed: false }; clientId = 'synthetic-follower'; owner = 'local:original'; hostId = 'local';
  subscriptions = 0; refreshes = 0; releases = 0; frameBytes = 0; failStart = false;
  callbacks = /** @type {Map<string,Set<(frame:Value)=>void>>} */ (new Map());
  state = { threadRuntimeStatus: { type: 'active', activeFlags: [] }, requests: /** @type {Value[]} */ ([]), turns: [
    { turnId: 'native-turn', status: 'inProgress', items: [{ type: 'agentMessage', id: 'answer', text: 'PRIVATE_LOADED_BODY'.repeat(40000) }] },
  ] };
  /** @param {string} _id */ generation(_id) { return this.owner; }
  async connect() {}
  /** @param {string} id @param {(frame:Value)=>void} callback */
  async subscribe(id, callback) {
    this.subscriptions++;
    if (this.failStart) throw Error('Synthetic owner is unavailable');
    let callbacks = this.callbacks.get(id); if (!callbacks) { callbacks = new Set(); this.callbacks.set(id, callbacks); }
    callbacks.add(callback); this.snapshot(id);
    return () => { const current = this.callbacks.get(id); if (current?.delete(callback)) this.releases++; if (!current?.size) this.callbacks.delete(id); };
  }
  /** @param {string} id @param {Value} change */
  emit(id, change) {
    const frame = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: this.owner.split(':').at(-1), params: { conversationId: id, hostId: 'local', change } };
    // Codex IPC uses a four-byte frame prefix and UTF-8 JSON.
    this.frameBytes += Buffer.byteLength(JSON.stringify(frame)) + 4; for (const callback of this.callbacks.get(id) ?? []) callback(frame);
  }
  /** @param {string} id */ snapshot(id) { this.emit(id, { type: 'snapshot', revision: 1, conversationState: this.state }); }
  /** @param {string} id */ async refreshSnapshot(id) { this.refreshes++; this.snapshot(id); }
  dispose() { this.socket.destroyed = true; this.callbacks.clear(); }
}

test('Mac status stays live after phone release with no additional ready snapshots or body retention', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let now = 1000;
  const ipc = new NativeIpc(), service = new NativeProjectActivityService({ sources: () => [source(0)], inventoryAvailable: () => true,
    now: () => now, ipcFactory: () => ipc, observerFactory: options => new CodexActivityObserver(/** @type {any} */ (options)) });
  t.after(() => service.close());
  service.intrinsicRefresh(); await flush();
  assert.equal(service.interests.size, 0); assert.equal(ipc.subscriptions, 1); assert.equal(ipc.refreshes, 0);
  const snapshotBytes = ipc.frameBytes, replicaBytes = Buffer.byteLength(JSON.stringify(service.entries.values().next().value?.observer.replica));
  assert.ok(snapshotBytes > 500000); assert.ok(replicaBytes < 1000);
  assert.equal(JSON.stringify(service.entries.values().next().value?.observer.replica).includes('PRIVATE_LOADED_BODY'), false);
  assert.equal(poll(service, 1).groups[0].active, 1); poll(service, 2, []);
  now += 31000; t.mock.timers.tick(31000); await flush();
  assert.equal(service.entries.size, 1); assert.equal(ipc.releases, 0); assert.equal(ipc.subscriptions, 1); assert.equal(ipc.refreshes, 0);
  ipc.emit('thread-0', { type: 'patches', baseRevision: 1, revision: 2, patches: [
    { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' }, { op: 'add', path: ['requests', 0], value: { id: 'native-permission' } },
  ] });
  const resumed = poll(service, 3).groups[0]; assert.equal(resumed.active, 0); assert.equal(resumed.waiting, 1); assert.equal(resumed.unknown, 0);
  assert.equal(ipc.subscriptions, 1); assert.equal(ipc.refreshes, 0);
  console.log(JSON.stringify({ fixtureOnly: true, initialNativeFrameBytes: snapshotBytes, retainedStatusReplicaBytes: replicaBytes,
    nativeLoadedSnapshotSubscriptions: ipc.subscriptions, additionalReadySnapshotReads: ipc.refreshes, completeHistoryCalls: 0 }));
});

test('background admission covers each app, prioritizes visible rows and leaves overflow unknown', async t => {
  const ag = source(500, { app: 'antigravity', protocol: 'antigravity-connect', runtimeGeneration: 'ag-owner', hostId: 'local:antigravity:' + 'a'.repeat(64), updatedAt: -100 });
  const claude = source(600, { app: 'claude-desktop', protocol: 'claude-desktop-native', runtimeGeneration: 'claude-owner', hostId: 'local:claude-desktop:' + 'b'.repeat(64), appMode: 'code', nativeCollection: 'claude-code-sessions', updatedAt: -200 });
  const sources = [...Array.from({ length: 140 }, (_, i) => source(i)), ag, claude,
    source(700, { isSubagent: true, parentId: 'thread-0', updatedAt: 999999 })];
  let activeReads = 0, peak = 0;
  const service = new NativeProjectActivityService({ sources: () => sources, inventoryAvailable: () => true, nativeAdapter: () => ({}), ipcFactory: () => ({}),
    observerFactory: options => { let known = false; return { status: () => ({ known, active: known && options.id !== 'thread-139', waiting: false, status: known ? 'ready' : 'refreshing' }),
      refresh: async () => { activeReads++; peak = Math.max(peak, activeReads); await Promise.resolve(); known = true; activeReads--; }, close() {} }; } });
  t.after(() => service.close()); service.intrinsicRefresh(); await flush();
  assert.equal(service.entries.size, 16); assert.equal(peak, 4);
  const admitted = [...service.entries.values()].map(entry => entry.source);
  assert.ok(['codex', 'antigravity', 'claude-desktop'].every(app => admitted.some(source => source.app === app)));
  assert.ok(admitted.some(source => source.id === 'thread-139')); assert.equal(admitted.some(source => source.id === 'thread-0' || source.id === 'thread-700'), false);
  assert.equal(service.entries.get(JSON.stringify(['codex', 'local', 'thread-139']))?.observer.status().active, false, 'recent admission is not active-state evidence');
  const visible = [{ ...group, sessions: [{ id: 'phone-0', nativeId: 'thread-0' }] }];
  const cold = poll(service, 1, visible).groups[0]; assert.ok(cold.sessions); assert.equal(cold.sessions[0].known, false);
  assert.equal(service.entries.values().next().value?.source.id, 'thread-0');
  await flush(); const result = poll(service, 2, visible).groups[0]; assert.ok(result.sessions);
  assert.equal(result.total, 140); assert.equal(result.unknown, 14); assert.equal(result.sessions[0].known, true); assert.equal(service.entries.size, 128);
  assert.ok(['antigravity', 'claude-desktop'].every(app => [...service.entries.values()].some(entry => entry.source.app === app)));
  assert.equal(peak, 4); poll(service, 3, []); await flush(); assert.equal(service.entries.size, 16);
});

test('shared current Antigravity activity needs no native list, steps or selected message reader', async t => {
  const host = 'local:antigravity:' + 'a'.repeat(64), native = source(1, { app: 'antigravity', protocol: 'antigravity-connect', runtimeGeneration: 'owner', hostId: host, updatedAt: 0 });
  let available = true, nativeReads = 0, active = true;
  const backend = { activityInventoryComplete: true, generation: () => 'owner', hostId: () => host, currentActivityAuthority: () => true,
    cachedActivity: () => ({ known: true, active, waiting: false, status: 'ready', observedAt: 1, generation: 'owner', aggregateActivity: { hostId: host } }),
    activity: async () => { nativeReads++; throw Error('Current headers must be reused'); }, snapshot: async () => { throw Error('No selected reader'); } };
  const service = new NativeProjectActivityService({ sources: () => [native], inventoryAvailable: () => available, nativeAdapter: () => backend });
  t.after(() => service.close()); service.intrinsicRefresh(); await flush();
  const groups = [{ ...group, hostId: host, app: 'antigravity' }];
  assert.equal(poll(service, 1, groups).groups[0].active, 1); assert.equal(nativeReads, 0);
  active = false; service.intrinsicRefresh(); await flush(); assert.equal(poll(service, 2, groups).groups[0].active, 0); assert.equal(nativeReads, 0);
  available = false; service.intrinsicRefresh(); await flush();
  assert.equal(service.entries.size, 1); const unavailable = poll(service, 3, groups).groups[0];
  assert.equal(unavailable.unknown, 1); assert.equal(unavailable.status, 'unavailable'); assert.equal(nativeReads, 0);
});

test('owner replacement cannot retain old activity and lease loss immediately releases native observers', async t => {
  let owned = true;
  const ipc = new NativeIpc(), service = new NativeProjectActivityService({ sources: () => [source(0)], inventoryAvailable: () => true, ownedAvailable: () => owned,
    ipcFactory: () => ipc, observerFactory: options => new CodexActivityObserver(/** @type {any} */ (options)) });
  t.after(() => service.close()); service.intrinsicRefresh(); await flush(); assert.equal(poll(service, 1).groups[0].unknown, 0);
  ipc.owner = 'local:replacement'; ipc.failStart = true;
  const unknown = poll(service, 2).groups[0]; assert.equal(unknown.unknown, 1); assert.equal(unknown.active, 0);
  await flush(); assert.equal(poll(service, 3).groups[0].unknown, 1);
  owned = false; service.intrinsicRefresh(); assert.equal(service.entries.size, 0); assert.equal(ipc.callbacks.size, 0);
  assert.equal(poll(service, 4).groups[0].unknown, 1); await flush(); assert.equal(service.entries.size, 0);
});

test('intrinsic cold failures retry on the bounded maintenance tick, and close clears all maintenance work', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let now = 1000, reads = 0;
  const service = new NativeProjectActivityService({ sources: () => [source(0)], inventoryAvailable: () => true, now: () => now, ipcFactory: () => ({}),
    observerFactory: () => ({ status: () => ({ known: false, active: false, waiting: false, status: 'unavailable' }), refresh: async () => { reads++; }, close() {} }) });
  t.after(() => service.close()); service.intrinsicRefresh(); await flush(); assert.equal(reads, 1);
  await flush(); assert.equal(reads, 1); now += 5000; t.mock.timers.tick(5000); await flush(); assert.equal(reads, 2);
  assert.equal(poll(service, 1).groups[0].unknown, 1); await flush();
  service.close(); const before = reads; now += 30000; t.mock.timers.tick(30000); await flush();
  assert.equal(reads, before); assert.equal(service.timer, null); assert.equal(service.intrinsicTimer, null); assert.equal(service.entries.size, 0);
  service.intrinsicRefresh(); assert.equal(service.entries.size, 0);
});

test('late intrinsic native completions cannot rebuild closed or lease-revoked state', async t => {
  let owned = true, finish = () => {};
  const service = new NativeProjectActivityService({ sources: () => [source(0)], inventoryAvailable: () => true, ownedAvailable: () => owned, ipcFactory: () => ({}),
    observerFactory: () => { let known = false, closed = false; return { status: () => ({ known, active: known, waiting: false, status: 'refreshing' }),
      refresh: () => new Promise(resolve => { finish = () => { if (!closed) known = true; resolve(undefined); }; }), close: () => { closed = true; } }; } });
  t.after(() => service.close()); service.intrinsicRefresh(); await flush(); assert.equal(service.inFlight, 1);
  owned = false; service.intrinsicRefresh(); assert.equal(service.entries.size, 0);
  finish(); await flush(); assert.equal(service.entries.size, 0); assert.equal(service.inFlight, 0);
  service.close(); finish(); await flush(); assert.equal(service.entries.size, 0);
});

test('already visited actors and children keep status coverage without entering ordinary project totals', async t => {
  const visited = source(0, { updatedAt: 0 }), child = source(900, { isSubagent: true, parentId: 'thread-0', updatedAt: 0 });
  let observed = [visited, child];
  const sources = [visited, ...Array.from({ length: 30 }, (_, i) => source(i + 1)), child];
  const service = new NativeProjectActivityService({ sources: () => sources, observedSources: () => observed, inventoryAvailable: () => true,
    ipcFactory: () => ({}), observerFactory: () => ({ status: () => ({ known: true, active: true, waiting: false, status: 'ready' }), refresh: async () => {}, close() {} }) });
  t.after(() => service.close()); service.intrinsicRefresh(); await flush();
  assert.equal(service.entries.size, 18); assert.equal(service.entries.values().next().value?.source.id, visited.id);
  assert.equal(service.cachedSourceStatus(child)?.active, true); assert.equal(service.cachedSourceStatus(visited)?.sameSource, true);
  assert.equal(poll(service, 1).groups[0].total, 31); poll(service, 2, []); await flush();
  assert.equal(service.entries.size, 18); observed = []; service.intrinsicRefresh(); await flush();
  assert.equal(service.entries.size, 16); assert.equal(service.cachedSourceStatus(child), null);
  assert.equal(service.cachedSourceStatus({ ...visited, protocol: 'foreign-protocol' }), null);
});

test('activity borrows same-host source IPC and releases only its own subscription', async t => {
  const ipc = new NativeIpc(); let bodyFrames = 0;
  const releaseBody = await ipc.subscribe('thread-0', () => { bodyFrames++; });
  const before = ipc.frameBytes;
  const service = new NativeProjectActivityService({ sources: () => [source(0)], observedSources: () => [source(0)], inventoryAvailable: () => true,
    nativeAdapter: () => ({ ipc }), observerFactory: options => new CodexActivityObserver(/** @type {any} */ (options)) });
  t.after(() => { service.close(); releaseBody(); ipc.dispose(); });
  service.intrinsicRefresh(); await flush(); assert.equal(service.ipcs.get('local'), ipc); assert.equal(service.borrowedIpcHosts.has('local'), true);
  assert.equal(service.cachedSourceStatus(source(0))?.active, true); assert.equal(ipc.subscriptions, 2);
  const sameIdSnapshotBytes = ipc.frameBytes - before;
  assert.ok(sameIdSnapshotBytes > 500000, 'the current native subscribe API still sends a loaded snapshot');
  service.close(); assert.equal(ipc.socket.destroyed, false); assert.equal(ipc.callbacks.get('thread-0')?.size, 1);
  ipc.snapshot('thread-0'); assert.equal(bodyFrames, 3);
  console.log(JSON.stringify({ fixtureOnly: true, sharedIpc: true, sameIdAdditionalSnapshotBytes: sameIdSnapshotBytes,
    bodySubscriberPreservedAfterStatusClose: true }));
});

test('a refresh returning an unchanged native capture deadline cannot spin a zero-delay read loop', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let now = 1000, reads = 0;
  const at = 1000;
  const service = new NativeProjectActivityService({ sources: () => [source(0)], inventoryAvailable: () => true, now: () => now, ipcFactory: () => ({}),
    observerFactory: () => { let initialized = false; const known = () => initialized && now - at < 5000; return {
      status: () => ({ known: known(), active: known(), waiting: false, status: known() ? 'ready' : 'unavailable' }),
      refreshDueAt: () => known() ? at + 3000 : null, refresh: async () => { reads++; initialized = true; }, close() {},
    }; } });
  t.after(() => service.close()); service.intrinsicRefresh(); await flush(); assert.equal(reads, 1);
  now += 3000; t.mock.timers.tick(3000); await flush(); assert.equal(reads, 2);
  now++; t.mock.timers.tick(1); await flush(); assert.equal(reads, 2);
  now = 6000; t.mock.timers.tick(1999); await flush(); assert.equal(reads, 3);
  assert.equal(service.cachedSourceStatus(source(0))?.known, false);
});

test('a healthy Codex baseline with partial subagent coverage stays unknown without repeated full snapshots', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let now = 1000; const ipc = new NativeIpc();
  ipc.state.threadRuntimeStatus.type = 'idle'; ipc.state.turns[0].status = 'completed';
  const service = new NativeProjectActivityService({ sources: () => [source(0)], inventoryAvailable: () => true, now: () => now,
    ipcFactory: () => ipc, observerFactory: options => new CodexActivityObserver(/** @type {any} */ (options)) });
  t.after(() => service.close()); service.intrinsicRefresh(); await flush();
  const observer = service.entries.values().next().value?.observer; assert.ok(observer);
  assert.equal(observer.status().ownKnown, true); assert.equal(observer.status().aggregateActivity.rosterComplete, false);
  assert.equal(observer.status().known, false); const captured = observer.status().observedAt, bytes = ipc.frameBytes;
  now += 30000; t.mock.timers.tick(30000); await flush();
  assert.equal(ipc.refreshes, 0, 'An unknown aggregate with a healthy baseline must not request another loaded-history snapshot');
  assert.equal(ipc.frameBytes, bytes); assert.equal(observer.status().observedAt, captured);
  assert.equal(poll(service, 1).groups[0].unknown, 1); assert.equal(poll(service, 2).groups[0].active, 0);
  assert.equal(observer.observationReady(), true);
});

test('slow absent-owner retries cannot starve never-attempted intrinsic sources within the same priority', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let now = 0; const started = /** @type {string[]} */ ([]);
  const service = new NativeProjectActivityService({ sources: () => Array.from({ length: 8 }, (_, i) => source(i)),
    inventoryAvailable: () => true, now: () => now, concurrency: 2, backgroundSources: 8, ipcFactory: () => ({}),
    observerFactory: options => ({ status: () => ({ known: false, active: false, waiting: false, status: 'unavailable' }),
      refresh: () => { started.push(options.id); return new Promise(resolve => setTimeout(() => resolve(undefined), 10000)); }, close() {} }) });
  t.after(() => service.close()); service.intrinsicRefresh(); await flush(); assert.equal(started.length, 2);
  for (let i = 0; i < 4; i++) { now += 5000; t.mock.timers.tick(5000); await flush(); }
  assert.equal(new Set(started).size, started.length, 'All never-attempted sources at this priority must start before retrying absent owners');
  assert.equal(started.length, 6); assert.ok(service.inFlight <= 2);
});
