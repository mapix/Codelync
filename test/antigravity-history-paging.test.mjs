import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityBackend } from '../src/adapters/antigravity-backend.mjs';
import { BridgeError } from '../src/errors.mjs';
import { recentRowsPage } from '../src/happy/recent-data.mjs';

/** @typedef {Record<string,any>} Value */
function fixture(userIndex = 50) {
  let generation = 'owner', oversized = 0, restart = false;
  const steps = Array.from({ length: 64 }, (_, index) => index === userIndex ? { status: 3, userInput: { query: 'Fixture user' } }
    : { status: 3, plannerResponse: { response: 'Fixture row ' + index } });
  const calls = /** @type {Value[]} */ ([]), rpc = { latestRuntime: { binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server', home: '/fixture/home', appDataDir: 'antigravity' },
    generation: () => generation, call: async (/** @type {string} */ method, /** @type {Value} */ body = {}) => {
      calls.push({ method, body });
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { child: { trajectoryId: 'original-trajectory', stepCount: steps.length, status: 2, trajectoryMetadata: { parentConversationId: 'parent', subagentSpec: { role: 'Worker' } } } } };
      if (method === 'GetCascadeTrajectorySteps') {
        if (oversized && steps.length - body.stepOffset >= oversized) throw new BridgeError('antigravity-response-too-large', 'Fixture bounded native response');
        if (restart) generation = 'new-owner';
        return { steps: steps.slice(body.stepOffset) };
      }
      throw Error('A large child must not read the full trajectory or start a native command.');
    } };
  const backend = new AntigravityBackend({ rpc, historyIndex: false });
  return { backend, calls, oversized: (/** @type {number} */ minimum) => { oversized = minimum; }, restart: () => { restart = true; }, changeOwner: () => { generation = 'new-owner'; } };
}

test('native suffixes preserve absolute row/user-turn identities and extend only the original offset', async () => {
  const f = fixture();
  try {
    const tail = await f.backend.snapshot('child');
    assert.equal(tail.nativeStepOffset, 48); assert.equal(tail.nativeStepEnd, 64); assert.equal(tail.historyComplete, false);
    assert.equal(tail.rows[0].order, 48); assert.equal(tail.currentTurnId, 'agy-turn:original-trajectory:50');
    const earlier = await f.backend.completeSnapshot('child');
    assert.equal(earlier.nativeStepOffset, 32); assert.equal(earlier.historyComplete, false);
    for (const row of tail.rows.filter(row => row.order >= 50)) {
      const same = earlier.rows.find(item => item.id === row.id); assert.ok(same); assert.equal(same.order, row.order); assert.equal(same.turnId, row.turnId);
    }
    await f.backend.completeSnapshot('child');
    const complete = await f.backend.completeSnapshot('child'); assert.equal(complete.nativeStepOffset, 0); assert.equal(complete.historyComplete, true);
    assert.deepEqual(f.calls.filter(call => call.method === 'GetCascadeTrajectorySteps').map(call => call.body.stepOffset), [48, 32, 16, 0]);
    assert.ok(f.calls.every(call => call.method === 'GetAllCascadeTrajectories' || Object.keys(call.body).sort().join(',') === 'cascadeId,stepOffset,trajectoryVerbosity'));
  } finally { await f.backend.dispose(); }
});

test('a loaded suffix without the original user turn remains observable without an inferred cancel target', async () => {
  const f = fixture(0);
  try {
    const view = await f.backend.snapshot('child'); assert.equal(view.status, 'running'); assert.equal(view.currentTurnId, null);
    assert.equal(view.historyComplete, false); assert.ok(view.rows.every(row => !!row.turnId));
  } finally { await f.backend.dispose(); }
});

test('oversized suffixes shrink the native offset request while a huge single step fails explicitly', async () => {
  const f = fixture();
  try {
    f.oversized(8); const small = await f.backend.snapshot('child'); assert.equal(small.nativeStepOffset, 60); assert.equal(small.rows.length, 4);
    f.oversized(1); await assert.rejects(f.backend.freshSnapshot('child'), { code: 'antigravity-response-too-large' });
  } finally { await f.backend.dispose(); }
});

test('an owner restart during a suffix read cannot be promoted to the next owner generation', async () => {
  const f = fixture();
  try { f.restart(); await assert.rejects(f.backend.snapshot('child'), { code: 'source-epoch-changed' }); }
  finally { await f.backend.dispose(); }
});

test('empty partial prefixes retain distinct actual native offsets in history cursors', () => {
  const a = recentRowsPage('mirror', [], { historyComplete: false, nativeStepOffset: 48 });
  const b = recentRowsPage('mirror', [], { historyComplete: false, nativeStepOffset: 32 });
  assert.equal(a.hasMore, true); assert.equal(b.hasMore, true); assert.notEqual(a.nextCursor, b.nextCursor);
});

