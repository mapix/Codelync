import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceImageAdapter } from '../src/happy/bound-source.mjs';
import { BridgeError } from '../src/errors.mjs';
import { nativeSavedHistoryPage, nativeHistoryBoundary } from '../src/happy/recent-data.mjs';

/** @typedef {Record<string,any>} Value */
function view() { return { status: 'history-only', ownerGeneration: null, currentTurnId: null, requests: [], historyComplete: false,
  rows: [{ id: 'saved', role: 'assistant', text: 'Original saved row', turnId: null, displayTurnId: 'saved-display-only', order: 100 }],
  historicalRead: { app: 'codex', version: 1, available: true, originator: 'Codex Desktop', nativeId: 'native', hostId: 'local', namespaceHash: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), byteBoundary: { start: 100, end: 200, total: 200 },
    trailingIncomplete: false, lastLifecycle: { type: 'turn_aborted', turnId: 'native-turn', terminalObserved: true } } }; }

test('original child history fallback does not acquire or impersonate a live controller', async () => {
  let live = 0, saved = 0, released = 0;
  const adapter = { supportsNativeSavedHistory: true, generation: () => null,
    snapshot: async () => { live++; throw new BridgeError('codex-owner-unavailable', 'Original child is no longer running.'); },
    freshSnapshot: async () => { throw Error('Must not repeat inactive discovery'); },
    readHistoricalPage: async () => { saved++; return view(); },
    subscribe: async () => { throw Error('Must not create a child controller'); }, releaseHistoricalSource: () => { released++; } };
  const wrapped = new SourceImageAdapter(adapter, /** @type {any} */ ({}), { app: 'codex', kind: 'session', hostId: 'local' });
  assert.equal((await wrapped.snapshot('native')).ownerGeneration, null);
  assert.equal((await wrapped.freshSnapshot('native')).status, 'history-only');
  const received = /** @type {Value[]} */ ([]), release = await wrapped.subscribe('native', frame => received.push(frame));
  assert.equal(received[0].ownerGeneration, null); release();
  assert.equal(live, 1); assert.equal(saved, 3); assert.equal(released, 1);
});

test('a verified terminal child reads saved data without waiting for unavailable live discovery', async () => {
  let live = 0;
  const saved = view(); saved.historicalRead.app = 'codex';
  saved.historicalRead.lastLifecycle = { type: 'turn_aborted', turnId: 'native-turn', terminalObserved: true }; saved.historicalRead.trailingIncomplete = false;
  const adapter = { supportsNativeSavedHistory: true, generation: () => null, readHistoricalPage: async () => saved,
    snapshot: async () => { live++; throw Error('Must not wait for completed child owner discovery'); } };
  const wrapped = new SourceImageAdapter(adapter, /** @type {any} */ ({}), { app: 'codex', kind: 'session', hostId: 'local', isSubagent: true });
  assert.equal((await wrapped.snapshot('native')).status, 'history-only'); assert.equal(live, 0);
  saved.historicalRead.lastLifecycle.terminalObserved = false;
  await assert.rejects(wrapped.snapshot('native'), /Must not wait/); assert.equal(live, 1);
});

test('foreign app and malformed live snapshots cannot borrow the Codex saved-history fallback', async () => {
  for (const [app, code] of [['antigravity', 'codex-owner-unavailable'], ['codex', 'invalid-native-frame']]) {
    let reads = 0;
    const adapter = { supportsNativeSavedHistory: true, snapshot: async () => { throw new BridgeError(code, 'Unavailable'); }, readHistoricalPage: async () => { reads++; return view(); } };
    const wrapped = new SourceImageAdapter(adapter, /** @type {any} */ ({}), { app, kind: 'session', hostId: 'local' });
    await assert.rejects(wrapped.snapshot('native'), { code }); assert.equal(reads, 0);
  }
});

