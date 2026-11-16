import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityBackend, AntigravityActivityObserver } from '../src/adapters/antigravity-backend.mjs';
import { antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';

/** @typedef {Record<string,any>} Value */
function fixture() {
  let now = 1000, owner = 'original-owner', elapsed = 1100;
  const calls = /** @type {string[]} */ ([]);
  const runtime = { binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server', home: '/fixture/home', appDataDir: 'antigravity' };
  const summaries = /** @type {Value} */ ({ active: { status: 'CASCADE_RUN_STATUS_RUNNING', workspaces: [{ workspaceFolderAbsoluteUri: 'file:///fixture/mo-agent-swarm' }] },
    parent: { status: 'CASCADE_RUN_STATUS_IDLE', hasRunningSubagents: true, workspaces: [{ workspaceFolderAbsoluteUri: 'file:///fixture/mo-agent-swarm' }] },
    child: { status: 'CASCADE_RUN_STATUS_RUNNING', trajectoryMetadata: { parentConversationId: 'parent', subagentSpec: { role: 'Worker' } } } });
  const rpc = { latestRuntime: runtime, generation: () => owner, dispose: async () => {}, call: async (/** @type {string} */ method) => {
    calls.push(method); if (method !== 'GetAllCascadeTrajectories') throw Error('Activity must not read history or send a model request');
    now += elapsed; return { trajectorySummaries: structuredClone(summaries) };
  } };
  const backend = new AntigravityBackend({ rpc, historyIndex: false, now: () => now });
  const observer = new AntigravityActivityObserver({ id: 'active', backend, expectedHostId: antigravityHostId(runtime), now: () => now });
  return { backend, observer, summaries, calls, now: () => now, setNow: (/** @type {number} */ value) => { now = value; },
    setElapsed: (/** @type {number} */ value) => { elapsed = value; }, changeOwner: () => { owner = 'next-owner'; } };
}

test('activity age starts at native read admission and cached reads cannot renew old proof', async () => {
  const f = fixture();
  try {
    await f.observer.refresh(); const current = f.observer.status();
    assert.equal(current.observedAt, 1000); assert.equal(f.now(), 2100); assert.equal(current.known, true); assert.equal(current.active, true);
    assert.equal(f.observer.refreshDueAt(), 4000);
    f.setNow(2200); const reused = await f.backend.activity('active'); assert.equal(reused.observedAt, 1000); assert.equal(f.calls.length, 1);
    f.setNow(6001); assert.equal(f.observer.status().known, false); assert.equal(f.observer.refreshDueAt(), null);
  } finally { f.observer.close(); await f.backend.dispose(); }
});

test('shared native index refresh updates every observer reduced replica without history or duplicate native reads', async () => {
  const f = fixture();
  try {
    await f.observer.refresh(); f.setNow(4000);
    await f.backend.list({ fresh: true, history: false });
    assert.equal(f.observer.status().observedAt, 4000); assert.equal(f.observer.status().known, true); assert.equal(f.observer.refreshDueAt(), 7000);
    assert.deepEqual(f.calls, ['GetAllCascadeTrajectories', 'GetAllCascadeTrajectories']);
    const parent = f.backend.cachedActivity('parent'); assert.equal(parent?.known, true); assert.equal(parent?.active, true); assert.equal(parent?.ownActive, false);
    assert.equal(f.calls.length, 2);
  } finally { f.observer.close(); await f.backend.dispose(); }
});

test('slow current replies do not become freshly known on arrival and native cache completion avoids refetch storms', async () => {
  const f = fixture(); f.setElapsed(6000);
  try {
    await f.observer.refresh(); assert.equal(f.observer.status().known, false); assert.equal(f.observer.refreshDueAt(), null);
    await f.backend.activity('active'); assert.equal(f.calls.length, 1);
  } finally { f.observer.close(); await f.backend.dispose(); }
});

test('foreign host, changed owner and closed foreground observers cannot keep a refresh deadline or positive busy proof', async () => {
  const f = fixture();
  try {
    await f.observer.refresh(); assert.equal(f.backend.cachedActivity('active', { expectedHostId: 'foreign' }), null);
    f.changeOwner(); assert.equal(f.backend.cachedActivity('active'), null); assert.equal(f.observer.status().known, false); assert.equal(f.observer.refreshDueAt(), null);
    f.observer.close(); assert.equal(f.observer.status().active, false); assert.equal(f.observer.refreshDueAt(), null);
  } finally { f.observer.close(); await f.backend.dispose(); }
});

test('resident activity authority survives an incomplete durable catalogue while catalogue removal authority stays false', async () => {
  const f = fixture();
  try {
    assert.equal(f.backend.activityInventoryComplete, false);
    f.backend.historyIndex = { merge: async (/** @type {Value} */ summaries) => ({ summaries, complete: false, stamp: 'partial-history', archivedIds: [] }), dispose: () => {} };
    await f.backend.list({ fresh: true });
    assert.equal(f.backend.inventoryComplete, false); assert.equal(f.backend.activityInventoryComplete, true);
    assert.equal((await f.backend.activity('active')).known, true);
    assert.deepEqual(f.calls, ['GetAllCascadeTrajectories']);
    f.changeOwner(); assert.equal(f.backend.activityInventoryComplete, false);
  } finally { f.observer.close(); await f.backend.dispose(); }
});

test('history merge failure retains proved resident authority but a failed next resident read revokes it', async () => {
  const f = fixture();
  try {
    f.backend.historyIndex = { merge: async () => { throw Error('Durable catalogue is unavailable'); }, dispose: () => {} };
    await assert.rejects(f.backend.list({ fresh: true }));
    assert.equal(f.backend.inventoryComplete, false); assert.equal(f.backend.activityInventoryComplete, true);
    f.backend.rpc.call = async () => { throw Error('Native resident read unavailable'); };
    await assert.rejects(f.backend.list({ fresh: true, history: false }));
    assert.equal(f.backend.activityInventoryComplete, false);
    assert.equal(f.backend.cachedActivity('active'), null);
    assert.equal(f.observer.status().known, false);
  } finally { f.observer.close(); await f.backend.dispose(); }
});
