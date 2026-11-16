import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeHappyConnector } from '../src/happy/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';

/** @typedef {Record<string,any>} Value */
const scope = { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
  parentConversationId: 'native-parent', ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' };
/** @param {string} status @param {number} seq @param {boolean} [available] @returns {Value} */
function rawTasks(status, seq, available = true) {
  return { version: 1, scope, tasks: Array.from({ length: 32 }, (_, i) => ({ ...scope, relationship: 'native-sdk-task', nativeTaskId: `task-${i}`, name: `Task ${i}`,
    taskType: 'local_agent', kind: 'agent', status, isBackgrounded: true, statusSource: 'native-lifecycle' })), tasksAvailable: available,
    tasksComplete: available, backgroundTasksComplete: available, tasksTruncated: false, dispatchChildren: [], dispatchChildrenAvailable: true,
    dispatchChildrenComplete: true, dispatchChildrenTruncated: false, partial: !available, capture: { epoch: 'e'.repeat(32), seq } };
}
/** @param {Value} tasks @returns {Value} */
function view(tasks) {
  return { status: 'idle', ownerGeneration: 'owner', currentTurnId: null, rows: [], requests: [], nativeTasks: tasks,
    nativeQuery: { version: 1, app: 'claude-desktop', nativeConversationId: scope.parentConversationId, hostId: scope.hostId,
      ownerGeneration: 'owner', queryToken: 'query', status: 'idle', canSend: true, activeSendMode: 'queue', canCancel: false } };
}
class Transport extends EventEmitter {
  sessionId = 'task-signal-fixture';
  /** @type {Value} */ metadata = {};
  /** @type {Value} */ agentState = { nativeTasks: { legacy: true } };
  /** @type {Map<string,(params:unknown)=>Promise<Value>>} */ handlers = new Map();
  async start() {}
  status() { return { pendingInbox: 0, pendingOutbox: 0 }; }
  listInbox() { return []; }
  async publish(/** @type {string} */ id, /** @type {Value} */ _record) { return { id }; }
  async updateMetadata(/** @type {(value:Value)=>Value|Promise<Value>} */ update) { this.metadata = await update(this.metadata); }
  async updateAgentState(/** @type {(value:Value)=>Value|Promise<Value>} */ update) { this.agentState = await update(this.agentState); }
  registerRpc(/** @type {string} */ method, /** @type {(params:unknown)=>Promise<Value>} */ handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method); }
  async rpc(/** @type {Value} */ params) { const handler = this.handlers.get('native-task-read'); assert.ok(handler); return handler(params); }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'task-signal-order-')), transport = new Transport();
  /** @type {Value} */ const state = { current: view(rawTasks('running', 1)), next: rawTasks('completed', 2), beforeRead: null };
  const adapter = /** @type {any} */ ({ generation: (/** @type {string|undefined} */ id) => id ? 'owner' : 'main',
    snapshot: async () => structuredClone(state.current), freshSnapshot: async () => structuredClone(state.current),
    subscribe: async (/** @type {string} */ _id, /** @type {(view:Value)=>void} */ callback) => { callback(structuredClone(state.current)); return () => {}; },
    taskSnapshot: async () => { const captured = structuredClone(state.next); await state.beforeRead?.(); return captured; },
    command: async () => { throw Error('No model/native operations allowed'); } });
  const connector = new NativeHappyConnector({ transport: /** @type {any} */ (transport), adapter, nativeId: scope.parentConversationId,
    sourceIdentity: { app: scope.app, kind: 'session', appMode: 'code', runtimeGeneration: 'owner', id: scope.parentConversationId, hostId: scope.hostId, nativeCollection: scope.nativeCollection, protocol: 'claude-desktop-native' },
    bindingId: 'native-task-signal-binding', statePath: join(directory, 'state.json'), encryptionKey: new Uint8Array(32).fill(8),
    receipts: await CommandReceipts.load(join(directory, 'receipts.json')), getGeneration: () => 'owner', assertLease: () => true });
  await connector.start();
  return { connector, transport, state, close: async () => { await connector.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('actual connector publishes signal only, removes legacy lists and matches a fresh read target before replying', async () => {
  const f = await fixture();
  try {
    assert.equal(f.transport.agentState.nativeTasks, undefined);
    assert.equal(f.transport.agentState.nativeTaskSignal.taskCount, 32);
    assert.equal(f.transport.agentState.nativeTaskSignal.tasks, undefined);
    const previous = f.transport.agentState.nativeTaskSignal.digest;
    const response = await f.transport.rpc({ scope, since: previous });
    assert.ok(response.kind === undefined || response.kind === 'native-task-delta');
    assert.equal(response.digest, f.transport.agentState.nativeTaskSignal.digest);
    assert.notEqual(response.digest, previous);
    assert.equal(f.transport.agentState.aggregateActivity.status, 'idle');
  } finally { await f.close(); }
});

test('an old lower-capture source view cannot overwrite a fresher explicit task read signal', async () => {
  const f = await fixture();
  try {
    await f.transport.rpc({ scope });
    const current = structuredClone(f.transport.agentState);
    await f.connector.project(view(rawTasks('running', 1)));
    assert.deepEqual(f.transport.agentState, current);
  } finally { await f.close(); }
});

test('a delayed old successful capture cannot resurrect availability after a later data-only unavailable view', async () => {
  const f = await fixture();
  /** @type {()=>void} */ let release = () => {};
  /** @type {()=>void} */ let began = () => {};
  const gate = new Promise(resolve => { release = () => resolve(undefined); });
  const started = new Promise(resolve => { began = () => resolve(undefined); });
  try {
    f.state.beforeRead = async () => { began(); await gate; };
    const delayed = f.transport.rpc({ scope }); await started;
    await f.connector.project(view(rawTasks('unknown', 2, false)));
    assert.equal(f.transport.agentState.nativeTaskSignal.tasksAvailable, false);
    release();
    await assert.rejects(delayed, { code: 'stale-task-feed' });
    assert.equal(f.transport.agentState.nativeTaskSignal.tasksAvailable, false);
  } finally { release(); await f.close(); }
});

test('the same capture cannot restore source-view availability but a strictly higher fresh capture can', async () => {
  const f = await fixture();
  try {
    await f.connector.project(view(rawTasks('unknown', 1, false)));
    assert.equal(f.transport.agentState.nativeTaskSignal.tasksAvailable, false);
    await f.connector.project(view(rawTasks('running', 1)));
    assert.equal(f.transport.agentState.nativeTaskSignal.tasksAvailable, false);
    f.state.next = rawTasks('running', 2);
    await f.transport.rpc({ scope });
    assert.equal(f.transport.agentState.nativeTaskSignal.tasksAvailable, true);
    assert.equal(f.transport.agentState.aggregateActivity.status, 'running');
  } finally { await f.close(); }
});

test('no-query dispatch-only metadata survives SDK-task withdrawal and can refresh under its own child proof', async () => {
  const f = await fixture();
  try {
    const noQuery = { ...scope, queryToken: null };
    const child = { app: scope.app, relationship: 'native-subagent', runtimeGeneration: scope.runtimeGeneration,
      nativeConversationId: 'active-child', name: 'Child', nativeCollection: 'local-agent-mode-sessions', hostId: 'child-host', ownerGeneration: 'child-owner',
      parentConversationId: scope.parentConversationId, parentHostId: scope.hostId, parentOwnerGeneration: scope.ownerGeneration,
      parentNativeCollection: scope.nativeCollection, status: 'running', statusSource: 'native-header' };
    const data = { ...rawTasks('unknown', 2, false), scope: noQuery, tasks: [], dispatchChildren: [child] };
    const current = view(data); current.nativeQuery.queryToken = null;
    await f.connector.project(current);
    assert.equal(f.transport.agentState.nativeTaskSignal.tasksAvailable, false);
    assert.equal(f.transport.agentState.nativeTaskSignal.dispatchChildrenAvailable, true);
    assert.equal(f.transport.agentState.nativeTaskSignal.dispatchChildCount, 1);
    assert.equal(f.transport.agentState.aggregateActivity.status, 'running');
    f.state.next = { ...data, capture: { epoch: 'e'.repeat(32), seq: 3 } };
    const refreshed = await f.transport.rpc({ scope: noQuery });
    assert.equal(refreshed.dispatchChildrenAvailable, true);
    assert.equal(f.transport.agentState.nativeTaskSignal.dispatchChildrenAvailable, true);
  } finally { await f.close(); }
});
