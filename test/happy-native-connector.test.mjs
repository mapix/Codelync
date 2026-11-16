import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHappyConnector } from '../src/happy/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { BridgeError } from '../src/errors.mjs';
import { encryptRecord, decryptRecord } from '../src/happy/session-transport.mjs';
import { readObserverHistoryArchives } from '../src/happy/observer-history.mjs';

/** @typedef {Record<string,any>} Value */
class FixtureTransport extends EventEmitter {
  constructor() { super(); this.sessionId = 'happy-fixture'; this.inbox = /** @type {Value[]} */ ([]); this.records = /** @type {Value[]} */ ([]); this.handlers = /** @type {Map<string,(params:unknown)=>Promise<any>>} */ (new Map()); this.metadata = /** @type {Value} */ ({}); this.agentState = /** @type {Value} */ ({}); this.failPublication = false; this.pendingOutbox = 0; }
  async start() {}
  status() { return { pendingInbox: this.inbox.length, pendingOutbox: this.pendingOutbox }; }
  listInbox() { return structuredClone(this.inbox); }
  async ackInbox(/** @type {string} */ id) { this.inbox = this.inbox.filter(item => item.id !== id); }
  registerRpc(/** @type {string} */ method, /** @type {(params:unknown)=>Promise<any>} */ handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method); }
  async updateMetadata(/** @type {(value:Value)=>Value} */ change) { this.metadata = change(this.metadata); }
  async updateAgentState(/** @type {(value:Value)=>Value|Promise<Value>} */ change) { this.agentState = await change(this.agentState); }
  async publish(/** @type {string} */ localId, /** @type {Value} */ record) { let found = this.records.find(item => item.localId === localId); if (!found) { found = { localId, record: structuredClone(record) }; this.records.push(found); } else assert.deepEqual(found.record, record); if (this.failPublication) { this.failPublication = false; throw Error('fixture happy ack lost'); } return { id: `log-${localId}` }; }
  inject(/** @type {Value} */ record, /** @type {string} */ localId = 'phone-local', /** @type {string} */ id = 'happy-user-1') { this.inbox.push({ id, localId, seq: this.inbox.length + 1, record, publishedByThisTransport: false }); this.emit('record'); }
  async rpc(/** @type {string} */ method, /** @type {Value} */ params) { const handler = this.handlers.get(method); assert.ok(handler); return handler(params); }
}
class FixtureAdapter {
  supportsNativeModelSettings = false;
  completeReads = 0;
  constructor(/** @type {Value} */ view = {}) { this.view = /** @type {Value} */ ({ status: 'idle', currentTurnId: null, rows: [], requests: [], revision: 1, ...view }); this.calls = /** @type {Value[]} */ ([]); this.callback = /** @type {((view:Value)=>void)|null} */ (null); this.fail = false; this.noIdentity = false; this.beforeSnapshot = /** @type {(()=>void)|null} */ (null); }
  async snapshot(/** @type {string} */ _id) { this.beforeSnapshot?.(); return structuredClone(this.view); }
  async freshSnapshot(/** @type {string} */ nativeId) { return this.snapshot(nativeId); }
  async completeSnapshot(/** @type {string} */ nativeId) { this.completeReads++; this.view.historyComplete = true; return this.snapshot(nativeId); }
  async subscribe(/** @type {string} */ _id, /** @type {(view:Value)=>void} */ callback) { this.callback = callback; callback(structuredClone(this.view)); return () => { this.callback = null; }; }
  emit() { this.view.revision++; this.callback?.(structuredClone(this.view)); }
  /** @returns {Promise<Value>} */
  async command(/** @type {string} */ nativeId, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) {
    this.calls.push({ nativeId, action, payload, commandId });
    if (this.fail) throw new BridgeError('delivery-unknown', 'fixture lost native ACK after dispatch');
    if (action === 'send' || action === 'steer') { const turn = this.view.currentTurnId ?? `turn-${this.calls.length}`; this.view.currentTurnId = turn; this.view.status = 'active'; this.view.rows.push({ id: `native-${this.calls.length}`, role: 'user', text: payload.text, turnId: turn, status: 'inProgress', ...(this.noIdentity ? {} : { commandId }) }); this.emit(); return { acknowledged: true, turnId: turn }; }
    if (action === 'interrupt') { this.view.currentTurnId = null; this.view.status = 'idle'; this.emit(); return { interruptedTurnId: payload.turnId, acknowledged: true }; }
    if (action === 'approval') { this.view.requests = this.view.requests.filter((/** @type {Value} */ request) => request.kind !== payload.kind || request.requestId !== payload.requestId); this.emit(); return { acknowledged: true, ok: true }; }
    if (action === 'answer-question') { for (const row of this.view.rows) for (const question of row.asyncQuestions ?? []) if (question.questionItemId === payload.questionItemId) question.answered = true; this.emit(); return { acknowledged: true, ok: true }; }
    throw new BridgeError('unsupported-action', 'fixture unsupported');
  }
}
async function fixture(/** @type {Value} */ view = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'happy-native-fixture-')), transport = new FixtureTransport(), adapter = new FixtureAdapter(view);
  const receiptsPath = join(directory, 'receipts.json'); let epoch = 'owner-1', lease = true;
  const options = { transport, adapter, nativeId: 'original-native-id', sourceIdentity: { app: 'codex', id: 'original-native-id', hostId: 'local' }, bindingId: 'fixture-binding', metadata: { path: '', host: 'fixture', client: { id: 'noninvasive-bridge', name: 'Fixture', version: '1' } }, statePath: join(directory, 'connector.json'), encryptionKey: new Uint8Array(32).fill(9), getGeneration: () => epoch, assertLease: () => lease, admissionTimeoutMs: 25 };
  const create = async (/** @type {Value} */ overrides = {}) => new NativeHappyConnector({ ...options, ...overrides, receipts: await CommandReceipts.load(receiptsPath) });
  return { directory, transport, adapter, options, create, epoch: (/** @type {string} */ value) => { epoch = value; }, lease: (/** @type {boolean} */ value) => { lease = value; }, dispose: () => rm(directory, { recursive: true, force: true }) };
}
const user = (/** @type {string} */ text) => ({ role: 'user', content: { type: 'text', text } });
const events = (/** @type {FixtureTransport} */ transport) => transport.records.map(item => item.record.content);

