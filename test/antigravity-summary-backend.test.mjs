import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityBackend, AntigravityActivityObserver } from '../src/adapters/antigravity-backend.mjs';
import { antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';

/** @typedef {Record<string,any>} Value */
const runtime = { binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server', home: '/fixture/home', appDataDir: 'fixture' };
/** @param {Value} [extra] */
function idle(extra = {}) { return { status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, hasRunningSubagents: false,
  hasActiveChildren: false, backgroundTaskCount: 0, ...extra }; }
/** @param {Value} scope @param {Value} initial @param {()=>number} now */
function streamFixture(scope, initial, now) {
  let available = true, epoch = 'epoch-one', revision = 1;
  const headers = new Map(Object.entries(initial)), captures = new Map(Object.keys(initial).map(id => [id, now()]));
  /** @type {Set<(change:Value)=>void>} */ const listeners = new Set();
  const stream = {
    readCount: 0, disposed: false,
    /** @param {(change:Value)=>void} listener */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** @param {string[]} ids @param {Value} context */
    getReplica(ids, context) {
      const current = available && !this.disposed && context.expectedHostId === scope.hostId && context.generation === scope.generation;
      const result = /** @type {Value} */ ({}), states = /** @type {Value} */ ({}), times = /** @type {Value} */ ({});
      for (const id of ids) {
        states[id] = current && headers.has(id) ? 'ready' : 'unknown';
        if (states[id] === 'ready') { result[id] = structuredClone(headers.get(id)); times[id] = captures.get(id); }
      }
      return { available: current, scope, streamEpoch: epoch, headers: result, states, captures: times, revision,
        complete: current && ids.every(id => states[id] === 'ready'), observedAt: now(),
        liveProof: current ? { ...scope, streamEpoch: epoch, currentAlive: true, fullReplacement: true, proto3Defaults: true } : null };
    },
    /** @param {string[]} ids @param {Value} context */
    async read(ids, context) { this.readCount++; return this.getReplica(ids, context); },
    /** @param {string[]} [ids] */
    emit(ids = []) { revision++; for (const listener of listeners) listener({ scope, available, streamEpoch: epoch, revision, changedIds: ids, deletedIds: [] }); },
    /** @param {string} id @param {Value} value */
    replace(id, value) { headers.set(id, value); captures.set(id, now()); this.emit([id]); },
    disconnect() { available = false; headers.clear(); this.emit(); },
    reconnect() { epoch = 'epoch-two'; available = true; headers.clear(); captures.clear(); this.emit(); },
    async dispose() { this.disposed = true; available = false; listeners.clear(); }
  };
  return stream;
}
/** @param {Value} [legacy] @param {Value} [rich] */
function fixture(legacy = { root: idle(), child: idle({ trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'Worker', initialPrompt: 'private prompt' } } }) }, rich = legacy) {
  let now = 1000, generation = 'owner-one';
  const calls = /** @type {string[]} */ ([]), streams = /** @type {ReturnType<typeof streamFixture>[]} */ ([]);
  const rpc = { latestRuntime: runtime, generation: () => generation, dispose: async () => {},
    /** @param {string} method @param {Value} [body] */
    call: async (method, body = {}) => {
      calls.push(method);
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: legacy };
      if (method === 'GetCascadeTrajectory') return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 1,
        trajectory: { trajectoryId: 'fixture-trajectory', cascadeId: body.cascadeId, steps: [{ status: 3, plannerResponse: { response: 'retained fixture body' } }] } };
      throw Error('No native mutation or other history method is allowed by this fixture');
    } };
  const backend = new AntigravityBackend({ rpc, historyIndex: false, now: () => now,
    summaryStreamFactory: scope => { const stream = streamFixture(scope, streams.length ? {} : rich, () => now); streams.push(stream); return stream; } });
  return { backend, calls, streams, now: () => now, advance: (/** @type {number} */ value) => { now = value; }, changeOwner: () => { generation = 'owner-two'; } };
}

test('current rich work overrides an idle cascade without history, per-session streams or capture renewal', async () => {
  const rich = { root: idle({ notFullyIdle: true, hasRunningSubagents: true }),
    child: idle({ notFullyIdle: true, hasRunningSubagents: true, backgroundTaskCount: 2,
      trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'Worker' } } }) };
  const f = fixture(undefined, rich), observer = new AntigravityActivityObserver({ id: 'root', backend: f.backend, now: f.now });
  try {
    await observer.refresh(); const first = observer.status();
    assert.equal(first.active, true); assert.equal(first.ownActive, false); assert.equal(first.ownNativeStatus, 'CASCADE_RUN_STATUS_IDLE');
    assert.equal(first.aggregateActivity.childCount, 1); assert.equal(first.aggregateActivity.status, 'running');
    f.advance(60000); await f.backend.activity('child');
    assert.equal(observer.status().known, true); assert.equal(observer.status().observedAt, first.observedAt); assert.equal(observer.refreshDueAt(), null);
    assert.equal(f.streams.length, 1); assert.deepEqual(f.calls, ['GetAllCascadeTrajectories']);
  } finally { observer.close(); await f.backend.dispose(); }
});

