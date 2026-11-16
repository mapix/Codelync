import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceImageAdapter } from '../src/happy/bound-source.mjs';

/** @typedef {Record<string,any>} Value */
const source = { app: 'claude-desktop', id: 'parent', hostId: 'host-code', nativeCollection: 'claude-code-sessions' };
test('actual bound wrapper forwards selected task APIs with fixed host and leaves current control view untouched', async () => {
  const calls = /** @type {Value[]} */ ([]), transport = /** @type {any} */ ({});
  const adapter = { hostId: () => source.hostId, generation: (/** @type {string} */ id) => id ? 'owner' : 'main',
    taskSnapshot: async (/** @type {string} */ id, /** @type {Value} */ context) => { calls.push({ method: 'tasks', id, context }); return { tasks: [] }; },
    taskLogPage: async (/** @type {string} */ id, /** @type {Value} */ context) => { calls.push({ method: 'logs', id, context }); return { logs: [] }; } };
  const bound = new SourceImageAdapter(adapter, transport, source); bound.latest = { status: 'running', nativeQuery: { queryToken: 'query' } };
  const previous = structuredClone(bound.latest), scope = { runtimeGeneration: 'main' };
  assert.ok(bound.taskSnapshot); assert.ok(bound.taskLogPage);
  const readTasks = bound.taskSnapshot, readLogs = bound.taskLogPage;
  await readTasks('parent', { expectedHostId: 'foreign', expectedGeneration: 'owner', expectedQueryToken: 'query', scope });
  await readLogs('parent', { expectedGeneration: 'owner', scope, taskId: 'task', limit: 12 });
  assert.equal(calls.length, 2); assert.equal(calls[0].context.expectedHostId, source.hostId); assert.equal(calls[0].context.expectedQueryToken, 'query');
  assert.equal(calls[1].context.limit, 12); assert.deepEqual(bound.latest, previous);
  await assert.rejects(() => readTasks('foreign', {}), { code: 'unsupported-action' });
  assert.equal(calls.length, 2);
  const codex = new SourceImageAdapter(adapter, transport, { ...source, app: 'codex' });
  assert.equal(codex.taskSnapshot, undefined); assert.equal(codex.taskLogPage, undefined);
});

test('bound task reads reject session/main/host changes before and after awaited data reads', async () => {
  for (const change of ['main', 'owner', 'host']) {
    let main = 'main', owner = 'owner', host = source.hostId, calls = 0;
    const adapter = { hostId: () => host, generation: (/** @type {string} */ id) => id ? owner : main,
      taskLogPage: async () => { calls++; if (change === 'main') main = 'other'; if (change === 'owner') owner = 'other'; if (change === 'host') host = 'other'; return { logs: [] }; } };
    const bound = new SourceImageAdapter(adapter, /** @type {any} */ ({}), source); assert.ok(bound.taskLogPage);
    const readLogs = bound.taskLogPage;
    await assert.rejects(() => readLogs('parent', { expectedGeneration: 'owner', scope: { runtimeGeneration: 'main' } }), { code: 'source-epoch-changed' });
    assert.equal(calls, 1);
  }
});

test('bound output and stop preserve exact scope and distinguish post-mutation owner drift', async () => {
  const scope = { app: 'claude-desktop', parentConversationId: source.id, hostId: source.hostId, nativeCollection: source.nativeCollection,
    ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' };
  for (const method of ['getTaskOutput', 'stopTask']) {
    let owner = 'owner', calls = 0;
    const adapter = { hostId: () => source.hostId, generation: (/** @type {string} */ id) => id ? owner : 'main',
      [method]: async () => { calls++; owner = 'other'; return {}; } };
    const bound = new SourceImageAdapter(adapter, /** @type {any} */ ({}), source);
    if (method === 'getTaskOutput') {
      assert.ok(bound.getTaskOutput);
      await assert.rejects(() => bound.getTaskOutput?.('parent', 'task', { scope }) ?? Promise.resolve(), { code: 'source-epoch-changed' });
    } else {
      assert.ok(bound.stopTask);
      await assert.rejects(() => bound.stopTask?.('parent', 'task', 'stable-command', { scope }) ?? Promise.resolve(), { code: 'delivery-unknown' });
    }
    assert.equal(calls, 1);
  }
});
