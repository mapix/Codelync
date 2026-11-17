import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBackend } from '../src/adapters/codex-backend.mjs';
import { CodexIpcAdapter } from '../src/adapters/codex-ipc.mjs';

/** @typedef {Record<string,any>} Value */
function fixture(lateOwner = false) {
  const id = 'fresh-owner-fixture';
  let owner = 'old-owner', revision = 0, refreshes = 0;
  /** @type {(frame:Value)=>void} */ let callback = () => {};
  const frame = (/** @type {string} */ client) => ({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: client,
    params: { conversationId: id, hostId: 'local', change: { type: 'snapshot', revision: ++revision,
      conversationState: { turns: [{ turnId: 'fixture-turn', status: 'inProgress', items: [{ id: 'fixture-row', type: 'agentMessage', text: client }] }] } } } });
  const ipc = {
    generation: () => `local:${owner}`,
    subscribe: async (/** @type {string} */ _id, /** @type {(frame:Value)=>void} */ fn) => { callback = fn; fn(frame(owner)); return () => {}; },
    refreshSnapshot: async (/** @type {string} */ _id, /** @type {(()=>void)|undefined} */ requested) => {
      refreshes++; owner = 'new-owner';
      callback(frame('old-owner')); // In-flight data before actual request admission remains insufficient.
      requested?.();
      if (lateOwner) owner = 'later-owner';
      queueMicrotask(() => callback(frame(owner)));
    },
    dispose() {},
  };
  const backend = new CodexBackend({ ipc: /** @type {CodexIpcAdapter} */ (/** @type {unknown} */ (ipc)), waitTimeoutMs: 1000, snapshotRefreshMs: 0 });
  return { id, backend, refreshes: () => refreshes };
}

test('current readonly refresh follows the owner verified at actual dispatch and coalesces', async () => {
  const f = fixture(); const release = await f.backend.subscribe(f.id, () => {});
  try {
    const first = f.backend.freshSnapshot(f.id), second = f.backend.freshSnapshot(f.id);
    assert.equal(first, second);
    const view = await first;
    assert.equal(view.ownerGeneration, 'local:new-owner');
    assert.equal(view.rows.at(-1)?.text, 'new-owner');
    assert.equal(f.refreshes(), 1);
  } finally { release(); f.backend.dispose(); }
});

test('another owner change after readonly dispatch remains rejected', async () => {
  const f = fixture(true); const release = await f.backend.subscribe(f.id, () => {});
  try { await assert.rejects(f.backend.freshSnapshot(f.id), { code: 'source-epoch-changed' }); }
  finally { release(); f.backend.dispose(); }
});

test('old native write generation remains pinned and the same command is never replayed', async () => {
  const ipc = new CodexIpcAdapter(); let requests = 0, routings = 0;
  ipc.routingOwner = async (id) => { routings++; return { sessionId: id, hostId: 'local', ownerClientId: 'new-owner', supportsUntrustedAppInput: true }; };
  ipc.request = async () => { requests++; return { type: 'response', resultType: 'success', result: {} }; };
  try {
    const command = ipc.send('fresh-owner-fixture', 'fixture input', 'owner-write-fixture', 'local:old-owner');
    await assert.rejects(command, { code: 'source-epoch-changed' });
    const repeat = ipc.send('fresh-owner-fixture', 'fixture input', 'owner-write-fixture', 'local:old-owner');
    assert.equal(repeat, command);
    await assert.rejects(repeat, { code: 'source-epoch-changed' });
    assert.equal(requests, 0); assert.equal(routings, 1);
  } finally { ipc.dispose(); }
});
