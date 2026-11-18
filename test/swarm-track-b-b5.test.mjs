import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravitySummaryStream, validateAntigravityStreamSummary } from '../src/adapters/antigravity-summary-stream.mjs';
import { antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';
import { NativeProjectActivityService } from '../src/codelync/project-activity.mjs';

/** @typedef {Record<string, any>} Value */

/** @param {unknown} value @param {number} [flags] */
function frame(value, flags = 0) {
  const body = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(body.length + 5);
  result[0] = flags;
  result.writeUInt32BE(body.length, 1);
  body.copy(result, 5);
  return result;
}

const runtime = {
  generation: 'original-owner',
  binary: '/fixture/Antigravity.app/Contents/MacOS/server',
  home: '/fixture/home',
  appDataDir: 'Antigravity',
};
const context = {
  expectedHostId: antigravityHostId(runtime),
  generation: runtime.generation,
  waitMs: 5000,
};

/** @param {() => boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Test condition not reached');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** @param {import('node:test').TestContext} t @param {Value} [options] */
function setupStream(t, options = {}) {
  /** @type {ReadableStreamDefaultController[]} */ const channels = [];
  /** @type {Value[]} */ const calls = [];
  const rpc = {
    runtime: async () => runtime,
    subscribeSummaries: async (/** @type {Value} */ args) => {
      calls.push(args);
      /** @type {ReadableStreamDefaultController | undefined} */ let control;
      const body = new ReadableStream({
        start(controller) { control = controller; },
        cancel() {},
      });
      args.signal.addEventListener('abort', () => { try { control?.error(new Error('cancelled')); } catch {} }, { once: true });
      assert.ok(control);
      channels.push(control);
      return {
        response: new Response(body, { headers: { 'content-type': 'application/connect+json' } }),
        scope: { hostId: context.expectedHostId, generation: runtime.generation },
        close: async () => {},
      };
    },
  };
  const stream = new AntigravitySummaryStream({
    rpc,
    expectedHostId: context.expectedHostId,
    generation: context.generation,
    reconnectMs: 25,
    ...options,
  });
  t.after(() => stream.dispose());
  return { stream, calls, channels };
}

test('R042: validateAntigravityStreamSummary validates source and latestExecutorTerminationReason enums and uint32 bounds', () => {
  const validInt = validateAntigravityStreamSummary({
    status: 1,
    source: 16,
    latestExecutorTerminationReason: 2,
  });
  assert.equal(validInt.source, 16);
  assert.equal(validInt.latestExecutorTerminationReason, 2);

  const validEnum = validateAntigravityStreamSummary({
    status: 'CASCADE_RUN_STATUS_IDLE',
    source: 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT',
    latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL',
  });
  assert.equal(validEnum.source, 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT');
  assert.equal(validEnum.latestExecutorTerminationReason, 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL');

  const badValues = [null, {}, [], -1, 1.5, 0x100000000, true, '', 'bad-lowercase', 'TOO_LONG_' + 'A'.repeat(130)];
  for (const bad of badValues) {
    assert.throws(() => validateAntigravityStreamSummary({ source: bad }), { code: 'antigravity-invalid-summary-stream' });
    assert.throws(() => validateAntigravityStreamSummary({ latestExecutorTerminationReason: bad }), { code: 'antigravity-invalid-summary-stream' });
  }
});

test('R042: live AntigravitySummaryStream rejects malformed source/termination reason frames fail-closed', async t => {
  const f = setupStream(t);
  const first = f.stream.read(['parent'], { ...context, waitMs: 500 });
  await until(() => f.channels.length === 1);
  f.channels[0].enqueue(frame({ updates: { parent: { status: 'CASCADE_RUN_STATUS_IDLE', source: { nested: 1 } } } }));
  const result = await first;
  assert.equal(result.available, false);
  assert.equal(result.headers.parent, undefined);
});

test('R042: AntigravitySummaryStream unrefs reconnect timers and settles all concurrent waiters on dispose()', async t => {
  let unrefCalls = 0;
  const originalSetTimeout = globalThis.setTimeout;
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  /** @type {typeof globalThis.setTimeout} */
  const wrappedSetTimeout = /** @type {any} */ ((/** @type {(...args: any[]) => void} */ fn, /** @type {number | undefined} */ ms, /** @type {any[]} */ ...args) => {
    const handle = originalSetTimeout(fn, ms, ...args);
    const originalUnref = handle.unref.bind(handle);
    handle.unref = () => {
      unrefCalls += 1;
      return originalUnref();
    };
    return handle;
  });

  const f = setupStream(t, { reconnectMs: 5000 });
  const w1 = f.stream.read(['parent-a'], { ...context, waitMs: 10000 });
  const w2 = f.stream.read(['parent-b'], { ...context, waitMs: 10000 });
  await until(() => f.channels.length === 1);
  assert.equal(f.stream.waiters.size, 2);

  globalThis.setTimeout = wrappedSetTimeout;
  try {
    f.channels[0].error(new Error('transient stream drop'));
    await until(() => f.stream.reconnect !== null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(unrefCalls, 1);

  await f.stream.dispose();
  assert.equal(f.stream.waiters.size, 0);
  const [r1, r2] = await Promise.all([w1, w2]);
  assert.equal(r1.available, false);
  assert.equal(r1.states['parent-a'], 'unknown');
  assert.equal(r2.available, false);
  assert.equal(r2.states['parent-b'], 'unknown');
});

/** @param {number} index @param {Value} [extra] */
function makeSource(index, extra = {}) {
  return {
    id: `thread-${index}`,
    relayId: `phone-${index}`,
    app: 'codex',
    kind: 'session',
    hostId: 'local',
    workspace: '/fixture/project',
    runtimeGeneration: 'gen-1',
    protocol: 'codex-ipc',
    appMode: 'desktop',
    nativeCollection: 'default',
    ...extra,
  };
}

test('R047: cachedSourceStatus avoids full inventory() rebuilds and skips sources() for untracked sessions', () => {
  let sourceReads = 0;
  let inventoryCalls = 0;
  let unrelatedIdReads = 0;
  const tracked = makeSource(42);
  const untracked = makeSource(9999);
  const catalog = Array.from({ length: 500 }, (_, i) => {
    if (i === 42) return tracked;
    const item = makeSource(i);
    if (i < 42) {
      // Confirm unrelated catalog entries do not even have metadata/nativeSession inspected on cachedSourceStatus.
      Object.defineProperty(item, 'metadata', {
        enumerable: true,
        get() { unrelatedIdReads += 1; return undefined; },
      });
    }
    return item;
  });

  const service = new NativeProjectActivityService({
    backgroundSources: 0,
    sources: () => { sourceReads += 1; return catalog; },
    inventoryAvailable: () => true,
    observerFactory: () => ({
      status: () => ({ known: true, active: true, waiting: false, status: 'ready' }),
      refresh: async () => {},
      close: () => {},
    }),
    ipcFactory: () => ({ dispose: () => {} }),
  });

  try {
    const originalInventory = service.inventory.bind(service);
    service.inventory = () => {
      inventoryCalls += 1;
      return originalInventory();
    };

    // Admit tracked entry into service.entries via one explicit poll.
    service.poll({
      clientId: 'phone-1',
      requestSeq: 1,
      groups: [{
        id: 'card-1',
        projectKey: '/fixture/project',
        hostId: 'local',
        sessions: [{ id: tracked.relayId, nativeId: tracked.id }],
      }],
    });
    assert.equal(inventoryCalls, 1);

    inventoryCalls = 0;
    sourceReads = 0;
    unrelatedIdReads = 0;

    // Untracked source short-circuits on entries.get(identity) before reading this.sources().
    assert.equal(service.cachedSourceStatus(untracked), null);
    assert.equal(inventoryCalls, 0);
    assert.equal(sourceReads, 0);

    // Tracked source verifies live epoch via targeted reverse scan without full inventory().
    const cached = service.cachedSourceStatus(tracked);
    assert.deepEqual(cached, { sameSource: true, known: true, active: true, waiting: false, status: 'ready' });
    assert.equal(inventoryCalls, 0);
    assert.equal(sourceReads, 1);
    assert.equal(unrelatedIdReads, 0);
  } finally {
    service.close();
  }
});

test('R047: cachedSourceStatus enforces strict source-epoch and visibility checks across in-place catalog mutations', () => {
  const tracked = makeSource(1, { protocol: 'antigravity-connect', app: 'antigravity', hostId: 'local:antigravity:' + 'a'.repeat(64) });
  /** @type {Value[]} */
  const catalog = [makeSource(0), tracked];

  const service = new NativeProjectActivityService({
    backgroundSources: 0,
    sources: () => catalog,
    inventoryAvailable: () => true,
    observerFactory: () => ({
      status: () => ({ known: true, active: false, waiting: true, status: 'ready' }),
      refresh: async () => {},
      close: () => {},
    }),
    ipcFactory: () => ({ dispose: () => {} }),
  });

  try {
    service.poll({
      clientId: 'phone-1',
      requestSeq: 1,
      groups: [{
        id: 'card-1',
        projectKey: '/fixture/project',
        hostId: tracked.hostId,
        app: 'antigravity',
        sessions: [{ id: tracked.relayId, nativeId: tracked.id }],
      }],
    });

    assert.equal(service.cachedSourceStatus(tracked)?.waiting, true);

    // Mutate catalog in place with a later duplicate whose runtimeGeneration drifted.
    catalog.push({ ...tracked, runtimeGeneration: 'gen-2' });
    assert.equal(service.cachedSourceStatus(tracked), null);

    // Remove the stale duplicate -> valid again.
    catalog.pop();
    assert.equal(service.cachedSourceStatus(tracked)?.waiting, true);

    // Visibility / epoch fields invalidated in place -> null.
    catalog[1] = { ...tracked, metadata: { nativeSession: { catalogueAvailable: false } } };
    assert.equal(service.cachedSourceStatus(tracked), null);

    catalog[1] = { ...tracked, archived: true };
    assert.equal(service.cachedSourceStatus(tracked), null);

    catalog[1] = { ...tracked, protocol: 'other-proto' };
    assert.equal(service.cachedSourceStatus(tracked), null);
  } finally {
    service.close();
  }
});
