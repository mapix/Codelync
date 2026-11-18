import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeProjectActivityService } from '../src/codelync/project-activity.mjs';
import { AntigravityBackend } from '../src/adapters/antigravity-backend.mjs';
import { antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';

/** @typedef {Record<string, any>} Value */
const runtime = {
  binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server',
  home: '/fixture/home',
  appDataDir: 'fixture',
};

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

test('R002: overdue refreshDueAt sleeps through retryAt backoff without a 1ms timer loop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 10_000;
  let refreshes = 0;
  let dueChecks = 0;
  let observedAt = 0;
  let gap = false;
  let shouldFail = false;
  const source = {
    id: 'agy-1',
    relayId: 'phone-agy-1',
    app: 'antigravity',
    kind: 'session',
    protocol: 'antigravity-connect',
    runtimeGeneration: 'agy-gen-1',
    hostId: antigravityHostId(runtime),
    workspace: '/fixture/project',
  };
  let triggerRefresh = () => {};
  const service = new NativeProjectActivityService({
    backgroundSources: 0,
    sources: () => [source],
    inventoryAvailable: () => true,
    now: () => now,
    ipcFactory: () => ({}),
    observerFactory: options => {
      triggerRefresh = options.requestRefresh;
      return {
        status: () => {
          const known = !gap && observedAt > 0 && now - observedAt <= 6_000;
          return { known, active: known, waiting: false, observedAt, status: known ? 'ready' : 'unavailable' };
        },
        needsRefresh: () => gap || !(observedAt > 0 && now - observedAt <= 6_000),
        refreshDueAt: () => {
          dueChecks++;
          return observedAt > 0 ? observedAt + 3_000 : null;
        },
        refresh: async () => {
          refreshes++;
          if (shouldFail) throw new Error('transient-native-failure');
          gap = false;
          observedAt = now;
        },
        close: () => {},
      };
    },
  });
  t.after(() => service.close());

  const group = { id: 'card-1', projectKey: '/fixture/project', hostId: source.hostId, app: 'antigravity' };
  service.poll({ clientId: 'phone', requestSeq: 1, groups: [group] });
  await flush();
  assert.equal(refreshes, 1);
  assert.equal(observedAt, 10_000);

  // A transient gap triggers queueRefresh at t=11_000 and fails -> retryAt=16_000;
  // then baseline recovers with observedAt=10_000 so refreshDueAt()=13_000 falls inside retryAt.
  now = 11_000;
  gap = true;
  shouldFail = true;
  triggerRefresh();
  await flush();
  await flush();
  assert.equal(refreshes, 2);
  gap = false;

  // Reach t=13_000 (due=13_000 <= now, retryAt=16_000).
  now = 13_000;
  t.mock.timers.tick(2_000);
  await flush();
  const checksAtOverdue = dueChecks;

  // Remaining 2_999ms until retryAt=16_000 must NOT 1ms busy-spin.
  shouldFail = false;
  now += 2_999;
  t.mock.timers.tick(2_999);
  await flush();
  assert.equal(refreshes, 2);
  assert.equal(dueChecks, checksAtOverdue, 'overdue refreshDueAt must not busy-spin 1ms timers during retryAt backoff');

  // At t=16_000, retryAt fires once and refreshes cleanly.
  now += 1;
  t.mock.timers.tick(1);
  await flush();
  await flush();
  assert.equal(refreshes, 3);
  const summary = service.poll({ clientId: 'phone', requestSeq: 2, groups: [group] }).groups[0];
  assert.equal(summary.unknown, 0);
  assert.equal(summary.active, 1);
});

test('R002: overdue refreshDueAt does not 1ms-spin while owner or inventory is unavailable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 20_000;
  let available = true;
  let refreshes = 0;
  let dueChecks = 0;
  const source = {
    id: 'agy-2',
    relayId: 'phone-agy-2',
    app: 'antigravity',
    kind: 'session',
    protocol: 'antigravity-connect',
    runtimeGeneration: 'agy-gen-2',
    hostId: antigravityHostId(runtime),
    workspace: '/fixture/project',
  };
  const service = new NativeProjectActivityService({
    backgroundSources: 0,
    sources: () => [source],
    inventoryAvailable: () => available,
    ownedAvailable: () => available,
    now: () => now,
    ipcFactory: () => ({}),
    observerFactory: () => ({
      status: () => ({ known: false, active: false, waiting: false, status: 'unavailable' }),
      needsRefresh: () => true,
      refreshDueAt: () => {
        dueChecks++;
        return 19_000;
      },
      refresh: async () => {
        refreshes++;
      },
      close: () => {},
    }),
  });
  t.after(() => service.close());

  const group = { id: 'card-2', projectKey: '/fixture/project', hostId: source.hostId, app: 'antigravity' };
  service.poll({ clientId: 'phone', requestSeq: 1, groups: [group] });
  await flush();
  assert.equal(refreshes, 1);

  available = false;
  service.poll({ clientId: 'phone', requestSeq: 2, groups: [group] });
  await flush();

  const checksWhileUnavailable = dueChecks;
  now += 10_000;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(refreshes, 1);
  assert.equal(dueChecks, checksWhileUnavailable, 'unavailable owner/inventory must not trigger 1ms polling loops');
});