test('Antigravity roster totals remain independent of limited display rows and unavailable counts stay unknown', async () => {
  const hostId = 'local:antigravity:' + 'a'.repeat(64);
  const child = { id: 'worker', name: 'worker', app: 'antigravity', nativeConversationId: 'worker',
    parentConversationId: 'original-native-id', nativeParentConversationId: 'coordinator', depth: 2,
    hostId, ownerGeneration: 'owner-1', relationship: 'native-subagent', status: 'running' };
  const f = await fixture({ ownerGeneration: 'owner-1', subagents: [child], subagentsAvailable: true,
    subagentsComplete: false, subagentsTruncated: true, subagentsTotal: 137 });
  const connector = await f.create({ sourceIdentity: { app: 'antigravity', id: 'original-native-id', hostId, kind: 'session', protocol: 'antigravity-connect' } });
  try {
    await connector.start();
    assert.equal(f.transport.agentState.subagents.length, 1);
    assert.equal(f.transport.agentState.subagents[0].nativeParentConversationId, 'coordinator');
    assert.equal(f.transport.agentState.subagents[0].depth, 2);
    assert.equal(f.transport.agentState.subagentsTotal, 137);
    assert.equal(f.transport.agentState.subagentsTruncated, true);
    f.adapter.view.subagentsTotal = -1; f.adapter.view.revision++; await connector.project(f.adapter.view);
    assert.equal(f.transport.agentState.subagentsTotal, null);
    f.adapter.view.subagentsTotal = 137; f.adapter.view.subagentsAvailable = false; f.adapter.view.revision++; await connector.project(f.adapter.view);
    assert.equal(f.transport.agentState.subagentsTotal, null);
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(f.adapter.completeReads, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('Claude task metadata stays compact and logs load only on request with owner/query fencing', async () => {
  const sourceIdentity = { app: 'claude-desktop', kind: 'session', id: 'original-native-id', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
    protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions', runtimeGeneration: 'owner-1' };
  const scope = { app: sourceIdentity.app, nativeCollection: sourceIdentity.nativeCollection, parentConversationId: sourceIdentity.id,
    hostId: sourceIdentity.hostId, ownerGeneration: 'owner-1', runtimeGeneration: 'main-owner', queryToken: 'query-1', cliSessionId: 'cli-1' };
  const nativeTasks = { version: 1, scope, tasks: [{ ...scope, relationship: 'native-sdk-task', nativeTaskId: 'task-1', name: 'Review', kind: 'agent',
    taskType: 'local_agent', status: 'running', isBackgrounded: true }], tasksAvailable: true, tasksComplete: false, backgroundTasksComplete: true,
    dispatchChildren: [], dispatchChildrenAvailable: true, dispatchChildrenComplete: true, state: { output: 'private' }, logs: ['private'] };
  const nativeQuery = { version: 1, app: sourceIdentity.app, nativeConversationId: sourceIdentity.id, hostId: sourceIdentity.hostId, ownerGeneration: 'owner-1',
    queryToken: 'query-1', status: 'idle', canSend: true, activeSendMode: 'queue', canCancel: false };
  const f = await fixture({ ownerGeneration: 'owner-1', nativeQuery, nativeTasks });
  const adapter = /** @type {Value} */ (f.adapter); let taskReads = 0, logReads = 0, lateOwnerChange = false, malformedPage = false;
  adapter.generation = () => 'main-owner';
  adapter.taskSnapshot = async (/** @type {string} */ id, /** @type {Value} */ context) => {
    taskReads++; assert.equal(id, sourceIdentity.id); assert.equal(context.expectedQueryToken, scope.queryToken); return structuredClone(nativeTasks);
  };
  adapter.taskLogPage = async (/** @type {string} */ id, /** @type {Value} */ context) => {
    logReads++; assert.equal(id, sourceIdentity.id); assert.equal(context.limit, 12); assert.equal(context.expectedHostId, sourceIdentity.hostId);
    if (lateOwnerChange) f.epoch('owner-2');
    return { scope, status: 'ok', available: true, logs: Array.from({ length: malformedPage ? 13 : 12 }, (_, i) => ({ id: `log-${i}`, sequence: i,
      nativeTaskId: 'task-1', subtype: 'task_progress', taskType: 'local_agent', kind: 'agent', status: 'running', output: 'private', toolInput: 'private' })),
    hasMore: true, nextCursor: 'ct1.fixture', truncated: false };
  };
  const connector = await f.create({ sourceIdentity });
  try {
    await connector.start(); assert.equal(taskReads, 0); assert.equal(logReads, 0); assert.equal(adapter.calls.length, 0);
    assert.equal('nativeTasks' in f.transport.agentState, false); assert.equal(f.transport.agentState.nativeTaskSignal.taskCount, 1);
    assert.equal('tasks' in f.transport.agentState.nativeTaskSignal, false); assert.equal(f.transport.agentState.aggregateActivity.status, 'running');
    assert.equal(f.transport.agentState.aggregateActivity.ownStatus, 'idle'); assert.equal(f.transport.agentState.aggregateActivity.taskCount, 1);
    assert.ok(f.transport.metadata.capabilities.rpcMethods.includes('native-task-log-read'));
    const read = await f.transport.rpc('native-task-read', { scope }); assert.equal(read.tasks.length, 1); assert.equal(taskReads, 1);
    const page = await f.transport.rpc('native-task-log-read', { scope, taskId: 'task-1' }); assert.equal(page.logs.length, 12);
    assert.equal('output' in page.logs[0], false); assert.equal('toolInput' in page.logs[0], false);
    await assert.rejects(() => f.transport.rpc('native-task-log-read', { scope: { ...scope, queryToken: 'other' } }), { code: 'source-epoch-changed' });
    assert.equal(logReads, 1);
    await assert.rejects(() => f.transport.rpc('native-task-log-read', { scope, limit: 101 }), { code: 'invalid-rpc-payload' });
    assert.equal(logReads, 1);
    malformedPage = true;
    await assert.rejects(() => f.transport.rpc('native-task-log-read', { scope }), { code: 'invalid-native-task-page' });
    malformedPage = false; lateOwnerChange = true;
    await assert.rejects(() => f.transport.rpc('native-task-log-read', { scope }), { code: 'source-epoch-changed' });
    assert.equal(adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('task signals remove restored full lists and fresh deltas cannot be overwritten by queued older observations', async () => {
  const sourceIdentity = { app: 'claude-desktop', kind: 'session', id: 'original-native-id', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
    protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions', runtimeGeneration: 'owner-1' };
  const scope = { app: sourceIdentity.app, nativeCollection: sourceIdentity.nativeCollection, parentConversationId: sourceIdentity.id,
    hostId: sourceIdentity.hostId, ownerGeneration: 'owner-1', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' };
  const task = (/** @type {number} */ i, /** @type {string} */ status) => ({ ...scope, relationship: 'native-sdk-task', nativeTaskId: `task-${i}`, name: `Review ${i}`,
    taskType: 'local_agent', kind: 'agent', status, isBackgrounded: false });
  const nativeTasks = { version: 1, scope, tasks: Array.from({ length: 128 }, (_, i) => task(i, i === 17 ? 'running' : 'completed')),
    tasksAvailable: true, tasksComplete: true, tasksTruncated: false, backgroundTasksComplete: true, dispatchChildren: [],
    dispatchChildrenAvailable: true, dispatchChildrenComplete: true, dispatchChildrenTruncated: false, partial: false, capture: { epoch: 'b'.repeat(32), seq: 1 } };
  const nativeQuery = { version: 1, app: scope.app, nativeConversationId: sourceIdentity.id, hostId: scope.hostId, ownerGeneration: scope.ownerGeneration,
    queryToken: scope.queryToken, status: 'idle', canSend: true, activeSendMode: 'queue', canCancel: false };
  const f = await fixture({ ownerGeneration: 'owner-1', nativeTasks, nativeQuery, contentStamp: 'initial' });
  const adapter = /** @type {Value} */ (f.adapter); adapter.generation = () => 'main';
  const latest = structuredClone(nativeTasks); latest.tasks[17].status = 'completed'; latest.capture.seq = 3;
  adapter.taskSnapshot = async () => structuredClone(latest);
  f.transport.agentState = { nativeTasks: { privateOldList: 'must disappear' } };
  const connector = await f.create({ sourceIdentity });
  try {
    await connector.start(); const base = f.transport.agentState.nativeTaskSignal.digest;
    assert.equal('nativeTasks' in f.transport.agentState, false); assert.equal(f.transport.agentState.aggregateActivity.status, 'running');
    let release = /** @type {()=>void} */ (() => {}), started = /** @type {()=>void} */ (() => {});
    const blocked = /** @type {Promise<void>} */ (new Promise(resolve => { release = () => resolve(); }));
    const entered = /** @type {Promise<void>} */ (new Promise(resolve => { started = () => resolve(); }));
    let blockNext = true; const originalUpdate = f.transport.updateAgentState.bind(f.transport);
    f.transport.updateAgentState = async change => { if (blockNext) { blockNext = false; started(); await blocked; } await originalUpdate(change); };
    const old = structuredClone(adapter.view); old.contentStamp = 'older'; old.nativeTasks.capture.seq = 2;
    const oldPublication = connector.project(old); await entered;
    const delta = await f.transport.rpc('native-task-read', { scope, since: base });
    assert.equal(delta.kind, 'native-task-delta'); assert.equal(delta.taskUpserts.length, 1);
    assert.equal(delta.digest, f.transport.agentState.nativeTaskSignal.digest); assert.equal(f.transport.agentState.aggregateActivity.status, 'idle');
    release(); await oldPublication;
    assert.equal(f.transport.agentState.nativeTaskSignal.digest, delta.digest); assert.equal(f.transport.agentState.aggregateActivity.status, 'idle');
    await connector.project(old);
    assert.equal(f.transport.agentState.nativeTaskSignal.digest, delta.digest); assert.equal(f.transport.agentState.aggregateActivity.status, 'idle');
    latest.capture.seq = 4;
    const unchanged = await f.transport.rpc('native-task-read', { scope, since: delta.digest });
    assert.equal(unchanged.kind, 'native-task-unchanged'); assert.equal('tasks' in unchanged, false);
    const unknown = await f.transport.rpc('native-task-read', { scope, since: 'c'.repeat(64) });
    assert.equal(unknown.kind, undefined); assert.equal(unknown.tasks.length, 128);
    assert.equal(adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('Claude query controls accept queued input without inventing a native turn and cancel only the exact query', async () => {
  const sourceIdentity = { app: 'claude-desktop', kind: 'session', id: 'original-native-id', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
    protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions', runtimeGeneration: 'owner-1' };
  const nativeQuery = { version: 1, app: 'claude-desktop', nativeConversationId: sourceIdentity.id, hostId: sourceIdentity.hostId, ownerGeneration: 'owner-1',
    queryToken: 'original-query', status: 'running', canSend: true, activeSendMode: 'queue', canCancel: true };
  const f = await fixture({ ownerGeneration: 'owner-1', status: 'running', currentTurnId: null, nativeQuery, nativeModel: { model: 'original-native-model[1m]', effort: null } });
  const adapter = /** @type {Value} */ (f.adapter); adapter.supportedActions = ['send', 'interrupt'];
  adapter.command = async (/** @type {string} */ nativeId, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId, /** @type {Value} */ context) => {
    adapter.calls.push({ nativeId, action, payload, commandId, context });
    assert.equal(context.expectedQueryToken, 'original-query');
    return action === 'send' ? { admitted: true, nativeDispatchConfirmed: true, queued: true, messageId: 'claude:queued-native-id' } : { cancelRequested: true };
  };
  const connector = await f.create({ sourceIdentity });
  try {
    await connector.start(); assert.equal(f.transport.metadata.capabilities.send, true); assert.equal(f.transport.metadata.capabilities.steering, false); assert.equal(f.transport.metadata.capabilities.abort, true);
    assert.equal(f.transport.metadata.nativeObservedModel.model, 'original-native-model[1m]'); assert.equal(f.transport.metadata.nativeObservedModel.readOnly, true);
    assert.equal(f.transport.metadata.capabilities.modelSelection, false); assert.equal(f.transport.metadata.nativeObservedModel.ownerGeneration, 'owner-1');
    f.transport.inject(user('Queued input')); await connector.processInbox();
    const accepted = events(f.transport).filter(event => event.ev.t === 'user-message-accepted');
    assert.equal(accepted.length, 1); assert.equal(accepted[0].ev.runId, null); assert.equal(accepted[0].ev.disposition, 'queued');
    assert.equal(accepted[0].turn, undefined); assert.equal(adapter.calls.length, 1);
    adapter.view.rows.push({ id: 'claude:queued-native-id', role: 'user', turnId: 'display-only-uuid-group', inputStatus: 'accepted', text: 'Queued input', tools: [] });
    await connector.project(adapter.view);
    assert.equal(events(f.transport).filter(event => event.ev.t === 'user-message-accepted').length, 1); assert.equal(adapter.calls.length, 1);
    await assert.rejects(f.transport.rpc('abort', { commandId: 'wrong-query-cancel', queryToken: 'old-query' }), { code: 'stale-turn' });
    await assert.rejects(f.transport.rpc('abort', { commandId: 'fake-turn-cancel', turnId: 'fake' }), { code: 'invalid-rpc-payload' });
    await f.transport.rpc('abort', { commandId: 'native-query-cancel', queryToken: 'original-query' });
    assert.equal(adapter.calls.length, 2); assert.deepEqual(adapter.calls[1].payload, { queryToken: 'original-query' });
    await f.transport.rpc('abort', { commandId: 'native-query-cancel', queryToken: 'original-query' }); assert.equal(adapter.calls.length, 2);
  } finally { await connector.close(); await f.dispose(); }
});

test('changed or unverified Claude native query input is rejected before any dispatch', async () => {
  const sourceIdentity = { app: 'claude-desktop', kind: 'session', id: 'original-native-id', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
    protocol: 'claude-desktop-native', appMode: 'chat', nativeCollection: 'local-agent-mode-sessions', runtimeGeneration: 'owner-1' };
  for (const changed of [false, true]) {
    const nativeQuery = { version: 1, app: 'claude-desktop', nativeConversationId: sourceIdentity.id, hostId: sourceIdentity.hostId, ownerGeneration: 'owner-1',
      queryToken: null, status: 'idle', canSend: changed, activeSendMode: 'unverified', canCancel: false };
    const f = await fixture({ ownerGeneration: 'owner-1', nativeQuery }); const connector = await f.create({ sourceIdentity });
    try {
      await connector.start(); if (changed) f.adapter.beforeSnapshot = () => { f.adapter.view.nativeQuery.queryToken = 'new-query'; };
      f.transport.inject(user('Must not enter another query')); await connector.processInbox();
      assert.equal(f.adapter.calls.length, 0); assert.equal(events(f.transport).some(event => event.ev.t === 'user-message-accepted'), false);
    } finally { await connector.close(); await f.dispose(); }
  }
});

test('a confirmed Claude native message survives observer restart without a fabricated turn or recent row', async () => {
  const sourceIdentity = { app: 'claude-desktop', kind: 'session', id: 'original-native-id', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
    protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions', runtimeGeneration: 'owner-1' };
  const nativeQuery = { version: 1, app: 'claude-desktop', nativeConversationId: sourceIdentity.id, hostId: sourceIdentity.hostId, ownerGeneration: 'owner-1',
    queryToken: null, status: 'idle', canSend: true, activeSendMode: 'queue', canCancel: false };
  const f = await fixture({ ownerGeneration: 'owner-1', nativeQuery }), adapter = /** @type {Value} */ (f.adapter);
  adapter.supportedActions = ['send'];
  adapter.command = async (/** @type {string} */ _nativeId, /** @type {string} */ _action, /** @type {Value} */ _payload, /** @type {string} */ commandId) => {
    adapter.calls.push({ commandId }); return { admitted: true, nativeDispatchConfirmed: true, queued: false, messageId: 'claude:admitted-native-uuid' };
  };
  let connector = await f.create({ sourceIdentity });
  try {
    await connector.start(); f.transport.inject(user('Original admitted input')); await connector.processInbox();
    const commandId = adapter.calls[0].commandId, before = (await f.transport.rpc('bridge-receipt', { commandId })).receipt;
    assert.equal(before.admission.confirmed, true); assert.equal(before.admission.turnId, null); assert.equal(before.admission.queued, false);
    await connector.close(); connector = await f.create({ sourceIdentity }); await connector.start();
    const after = (await f.transport.rpc('bridge-receipt', { commandId })).receipt;
    assert.deepEqual(after.admission, before.admission); assert.equal(after.status, 'complete');
    assert.equal(adapter.calls.length, 1); assert.equal(events(f.transport).filter(event => event.ev.t === 'user-message-accepted').length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('Claude native older pages preserve live controls and carry exact owner-bound UUID cursors', async () => {
  const row = (/** @type {string} */ id) => ({ id: 'claude:' + id, role: 'assistant', turnId: 'display-native-turn', text: id, tools: [] });
  const f = await fixture({ ownerGeneration: 'owner-1', status: 'running', historyComplete: false, rows: [row('recent-a'), row('recent-b')] });
  const sourceIdentity = { app: 'claude-desktop', kind: 'session', id: f.options.nativeId, hostId: 'local:claude-desktop:' + 'a'.repeat(64),
    protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions', runtimeGeneration: 'owner-1' };
  const adapter = /** @type {Value} */ (f.adapter); adapter.supportsNativeHistoryPaging = true; adapter.supportsDataOnlyHistoryPaging = true;
  let reads = 0; adapter.readDataHistoryPage = async (/** @type {string} */ nativeId, /** @type {Value} */ boundary) => {
    reads++; assert.equal(nativeId, f.options.nativeId); assert.equal(boundary.ownerGeneration, 'owner-1');
    return { ownerGeneration: 'owner-1', historyDataOnly: true, historyComplete: false, coverage: { found: true },
      rows: [row('old-a'), row('old-b'), row('old-c')], status: 'idle', requests: [{ requestId: 'historical-unsafe-request' }] };
  };
  const connector = await f.create({ sourceIdentity });
  try {
    const recent = await connector.readRecent({ limit: 1 }); const metadata = structuredClone(f.transport.metadata), agentState = structuredClone(f.transport.agentState);
    const old = await connector.readRecent({ fresh: false, cursor: recent.nextCursor, limit: 2 });
    assert.deepEqual(old.rows.map((/** @type {Value} */ item) => item.id), ['claude:old-b', 'claude:old-c']);
    assert.equal(old.status, 'running'); assert.equal(old.ownerGeneration, 'owner-1'); assert.equal(old.hasMore, true);
    assert.deepEqual(f.transport.metadata, metadata); assert.deepEqual(f.transport.agentState, agentState);
    const boundary = JSON.parse(Buffer.from(old.nextCursor, 'base64url').toString()); assert.equal(boundary.id, 'claude:old-b'); assert.equal(boundary.ownerGeneration, 'owner-1');
    boundary.ownerGeneration = 'foreign-owner';
    await assert.rejects(connector.readRecent({ fresh: false, cursor: Buffer.from(JSON.stringify(boundary)).toString('base64url') }), { code: 'source-epoch-changed' });
    assert.equal(reads, 1); assert.equal(f.adapter.completeReads, 0); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('Claude history rejects unconfirmed and changed-owner pages without projecting stale data', async () => {
  for (const mode of ['unconfirmed', 'foreign', 'late-change']) {
    const f = await fixture({ ownerGeneration: 'owner-1', historyComplete: false, rows: [{ id: 'claude:recent', role: 'assistant', turnId: 'display', text: 'Recent', tools: [] }] });
    const adapter = /** @type {Value} */ (f.adapter); adapter.supportsNativeHistoryPaging = true; adapter.supportsDataOnlyHistoryPaging = true;
    adapter.readDataHistoryPage = async () => {
      if (mode === 'late-change') f.epoch('owner-2');
      return { historyDataOnly: true, rows: [], historyComplete: true, ownerGeneration: mode === 'foreign' ? 'owner-other' : 'owner-1', coverage: { found: mode !== 'unconfirmed' } };
    };
    const sourceIdentity = { app: 'claude-desktop', kind: 'session', id: f.options.nativeId, hostId: 'local:claude-desktop:' + 'a'.repeat(64), protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions', runtimeGeneration: 'owner-1' };
    const connector = await f.create({ sourceIdentity });
    try {
      const recent = await connector.readRecent({ limit: 1 }), metadata = structuredClone(f.transport.metadata);
      await assert.rejects(connector.readRecent({ fresh: false, cursor: recent.nextCursor, limit: 1 }), { code: mode === 'late-change' ? 'source-epoch-changed' : 'complete-history-unconfirmed' });
      assert.deepEqual(f.transport.metadata, metadata); assert.equal(f.adapter.completeReads, 0); assert.equal(f.adapter.calls.length, 0);
    } finally { await connector.close(); await f.dispose(); }
  }
});

test('verified Desktop saved history is readable with no live owner and cannot enable native controls or admission', async () => {
  const f = await fixture({ status: 'history-only', ownerGeneration: null, currentTurnId: null, historyComplete: true,
    rows: [{ id: 'saved-row', role: 'assistant', text: 'Saved original row', turnId: 'saved-native-turn', tools: [] }],
    historicalRead: { app: 'codex', version: 1, available: true, originator: 'Codex Desktop', nativeId: 'original-native-id', hostId: 'local', namespaceHash: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), byteBoundary: { start: 0, end: 100, total: 100 } } });
  /** @type {Value} */ (f.adapter).supportsNativeSavedHistory = true;
  const connector = await f.create();
  try {
    await connector.start(); const recent = await connector.readRecent({ limit: 1 });
    assert.equal(recent.rows[0].text, 'Saved original row'); assert.equal(recent.ownerGeneration, null);
    assert.equal(connector.status().sourceStatus, 'history-only'); assert.equal(f.transport.metadata.bridge.source.runtimeGeneration, null);
    assert.equal(f.transport.metadata.capabilities.steering, false); assert.equal(f.transport.metadata.capabilities.abort, false);
    assert.equal(f.transport.metadata.nativeSavedHistory.readOnly, true);
    assert.deepEqual(f.transport.metadata.capabilities.rpcMethods, ['bridge-receipt']);
    assert.deepEqual(f.transport.agentState.requests, {}); assert.deepEqual(f.transport.agentState.communications, {});
    f.transport.inject(user('Must not execute from saved history')); await connector.processInbox();
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(events(f.transport).some(event => event.ev?.t === 'user-message-accepted'), false);
  } finally { await connector.close(); await f.dispose(); }
});

test('unverified or foreign saved-history provenance cannot enter the native projection', async () => {
  for (const proof of [{ namespaceHash: 'invalid' }, { nativeId: 'foreign' }, { hostId: 'remote' }, { app: 'terminal' }, { byteBoundary: { start: 100, end: 50, total: 100 } }]) {
    const f = await fixture({ status: 'history-only', ownerGeneration: null, currentTurnId: null,
      historicalRead: { app: 'codex', version: 1, available: true, originator: 'Codex Desktop', nativeId: 'original-native-id', hostId: 'local', namespaceHash: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), byteBoundary: { start: 0, end: 100, total: 100 }, ...proof } });
    /** @type {Value} */ (f.adapter).supportsNativeSavedHistory = true;
    const connector = await f.create();
    try { await assert.rejects(connector.start(), { code: 'native-history-unverified' }); assert.equal(f.adapter.calls.length, 0); }
    finally { await connector.close(); await f.dispose(); }
  }
});

test('an async older saved page cannot publish under a newer saved-data metadata stamp', async () => {
  const proof = { app: 'codex', version: 1, available: true, originator: 'Codex Desktop', nativeId: 'original-native-id', hostId: 'local', namespaceHash: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), byteBoundary: { start: 100, end: 200, total: 200 } };
  const f = await fixture({ status: 'history-only', ownerGeneration: null, currentTurnId: null, historyComplete: false,
    rows: [{ id: 'saved-row', role: 'assistant', text: 'Saved original row', turnId: 'saved-turn', order: 100, tools: [] }], historicalRead: proof });
  const adapter = /** @type {Value} */ (f.adapter); adapter.supportsNativeSavedHistory = true;
  const connector = await f.create();
  try {
    await connector.start(); const first = await connector.readRecent({ limit: 1 });
    const captured = structuredClone(f.adapter.view);
    adapter.readHistoricalPage = async () => {
      const newer = { ...f.adapter.view, contentStamp: 'new-saved-data', historicalRead: { ...proof, sourceStamp: 'c'.repeat(64) } };
      await connector.project(newer); return captured;
    };
    await assert.rejects(connector.readRecent({ fresh: false, cursor: first.nextCursor, limit: 1 }), { code: 'source-epoch-changed' });
    assert.equal(f.transport.metadata.nativeSavedHistory.sourceStamp, 'c'.repeat(64)); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('GET history query limits normalize to numeric saved-reader bounds', async () => {
  const proof = { app: 'codex', version: 1, available: true, originator: 'Codex Desktop', nativeId: 'original-native-id', hostId: 'local', namespaceHash: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), byteBoundary: { start: 100, end: 200, total: 200 } };
  const f = await fixture({ status: 'history-only', ownerGeneration: null, currentTurnId: null, historyComplete: false,
    rows: [{ id: 'saved-row', role: 'assistant', text: 'Saved row', turnId: 'saved-turn', order: 100, tools: [] }], historicalRead: proof });
  const adapter = /** @type {Value} */ (f.adapter); adapter.supportsNativeSavedHistory = true;
  let requested = 0; adapter.readHistoricalPage = async (/** @type {string} */ _id, /** @type {Value} */ boundary) => {
    if (!Number.isSafeInteger(boundary.limit)) throw new BridgeError('codex-history-boundary-invalid', 'Numeric limit required.', 400);
    requested = boundary.limit;
    return { ...f.adapter.view, historyComplete: true, historicalRead: { ...proof, byteBoundary: { start: 0, end: 100, total: 200 } } };
  };
  const connector = await f.create();
  try {
    await connector.start(); const first = await connector.readRecent({ limit: 1 });
    const earlier = await connector.readRecent({ fresh: false, cursor: first.nextCursor, limit: '4' });
    assert.equal(requested, 4); assert.equal(earlier.hasMore, false); assert.equal(f.adapter.calls.length, 0);
    await assert.rejects(connector.readRecent({ fresh: false, cursor: first.nextCursor, limit: '4.5' }), { code: 'invalid-page-limit' });
  } finally { await connector.close(); await f.dispose(); }
});

test('image sync uses only markers; explicit reads reuse a durable attachment across ACK loss and restart', async () => {
  const f = await fixture(); const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const path = join(f.directory, 'image.png'); await writeFile(path, png);
  f.adapter.view.rows = [{ id: 'original-image', role: 'tool', text: '', turnId: 'original-turn', tools: [{ id: 'original-image', name: 'view_image', imagePath: path, output: '', status: 'completed' }] }];
  const uploads = /** @type {Value[]} */ ([]), ref = 'sessions/happy-fixture/attachments/11111111-1111-1111-1111-111111111111.enc';
  /** @type {any} */ (f.transport).uploadAttachment = async (/** @type {Buffer} */ bytes, /** @type {Value} */ options) => { uploads.push({ bytes, options }); return { ref }; };
  let connector = await f.create();
  try {
    f.transport.failPublication = true; await assert.rejects(connector.start()); await connector.close();
    connector = await f.create(); await connector.start();
    const recent = await connector.readRecent(); await connector.readRecent();
    assert.equal(uploads.length, 0);
    assert.deepEqual(recent.rows[0].tools[0].arguments, { nativeImageId: 'original-image', name: 'image.png' });
    const attachment = await f.transport.rpc('native-image-read', { imageId: 'original-image' });
    await f.transport.rpc('native-image-read', { imageId: 'original-image' });
    await connector.close(); connector = await f.create(); await connector.start();
    assert.deepEqual(await f.transport.rpc('native-image-read', { imageId: 'original-image' }), attachment);
    assert.equal(uploads.length, 1); assert.deepEqual([...uploads[0].bytes.subarray(0, 3)], [255, 216, 255]); assert.ok(uploads[0].bytes.length + 40 <= 500000);
    assert.deepEqual(attachment, { ref, name: 'image.jpg', size: uploads[0].bytes.length, image: { width: 1, height: 1 } });
    assert.equal(recent.rows[0].tools[0].name, 'file'); assert.equal(JSON.stringify(recent).includes(path), false);
    const start = events(f.transport).filter(event => event.ev.t === 'tool-call-start');
    assert.equal(start.length, 1); assert.equal(start[0].ev.call, 'original-image'); assert.equal(start[0].ev.args.nativeImageId, 'original-image'); assert.equal(start[0].ev.args.ref, undefined);
    await assert.rejects(f.transport.rpc('native-image-read', { imageId: 'other-session-image' }), { code: 'native-image-unavailable' });
    await assert.rejects(f.transport.rpc('native-image-read', { imageId: 'original-image', path }), { code: 'invalid-image-request' });
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('history and missing images stay as markers until an explicit image read', async () => {
  const f = await fixture(); const path = join(f.directory, 'later.png');
  const image = { id: 'older-image', role: 'tool', text: '', turnId: 'original-turn', tools: [{ id: 'older-image', name: 'view_image', imagePath: path, output: '', status: 'completed' }] };
  f.adapter.view.rows = [image, { id: 'latest', role: 'assistant', text: 'Latest', turnId: 'original-turn' }];
  let uploads = 0; /** @type {any} */ (f.transport).uploadAttachment = async () => { uploads++; return { ref: 'sessions/happy-fixture/attachments/11111111-1111-1111-1111-111111111111.enc' }; };
  const connector = await f.create({ recentRowLimit: 1 });
  try {
    await connector.start(); assert.equal(uploads, 0);
    const failed = await connector.readRecent({ limit: 2 }); assert.equal(failed.rows.length, 2);
    assert.equal(uploads, 0); assert.equal(failed.rows[0].tools[0].arguments.nativeImageId, 'older-image'); assert.equal(JSON.stringify(failed).includes(path), false);
    await assert.rejects(f.transport.rpc('native-image-read', { imageId: 'older-image' }), { code: 'native-image-unavailable' });
    await writeFile(path, await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer());
    const recovered = await connector.readRecent({ limit: 2 }); assert.equal(recovered.rows[0].tools[0].name, 'file'); assert.equal(uploads, 0);
    await f.transport.rpc('native-image-read', { imageId: 'older-image' }); assert.equal(uploads, 1);
    assert.equal((await connector.readRecent({ limit: 2 })).rows[0].tools[0].arguments.ref, undefined);
    assert.equal(connector.status().sourceStatus, 'connected'); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('an image from a remote or unleased owner cannot open or upload local files', async () => {
  for (const hostId of ['remote', 'local']) {
    const f = await fixture({ rows: [{ id: 'image', role: 'tool', text: '', turnId: 'turn', tools: [{ id: 'image', name: 'view_image', imagePath: '/untrusted/file.png', output: '', status: 'completed' }] }] });
    let uploads = 0; /** @type {any} */ (f.transport).uploadAttachment = async () => { uploads++; throw Error('Must not upload'); };
    if (hostId === 'local') f.lease(false);
    const connector = await f.create({ sourceIdentity: { ...f.options.sourceIdentity, hostId } });
    try {
      await connector.start(); const recent = await connector.readRecent();
      assert.equal(recent.rows[0].tools[0].arguments.nativeImageId, 'image');
      await assert.rejects(f.transport.rpc('native-image-read', { imageId: 'image' }), { code: 'source-epoch-changed' });
      assert.equal(uploads, 0); assert.equal(f.adapter.calls.length, 0);
    } finally { await connector.close(); await f.dispose(); }
  }
});

test('an unchanged original stamp cannot suppress the lazy image projection migration', async () => {
  const f = await fixture({ contentStamp: 'unchanged-original', rows: [{ id: 'image', role: 'tool', text: '', turnId: 'turn', tools: [{ id: 'image', name: 'view_image', imagePath: '/fixture/image.png', output: '', status: 'completed' }] }] });
  let connector = await f.create();
  try {
    await connector.start(); const before = await connector.readRecent(); await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8')), state = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    delete state.nativeImageProjectionVersion;
    state.rows.find((/** @type {Value} */ row) => row.id === 'tool:image').inputDigest = 'prior-image-projection';
    file.ciphertext = encryptRecord(state, f.options.encryptionKey); await writeFile(f.options.statePath, JSON.stringify(file));
    connector = await f.create(); await connector.start(); const after = await connector.readRecent();
    assert.ok(after.rows[0].snapshotRevision > before.rows[0].snapshotRevision);
    assert.equal(after.rows[0].tools[0].arguments.nativeImageId, 'image');
    assert.ok(events(f.transport).some(event => event.ev.t === 'native-row-upsert' && event.ev.tools?.[0]?.arguments?.nativeImageId === 'image'));
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('an accepted native row publishes and retains the old steering wire identities in fresh seeds', async () => {
  const f = await fixture({ rows: [{ id: 'temporary-steering-uuid', role: 'user', text: 'Original input', turnId: 'original-turn', commandId: 'original-caller' }] });
  const connector = await f.create();
  try {
    await connector.start(); const oldWire = events(f.transport).find(event => event.ev.t === 'text').id;
    f.adapter.view.rows = [{ id: 'accepted-user-row', role: 'user', text: 'Original input', turnId: 'original-turn', commandId: 'original-caller', replaceSourceRowIds: ['temporary-steering-uuid'] }]; f.adapter.view.revision++;
    await connector.project(f.adapter.view);
    const update = events(f.transport).find(event => event.ev.t === 'native-row-upsert' && event.ev.sourceRowId === 'accepted-user-row');
    assert.ok(update); assert.ok(update.ev.replaceIds.includes(oldWire));
    const recent = await connector.readRecent({ limit: 20 });
    assert.ok(recent.rows[0].replaceIds.includes(oldWire)); assert.deepEqual(recent.rows[0].replaceSourceRowIds, ['temporary-steering-uuid']);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('a near-capacity legacy checkpoint archives acknowledged bodies and old prefixes without replaying unknown commands', async () => {
  const f = await fixture({ rows: [{ id: 'current-row', role: 'assistant', text: 'Current', turnId: 'current-turn', status: 'completed' }] });
  let connector = await f.create({ recentRowLimit: 2 });
  try {
    await connector.start(); await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8')), state = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    const prefix = 'P'.repeat(11 * 1024 * 1024), body = 'B'.repeat(1024 * 1024);
    const legacy = Array.from({ length: 15 }, (_, index) => ({ id: `legacy-acked-event-${index}`, localId: `legacy-acked-event-${index}-observed`, ciphertext: encryptRecord({ role: 'session', content: { ev: { t: 'text', text: body } } }, f.options.encryptionKey), sent: true }));
    state.events.push(...legacy);
    state.rows.push({ id: 'old-row', role: 'assistant', turnId: 'old-turn', text: prefix,
      digest: createHmac('sha256', f.options.encryptionKey).update(JSON.stringify(prefix)).digest('hex'), eventIds: legacy.map(event => event.id), revision: 3, rowIdentityVersion: 1 });
    const unknown = { id: 'old-unknown-reply', origin: 'rpc', action: 'answer-question', payload: { questionItemId: 'old-question', answer: 'original draft' }, epoch: 'previous-owner', state: 'unknown', error: 'delivery-unknown' };
    state.commands.push(unknown); delete state.activeRowIds;
    const originalEvents = structuredClone(state.events);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) < 32 * 1024 * 1024);
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', f.options.encryptionKey, nonce), encoded = Buffer.from(JSON.stringify(state));
    file.ciphertext = Buffer.concat([Buffer.from([0]), nonce, cipher.update(encoded), cipher.final(), cipher.getAuthTag()]).toString('base64'); await writeFile(f.options.statePath, JSON.stringify(file));
    f.adapter.view.rows.push({ id: 'new-row', role: 'assistant', text: 'N'.repeat(1024 * 1024), turnId: 'current-turn', status: 'completed' }); f.adapter.view.revision++;
    connector = await f.create({ recentRowLimit: 2 }); await connector.start();
    let hot = /** @type {Value} */ (decryptRecord(JSON.parse(await readFile(f.options.statePath, 'utf8')).ciphertext, f.options.encryptionKey));
    assert.ok(Buffer.byteLength(JSON.stringify(hot)) < 8 * 1024 * 1024);
    assert.deepEqual(hot.commands.find((/** @type {Value} */ command) => command.id === unknown.id), unknown);
    assert.deepEqual(hot.rows.find((/** @type {Value} */ row) => row.id === 'old-row').eventIds, legacy.map(event => event.id));
    const history = await readObserverHistoryArchives(hot, f.options.statePath, f.options.encryptionKey);
    for (const event of originalEvents) assert.deepEqual(history.events.find(saved => saved.id === event.id), event);
    const oldRow = history.rows.find(row => row.id === 'old-row'); assert.ok(oldRow); assert.equal(oldRow.text, prefix);
    assert.equal(f.transport.records.some(item => legacy.some(event => item.localId === event.localId)), false);
    f.adapter.view.rows = [{ id: 'old-row', role: 'assistant', text: prefix + ' extended', turnId: 'old-turn', status: 'completed' }]; f.adapter.view.revision++;
    await connector.project(f.adapter.view);
    const delta = events(f.transport).filter(event => event.ev.t === 'text').at(-1);
    assert.ok(delta);
    assert.equal(delta.ev.text, ' extended');
    hot = /** @type {Value} */ (decryptRecord(JSON.parse(await readFile(f.options.statePath, 'utf8')).ciphertext, f.options.encryptionKey));
    assert.equal(hot.rows.find((/** @type {Value} */ row) => row.id === 'old-row').text, prefix + ' extended');
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('an identical full snapshot with empty bootstrap does not rewrite the encrypted checkpoint', async () => {
  const f = await fixture({ contentStamp: 'unchanged-public-view', rows: [{ id: 'stable-row', role: 'assistant', text: 'Stable content', turnId: 'stable-turn', status: 'completed' }] });
  const connector = await f.create();
  try { await connector.start(); const before = await readFile(f.options.statePath, 'utf8');
    await connector.project(f.adapter.view); await connector.project(f.adapter.view);
    assert.equal(await readFile(f.options.statePath, 'utf8'), before);
  } finally { await connector.close(); await f.dispose(); }
});

test('same-owner unchanged Antigravity reattachment restores disconnected metadata without replay or content journal writes', async () => {
  const f = await fixture({ contentStamp: 'unchanged-antigravity-owner', ownerGeneration: 'owner-1',
    rows: [{ id: 'stable-agy-row', role: 'assistant', text: 'Synthetic unchanged native marker', turnId: 'stable-turn', status: 'completed' }] });
  const sourceIdentity = { ...f.options.sourceIdentity, app: 'antigravity', kind: 'session', protocol: 'antigravity-connect', hostId: 'local:antigravity:' + 'a'.repeat(64) };
  let connector = await f.create({ sourceIdentity });
  try {
    await connector.start(); assert.equal(f.transport.metadata.bridge.sourceStatus, 'connected'); assert.equal(f.transport.metadata.capabilities.steering, true);
    const checkpoint = await readFile(f.options.statePath, 'utf8'); await connector.close();
    // Normal bound-source retirement closes network capabilities separately from
    // the original native content checkpoint and owner generation.
    const transport = new FixtureTransport();
    transport.metadata = { ...f.transport.metadata, bridge: { ...f.transport.metadata.bridge, sourceStatus: 'disconnected' },
      capabilities: { ...f.transport.metadata.capabilities, steering: false, abort: false, rpcMethods: [] } };
    let metadataUpdates = 0; const updateMetadata = transport.updateMetadata.bind(transport);
    transport.updateMetadata = async change => { metadataUpdates++; await updateMetadata(change); };
    connector = await f.create({ sourceIdentity, transport }); await connector.start();
    const recent = await connector.readRecent({ fresh: true });
    assert.equal(recent.rows.length, 1); assert.equal(connector.status().sourceStatus, 'connected');
    assert.equal(transport.metadata.bridge.sourceStatus, 'connected'); assert.equal(transport.metadata.capabilities.steering, true);
    assert.ok(transport.metadata.capabilities.rpcMethods.includes('abort')); assert.ok(metadataUpdates > 0);
    assert.equal(await readFile(f.options.statePath, 'utf8'), checkpoint); assert.equal(transport.records.length, 0); assert.equal(f.adapter.calls.length, 0);
    const publications = metadataUpdates; await connector.project(f.adapter.view); await connector.project(f.adapter.view);
    assert.equal(metadataUpdates, publications); assert.equal(await readFile(f.options.statePath, 'utf8'), checkpoint);
  } finally { await connector.close(); await f.dispose(); }
});

test('unchanged-content attachment retries failed metadata publication and rechecks a changed lease', async () => {
  const f = await fixture({ contentStamp: 'unchanged-metadata-retry', rows: [{ id: 'stable', role: 'assistant', text: 'Synthetic stable row', turnId: 'stable-turn', status: 'completed' }] });
  const connector = await f.create();
  try {
    await connector.start(); const checkpoint = await readFile(f.options.statePath, 'utf8');
    const updateMetadata = f.transport.updateMetadata.bind(f.transport); let fail = true;
    f.transport.updateMetadata = async change => { if (fail) { fail = false; throw Error('Synthetic metadata write failure'); } await updateMetadata(change); };
    f.lease(false); await assert.rejects(connector.project(f.adapter.view), /metadata write failure/);
    await connector.project(f.adapter.view); assert.equal(f.transport.metadata.capabilities.steering, false);
    f.lease(true); await connector.project(f.adapter.view); assert.equal(f.transport.metadata.capabilities.steering, true);
    assert.equal(await readFile(f.options.statePath, 'utf8'), checkpoint); assert.equal(f.adapter.calls.length, 0);
    // A failed metadata update after a same-lease content/state transition also
    // remains retryable; an earlier successful attachment cannot suppress it.
    f.adapter.view.contentStamp = 'changed-running-native'; f.adapter.view.currentTurnId = 'native-running-turn'; f.adapter.view.status = 'active'; fail = true;
    await assert.rejects(connector.project(f.adapter.view), /metadata write failure/);
    const projected = await readFile(f.options.statePath, 'utf8'); await connector.project(f.adapter.view);
    assert.equal(f.transport.metadata.bridge.currentTurnId, 'native-running-turn'); assert.equal(f.transport.metadata.capabilities.abort, true);
    assert.equal(await readFile(f.options.statePath, 'utf8'), projected); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('native first attachment primes its bounded history without broadcast and the first live repair is self-contained', async () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({ id: `native-old-${index}`, role: 'assistant', text: `Old native row ${index}`, turnId: `old-turn-${index}`, status: 'completed' }));
  const f = await fixture({ rows, historyComplete: true });
  const connector = await f.create({ publishInitialHistory: false, recentRowLimit: 100, supportsNativeProjection: true });
  try {
    await connector.start(); assert.equal(f.transport.records.length, 0);
    const recent = await connector.readRecent({ fresh: true, limit: 1 }); assert.equal(recent.rows.length, 1); assert.equal(recent.rows[0].id, 'native-old-299');
    const state = /** @type {Value} */ (decryptRecord(JSON.parse(await readFile(f.options.statePath, 'utf8')).ciphertext, f.options.encryptionKey));
    assert.equal(state.activeRowIds.length, 100); assert.ok(state.rows.every((/** @type {Value} */ row) => !row.eventIds.length));
    f.adapter.view.rows[299].text = 'Old native row 299 now revised'; f.adapter.view.revision++;
    await connector.project(f.adapter.view);
    const repaired = events(f.transport).find(event => event.ev.t === 'native-row-upsert' && event.ev.sourceRowId === 'native-old-299');
    assert.ok(repaired); assert.equal(repaired.ev.text, 'Old native row 299 now revised');
    f.adapter.view.rows.push({ id: 'new-live-row', role: 'assistant', text: 'New live text', turnId: 'new-live-turn', status: 'completed' }); f.adapter.view.revision++;
    await connector.project(f.adapter.view); assert.ok(events(f.transport).some(event => event.ev.t === 'text' && event.ev.text === 'New live text'));
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('new historical rows and primed tool baselines do not leak history, while a real tool completion seeds itself', async () => {
  const latest = { id: 'latest-tool', role: 'tool', text: '', turnId: 'tool-turn', tools: [{ id: 'native-tool', name: 'run_command', arguments: { command: 'synthetic only' }, output: '', status: 'running' }] };
  const f = await fixture({ rows: [latest], currentTurnId: 'tool-turn', status: 'running', historyComplete: false });
  const connector = await f.create({ publishInitialHistory: false, recentRowLimit: 100, supportsNativeProjection: true });
  try {
    await connector.start(); assert.equal(f.transport.records.length, 0);
    const old = Array.from({ length: 80 }, (_, index) => ({ id: `history-${index}`, role: 'assistant', text: `Historical row ${index}`, turnId: `history-turn-${index}`, status: 'completed' }));
    f.adapter.view.rows = [...old, latest]; f.adapter.view.revision++;
    await connector.project(f.adapter.view, true); assert.equal(f.transport.records.length, 0);
    latest.tools[0].output = 'Actual new completion'; latest.tools[0].status = 'completed'; f.adapter.view.currentTurnId = null; f.adapter.view.status = 'idle'; f.adapter.view.revision++;
    await connector.project(f.adapter.view);
    const tool = events(f.transport).find(event => event.ev.t === 'native-row-upsert' && event.ev.sourceRowId === 'latest-tool'); assert.ok(tool);
    assert.equal(tool.ev.tools[0].output, 'Actual new completion'); assert.equal(tool.ev.tools[0].status, 'completed');
    assert.equal(events(f.transport).some(event => event.ev.t === 'text' && event.ev.text.startsWith('Historical row')), false);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('same-stamp reattachment marks the history baseline primed so the next newly live row is published', async () => {
  const f = await fixture({ contentStamp: 'original-unchanged', rows: [{ id: 'old-row', role: 'assistant', text: 'Old native row', turnId: 'old-turn', status: 'completed' }] });
  let connector = await f.create({ publishInitialHistory: false, supportsNativeProjection: true });
  try {
    await connector.start(); assert.equal(f.transport.records.length, 0); await connector.close();
    connector = await f.create({ publishInitialHistory: false, supportsNativeProjection: true }); await connector.start();
    f.adapter.view.rows.push({ id: 'fresh-row', role: 'assistant', text: 'Only new live data', turnId: 'fresh-turn', status: 'completed' });
    f.adapter.view.contentStamp = 'new-live-stamp'; f.adapter.view.revision++; await connector.project(f.adapter.view);
    assert.ok(events(f.transport).some(event => event.ev.t === 'text' && event.ev.text === 'Only new live data'));
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('history priming never suppresses exact native admission receipts or replays an unknown input', async () => {
  const f = await fixture(); let connector = await f.create({ publishInitialHistory: false, supportsNativeProjection: true });
  try {
    await connector.start(); f.adapter.fail = true; f.transport.inject(user('Synthetic admission only'), 'original-local', 'original-broker');
    await connector.processInbox(); assert.equal(f.adapter.calls.length, 1); const commandId = f.adapter.calls[0].commandId;
    await connector.close(); f.adapter.fail = false;
    f.adapter.view.rows = [{ id: 'original-native-user', role: 'user', text: 'Synthetic admission only', commandId, turnId: 'native-admitted-turn', inputStatus: 'accepted', status: 'completed' }];
    f.adapter.view.revision++; connector = await f.create({ publishInitialHistory: false, supportsNativeProjection: true }); await connector.start();
    const accepted = events(f.transport).find(event => event.ev.t === 'user-message-accepted'); assert.ok(accepted);
    assert.equal(accepted.ev.ref, 'original-broker'); assert.equal(accepted.ev.runId, 'native-admitted-turn'); assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('source-bound parent-owned native input disables direct steering without disconnecting read, stop or native responses', async () => {
  const f = await fixture({ status: 'active', currentTurnId: 'native-active-turn',
    rows: [{ id: 'async-question-row', role: 'assistant', text: '', turnId: 'native-active-turn', asyncQuestions: [{ questionItemId: 'async-child-question', title: 'Message question', options: ['A'], answered: false }] }],
    requests: [{ kind: 'user-input', requestId: 'real-native-request', operable: true, questions: [{ id: 'native-q', question: 'Native request', options: [{ label: 'A' }] }] }],
    nativeInput: { app: 'codex', nativeConversationId: 'original-native-id', hostId: 'local', ownerGeneration: 'owner-1',
    available: false, reason: 'parent-owned-subagent', parentConversationId: 'parent-native', agentPath: '/root/child' } });
  const connector = await f.create();
  try {
    await connector.start(); assert.equal(f.transport.metadata.bridge.sourceStatus, 'connected');
    assert.equal(f.transport.metadata.capabilities.steering, false); assert.equal(f.transport.metadata.capabilities.abort, true);
    assert.ok(f.transport.metadata.capabilities.rpcMethods.includes('permission')); assert.ok(f.transport.metadata.capabilities.rpcMethods.includes('communication'));
    assert.equal(f.transport.agentState.nativeInput.reason, 'parent-owned-subagent'); assert.equal(f.transport.agentState.nativeInput.parentConversationId, 'parent-native');
    assert.equal(Object.keys(f.transport.agentState.communications).length, 1);
    assert.equal(Object.values(f.transport.agentState.communications)[0].form.questions[0].question, 'Native request');
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('verified native suffix history can advance a cursor without claiming complete history or replaying commands', async () => {
  const f = await fixture({ status: 'idle', currentTurnId: null, nativeStepOffset: 48, nativeStepEnd: 64, historyComplete: false,
    rows: [{ id: 'tail-row', role: 'assistant', text: 'Tail', turnId: 'original-turn', order: 48, status: 'completed' }] });
  (/** @type {Value} */ (f.adapter)).supportsNativeHistoryPaging = true;
  f.adapter.completeSnapshot = async () => ({ ...f.adapter.view, nativeStepOffset: 32, nativeStepEnd: 64, historyComplete: false,
    rows: [{ id: 'earlier-row', role: 'assistant', text: 'Earlier', turnId: 'original-turn', order: 32, status: 'completed' }, ...f.adapter.view.rows] });
  const connector = await f.create();
  try {
    const first = await connector.readRecent({ fresh: false, limit: 1 }); assert.equal(first.hasMore, true);
    const earlier = await connector.readRecent({ fresh: false, cursor: first.nextCursor, limit: 1 });
    assert.equal(earlier.rows[0].id, 'earlier-row'); assert.equal(earlier.historyComplete, false); assert.equal(earlier.hasMore, true);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('materialized history pages survive a fresh latest view without changing live pending requests or native controls', async () => {
  const f = await fixture({ status: 'idle', currentTurnId: null, trajectoryId: 'native-trajectory', nativeStepOffset: 48, nativeStepEnd: 64, historyComplete: false,
    rows: [{ id: 'tail', role: 'assistant', text: 'Tail', turnId: 'original-turn', order: 63, status: 'completed' }] });
  (/** @type {Value} */ (f.adapter)).supportsNativeHistoryPaging = true;
  (/** @type {Value} */ (f.adapter)).readMaterializedHistory = () => ({ ownerGeneration: 'owner-1', status: 'active', currentTurnId: 'old-control-turn', requests: [{ id: 'old-request' }],
    nativeStepOffset: 32, nativeStepEnd: 64, historyComplete: false,
    rows: [{ id: 'earlier', role: 'assistant', text: 'Materialized', turnId: 'original-turn', order: 32, status: 'completed' }, ...f.adapter.view.rows] });
  let expansions = 0; f.adapter.completeSnapshot = async () => { expansions++; return f.adapter.view; };
  const connector = await f.create();
  try {
    const first = await connector.readRecent({ fresh: false, limit: 1 });
    const source = structuredClone(f.transport.metadata), requests = structuredClone(f.transport.agentState.requests);
    const page = await connector.readRecent({ fresh: false, cursor: first.nextCursor, limit: 1 });
    assert.equal(page.rows[0].id, 'earlier'); assert.equal(page.status, 'idle'); assert.equal(page.currentTurnId, null);
    assert.equal(expansions, 0); assert.deepEqual(f.transport.metadata, source); assert.deepEqual(f.transport.agentState.requests, requests);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('unknown question replies recover only from the accepted original command ID under the same epoch', async () => {
  const f = await fixture({ rows: [{ id: 'question-row', role: 'assistant', text: '', turnId: 'question-turn', asyncQuestions: [{ questionItemId: 'strict-question', title: 'Choose', options: ['A'], answered: false }] }] });
  const connector = await f.create();
  try {
    await connector.start(); f.adapter.fail = true;
    const id = 'strict-question-answer', key = Object.keys(f.transport.agentState.communications)[0];
    await assert.rejects(f.transport.rpc('communication', { commandId: id, id: key, status: 'answered', answers: { answer: { options: ['A'] } } }));
    f.adapter.view.rows.push({ id: 'pending-steer', role: 'user', text: 'Choose\nA', commandId: id, turnId: 'question-turn', inputStatus: 'pending' });
    await connector.project(f.adapter.view);
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId: id })).receipt.status, 'unknown');
    f.adapter.view.rows.at(-1).inputStatus = 'accepted';
    await connector.project(f.adapter.view);
    const recovered = (await f.transport.rpc('bridge-receipt', { commandId: id })).receipt;
    assert.equal(recovered.status, 'complete'); assert.equal(recovered.nativeReceiptStatus, 'unknown'); assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('text suffixes preserve native identity and confirmed user rows replace provisional echoes', async () => {
  const f = await fixture({ currentTurnId: 'turn-1', status: 'active', rows: [{ id: 'assistant-row', role: 'assistant', text: 'Hello', turnId: 'turn-1', status: 'inProgress' }] });
  const connector = await f.create();
  try {
    await connector.start();
    f.adapter.view.rows[0].text += ' world'; await connector.project(f.adapter.view);
    const text = f.transport.records.filter(item => item.record.content.ev.t === 'text');
    assert.deepEqual(text.map(item => item.record.meta.nativeRow), [{ id: 'assistant-row', offset: 0, revision: 0 }, { id: 'assistant-row', offset: 5, revision: 0 }]);
    f.adapter.view.rows.push({ id: 'pending-user:client-id', role: 'user', text: 'Reply', commandId: 'client-id', turnId: 'turn-1' });
    await connector.project(f.adapter.view);
    const provisional = events(f.transport).find(event => event.ev.t === 'text' && event.ev.text === 'Reply'); assert.ok(provisional);
    f.adapter.view.rows[1] = { id: 'confirmed-user', role: 'user', text: 'Reply', commandId: 'client-id', turnId: 'turn-1' };
    await connector.project(f.adapter.view);
    const replacement = events(f.transport).find(event => event.ev.t === 'native-row-upsert' && event.ev.sourceRowId === 'confirmed-user');
    assert.ok(replacement); assert.ok(replacement.ev.replaceIds.includes(provisional.id));
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('unchanged legacy text receives one full identity replacement without replaying commands', async () => {
  const f = await fixture({ rows: [{ id: 'legacy-row', role: 'assistant', text: 'Existing complete text', turnId: 'turn-1', status: 'completed' }] });
  let connector = await f.create();
  try {
    await connector.start(); await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    const state = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    for (const row of state.rows) delete row.rowIdentityVersion;
    file.ciphertext = encryptRecord(state, f.options.encryptionKey);
    await writeFile(f.options.statePath, JSON.stringify(file));
    connector = await f.create(); await connector.start(); await connector.project(f.adapter.view);
    const replacements = events(f.transport).filter(event => event.ev.t === 'native-row-upsert' && event.ev.sourceRowId === 'legacy-row');
    assert.equal(replacements.length, 1); assert.equal(replacements[0].ev.text, 'Existing complete text');
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('a fresh own input supplies broker and local aliases instead of creating another phone user message', async () => {
  const f = await fixture(); const connector = await f.create();
  try {
    await connector.start(); f.transport.inject(user('Own phone input'), 'phone-local-alias', 'server-user-alias');
    await connector.processInbox();
    const recent = await connector.readRecent();
    const own = recent.rows.find((/** @type {Value} */ row) => row.role === 'user'); assert.ok(own);
    assert.ok(own.replaceIds.includes('server-user-alias')); assert.ok(own.replaceIds.includes('phone-local-alias'));
    assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('recent native reads return complete rows and advance seed version for changed same-revision snapshots without commands', async () => {
  const f = await fixture({ currentTurnId: 'original-turn', status: 'active', rows: [{ id: 'native-text', role: 'assistant', text: 'complete base', turnId: 'original-turn', at: 10, status: 'inProgress' }] });
  const connector = await f.create();
  try {
    const first = await connector.readRecent();
    assert.equal(first.rows[0].text, 'complete base'); assert.ok(first.rows[0].replaceIds.length > 0);
    f.adapter.view.rows[0].text += ' and current suffix'; // The original silent snapshot revision intentionally stays 1.
    const second = await connector.readRecent();
    assert.equal(second.revision, first.revision); assert.equal(second.rows[0].text, 'complete base and current suffix');
    assert.ok(second.rows[0].snapshotRevision > first.rows[0].snapshotRevision);
    assert.equal(second.rows[0].streamRevision, first.rows[0].streamRevision); assert.equal(f.adapter.calls.length, 0);
    assert.equal(connector.status().activeOperations, 0);
  } finally { await connector.close(); await f.dispose(); }
});
test('bounded real observation retains full history evidence without publishing older rows or loading history on entry', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: `native-${index}`, role: 'assistant', text: `complete-${index}`, turnId: 'original-turn', at: index, status: 'completed' }));
  const f = await fixture({ rows, historyComplete: false }); Object.assign(f.options, { recentRowLimit: 100 });
  const connector = await f.create();
  try {
    const first = await connector.readRecent();
    assert.equal(first.rows[0].id, 'native-150'); assert.equal(f.adapter.completeReads, 0);
    assert.equal(events(f.transport).filter(event => event.ev.t === 'text').length, 100);
    const older = await connector.readRecent({ fresh: false, cursor: first.nextCursor });
    assert.equal(f.adapter.completeReads, 0); assert.equal(older.historyComplete, false);
    const earlier = await connector.readRecent({ fresh: false, cursor: older.nextCursor });
    assert.equal(earlier.rows[0].id, 'native-50'); assert.equal(f.adapter.completeReads, 0);
    assert.equal(events(f.transport).filter(event => event.ev.t === 'text').length, 100);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('Codex small older pages reuse confirmed loaded rows while a bulk-history failure cannot replace live controls', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ id: `loaded-${index}`, role: 'assistant', text: `Original ${index}`, tools: [], turnId: 'active-turn' }));
  const f = await fixture({ ownerGeneration: 'owner-1', status: 'active', currentTurnId: 'active-turn', rows, historyComplete: false,
    requests: [{ kind: 'native-request', requestId: 'pending-native' }] });
  f.adapter.completeSnapshot = async () => { f.adapter.completeReads++; throw new BridgeError('history-unavailable', 'The original bulk history is unavailable.'); };
  const connector = await f.create();
  try {
    const recent = await connector.readRecent({ limit: 1 });
    const nativeCursor = JSON.parse(Buffer.from(recent.nextCursor, 'base64url').toString('utf8'));
    assert.equal(nativeCursor.ownerGeneration, 'owner-1');
    for (const foreign of [{ ...nativeCursor, sessionId: 'other-session' }, { ...nativeCursor, ownerGeneration: 'other-owner' }]) {
      await assert.rejects(connector.readRecent({ fresh: false, cursor: Buffer.from(JSON.stringify(foreign)).toString('base64url'), limit: 4 }),
        { code: foreign.sessionId === 'other-session' ? 'invalid-history-cursor' : 'source-epoch-changed' });
    }
    assert.equal(f.adapter.completeReads, 0);
    const older = await connector.readRecent({ fresh: false, cursor: recent.nextCursor, limit: 4 });
    await assert.rejects(connector.readRecent({ fresh: false,
      cursor: Buffer.from(JSON.stringify({ ...nativeCursor, id: 'not-in-native-window' })).toString('base64url'), limit: 4 }),
      { code: 'stale-history-cursor' });
    assert.deepEqual(older.rows.map((/** @type {Value} */ row) => row.id), ['loaded-3', 'loaded-4', 'loaded-5', 'loaded-6']);
    assert.equal(older.ownerGeneration, 'owner-1'); assert.equal(older.currentTurnId, 'active-turn');
    assert.equal(older.historyComplete, false); assert.equal(f.adapter.completeReads, 0);
    const start = await connector.readRecent({ fresh: false, cursor: older.nextCursor, limit: 4 });
    assert.deepEqual(start.rows.map((/** @type {Value} */ row) => row.id), ['loaded-0', 'loaded-1', 'loaded-2']);
    assert.equal(f.adapter.completeReads, 0);
    await assert.rejects(connector.readRecent({ fresh: false, cursor: start.nextCursor, limit: 4 }), { code: 'history-unavailable' });
    assert.equal(f.adapter.completeReads, 1);
    const latest = await connector.readRecent({ limit: 1 });
    assert.equal(latest.rows[0].id, 'loaded-7'); assert.equal(latest.currentTurnId, 'active-turn');
    assert.deepEqual(f.adapter.view.requests, [{ kind: 'native-request', requestId: 'pending-native' }]);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('RPC identity includes the method and cannot reinterpret an open receipt as a successful abort', async () => {
  const f = await fixture({ currentTurnId: 'original-turn' });
  f.adapter.command = async (/** @type {string} */ _id, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
    f.adapter.calls.push({ action, payload, commandId }); return { requested: true };
  };
  const connector = await f.create();
  try {
    await connector.start(); const params = { commandId: 'same-id-different-method', turnId: 'original-turn' };
    await f.transport.rpc('open-desktop', params);
    await assert.rejects(f.transport.rpc('abort', params), { code: 'command-conflict' });
    assert.equal(f.adapter.calls.length, 1); assert.equal(f.adapter.calls[0].action, 'open-desktop');
  } finally { await connector.close(); await f.dispose(); }
});

test('native child model display never starts a settings controller and stale clients cannot read or write it', async () => {
  for (const app of ['codex', 'antigravity', 'claude-desktop']) {
    const f = await fixture(); f.adapter.supportsNativeModelSettings = true;
    const source = app === 'codex' ? f.options.sourceIdentity : { app, id: 'original-native-id', kind: 'session',
      hostId: `local:${app}:` + 'a'.repeat(64), protocol: app === 'antigravity' ? 'antigravity-connect' : 'claude-desktop-native',
      ...(app === 'claude-desktop' ? { nativeCollection: 'claude-code-sessions', appMode: 'code' } : {}) };
    const connector = await f.create({ sourceIdentity: source, metadata: { ...f.options.metadata, nativeSession: { isSubagent: true } } });
    try {
      await connector.start();
      assert.equal(f.transport.metadata.capabilities.rpcMethods.includes('codex-controls-read'), false);
      assert.equal(f.transport.metadata.capabilities.rpcMethods.includes('codex-controls-update'), false);
      await assert.rejects(f.transport.rpc('codex-controls-read', { commandId: 'child-model-read' }), { code: 'unsupported-action' });
      await assert.rejects(f.transport.rpc('codex-controls-update', { commandId: 'child-model-write', model: 'model-B', reasoningEffort: null,
        expectedModel: 'model-A', expectedReasoningEffort: null }), { code: 'unsupported-action' });
      const view = await connector.readRecent({ fresh: true, limit: 1 });
      assert.equal(view.ownerGeneration, 'owner-1'); assert.equal(f.adapter.calls.length, 0);
    } finally { await connector.close(); await f.dispose(); }
  }
});

test('native controls read publishes original settings and model writes retain CAS, receipt and epoch boundaries', async () => {
  const f = await fixture({ currentTurnId: 'active-original-turn', status: 'active' }); f.adapter.supportsNativeModelSettings = true;
  const controls = { model: { available: true, current: { model: 'model-A', reasoningEffort: 'medium', modelProvider: 'fixture' }, models: [{ id: 'model-A', label: 'A', reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }, { id: 'model-B', label: 'B', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }], catalogSource: 'fixture' } };
  f.adapter.command = async (/** @type {string} */ nativeId, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
    f.adapter.calls.push({ nativeId, action, payload, commandId });
    if (action === 'read-controls') return structuredClone(controls);
    if (action !== 'update-settings') throw new BridgeError('unsupported-action', 'fixture');
    if (f.adapter.fail) throw new BridgeError('delivery-unknown', 'fixture lost settings ACK');
    if (payload.expectedModel !== controls.model.current.model || payload.expectedReasoningEffort !== controls.model.current.reasoningEffort) throw new BridgeError('settings-conflict', 'fixture stale choice');
    controls.model.current = { ...controls.model.current, model: payload.model, reasoningEffort: payload.reasoningEffort }; return { acknowledged: true, applied: true, settingsReadbackConfirmed: true, controls: structuredClone(controls) };
  };
  const connector = await f.create();
  try {
    await connector.start(); await f.transport.rpc('codex-controls-read', { commandId: 'read-original-controls' });
    assert.equal(f.transport.metadata.nativeControls.model.current.model, 'model-A'); assert.equal(f.transport.metadata.capabilities.modelSelection, true);
    const params = { commandId: 'model-choice-stable', model: 'model-B', reasoningEffort: 'low', expectedModel: 'model-A', expectedReasoningEffort: 'medium' };
    await f.transport.rpc('codex-controls-update', params); await f.transport.rpc('codex-controls-update', params);
    assert.equal(f.adapter.calls.filter(c => c.action === 'update-settings').length, 1); assert.equal(f.adapter.view.currentTurnId, 'active-original-turn');
    await assert.rejects(f.transport.rpc('codex-controls-update', { ...params, commandId: 'model-choice-extra-field', cwd: '/never-change' }), { code: 'invalid-settings' });
    await assert.rejects(f.transport.rpc('codex-controls-update', { ...params, commandId: 'model-choice-stale' }), { code: 'settings-conflict' });
    f.adapter.fail = true; const lost = { ...params, commandId: 'model-choice-unknown', expectedModel: 'model-B', expectedReasoningEffort: 'low' };
    await assert.rejects(f.transport.rpc('codex-controls-update', lost), { code: 'delivery-unknown' });
    const count = f.adapter.calls.filter(c => c.action === 'update-settings').length;
    await assert.rejects(f.transport.rpc('codex-controls-update', lost), { code: 'delivery-unknown' }); assert.equal(f.adapter.calls.filter(c => c.action === 'update-settings').length, count);
  } finally { await connector.close(); await f.dispose(); }
});

test('applied model settings with lost readback reconcile the original unknown ID using same-owner reads only', async () => {
  const f = await fixture(); f.adapter.supportsNativeModelSettings = true;
  const controls = { model: { available: true, current: { model: 'model-A', reasoningEffort: 'medium', modelProvider: 'fixture' }, models: [], catalogSource: 'fixture' } };
  let writes = 0;
  f.adapter.command = async (/** @type {string} */ _nativeId, /** @type {string} */ action, /** @type {Value} */ payload) => {
    if (action === 'read-controls') return structuredClone(controls);
    if (action !== 'update-settings') throw new BridgeError('unsupported-action', 'fixture');
    writes++; controls.model.current = { ...controls.model.current, model: payload.model, reasoningEffort: payload.reasoningEffort };
    return { applied: true, acknowledged: false, settingsReadbackConfirmed: false };
  };
  let connector = await f.create();
  const params = { commandId: 'applied-settings-lost-readback', model: 'model-B', reasoningEffort: 'low', expectedModel: 'model-A', expectedReasoningEffort: 'medium' };
  try {
    await connector.start(); await assert.rejects(f.transport.rpc('codex-controls-update', params), { code: 'delivery-unknown' });
    const recovered = await f.transport.rpc('bridge-receipt', { commandId: params.commandId });
    assert.equal(recovered.receipt.id, params.commandId); assert.equal(recovered.receipt.status, 'complete'); assert.equal(recovered.receipt.nativeReceiptStatus, 'unknown'); assert.equal(writes, 1);
    await f.transport.rpc('codex-controls-update', params); assert.equal(writes, 1);
    await connector.close(); connector = await f.create(); await connector.start();
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId: params.commandId })).receipt.status, 'complete');
    await f.transport.rpc('codex-controls-update', params); assert.equal(writes, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('a legacy methodless RPC checkpoint migrates only its frozen original method without native replay', async () => {
  const f = await fixture();
  f.adapter.command = async (/** @type {string} */ _id, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
    f.adapter.calls.push({ action, payload, commandId }); return { requested: true };
  };
  let connector = await f.create();
  const params = { commandId: 'legacy-open-receipt' };
  try {
    await connector.start(); await f.transport.rpc('open-desktop', params); await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    const old = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    const command = old.commands.find((/** @type {Value} */ saved) => saved.id === params.commandId);
    delete command.rpcMethod; command.requestDigest = createHmac('sha256', f.options.encryptionKey).update(JSON.stringify(params)).digest('hex');
    file.ciphertext = encryptRecord(old, f.options.encryptionKey);
    await writeFile(f.options.statePath, JSON.stringify(file), { mode: 0o600 });
    connector = await f.create(); await connector.start(); await f.transport.rpc('open-desktop', params);
    await assert.rejects(f.transport.rpc('abort', params), { code: 'command-conflict' });
    assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('window source has only explicit controls and never treats a phone message as Agent input', async () => {
  const f = await fixture({ kind: 'window', status: 'active', textInputAvailable: false, semanticControlAvailable: true, coordinateControlAvailable: true,
    captureStamp: { runtimeGeneration: 'owner-1', windowGeneration: 'window-1', layoutGeneration: 'layout-1', imageLayoutHash: 'image-1' }, bounds: { width: 600, height: 400 }, imageRef: 'test-encrypted-ref', controls: [] });
  f.options.sourceIdentity.app = 'terminal';
  f.adapter.command = async (/** @type {string} */ _id, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
    f.adapter.calls.push({ action, payload, commandId }); return { acknowledged: true };
  };
  const connector = await f.create();
  try {
    await connector.start();
    assert.equal(f.transport.metadata.capabilities.messageReceipts, true);
    assert.ok(f.transport.metadata.capabilities.rpcMethods.includes('window-control'));
    assert.equal(f.transport.agentState.windowObservation.imageRef, 'test-encrypted-ref');
    f.transport.inject(user('cannot inject into a terminal')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 0);
    await assert.rejects(f.transport.rpc('window-control', { commandId: 'terminal-no-type', action: 'type', payload: { nodeId: 'fake', text: 'never injected' } }), { code: 'unsupported-action' });
    assert.equal(f.adapter.calls.length, 0);
    const click = { commandId: 'window-click-once', action: 'click', payload: { captureStamp: f.adapter.view.captureStamp, x: 5, y: 6 } };
    await f.transport.rpc('window-control', click); await f.transport.rpc('window-control', click); assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('an idle source without an existing owner keeps observation available and never creates another runtime', async () => {
  const f = await fixture({ status: 'owner-unavailable' });
  f.adapter.subscribe = async () => { throw new BridgeError('codex-owner-unavailable', 'No original owner is loaded.'); };
  const connector = await f.create();
  try { await connector.start(); assert.equal(connector.status().sourceStatus, 'owner-unavailable'); assert.equal(f.transport.metadata.capabilities.steering, false); assert.equal(f.adapter.calls.length, 0); }
  finally { await connector.close(); await f.dispose(); }
});

test('bootstrap identity initializes prefix, Unicode suffix publishes once and nonprefix is explicit replacement', async () => {
  const row = { id: 'row-a', role: 'assistant', text: 'Hello', turnId: 'native-turn', status: 'inProgress' }, f = await fixture({ rows: [row], currentTurnId: 'native-turn', status: 'active' });
  const bootstrap = 'ni' + createHash('sha256').update(`original-native-id:${row.id}:bootstrap`).digest('hex').slice(0, 28);
  f.transport.inbox.push({ id: 'bootstrap-log', localId: bootstrap + '-observed', record: { role: 'session', content: { id: bootstrap, time: 100, role: 'agent', turn: row.turnId, ev: { t: 'text', text: row.text } } } });
  const connector = await f.create();
  try { await connector.start(); assert.equal(events(f.transport).filter(item => item.ev.t === 'text').length, 0);
    f.adapter.view.rows[0].text = 'Hello 😀\n中文'; await connector.project(f.adapter.view);
    assert.equal(events(f.transport).find(item => item.ev.t === 'text')?.ev.text, ' 😀\n中文'); const before = f.transport.records.length; await connector.project(f.adapter.view); assert.equal(f.transport.records.length, before);
    f.adapter.view.rows[0].text = 'corrected text'; await connector.project(f.adapter.view);
    const replacements = events(f.transport).filter(item => item.ev.t === 'native-row-upsert');
    assert.ok(replacements[0].ev.replaceIds.includes(bootstrap));
    const replace = replacements.at(-1); assert.ok(replace); assert.equal(replace.ev.text, 'corrected text');
    assert.ok(replace.ev.replaceIds.includes(replacements[0].id)); assert.equal(connector.status().projectionStatus, 'resync-required'); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('native input called once, accepted references Happy server id/real turn, own echo is correlated by commandId', async () => {
  const f = await fixture(); let connector = await f.create();
  try { await connector.start(); f.transport.inject(user('own Happy message')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
    const accepted = events(f.transport).find(item => item.ev.t === 'user-message-accepted'); assert.ok(accepted); assert.equal(accepted.ev.ref, 'happy-user-1'); assert.equal(accepted.ev.runId, 'turn-1');
    assert.equal(events(f.transport).filter(item => item.role === 'user' && item.ev.t === 'text').length, 0);
    await connector.close(); connector = await f.create(); await connector.start(); f.transport.inject(user('own Happy message')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
    assert.ok(!(await readFile(f.options.statePath, 'utf8')).includes('own Happy message'));
  } finally { await connector.close(); await f.dispose(); }
});

test('unknown native dispatch survives restart without retry and does not emit fake accepted/rejected', async () => {
  const f = await fixture(); f.adapter.fail = true; let connector = await f.create();
  try { await connector.start(); f.transport.inject(user('unknown request')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
    const command = f.adapter.calls[0].commandId; assert.equal((await f.transport.rpc('bridge-receipt', { commandId: command })).receipt.status, 'unknown');
    assert.equal(events(f.transport).filter(item => ['user-message-accepted', 'user-message-rejected'].includes(item.ev.t)).length, 0);
    assert.equal(events(f.transport).filter(item => item.ev.t === 'user-message-delivery-unknown').length, 1);
    await connector.close(); connector = await f.create(); await connector.start(); f.transport.inject(user('unknown request')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('a late matching input row from a replacement owner cannot confirm an old native admission', async () => {
  const f = await fixture({ ownerGeneration: 'owner-1' }), adapter = /** @type {Value} */ (f.adapter);
  adapter.command = async (/** @type {string} */ _nativeId, /** @type {string} */ _action, /** @type {Value} */ _payload, /** @type {string} */ commandId) => {
    adapter.calls.push({ commandId }); return { acknowledged: true, messageId: 'matching-native-row' };
  };
  f.adapter.beforeSnapshot = () => {
    if (!adapter.calls.length) return;
    f.epoch('replacement-owner'); adapter.view.ownerGeneration = 'replacement-owner';
    adapter.view.rows = [{ id: 'matching-native-row', role: 'user', commandId: adapter.calls[0].commandId, inputStatus: 'accepted',
      turnId: 'replacement-native-turn', text: 'Original input', tools: [] }];
  };
  const connector = await f.create();
  try {
    await connector.start(); f.transport.inject(user('Original input')); await connector.processInbox();
    const commandId = adapter.calls[0].commandId;
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    assert.equal(events(f.transport).some(event => event.ev.t === 'user-message-accepted'), false);
    await connector.project(adapter.view);
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    f.transport.inject(user('Original input')); await connector.processInbox();
    assert.equal(adapter.calls.length, 1); assert.equal(events(f.transport).some(event => event.ev.t === 'user-message-accepted'), false);
  } finally { await connector.close(); await f.dispose(); }
});

test('unknown message receipt is stable across restart and late exact native identity confirms it without redispatch', async () => {
  const f = await fixture(); f.adapter.fail = true; let connector = await f.create();
  try {
    await connector.start(); f.transport.inject(user('late-confirmation')); await connector.processInbox();
    const commandId = f.adapter.calls[0].commandId;
    const unknown = events(f.transport).find(item => item.ev.t === 'user-message-delivery-unknown');
    assert.ok(unknown); assert.equal(unknown.ev.ref, 'happy-user-1'); assert.equal(unknown.ev.commandId, commandId);
    await connector.close(); connector = await f.create(); await connector.start();
    f.transport.inject(user('late-confirmation')); await connector.processInbox();
    assert.equal(f.adapter.calls.length, 1);
    assert.deepEqual(events(f.transport).filter(item => item.ev.t === 'user-message-delivery-unknown'), [unknown]);
    f.adapter.view.rows.push({ id: 'original-late-row', role: 'user', text: 'late-confirmation', commandId, turnId: 'original-late-turn', status: 'completed' });
    await connector.project(f.adapter.view);
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'complete');
    const accepted = events(f.transport).filter(item => item.ev.t === 'user-message-accepted');
    assert.equal(accepted.length, 1); assert.equal(accepted[0].ev.ref, 'happy-user-1'); assert.equal(accepted[0].ev.runId, 'original-late-turn');
    assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('a failed pending user row without a turn ID never confirms input, including an old saved false confirmation', async () => {
  const f = await fixture(); let connector = await f.create();
  f.adapter.command = async (nativeId, action, payload, commandId) => {
    f.adapter.calls.push({ nativeId, action, payload, commandId });
    f.adapter.view.rows.push({ id: `pending-user:${commandId}`, role: 'user', text: payload.text, commandId, turnId: null, status: 'failed' });
    f.adapter.emit();
    throw new BridgeError('delivery-unknown', 'fixture cloud-only admission rejected before turn allocation');
  };
  try {
    await connector.start(); f.transport.inject(user('fixture pending input')); await connector.processInbox();
    const commandId = f.adapter.calls[0].commandId;
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    assert.equal(events(f.transport).filter(item => item.ev.t === 'user-message-accepted').length, 0);
    await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    const saved = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    saved.commands[0].admission = { confirmed: true, turnId: null, messageId: `pending-user:${commandId}`, queued: false };
    file.ciphertext = encryptRecord(saved, f.options.encryptionKey);
    await writeFile(f.options.statePath, JSON.stringify(file), { mode: 0o600 });
    connector = await f.create(); await connector.start();
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    assert.equal(f.adapter.calls.length, 1);
    assert.equal(events(f.transport).filter(item => item.ev.t === 'user-message-accepted').length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('an acknowledged result with matching text but no native identity remains unknown; unrelated same-text rows are preserved', async () => {
  const f = await fixture(); f.adapter.noIdentity = true; const connector = await f.create();
  try { await connector.start(); f.transport.inject(user('same text')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
    const receipt = await f.transport.rpc('bridge-receipt', { commandId: f.adapter.calls[0].commandId }); assert.equal(receipt.receipt.status, 'unknown');
    await connector.project(f.adapter.view); assert.equal(events(f.transport).filter(item => item.role === 'user' && item.ev.text === 'same text').length, 1);
    assert.equal(events(f.transport).some(item => item.ev.t === 'user-message-accepted'), false);
  } finally { await connector.close(); await f.dispose(); }
});

test('epoch changes during fresh snapshot and lost lease fence native side effects', async () => {
  const f = await fixture(), connector = await f.create();
  try { await connector.start(); f.adapter.beforeSnapshot = () => f.epoch('owner-2'); f.transport.inject(user('fenced epoch')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 0);
    f.adapter.beforeSnapshot = null; f.lease(false); f.transport.inject(user('fenced lease'), 'phone-second', 'happy-second'); await connector.processInbox(); assert.equal(f.adapter.calls.length, 0);
    assert.ok(events(f.transport).some(item => item.ev.t === 'user-message-rejected'));
  } finally { await connector.close(); await f.dispose(); }
});

test('abort requires the foreground current turn, ignores background-running status, and repeats reuse original receipt', async () => {
  const f = await fixture({ status: 'running', currentTurnId: null }), connector = await f.create();
  try { await connector.start(); await assert.rejects(f.transport.rpc('abort', { commandId: 'abort-original-1', turnId: 'background-turn' }), { code: 'stale-turn' }); assert.equal(f.adapter.calls.length, 0);
    f.adapter.view.currentTurnId = 'foreground-turn'; await connector.project(f.adapter.view);
    const params = { commandId: 'abort-original-2', turnId: 'foreground-turn' }; await f.transport.rpc('abort', params); await f.transport.rpc('abort', params);
    const reply = await f.transport.rpc('abort', params); assert.equal(reply.receipt.id, params.commandId); assert.equal(reply.receipt.commandId, params.commandId);
    assert.equal(f.adapter.calls.length, 1); assert.deepEqual(f.adapter.calls[0].payload, { turnId: 'foreground-turn' });
  } finally { await connector.close(); await f.dispose(); }
});

test('permission mapping keeps typed original id and rejects unsupported grants; communication uses real question identity', async () => {
  const f = await fixture({ requests: [{ requestId: 8, kind: 'command', operable: true, command: 'fixture command', acceptSupported: false, allowedActions: ['decline', 'cancel'] }], rows: [{ id: 'question-row', role: 'assistant', text: '', turnId: 'turn-question', asyncQuestions: [{ questionItemId: 'original-question-item', title: 'Question?', options: ['A'], answered: false }] }] }), connector = await f.create();
  try { await connector.start(); const requestKey = Object.keys(f.transport.agentState.requests)[0];
    await assert.rejects(f.transport.rpc('permission', { commandId: 'permission-denied-1', id: requestKey, approved: true }), { code: 'unsupported-approval' }); assert.equal(f.adapter.calls.length, 0);
    await f.transport.rpc('permission', { commandId: 'permission-decline-1', id: requestKey, approved: false }); assert.equal(f.adapter.calls[0].payload.requestId, 8); assert.equal(typeof f.adapter.calls[0].payload.requestId, 'number');
    const questionKey = Object.keys(f.transport.agentState.communications)[0];
    await f.transport.rpc('communication', { commandId: 'question-answer-1', id: questionKey, status: 'answered', answers: { answer: { options: [], custom: '中文😀' } } });
    assert.deepEqual(f.adapter.calls[1].payload, { questionItemId: 'original-question-item', answer: '中文😀' });
    assert.deepEqual([...f.transport.handlers.keys()], ['abort', 'permission', 'communication', 'bridge-receipt', 'open-desktop', 'window-control', 'native-image-read']);
  } finally { await connector.close(); await f.dispose(); }
});

test('projection plans keep id/time/body across Happy ACK loss and reconnect', async () => {
  const f = await fixture({ rows: [{ id: 'stable-row', role: 'assistant', text: 'stable output', turnId: 'stable-turn', status: 'inProgress' }] }); let connector = await f.create(); f.transport.failPublication = true;
  try { await assert.rejects(connector.start()); const captured = structuredClone(f.transport.records[0]); await connector.close();
    connector = await f.create(); await connector.start(); assert.deepEqual(f.transport.records[0], captured); assert.equal(f.transport.records.filter(item => item.localId === captured.localId).length, 1); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('tool output is not marked complete while running; terminal output precedes native turn end', async () => {
  const f = await fixture({ currentTurnId: 'tool-turn', status: 'active', rows: [{ id: 'tool-row', role: 'tool', text: '', turnId: 'tool-turn', status: 'inProgress', tools: [{ id: 'original-tool-id', name: 'Fixture', output: '', status: 'inProgress' }] }] }), connector = await f.create();
  try { await connector.start(); f.adapter.view.rows[0].tools[0].output = 'partial'; await connector.project(f.adapter.view); assert.equal(events(f.transport).some(item => item.ev.t === 'tool-call-end'), false);
    f.adapter.view.rows[0].tools[0] = { id: 'original-tool-id', name: 'Fixture', output: 'complete output', status: 'completed' }; f.adapter.view.rows[0].status = 'completed'; f.adapter.view.currentTurnId = null; await connector.project(f.adapter.view);
    const stream = events(f.transport); assert.ok(stream.findIndex(item => item.ev.t === 'tool-call-end') < stream.findIndex(item => item.ev.t === 'turn-end')); assert.equal(stream.find(item => item.ev.t === 'tool-call-end').ev.result, 'complete output');
  } finally { await connector.close(); await f.dispose(); }
});

test('phone communications retire old turns and do not reopen history after the current answer', async () => {
  const currentQuestion = { questionItemId: 'current-question', title: 'Current question', options: ['A'], answered: false };
  const f = await fixture({ currentTurnId: 'current-turn', latestTurnId: 'current-turn', rows: [
    { id: 'old-row', role: 'assistant', text: '', turnId: 'old-turn', asyncQuestions: [{ questionItemId: 'old-question', title: 'Old question', answered: false }] },
    { id: 'current-row', role: 'assistant', text: '', turnId: 'current-turn', asyncQuestions: [currentQuestion] },
  ] }), connector = await f.create();
  try {
    await connector.start();
    const keys = Object.keys(f.transport.agentState.communications);
    assert.equal(keys.length, 1); assert.equal(f.transport.agentState.communications[keys[0]].title, 'Current question');
    currentQuestion.answered = true; f.adapter.emit();
    await connector.project(f.adapter.view);
    assert.equal(Object.keys(f.transport.agentState.communications).length, 0);
    assert.equal(f.adapter.view.rows[0].asyncQuestions[0].answered, false);
    await assert.rejects(f.transport.rpc('communication', { commandId: 'late-current-answer', id: keys[0], status: 'answered', answers: { answer: { options: ['A'], custom: '' } } }));
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('bootstrap observations survive initial source unavailable and seed later exact rows without double history', async () => {
  const row = { id: 'later-row', role: 'assistant', text: 'original history', turnId: 'old-turn', status: 'completed' }, f = await fixture({ status: 'owner-unavailable' });
  const bootstrap = 'ni' + createHash('sha256').update(`original-native-id:${row.id}:bootstrap`).digest('hex').slice(0, 28);
  f.transport.inbox.push({ id: 'bootstrap-later', localId: bootstrap + '-observed', record: { role: 'session', content: { id: bootstrap, time: 10, role: 'agent', turn: row.turnId, ev: { t: 'text', text: row.text } } } });
  const connector = await f.create();
  try { await connector.start(); assert.equal(f.transport.inbox.length, 0); f.adapter.view = { status: 'idle', currentTurnId: null, requests: [], rows: [row], revision: 5 }; await connector.project(f.adapter.view);
    assert.equal(events(f.transport).filter(item => item.ev.t === 'text').length, 0); assert.equal(f.adapter.calls.length, 0);
    const before = f.transport.records.length; await connector.project({ ...f.adapter.view, revision: 4, rows: [{ ...row, text: 'stale altered text' }] }); assert.equal(f.transport.records.length, before);
  } finally { await connector.close(); await f.dispose(); }
});

test('missing generation/lease and window-only sources expose honest capabilities and never native text admission', async () => {
  const f = await fixture({ kind: 'window', rows: [], requests: [], status: 'connected', currentTurnId: null }), connector = await f.create();
  try { await connector.start(); assert.equal(f.transport.metadata.bridge.controlMode, 'window'); assert.equal(f.transport.metadata.capabilities.abort, false); assert.equal(f.transport.metadata.capabilities.messageReceipts, true);
    f.transport.inject(user('do not turn this window into a fake native chat')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('an unknown RPC repeated with the same id remains unknown and never becomes a successful reply', async () => {
  const f = await fixture({ status: 'active', currentTurnId: 'live-turn' }), connector = await f.create(); f.adapter.fail = true;
  try { await connector.start(); const params = { commandId: 'unknown-abort-same-id', turnId: 'live-turn' };
    await assert.rejects(f.transport.rpc('abort', params), { code: 'delivery-unknown', effectMayHaveOccurred: true });
    await assert.rejects(f.transport.rpc('abort', params), { code: 'delivery-unknown', effectMayHaveOccurred: true });
    assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('source RPC keeps sanitized nativeCause in public receipt and reloads unknown without another effect', async () => {
  const f = await fixture({ status: 'active', currentTurnId: 'live-turn' }); let connector = await f.create(), effects = 0;
  f.adapter.command = async () => { effects++; throw Object.assign(new BridgeError('delivery-unknown', 'raw details never published'), { nativeCause: 'window_focus_unconfirmed' }); };
  const params = { commandId: 'cause-source-rpc-once', turnId: 'live-turn' };
  try {
    await connector.start();
    await assert.rejects(f.transport.rpc('abort', params), error => {
      const value = /** @type {Value} */ (error); assert.equal(value.code, 'delivery-unknown'); assert.equal(value.receipt.nativeCause, 'window_focus_unconfirmed'); return true;
    });
    const before = (await f.transport.rpc('bridge-receipt', { commandId: params.commandId })).receipt;
    assert.equal(before.nativeCause, 'window_focus_unconfirmed'); assert.equal(before.status, 'unknown');
    await connector.close(); connector = await f.create(); await connector.start();
    const after = (await f.transport.rpc('bridge-receipt', { commandId: params.commandId })).receipt;
    assert.deepEqual(after, before);
    await assert.rejects(f.transport.rpc('abort', params), { code: 'delivery-unknown' }); assert.equal(effects, 1);
    assert.ok(!JSON.stringify(after).includes('raw details'));
  } finally { await connector.close(); await f.dispose(); }
});

test('existing Root confirmed admission repairs a lost connector terminal write without native redispatch', async () => {
  const f = await fixture({ status: 'owner-unavailable' });
  const receipts = await CommandReceipts.load(join(f.directory, 'receipts.json'));
  const connector = new NativeHappyConnector({ ...f.options, receipts });
  const nativeCommandId = 'hc' + createHash('sha256').update(JSON.stringify(['fixture-binding', 'phone-local', 'send'])).digest('hex').slice(0, 62);
  await receipts.run(connector.receiptScope, nativeCommandId, { action: 'send', payload: { text: 'already admitted before connector crashed' }, epoch: 'owner-1', expectedTurnId: null }, async () => ({ nativeAdmission: { confirmed: true, turnId: 'previous-real-fixture-turn', messageId: 'previous-fixture-user' } }));
  try { await connector.start(); f.transport.inject(user('already admitted before connector crashed')); await connector.processInbox();
    assert.equal(f.adapter.calls.length, 0); const accepted = events(f.transport).find(item => item.ev.t === 'user-message-accepted'); assert.ok(accepted); assert.equal(accepted.ev.runId, 'previous-real-fixture-turn');
  } finally { await connector.close(); await f.dispose(); }
});

test('Root receipt payload conflict after connector journal loss cannot accept a different input under an old id', async () => {
  const f = await fixture(), receipts = await CommandReceipts.load(join(f.directory, 'receipts.json')), connector = new NativeHappyConnector({ ...f.options, receipts });
  const key = 'hc' + createHash('sha256').update(JSON.stringify(['fixture-binding', 'phone-local', 'send'])).digest('hex').slice(0, 62);
  await receipts.run(connector.receiptScope, key, { action: 'send', payload: { text: 'different old input' }, epoch: 'owner-1', expectedTurnId: null }, async () => ({ nativeAdmission: { confirmed: true, turnId: 'old-turn' } }));
  try { await connector.start(); f.transport.inject(user('new conflicting input')); await assert.rejects(connector.processInbox(), { code: 'command-conflict' });
    assert.equal(f.adapter.calls.length, 0); assert.equal(events(f.transport).some(item => item.ev.t === 'user-message-accepted'), false);
  } finally { await connector.close(); await f.dispose(); }
});

test('blocking communication answers preserve native question ids and permission scope is explicit, never silently changed', async () => {
  const f = await fixture({ requests: [
    { kind: 'user-input', requestId: 'original-blocking', operable: true, questions: [{ id: 'native-question-id', question: 'Choose', options: [{ label: 'A' }], secret: false }] },
    { kind: 'permissions', requestId: 'original-grant', operable: true, requestedPermissions: { network: { enabled: true } }, grantScopes: ['turn', 'session'] },
  ] }), connector = await f.create();
  try { await connector.start(); const question = Object.keys(f.transport.agentState.communications)[0];
    await f.transport.rpc('communication', { commandId: 'native-blocking-answer', id: question, kind: 'form', status: 'answered', answers: { 'native-question-id': { options: ['A'], custom: '中文' } } });
    assert.deepEqual(f.adapter.calls[0].payload, { kind: 'user-input', requestId: 'original-blocking', response: { answers: { 'native-question-id': { answers: ['A', '中文'] } } } });
    await connector.project(f.adapter.view); const permission = Object.keys(f.transport.agentState.requests)[0];
    await assert.rejects(f.transport.rpc('permission', { commandId: 'bad-permission-scope', id: permission, approved: true, scope: 'global' }), { code: 'unsupported-permission-mode' });
    await f.transport.rpc('permission', { commandId: 'native-session-grant', id: permission, approved: true, scope: 'session' });
    assert.deepEqual(f.adapter.calls[1].payload.response, { permissions: { network: { enabled: true } }, scope: 'session' });
  } finally { await connector.close(); await f.dispose(); }
});

test('close during transport startup does not leave a late SDK subscription or RPC handlers', async () => {
  const f = await fixture(); let releaseTransport = /** @type {()=>void} */ (() => {}), signalStarted = /** @type {()=>void} */ (() => {});
  const started = new Promise(resolveStarted => { signalStarted = () => resolveStarted(undefined); });
  f.transport.start = () => new Promise(resolveStart => { releaseTransport = () => resolveStart(undefined); signalStarted(); });
  const connector = await f.create();
  try { const opening = connector.start(), rejected = assert.rejects(opening, { code: 'connector-closed' }); await started;
    const closing = connector.close(); releaseTransport(); await closing; await rejected;
    assert.equal(f.adapter.callback, null); assert.equal(f.adapter.calls.length, 0); assert.equal(f.transport.handlers.size, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('a rejected second connector cannot release the first connector checkpoint ownership', async () => {
  const f = await fixture(), first = await f.create(), second = await f.create(), third = await f.create();
  try { await first.start(); await assert.rejects(second.start(), { code: 'connector-in-use' }); await second.close(); await assert.rejects(third.start(), { code: 'connector-in-use' });
    assert.equal(f.adapter.calls.length, 0);
  } finally { await Promise.allSettled([first.close(), second.close(), third.close()]); await f.dispose(); }
});

function gate() {
  let release = /** @type {()=>void} */ (() => {});
  const promise = /** @type {Promise<void>} */ (new Promise(resolve => { release = () => resolve(undefined); }));
  return { promise, release: () => release() };
}

test('idle retirement closes only observation and fences captured RPC/input entries without changing journals', async () => {
  const f = await fixture({ status: 'active', currentTurnId: 'original-running-turn' }), connector = await f.create();
  try {
    await connector.start(); await connector.project(f.adapter.view);
    const rpc = f.transport.handlers.get('open-desktop'); assert.ok(rpc);
    const before = await readFile(f.options.statePath, 'utf8');
    const retiring = connector.tryCloseIfIdle();
    await assert.rejects(rpc({ commandId: 'late-rpc-after-retirement' }), { code: 'source-unavailable' });
    f.transport.inject(user('late captured input'));
    await connector.processInbox(); assert.equal(await retiring, true);
    assert.equal(f.adapter.calls.length, 0); assert.equal(f.adapter.callback, null); assert.equal(f.transport.handlers.size, 0);
    assert.equal(f.transport.inbox.length, 1); assert.equal(await readFile(f.options.statePath, 'utf8'), before);
    assert.equal(f.adapter.view.currentTurnId, 'original-running-turn'); assert.equal(await connector.tryCloseIfIdle(), true);
  } finally { await connector.close(); await f.dispose(); }
});

test('an RPC awaiting epoch before its prepared plan pins the observer until the whole operation settles', async () => {
  const f = await fixture(), entered = gate(), resume = gate(); let paused = false;
  f.adapter.command = async (_id, action) => { f.adapter.calls.push({ action }); return { requested: true }; };
  const connector = new NativeHappyConnector({ ...f.options, receipts: await CommandReceipts.load(join(f.directory, 'receipts.json')),
    getGeneration: () => { if (!paused) return 'owner-1'; entered.release(); return resume.promise.then(() => 'owner-1'); } });
  try {
    await connector.start(); await connector.project(f.adapter.view); paused = true;
    const operation = f.transport.rpc('open-desktop', { commandId: 'held-before-prepared-plan' }); await entered.promise;
    assert.equal(connector.status().commands, 0); assert.equal(await connector.tryCloseIfIdle(), false);
    paused = false; resume.release(); await operation;
    assert.equal(f.adapter.calls.length, 1); assert.equal(await connector.tryCloseIfIdle(), true);
  } finally { paused = false; resume.release(); await connector.close(); await f.dispose(); }
});

test('native dispatch and input processing remain protected until admission and event publication settle', async () => {
  const f = await fixture(), entered = gate(), resume = gate(), connector = await f.create();
  f.adapter.command = async (_id, action) => {
    f.adapter.calls.push({ action }); entered.release(); await resume.promise;
    return { admitted: true, turnId: 'original-admitted-turn', messageId: 'original-message' };
  };
  try {
    await connector.start(); await connector.project(f.adapter.view); f.transport.inject(user('held admission'));
    const input = connector.processInbox(); await entered.promise;
    assert.equal(await connector.tryCloseIfIdle(), false); assert.equal(f.transport.inbox.length, 1);
    resume.release(); await input; assert.equal(f.adapter.calls.length, 1);
    assert.equal(await connector.tryCloseIfIdle(), true);
  } finally { resume.release(); await connector.close(); await f.dispose(); }
});

test('pending inbox, outbox and unsent events prevent LRU retirement while explicit close remains available', async () => {
  for (const pending of ['inbox', 'outbox', 'events']) {
    const f = await fixture(), connector = await f.create();
    try {
      await connector.start(); await connector.project(f.adapter.view);
      if (pending === 'inbox') f.transport.inbox.push({ id: 'captured-not-admitted', record: user('captured input') });
      if (pending === 'outbox') f.transport.pendingOutbox = 1;
      if (pending === 'events') {
        f.transport.failPublication = true;
        await assert.rejects(connector.project({ ...f.adapter.view, revision: 2, rows: [{ id: 'late-owner-row', role: 'assistant', text: 'queued event', turnId: 'old-turn' }] }));
        assert.ok(connector.status().pendingEvents > 0);
      }
      const before = await readFile(f.options.statePath, 'utf8');
      assert.equal(await connector.tryCloseIfIdle(), false); assert.equal(connector.status().closed, false);
      await connector.close(); assert.equal(await readFile(f.options.statePath, 'utf8'), before);
      if (pending === 'inbox') assert.equal(f.transport.inbox.length, 1);
      if (pending === 'outbox') assert.equal(f.transport.pendingOutbox, 1);
    } finally { await connector.close(); await f.dispose(); }
  }
});

test('a durable prepared command is not mistaken for idle history during retirement', async () => {
  const f = await fixture(); let connector = await f.create();
  try {
    await connector.start(); await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8')), state = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    state.commands.push({ id: 'prepared-original-command', key: 'rpc:prepared-original-command', origin: 'rpc', state: 'prepared', action: 'approval', payload: {}, epoch: 'owner-1' });
    file.ciphertext = encryptRecord(state, f.options.encryptionKey); await writeFile(f.options.statePath, JSON.stringify(file));
    connector = await f.create(); await connector.start(); await connector.project(f.adapter.view);
    assert.equal(await connector.tryCloseIfIdle(), false); assert.equal(f.adapter.calls.length, 0);
    await connector.close();
    const saved = /** @type {Value} */ (decryptRecord(JSON.parse(await readFile(f.options.statePath, 'utf8')).ciphertext, f.options.encryptionKey));
    assert.equal(saved.commands[0].state, 'prepared');
  } finally { await connector.close(); await f.dispose(); }
});

test('unknown command history survives idle retirement and reopening without native replay', async () => {
  const f = await fixture(); let connector = await f.create(); f.adapter.fail = true;
  try {
    await connector.start(); f.transport.inject(user('original unknown input')); await connector.processInbox(); await connector.project(f.adapter.view);
    const commandId = f.adapter.calls[0].commandId;
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    const projection = await readFile(f.options.statePath, 'utf8'), receipts = await readFile(join(f.directory, 'receipts.json'), 'utf8');
    assert.equal(await connector.tryCloseIfIdle(), true);
    assert.equal(await readFile(f.options.statePath, 'utf8'), projection); assert.equal(await readFile(join(f.directory, 'receipts.json'), 'utf8'), receipts);
    connector = await f.create(); await connector.start();
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    f.transport.inject(user('original unknown input')); await connector.processInbox();
    assert.equal(f.adapter.calls.length, 1); assert.equal(events(f.transport).some(item => item.ev.t === 'user-message-accepted'), false);
  } finally { await connector.close(); await f.dispose(); }
});

test('warm recent cache returns bounded whole rows immediately while a shared native refresh is held', async () => {
  const f = await fixture({ ownerGeneration: 'owner-1', status: 'active', currentTurnId: 'current-native-turn', historyComplete: false,
    rows: [1, 2, 3].map(i => ({ id: `cached-row-${i}`, role: 'assistant', turnId: 'current-native-turn', text: `whole native row ${i}`, status: 'inProgress' })) });
  const connector = await f.create(); let release = () => {};
  try {
    await connector.start();
    const records = f.transport.records.length, before = JSON.stringify(f.transport.metadata);
    let nativeReads = 0;
    const held = new Promise(resolve => { release = () => resolve(undefined); });
    f.adapter.freshSnapshot = async () => { nativeReads++; await held; return structuredClone(f.adapter.view); };
    const first = connector.readRecent({ fresh: true, limit: 1 });
    const second = connector.readRecent({ fresh: true, limit: 2 });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(nativeReads, 1);
    const cached = await connector.readCachedRecent({ limit: 1 }); assert.ok(cached);
    assert.equal(cached.rows[0].id, 'cached-row-3'); assert.equal(cached.rows[0].text, 'whole native row 3');
    assert.equal(cached.rows[0].ownerGeneration, 'owner-1'); assert.equal(cached.status, 'unknown'); assert.equal(cached.currentTurnId, null);
    assert.equal(cached.nextCursor, null); assert.equal(cached.hasMore, true);
    assert.deepEqual(cached.freshness, { version: 1, mode: 'cached', capturedAt: cached.freshness.capturedAt,
      ownerGeneration: 'owner-1', currentControlAuthority: false, revalidationPending: true });
    const again = await connector.readCachedRecent({ limit: 2 }); assert.ok(again); assert.equal(again.rows.length, 2); assert.equal(again.freshness.capturedAt, cached.freshness.capturedAt);
    cached.rows[0].text = 'consumer edit'; const third = await connector.readCachedRecent({ limit: 1 }); assert.ok(third); assert.equal(third.rows[0].text, 'whole native row 3');
    assert.equal(f.transport.records.length, records); assert.equal(JSON.stringify(f.transport.metadata), before);
    assert.equal(nativeReads, 1); assert.equal(f.adapter.completeReads, 0); assert.equal(f.adapter.calls.length, 0);
    release(); const fresh = await Promise.all([first, second]);
    assert.deepEqual(fresh.map(x => x.rows.length), [1, 2]); assert.equal(fresh[0].freshness.mode, 'fresh'); assert.equal(fresh[0].freshness.currentControlAuthority, true);
    assert.equal(nativeReads, 1);
  } finally { release(); await connector.close(); await f.dispose(); }
});

test('warm recent caches reject foreign owner, lost lease, older cursors and closed connectors', async () => {
  const f = await fixture({ ownerGeneration: 'owner-1', rows: [{ id: 'cache-row', role: 'assistant', turnId: 'native-turn', text: 'retained whole row' }] });
  const connector = await f.create();
  try {
    assert.equal(await connector.readCachedRecent({ limit: 1 }), null);
    await connector.start(); assert.ok(await connector.readCachedRecent({ limit: 1 }));
    await assert.rejects(connector.readCachedRecent({ cursor: 'old-cursor', limit: 1 }), { code: 'invalid-history-cursor' });
    f.epoch('owner-2'); assert.equal(await connector.readCachedRecent({ limit: 1 }), null);
    f.epoch('owner-1'); f.lease(false); assert.equal(await connector.readCachedRecent({ limit: 1 }), null);
    f.lease(true); await connector.project({ status: 'owner-unavailable', rows: [], currentTurnId: null });
    assert.equal(await connector.readCachedRecent({ limit: 1 }), null);
    await connector.close(); await assert.rejects(connector.readCachedRecent({ limit: 1 }), { code: 'source-unavailable' });
    assert.equal(f.adapter.completeReads, 0); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('an oversized public recent row disables optional caching without breaking native message reads', async () => {
  const text = 'x'.repeat(1024 * 1024), f = await fixture({ ownerGeneration: 'owner-1', rows: [{ id: 'large-cache-row', role: 'assistant', turnId: 'native-turn', text }] });
  const connector = await f.create({ publishInitialHistory: false });
  try {
    await connector.start(); assert.equal(await connector.readCachedRecent({ limit: 1 }), null);
    const fresh = await connector.readRecent({ limit: 1 }); assert.equal(fresh.rows[0].text.length, text.length); assert.equal(fresh.freshness.mode, 'fresh');
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});