test('summary-only deltas and failed/reconnected stream keep body and do not borrow old row authority', async () => {
  const f = fixture(), frames = /** @type {Value[]} */ ([]); let release = () => {};
  const latest = () => { const value = frames.at(-1); assert.ok(value); return value; };
  const current = () => { const value = f.backend.cachedActivity('root'); assert.ok(value); return value; };
  try {
    release = await f.backend.subscribe('root', value => frames.push(value));
    const initial = latest(), body = JSON.stringify(initial.rows), histories = f.calls.filter(method => method === 'GetCascadeTrajectory').length;
    f.streams[0].replace('root', idle({ notFullyIdle: true, hasRunningSubagents: true }));
    f.streams[0].replace('child', idle({ notFullyIdle: true, backgroundTaskCount: 2, trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'Worker' } } }));
    assert.equal(latest().aggregateActivity.active, true); assert.equal(JSON.stringify(latest().rows), body);
    assert.notEqual(latest().contentStamp, initial.contentStamp);
    f.streams[0].disconnect(); assert.equal(latest().aggregateActivity.known, false); assert.equal(JSON.stringify(latest().rows), body);
    f.streams[0].reconnect(); assert.equal(current().known, false);
    f.streams[0].replace('child', idle({ trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'Worker' } } }));
    assert.equal(current().known, false);
    f.streams[0].replace('root', idle()); assert.equal(current().known, true);
    assert.equal(f.calls.filter(method => method === 'GetCascadeTrajectory').length, histories);
    assert.equal(JSON.stringify(latest().rows), body);
  } finally { release(); await f.backend.dispose(); }
});

test('owner change cannot reuse same IDs from an older summary stream epoch', async () => {
  const f = fixture();
  try {
    await f.backend.activity('root'); const initial = f.backend.cachedActivity('root'); assert.ok(initial); assert.equal(initial.known, true);
    assert.equal(f.backend.cachedActivity('root', { expectedHostId: antigravityHostId({ ...runtime, home: '/fixture/foreign-owner' }) }), null);
    f.changeOwner(); assert.equal(f.backend.cachedActivity('root'), null);
    await f.backend.activity('root'); assert.equal(f.streams[0].disposed, true); assert.equal(f.streams.length, 2);
    const restored = f.backend.cachedActivity('root'); assert.ok(restored); assert.equal(restored.known, false);
  } finally { await f.backend.dispose(); }
});

test('full 136-member current authority is independent from a 128-row display bound', async () => {
  const legacy = /** @type {Value} */ ({ root: idle() });
  for (let at = 0; at < 136; at++) legacy[`child-${at}`] = idle({ trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'Worker' } } });
  const f = fixture(legacy);
  try {
    const activity = await f.backend.activity('root');
    assert.equal(activity.known, true); assert.equal(activity.active, false); assert.equal(activity.aggregateActivity.childCount, 136); assert.equal(activity.aggregateActivity.rosterComplete, true);
    const view = await f.backend.snapshot('root'); assert.ok(view.subagents); assert.equal(view.subagents.length, 128); assert.equal(view.subagentsTotal, 136); assert.equal(view.subagentsTruncated, true);
    assert.equal(view.subagentsComplete, false); assert.equal(view.aggregateActivity.known, true); assert.equal(view.aggregateActivity.rosterComplete, true);
    f.streams[0].replace('child-135', idle({ notFullyIdle: true, backgroundTaskCount: 2, trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'Worker' } } }));
    const active = f.backend.withSubagents('root', view); assert.ok(active.subagents); assert.equal(active.aggregateActivity.active, true); assert.ok(active.subagents.some(row => row.id === 'child-135'));
  } finally { await f.backend.dispose(); }
});

test('legacy idle without a validated current rich summary is unconfirmed', async () => {
  const f = fixture(undefined, {});
  try { const value = await f.backend.activity('root'); assert.equal(value.known, false); assert.equal(value.active, false); assert.equal(f.calls.length, 1); }
  finally { await f.backend.dispose(); }
});

test('full rich replacement cannot inherit older killed, interrupted or waiting markers', async () => {
  const metadata = { parentConversationId: 'root', subagentSpec: { role: 'Worker' } };
  const legacy = { root: idle({ killed: true, interrupted: true, latestExecutorTerminationReason: 2 }),
    child: idle({ killed: true, interrupted: true, latestExecutorTerminationReason: 2, trajectoryMetadata: metadata }) };
  const f = fixture(legacy, { root: idle(), child: idle({ trajectoryMetadata: metadata }) });
  try {
    const view = await f.backend.snapshot('root'); assert.ok(view.subagents);
    assert.equal(view.subagents[0].status, 'idle'); assert.equal(view.aggregateActivity.active, false);
    f.streams[0].replace('child', idle({ status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true, trajectoryMetadata: metadata }));
    const current = f.backend.withSubagents('root', view); assert.ok(current.subagents);
    assert.equal(current.subagents[0].status, 'running'); assert.equal(current.aggregateActivity.waiting, false);
  } finally { await f.backend.dispose(); }
});