test('a resumed task marker cannot keep suppressing the real owner freshness or subscription path', async () => {
  for (const action of ['fresh', 'subscribe']) {
    const saved = view(); let fresh = 0, subscribed = 0;
    const live = { status: 'running', ownerGeneration: 'resumed-owner', currentTurnId: 'new-native-turn', rows: [], requests: [] };
    const adapter = { supportsNativeSavedHistory: true, generation: () => null, readHistoricalPage: async () => saved,
      snapshot: async () => { throw Error('Closed child'); }, freshSnapshot: async () => { fresh++; return live; },
      subscribe: async (/** @type {string} */ _id, /** @type {(frame:Value)=>void} */ callback) => { subscribed++; callback(live); return () => {}; } };
    const wrapped = new SourceImageAdapter(adapter, /** @type {any} */ ({}), { app: 'codex', kind: 'session', hostId: 'local', isSubagent: true });
    await wrapped.snapshot('native');
    saved.historicalRead.lastLifecycle = { type: 'task_started', turnId: 'new-native-turn', terminalObserved: false };
    if (action === 'fresh') { assert.equal((await wrapped.freshSnapshot('native')).ownerGeneration, 'resumed-owner'); assert.equal(fresh, 1); }
    else { const release = await wrapped.subscribe('native', () => {}); release(); assert.equal(subscribed, 1); }
  }
});

test('saved byte cursors retain original data scope and display-only grouping without a live turn', () => {
  const page = nativeSavedHistoryPage('session', view(), { limit: 1 });
  assert.equal(page.rows[0].turnId, 'saved-display-only'); assert.equal(page.rows[0].readOnlyHistory, true);
  assert.equal(page.hasMore, true);
  assert.deepEqual(nativeHistoryBoundary(page.nextCursor, 'session').nativeSavedHistory, { beforeByte: 100, sourceStamp: 'b'.repeat(64) });
  assert.throws(() => nativeHistoryBoundary(page.nextCursor, 'foreign'), { code: 'invalid-history-cursor' });
});

test('a smaller recent viewport retains older rows even when the saved reader materialized complete history', () => {
  const complete = view(); complete.historyComplete = true;
  complete.historicalRead.byteBoundary.start = 0;
  complete.rows = [{ ...complete.rows[0], id: 'earlier', order: 50 }, { ...complete.rows[0], id: 'latest', order: 100 }];
  const recent = nativeSavedHistoryPage('session', complete, { limit: 1 });
  assert.equal(recent.rows[0].id, 'latest'); assert.equal(recent.hasMore, true);
  assert.equal(nativeHistoryBoundary(recent.nextCursor, 'session').nativeSavedHistory.beforeByte, 100);
  complete.rows = [complete.rows[0]];
  const end = nativeSavedHistoryPage('session', complete, { limit: 1 });
  assert.equal(end.hasMore, false); assert.equal(end.nextCursor, null);
});

test('Claude wrapper binds every native lane to the collection host and keeps old history separate from controls', async () => {
  const expectedHostId = 'local:claude-desktop:' + 'a'.repeat(64); let host = expectedHostId;
  const contexts = /** @type {Value[]} */ ([]), current = { status: 'running', ownerGeneration: 'owner', rows: [], requests: [], currentTurnId: null };
  const adapter = { supportsNativeHistoryPaging: true, hostId: () => host, generation: () => 'owner',
    snapshot: async (/** @type {string} */ _id, /** @type {Value} */ context) => { contexts.push(context); return current; },
    historyPage: async (/** @type {string} */ _id, /** @type {Value} */ context) => { contexts.push(context); return { rows: [], ownerGeneration: 'owner', historyDataOnly: true }; },
    command: async (/** @type {string} */ _id, /** @type {string} */ _action, /** @type {Value} */ _payload, /** @type {string} */ _command, /** @type {Value} */ context) => { contexts.push(context); return {}; } };
  const wrapped = new SourceImageAdapter(adapter, /** @type {any} */ ({}), { app: 'claude-desktop', kind: 'session', hostId: expectedHostId });
  await wrapped.snapshot('native'); const latest = wrapped.latest;
  await wrapped.readDataHistoryPage('native', { id: 'claude:uuid', ownerGeneration: 'owner' });
  await wrapped.command('native', 'send', { text: 'Reviewed' }, 'command-id', { expectedGeneration: 'owner' });
  assert.equal(wrapped.latest, latest); assert.equal(wrapped.supportsDataOnlyHistoryPaging, true);
  assert.equal(contexts.every(context => context.expectedHostId === expectedHostId), true);
  assert.equal(contexts[1].historyBoundary.id, 'claude:uuid');
  host = 'local:claude-desktop:' + 'b'.repeat(64);
  assert.equal(wrapped.generation('native'), null);
  await assert.rejects(wrapped.readDataHistoryPage('native', { id: 'claude:uuid' }), { code: 'source-epoch-changed' });
  await assert.rejects(wrapped.snapshot('native'), { code: 'source-epoch-changed' });
});