/** @param {Value} scope @param {Value} initial @param {()=>number} now */
function createSummaryStreamFixture(scope, initial, now) {
  let available = true;
  let epoch = 'epoch-one';
  let revision = 1;
  const headers = new Map(Object.entries(initial));
  const deleted = new Set();
  const captures = new Map(Object.keys(initial).map(id => [id, now()]));
  /** @type {Set<(change:Value)=>void>} */ const listeners = new Set();
  return {
    disposed: false,
    /** @param {(change:Value)=>void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** @param {string[]} ids @param {Value} context */
    getReplica(ids, context) {
      const current = available && !this.disposed && context.expectedHostId === scope.hostId && context.generation === scope.generation;
      const outHeaders = /** @type {Value} */ ({});
      const states = /** @type {Value} */ ({});
      const outCaptures = /** @type {Value} */ ({});
      for (const id of ids) {
        if (current && headers.has(id)) {
          states[id] = 'ready';
          outHeaders[id] = structuredClone(headers.get(id));
          outCaptures[id] = captures.get(id);
        } else {
          states[id] = current && deleted.has(id) ? 'deleted' : 'unknown';
        }
      }
      return {
        available: current,
        scope,
        streamEpoch: epoch,
        headers: outHeaders,
        states,
        captures: outCaptures,
        revision,
        complete: current && ids.every(id => states[id] !== 'unknown'),
        observedAt: now(),
        liveProof: current ? { ...scope, streamEpoch: epoch, currentAlive: true, fullReplacement: true, proto3Defaults: true } : null,
      };
    },
    /** @param {string[]} ids @param {Value} context */
    async read(ids, context) {
      return this.getReplica(ids, context);
    },
    /** @param {string[]} [changedIds] @param {string[]} [deletedIds] */
    emit(changedIds = [], deletedIds = []) {
      revision++;
      for (const listener of listeners) {
        listener({ scope, available, streamEpoch: epoch, revision, changedIds, deletedIds });
      }
    },
    /** @param {string} id @param {Value} value */
    replace(id, value) {
      deleted.delete(id);
      headers.set(id, value);
      captures.set(id, now());
      this.emit([id], []);
    },
    /** @param {string} id */
    remove(id) {
      headers.delete(id);
      captures.delete(id);
      deleted.add(id);
      this.emit([], [id]);
    },
    disconnect() {
      available = false;
      headers.clear();
      deleted.clear();
      this.emit();
    },
    reconnect() {
      epoch = 'epoch-two';
      available = true;
      headers.clear();
      captures.clear();
      deleted.clear();
      this.emit();
    },
    async dispose() {
      this.disposed = true;
      available = false;
      listeners.clear();
    },
  };
}

test('R007: stream-deleted subagents/conversations stay purged across stream disconnect and reconnect', async () => {
  const now = 1000;
  const generation = 'owner-one';
  const childHeader = {
    status: 'CASCADE_RUN_STATUS_IDLE',
    notFullyIdle: false,
    hasRunningSubagents: false,
    hasActiveChildren: false,
    backgroundTaskCount: 0,
    trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'Worker' } },
  };
  const rootHeader = {
    status: 'CASCADE_RUN_STATUS_IDLE',
    notFullyIdle: false,
    hasRunningSubagents: false,
    hasActiveChildren: false,
    backgroundTaskCount: 0,
    workspaces: [{ workspaceFolderAbsoluteUri: 'file:///fixture/project' }],
  };
  /** @type {ReturnType<typeof createSummaryStreamFixture>[]} */ const streams = [];
  const rpc = {
    latestRuntime: runtime,
    generation: () => generation,
    dispose: async () => {},
    /** @param {string} method @param {Value} [body] */
    call: async (method, body = {}) => {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { root: rootHeader, child: childHeader } };
      if (method === 'GetCascadeTrajectory') {
        return {
          status: 'CASCADE_RUN_STATUS_IDLE',
          numTotalSteps: 1,
          trajectory: {
            trajectoryId: 'traj-root',
            cascadeId: body.cascadeId,
            steps: [{ status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'idle answer' } }],
          },
        };
      }
      throw Error(`Unexpected RPC ${method}`);
    },
  };
  const backend = new AntigravityBackend({
    rpc,
    historyIndex: false,
    now: () => now,
    summaryStreamFactory: scope => {
      const stream = createSummaryStreamFixture(scope, { root: rootHeader, child: childHeader }, () => now);
      streams.push(stream);
      return stream;
    },
  });
  try {
    const view = await backend.snapshot('root');
    assert.equal(view.subagents?.length, 1);
    assert.equal((await backend.activity('root')).aggregateActivity.childCount, 1);

    streams[0].remove('child');
    assert.equal(backend.cachedActivity('root')?.aggregateActivity.childCount, 0);
    assert.equal(backend.withSubagents('root', view).subagents?.length, 0);

    streams[0].disconnect();
    streams[0].reconnect();
    streams[0].replace('root', rootHeader);

    assert.equal(backend.residentSummaries.child, undefined, 'deleted stream item must not resurrect after reconnect');
    assert.equal(backend.cachedActivity('root')?.aggregateActivity.childCount, 0);
    assert.equal(backend.withSubagents('root', view).subagents?.length, 0);
    assert.equal(Object.hasOwn(backend.baseResidentSummaries, 'child'), false);

    // Re-creation under a live ready header re-admits cleanly.
    streams[0].replace('child', childHeader);
    assert.equal(backend.cachedActivity('root')?.aggregateActivity.childCount, 1);
  } finally {
    await backend.dispose();
  }
});

