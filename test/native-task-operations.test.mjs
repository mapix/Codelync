import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeHappyConnector } from '../src/happy/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { rpcTarget } from '../packages/wire/codelight.js';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */
const scope = { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
  parentConversationId: 'parent', ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' };
class Transport extends EventEmitter {
  sessionId = 'task-operation-fixture';
  /** @type {Value} */ metadata = {};
  /** @type {Value} */ agentState = {};
  /** @type {Map<string,(params:unknown)=>Promise<Value>>} */ handlers = new Map();
  async start() {}
  status() { return { pendingInbox: 0, pendingOutbox: 0 }; }
  listInbox() { return []; }
  async publish(/** @type {string} */ id) { return { id }; }
  async updateMetadata(/** @type {(value:Value)=>Value|Promise<Value>} */ update) { this.metadata = await update(this.metadata); }
  async updateAgentState(/** @type {(value:Value)=>Value|Promise<Value>} */ update) { this.agentState = await update(this.agentState); }
  registerRpc(/** @type {string} */ method, /** @type {(params:unknown)=>Promise<Value>} */ handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method); }
  async rpc(/** @type {string} */ method, /** @type {Value} */ params) { const handler = this.handlers.get(method); assert.ok(handler); return handler(params); }
}
/** @param {boolean} [readOnly] */
async function fixture(readOnly = false) {
  const directory = await mkdtemp(join(tmpdir(), 'native-task-operations-')), transport = new Transport();
  /** @type {Value} */ const state = { lease: true, outputCalls: 0, stopCalls: 0, commandCalls: 0, snapshotCalls: 0, output: 'whole\n输出', stopped: true, onOutput: null, onStop: null, onCommand: null };
  const tasks = { version: 1, scope, tasks: ['task-a', 'task-b'].map(nativeTaskId => ({ ...scope, relationship: 'native-sdk-task', nativeTaskId, name: nativeTaskId, taskType: 'local_bash',
    kind: 'shell', status: 'running', isBackgrounded: true, statusSource: 'native-task-lifecycle' })), tasksAvailable: true, tasksComplete: true,
    backgroundTasksComplete: true, tasksTruncated: false, dispatchChildren: [], dispatchChildrenAvailable: true,
    dispatchChildrenComplete: true, dispatchChildrenTruncated: false, capture: { epoch: 'e'.repeat(32), seq: 1 } };
  const view = { rows: [], requests: [], status: 'idle', ownerGeneration: 'owner', currentTurnId: null, nativeTasks: tasks, nativeReadOnly: readOnly,
    nativeTaskControls: { version: 1, scope, outputTaskTypes: ['local_bash'], stopTaskTypes: ['local_bash'] },
    nativeQuery: { version: 1, app: 'claude-desktop', nativeConversationId: 'parent', hostId: scope.hostId, ownerGeneration: 'owner', queryToken: 'query',
      status: 'idle', canSend: !readOnly, activeSendMode: 'queue', canCancel: false } };
  const adapter = /** @type {any} */ ({ generation: (/** @type {string|undefined} */ id) => id ? 'owner' : 'main',
    snapshot: async () => { state.snapshotCalls++; return structuredClone(view); },
    subscribe: async () => () => {},
    getTaskOutput: async () => { state.outputCalls++; await state.onOutput?.(); return { scope, taskId: 'task-a', output: state.output, truncated: false, privateField: 'synthetic-secret' }; },
    stopTask: async (/** @type {string} */ _id, /** @type {string} */ taskId) => { state.stopCalls++; await state.onStop?.(); return state.stopped ? { scope, taskId, stopped: true, nativeDispatchConfirmed: true, readbackConfirmed: true } : {}; },
    supportsSourceCommands: true,
    command: async () => { state.commandCalls++; if (state.onCommand) return state.onCommand(); throw Error('No parent/model command allowed'); } });
  const connector = new NativeHappyConnector({ transport: /** @type {any} */ (transport), adapter, nativeId: 'parent',
    sourceIdentity: { ...scope, id: 'parent', kind: 'session', appMode: 'code', protocol: 'claude-desktop-native' },
    bindingId: 'task-operation-binding', statePath: join(directory, 'state.json'), encryptionKey: new Uint8Array(32).fill(8),
    receipts: await CommandReceipts.load(join(directory, 'receipts.json')), getGeneration: () => 'owner', assertLease: () => state.lease });
  await connector.start(); state.snapshotCalls = 0;
  return { connector, transport, state, close: async () => { await connector.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('task output is exact bounded data, with no transcript, receipt, history or ongoing output publication', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.transport.agentState);
    const reply = await f.transport.rpc('native-task-output-read', { scope, taskId: 'task-a' });
    assert.equal(reply.output, f.state.output); assert.equal(reply.truncated, false); assert.equal(reply.privateField, undefined);
    assert.equal(f.state.outputCalls, 1); assert.equal(f.state.snapshotCalls, 0); assert.equal(f.connector.status().commands, 0);
    assert.deepEqual(f.transport.agentState, before);
  } finally { await f.close(); }
});