test('history expansion followed by final release and re-entry restores the small latest native read', async () => {
  const f = fixture(0); let release = await f.backend.subscribe('child', () => {});
  try {
    const expanded = await f.backend.completeSnapshot('child'); assert.equal(expanded.nativeStepOffset, 32);
    const cursor = { id: expanded.rows[0].id, nativeStepOffset: 32 };
    release(); assert.equal(f.backend.historyOffsets.has('child'), false);
    const before = f.calls.length;
    release = await f.backend.subscribe('child', () => {});
    const requests = f.calls.slice(before).filter(call => call.method === 'GetCascadeTrajectorySteps');
    assert.deepEqual(requests.map(call => call.body.stepOffset), [48]);
    const cached = await f.backend.readMaterializedHistory('child', { id: expanded.rows[10].id, nativeStepOffset: 32 });
    assert.ok(cached); assert.equal(cached.nativeStepOffset, 32);
    const older = await f.backend.completeSnapshot('child', { historyBoundary: cursor });
    assert.equal(older.nativeStepOffset, 16); assert.equal(older.historyComplete, false);
  } finally { release(); await f.backend.dispose(); }
});

test('plain fresh/live reads stay small while an existing history cursor continues from its materialized boundary', async () => {
  const f = fixture(0);
  try {
    await f.backend.snapshot('child'); const history = await f.backend.completeSnapshot('child');
    const before = f.calls.length, fresh = await f.backend.freshSnapshot('child');
    assert.equal(fresh.nativeStepOffset, 48); assert.equal(fresh.rows.length, 16); assert.equal(fresh.currentTurnId, null);
    assert.equal(f.backend.historyOffsets.get('child')?.offset, 32);
    assert.equal(f.calls.slice(before).filter(call => call.method === 'GetCascadeTrajectorySteps')[0].body.stepOffset, 48);
    const boundary = { id: history.rows[0].id, nativeStepOffset: 32 };
    const next = await f.backend.completeSnapshot('child', { historyBoundary: boundary }); assert.equal(next.nativeStepOffset, 16);
    const same = next.rows.find(row => row.id === history.rows[0].id); assert.ok(same); assert.equal(same.turnId, history.rows[0].turnId);
  } finally { await f.backend.dispose(); }
});

test('old-owner materialized rows cannot serve a new-owner history cursor', async () => {
  const f = fixture(0);
  try {
    await f.backend.snapshot('child'); const older = await f.backend.completeSnapshot('child');
    const boundary = { id: older.rows[0].id, nativeStepOffset: older.nativeStepOffset };
    f.changeOwner(); assert.equal(await f.backend.readMaterializedHistory('child', boundary), null);
    await assert.rejects(f.backend.completeSnapshot('child', { historyBoundary: boundary }), { code: 'stale-history-cursor' });
    assert.equal((await f.backend.freshSnapshot('child')).nativeStepOffset, 48);
  } finally { await f.backend.dispose(); }
});

test('a proven zero start ends older paging without claiming an incomplete whole view is complete', () => {
  const page = recentRowsPage('mirror', [], { historyComplete: false, nativeStepOffset: 0 });
  assert.equal(page.hasMore, false); assert.equal(page.nextCursor, null);
});

test('materialized history validates the current process lifetime before serving cached rows', async () => {
  const f = fixture(0);
  try {
    await f.backend.snapshot('child'); const history = await f.backend.completeSnapshot('child');
    const before = f.calls.length;
    f.backend.rpc.runtime = async () => { f.changeOwner(); return {}; };
    assert.equal(await f.backend.readMaterializedHistory('child', { id: history.rows[8].id, nativeStepOffset: 32 }), null);
    assert.equal(f.calls.length, before);
  } finally { await f.backend.dispose(); }
});

test('an in-flight history expansion retains its data but cannot restore read intent after final release', async () => {
  const f = fixture(0), release = await f.backend.subscribe('child', () => {}), original = f.backend.rpc.call;
  let enter = () => {}, finish = () => {};
  const entered = new Promise(resolve => { enter = () => resolve(undefined); }), waiting = new Promise(resolve => { finish = () => resolve(undefined); });
  f.backend.rpc.call = async (/** @type {string} */ method, /** @type {Value} */ body = {}, /** @type {Value} */ options = {}) => { if (method === 'GetCascadeTrajectorySteps' && body?.stepOffset === 32) { enter(); await waiting; } return original(method, body, options); };
  try {
    const expanding = f.backend.completeSnapshot('child'); await entered; release(); finish();
    const view = await expanding; assert.equal(view.nativeStepOffset, 32); assert.equal(f.backend.historyOffsets.has('child'), false);
    const retained = await f.backend.readMaterializedHistory('child', { id: view.rows[8].id, nativeStepOffset: 32 }); assert.ok(retained);
    assert.equal((await f.backend.freshSnapshot('child')).nativeStepOffset, 48);
  } finally { release(); await f.backend.dispose(); }
});