test('R007: idle subscribe() detects live own-status/waiting transitions without stepCount/mtime changes while skipping child-only reloads', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = 5000;
  const generation = 'owner-one';
  let trajectoryStatus = 'CASCADE_RUN_STATUS_IDLE';
  /** @type {Value[]} */ let trajectorySteps = [
    { status: 'CORTEX_STEP_STATUS_DONE', userInput: { query: 'hi' } },
    { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'done' } },
  ];
  let reads = 0;
  const rootIdle = {
    trajectoryId: 'traj-root',
    lastModifiedTime: '2026-11-17T00:00:00Z',
    stepCount: 2,
    status: 'CASCADE_RUN_STATUS_IDLE',
    notFullyIdle: false,
    hasRunningSubagents: false,
    hasActiveChildren: false,
    backgroundTaskCount: 0,
  };
  const childIdle = {
    status: 'CASCADE_RUN_STATUS_IDLE',
    notFullyIdle: false,
    hasRunningSubagents: false,
    hasActiveChildren: false,
    backgroundTaskCount: 0,
    trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'Worker' } },
  };
  /** @type {ReturnType<typeof createSummaryStreamFixture>[]} */ const streams = [];
  const rpc = {
    latestRuntime: runtime,
    generation: () => generation,
    dispose: async () => {},
    /** @param {string} method @param {Value} [body] */
    call: async (method, body = {}) => {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { root: rootIdle, child: childIdle } };
      if (method === 'GetCascadeTrajectory') {
        reads++;
        return {
          status: trajectoryStatus,
          numTotalSteps: trajectorySteps.length,
          trajectory: { trajectoryId: 'traj-root', cascadeId: body.cascadeId, steps: trajectorySteps },
        };
      }
      throw Error(`Unexpected RPC ${method}`);
    },
  };
  const backend = new AntigravityBackend({
    rpc,
    historyIndex: false,
    now: () => now,
    summaryStreamFactory: scope => {
      const stream = createSummaryStreamFixture(scope, { root: rootIdle, child: childIdle }, () => now);
      streams.push(stream);
      return stream;
    },
  });
  /** @type {Value[]} */ const frames = [];
  let release = () => {};
  try {
    release = await backend.subscribe('root', view => frames.push(view));
    assert.equal(frames.at(-1)?.status, 'idle');
    assert.equal(reads, 1);

    // Child-only change keeps parent own fields identical and must NOT reload full trajectory.
    streams[0].replace('child', { ...childIdle, status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true });
    t.mock.timers.tick(1000);
    await flush();
    await flush();
    assert.equal(reads, 1);
    assert.equal(frames.at(-1)?.subagents?.[0]?.status, 'running');
    assert.equal(frames.at(-1)?.status, 'idle');

    // Live own status transitions to RUNNING with unchanged trajectoryId/lastModifiedTime/stepCount.
    trajectoryStatus = 'CASCADE_RUN_STATUS_RUNNING';
    trajectorySteps = [
      ...trajectorySteps,
      {
        status: 'CORTEX_STEP_STATUS_WAITING',
        requestedInteraction: { askQuestion: { questions: [{ question: 'Proceed?', options: [{ id: 'o1', text: 'Yes' }] }] } },
      },
    ];
    streams[0].replace('root', {
      ...rootIdle,
      status: 'CASCADE_RUN_STATUS_RUNNING',
      waitingSteps: [{ type: 'WAITING', stepIndex: 2 }],
    });
    t.mock.timers.tick(1000);
    await flush();
    await flush();
    assert.equal(reads, 2, 'own status transition must invalidate idle indexHint and fetch updated snapshot');
    assert.equal(frames.at(-1)?.status, 'waiting');
    assert.equal(frames.at(-1)?.requests?.length, 1);
  } finally {
    release();
    await backend.dispose();
  }
});