test('output rejects foreign scope/task, revoked lease and oversized UTF8 before publication', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.transport.rpc('native-task-output-read', { scope: { ...scope, queryToken: 'foreign' }, taskId: 'task-a' }));
    await assert.rejects(() => f.transport.rpc('native-task-output-read', { scope, taskId: 'foreign' }));
    assert.equal(f.state.outputCalls, 0);
    f.state.output = '汉'.repeat(22000);
    await assert.rejects(() => f.transport.rpc('native-task-output-read', { scope, taskId: 'task-a' }), { code: 'invalid-native-task-output' });
    f.state.output = 'safe'; f.state.onOutput = () => { f.state.lease = false; };
    await assert.rejects(() => f.transport.rpc('native-task-output-read', { scope, taskId: 'task-a' }), { code: 'source-epoch-changed' });
  } finally { await f.close(); }
});

test('single-task stop uses one durable ID, detects conflict and avoids parent snapshots/cancellation', async () => {
  const f = await fixture();
  try {
    const params = { scope, taskId: 'task-a', commandId: 'stop-task-command' };
    const first = await f.transport.rpc('native-task-stop', params), second = await f.transport.rpc('native-task-stop', params);
    assert.equal(first.ok, true); assert.deepEqual(second.receipt, first.receipt);
    assert.equal(f.state.stopCalls, 1); assert.equal(f.state.snapshotCalls, 0); assert.equal(f.connector.status().commands, 1);
    await assert.rejects(() => f.transport.rpc('native-task-stop', { ...params, taskId: 'another' }), { code: 'command-conflict' });
    assert.equal(f.state.stopCalls, 1);
    assert.notEqual(rpcTarget('native-task-stop', params), rpcTarget('native-task-stop', { ...params, taskId: 'another' }));
  } finally { await f.close(); }
});

test('void stop remains unknown and replay never invokes native again; readonly deny wins over incorrect type flags', async () => {
  const f = await fixture(), ro = await fixture(true);
  try {
    f.state.stopped = false;
    const params = { scope, taskId: 'task-a', commandId: 'unknown-task-stop' };
    await assert.rejects(() => f.transport.rpc('native-task-stop', params), { code: 'delivery-unknown' });
    await assert.rejects(() => f.transport.rpc('native-task-stop', params), { code: 'delivery-unknown' });
    assert.equal(f.state.stopCalls, 1);
    assert.equal(ro.transport.metadata.capabilities.readOnly, true);
    assert.equal(ro.transport.metadata.capabilities.rpcMethods.includes('native-task-stop'), false);
    await assert.rejects(() => ro.transport.rpc('native-task-stop', { ...params, commandId: 'readonly-task-stop' }), { code: 'native-read-only' });
    assert.equal(ro.state.stopCalls, 0); assert.equal(ro.connector.status().commands, 0);
  } finally { await f.close(); await ro.close(); }
});

test('concurrent same-ID different-task requests cannot coalesce into another task receipt', async () => {
  const f = await fixture();
  try {
    const replies = await Promise.allSettled([
      f.transport.rpc('native-task-stop', { scope, taskId: 'task-a', commandId: 'concurrent-task-stop' }),
      f.transport.rpc('native-task-stop', { scope, taskId: 'task-b', commandId: 'concurrent-task-stop' }),
    ]);
    assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1);
    const rejected = replies.find(reply => reply.status === 'rejected'); assert.ok(rejected && rejected.status === 'rejected');
    assert.equal(rejected.reason.code, 'command-conflict');
    assert.equal(f.state.stopCalls, 1); assert.equal(f.connector.status().commands, 1);
  } finally { await f.close(); }
});

test('after-effect scope errors remain unknown even when the code is otherwise a safe pre-admission rejection', async () => {
  const f = await fixture();
  try {
    f.state.onStop = () => { throw Object.assign(new BridgeError('source-epoch-changed', 'After native effect'), { effectMayHaveOccurred: true }); };
    const params = { scope, taskId: 'task-a', commandId: 'after-effect-task-stop' };
    await assert.rejects(() => f.transport.rpc('native-task-stop', params), error => {
      assert.equal(/** @type {any} */ (error).code, 'delivery-unknown'); assert.equal(/** @type {any} */ (error).effectMayHaveOccurred, true); return true;
    });
    await assert.rejects(() => f.transport.rpc('native-task-stop', params), { code: 'delivery-unknown' });
    assert.equal(f.state.stopCalls, 1);
  } finally { await f.close(); }
});

test('an explicit possible effect overrides safe error names for other native commands', async () => {
  const f = await fixture();
  try {
    f.state.onCommand = () => { throw Object.assign(new BridgeError('source-epoch-changed', 'Native effect already possible'), { effectMayHaveOccurred: true }); };
    const params = { commandId: 'partial-native-setting', name: 'fixture-command', arguments: '' };
    await assert.rejects(() => f.transport.rpc('source-command', params), error => {
      assert.equal(/** @type {any} */ (error).code, 'delivery-unknown'); assert.equal(/** @type {any} */ (error).effectMayHaveOccurred, true); return true;
    });
    await assert.rejects(() => f.transport.rpc('source-command', params), { code: 'delivery-unknown' });
    assert.equal(f.state.commandCalls, 1);
  } finally { await f.close(); }
});
