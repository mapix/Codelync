import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravitySummaryFrameDecoder, AntigravitySummaryStream, validateAntigravityStreamSummary } from '../src/adapters/antigravity-summary-stream.mjs';
import { antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {unknown} value @param {number} [flags] */
function frame(value, flags = 0) { const body = Buffer.from(JSON.stringify(value)), result = Buffer.alloc(body.length + 5); result[0] = flags; result.writeUInt32BE(body.length, 1); body.copy(result, 5); return result; }
const runtime = { generation: 'original-owner', binary: '/fixture/Antigravity.app/Contents/MacOS/server', home: '/fixture/home', appDataDir: 'Antigravity' };
const context = { expectedHostId: antigravityHostId(runtime), generation: runtime.generation, waitMs: 300 };
/** @param {()=>boolean} predicate */
async function until(predicate) { const deadline = Date.now() + 1000; while (!predicate()) { if (Date.now() > deadline) throw Error('Test condition not reached'); await new Promise(resolve => setTimeout(resolve, 5)); } }
/** @param {import('node:test').TestContext} t @param {Value} [options] */
function setup(t, options = {}) {
  /** @type {ReadableStreamDefaultController[]} */ const channels = [];
  /** @type {Value[]} */ const calls = []; let currentRuntime = runtime, clock = 100, failRuntime = false;
  const rpc = { runtime: async () => { if (failRuntime) { failRuntime = false; throw Error('Temporary runtime read failure'); } return currentRuntime; }, subscribeSummaries: async (/** @type {Value} */ args) => {
    calls.push(args);
    /** @type {ReadableStreamDefaultController|undefined} */ let control;
    const body = new ReadableStream({ start(controller) { control = controller; }, cancel() {} });
    args.signal.addEventListener('abort', () => { try { control?.error(Error('cancelled')); } catch {} }, { once: true });
    assert.ok(control); channels.push(control);
    return { response: new Response(body, { headers: { 'content-type': 'application/connect+json' } }),
      scope: { hostId: context.expectedHostId, generation: runtime.generation }, close: options.close ?? (async () => {}) };
  } };
  const stream = new AntigravitySummaryStream({ rpc, expectedHostId: context.expectedHostId, generation: context.generation, now: () => clock, reconnectMs: 20, ...options });
  t.after(() => stream.dispose());
  return { stream, calls, channels, failRuntime: () => { failRuntime = true; }, advance: (/** @type {number} */ value) => { clock = value; }, owner: (/** @type {typeof runtime} */ value) => { currentRuntime = value; } };
}

test('Connect framing accepts arbitrary byte boundaries without growing concatenation', () => {
  const input = Buffer.concat([frame({ updates: { parent: { status: 'CASCADE_RUN_STATUS_IDLE' } } }), frame({ deletes: ['parent'] })]);
  const decoder = new AntigravitySummaryFrameDecoder(); const result = [];
  for (const byte of input) result.push(...decoder.feed(Uint8Array.of(byte)));
  decoder.finish(); assert.equal(result.length, 2); assert.deepEqual(JSON.parse(result[1].payload.toString()), { deletes: ['parent'] });
});
test('Connect rejects compressed, unknown flags, excessive or truncated lengths', () => {
  for (const flags of [1, 3, 4, 128]) assert.throws(() => new AntigravitySummaryFrameDecoder().feed(frame({}, flags)));
  const decoder = new AntigravitySummaryFrameDecoder(20), header = Buffer.alloc(5); header.writeUInt32BE(21, 1);
  assert.throws(() => decoder.feed(header)); const partial = new AntigravitySummaryFrameDecoder(); partial.feed(frame({ updates: {} }).subarray(0, 6)); assert.throws(() => partial.finish());
});
test('only full native replacements use missing bool/uint32 protobuf defaults', () => {
  const header = validateAntigravityStreamSummary({ status: 'CASCADE_RUN_STATUS_IDLE', trajectoryMetadata: { parentConversationId: 'parent', agent: { isSubagent: true } } });
  assert.equal(header.notFullyIdle, false); assert.equal(header.hasRunningSubagents, false); assert.equal(header.backgroundTaskCount, 0);
  assert.equal(header.trajectoryMetadata.parentConversationId, 'parent'); assert.equal(header.status, 'CASCADE_RUN_STATUS_IDLE');
  assert.equal(validateAntigravityStreamSummary({}).status, 0);
});
test('malformed header flag/counter/object types and prototype keys fail closed', () => {
  for (const value of [{ notFullyIdle: 'false' }, { hasRunningSubagents: 1 }, { backgroundTaskCount: -1 }, { backgroundTaskCount: 0x100000000 }, { status: 'IDLE' }, { waitingSteps: {} }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => validateAntigravityStreamSummary(value));
});
test('one native stream coalesces startup for parent and child; live lease survives an old event time', async t => {
  const f = setup(t), parent = f.stream.read(['parent'], context), child = f.stream.read(['child'], context);
  await until(() => f.channels.length === 1); f.channels[0].enqueue(frame({ updates: { parent: { status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: true, hasRunningSubagents: true }, child: { status: 'CASCADE_RUN_STATUS_RUNNING' } } }));
  const a = await parent, b = await child; assert.equal(f.calls.length, 1); assert.equal(a.available, true); assert.equal(b.states.child, 'ready');
  assert.equal(a.headers.parent.notFullyIdle, true); const epoch = a.liveProof.streamEpoch; f.advance(60000);
  const later = f.stream.getReplica(['parent'], context); assert.ok(later.liveProof); assert.equal(later.liveProof.currentAlive, true); assert.equal(later.liveProof.streamEpoch, epoch); assert.equal(later.captures.parent, 100); assert.equal(later.states.parent, 'ready'); assert.equal(f.calls.length, 1);
});
test('a complete replacement clears earlier running flags and emits status changes with unchanged text', async t => {
  const f = setup(t);
  /** @type {Value[]} */ const changes = []; f.stream.subscribe(value => changes.push(value)); const first = f.stream.read(['parent'], context);
  await until(() => f.channels.length === 1); f.channels[0].enqueue(frame({ updates: { parent: { summary: 'same', status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: true } } })); await first;
  f.advance(200); f.channels[0].enqueue(frame({ updates: { parent: { summary: 'same', status: 'CASCADE_RUN_STATUS_IDLE' } } }));
  await until(() => f.stream.getReplica(['parent'], context).headers.parent?.notFullyIdle === false);
  const last = changes.at(-1); assert.ok(last);
  assert.equal(f.stream.getReplica(['parent'], context).captures.parent, 200); assert.equal(last.changedIds[0], 'parent');
});
test('deletion withdraws that row instead of turning a cached idle header into idle', async t => {
  const f = setup(t), first = f.stream.read(['parent'], context); await until(() => f.channels.length === 1);
  f.channels[0].enqueue(frame({ updates: { parent: { status: 'CASCADE_RUN_STATUS_IDLE' } } })); await first;
  f.channels[0].enqueue(frame({ deletes: ['parent'] })); await until(() => f.stream.getReplica(['parent'], context).states.parent === 'deleted');
  const result = f.stream.getReplica(['parent'], context); assert.equal(result.headers.parent, undefined); assert.equal(result.available, true);
});
test('reconnect uses a new epoch and cannot reuse an unreceived parent proof', async t => {
  const f = setup(t), first = f.stream.read(['parent'], context); await until(() => f.channels.length === 1);
  f.channels[0].enqueue(frame({ updates: { parent: { status: 'CASCADE_RUN_STATUS_IDLE' } } })); const old = await first;
  f.channels[0].error(Error('network failed')); await until(() => !f.stream.getReplica(['parent'], context).available);
  await until(() => f.channels.length === 2); f.channels[1].enqueue(frame({ updates: { child: { status: 'CASCADE_RUN_STATUS_RUNNING' } } }));
  await until(() => f.stream.getReplica(['child'], context).states.child === 'ready');
  const next = f.stream.getReplica(['parent'], context); assert.ok(next.liveProof); assert.equal(next.states.parent, 'unknown'); assert.notEqual(next.liveProof.streamEpoch, old.liveProof.streamEpoch);
});
test('a transient owner-read error can recover on the same original owner without permanent stop', async t => {
  const f = setup(t); f.failRuntime(); const missing = await f.stream.read(['parent'], context); assert.equal(missing.available, false); assert.equal(f.calls.length, 0);
  const recovered = f.stream.read(['parent'], context); await until(() => f.channels.length === 1);
  f.channels[0].enqueue(frame({ updates: { parent: { status: 'CASCADE_RUN_STATUS_IDLE' } } })); assert.equal((await recovered).states.parent, 'ready');
});
test('legal 20,000-ID deletion batches stay bounded and preserve per-ID unknown/deleted state', async t => {
  const f = setup(t), updates = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => ['id-' + i, { status: 'CASCADE_RUN_STATUS_IDLE' }]));
  const ready = f.stream.read(['id-0'], context); await until(() => f.channels.length === 1); f.channels[0].enqueue(frame({ updates })); await ready;
  const deletes = Object.keys(updates), started = Date.now(); f.channels[0].enqueue(frame({ deletes }));
  await until(() => f.stream.getReplica(['id-0'], context).states['id-0'] === 'deleted'); assert.ok(Date.now() - started < 1000);
  assert.equal(f.stream.getReplica(['id-19999'], context).states['id-19999'], 'deleted');
});
test('replica headers keep native relationship evidence but never expose prompts, annotations or step arguments', () => {
  const value = validateAntigravityStreamSummary({ summary: 'private prompt fixture', annotations: { title: 'private title fixture' }, status: 'CASCADE_RUN_STATUS_IDLE',
    trajectoryMetadata: { parentConversationId: 'parent', rootConversationId: 'root', subagentSpec: { prompt: 'private instruction fixture' } },
    waitingSteps: [{ type: 'WAITING', stepIndex: 3, arguments: 'private arguments fixture' }] });
  assert.equal(value.nativeSubagentSpecPresent, true); assert.equal(value.trajectoryMetadata.rootConversationId, 'root');
  assert.ok(!JSON.stringify(value).includes('private')); assert.equal(value.waitingSteps.length, 1);
});
test('owner mismatch and foreign requested host immediately withdraw authority without retargeting', async t => {
  const f = setup(t), first = f.stream.read(['parent'], context); await until(() => f.channels.length === 1);
  f.channels[0].enqueue(frame({ updates: { parent: { status: 'CASCADE_RUN_STATUS_IDLE' } } })); await first;
  const foreign = await f.stream.read(['parent'], { ...context, expectedHostId: 'other-host' }); assert.equal(foreign.available, false); assert.equal(f.calls.length, 1);
  f.owner({ ...runtime, generation: 'new-owner' }); const changed = await f.stream.read(['parent'], context); assert.equal(changed.available, false); assert.equal(changed.states.parent, 'unknown'); assert.equal(f.calls.length, 1);
});
test('disposal aborts the actual native request and resolves an unready read as unknown', async t => {
  const f = setup(t), waiting = f.stream.read(['parent'], { ...context, waitMs: 1000 }); await until(() => f.calls.length === 1);
  await f.stream.dispose(); assert.equal(f.calls[0].signal.aborted, true); const result = await waiting; assert.equal(result.available, false); assert.equal(result.states.parent, 'unknown');
});
test('malformed UTF8/JSON/endstream clears authority and never publishes an invalid row', async t => {
  for (const data of [frame({ metadata: {} }, 2), Buffer.from([0, 0, 0, 0, 1, 255]), frame({ updates: { parent: { notFullyIdle: 'false' } } })]) {
    const f = setup(t), waiting = f.stream.read(['parent'], context); await until(() => f.calls.length === 1); f.channels[0].enqueue(data);
    const result = await waiting; assert.equal(result.available, false); assert.equal(result.headers.parent, undefined); await f.stream.dispose();
  }
});
test('end-stream withdraws ready row authority before asynchronous transport cleanup completes', async t => {
  /** @type {()=>void} */ let finish = () => {};
  const closing = new Promise(resolve => { finish = () => resolve(undefined); });
  const f = setup(t, { close: () => closing }), ready = f.stream.read(['parent'], context);
  await until(() => f.channels.length === 1); f.channels[0].enqueue(frame({ updates: { parent: { status: 'CASCADE_RUN_STATUS_IDLE' } } })); await ready;
  f.channels[0].enqueue(frame({ metadata: {} }, 2)); await until(() => !f.stream.getReplica(['parent'], context).available);
  assert.equal(f.stream.getReplica(['parent'], context).states.parent, 'unknown'); finish();
});
test('invalid read limits and IDs are rejected without starting a stream', async t => {
  const f = setup(t); await assert.rejects(f.stream.read(['../foreign'], context)); await assert.rejects(f.stream.read(['parent'], { ...context, waitMs: 20000 })); assert.equal(f.calls.length, 0);
});
