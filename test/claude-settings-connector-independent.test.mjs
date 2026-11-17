import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeHappyConnector } from '../src/codelync/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { confirmedNativeSettingsEvidence } from '../src/codelync/native-settings-scope.mjs';

/** @typedef {Record<string, any>} Value */
/** @typedef {(params:Value)=>Promise<Value>} RpcHandler */
/** @typedef {{view:Value,controls:Value,writes:number,reads:number,readHook:((commandId:string,context?:Value)=>void|Promise<void>)|null,writeHook:((payload:Value,commandId:string,context?:Value)=>Value|Promise<Value>)|null}} FixtureState */
/** @typedef {{supportsNativeModelSettings:boolean,supportsSourceCommands:boolean,supportedActions:string[],generation:(id?:string)=>string,snapshot:()=>Promise<Value>,subscribe:()=>Promise<()=>void>,command:(id:string,action:string,payload:Value,commandId:string,context?:Value)=>Promise<Value>}} FixtureAdapter */
/** @typedef {{transport:SyntheticTransport,receipts:CommandReceipts,state:FixtureState,adapter:FixtureAdapter,connector:NativeHappyConnector,unblock:Set<()=>void>,update:RpcHandler,receipt:(commandId:string)=>Promise<Value>}} Fixture */

// Synthetic owner data exercises the real connector and durable receipts. No
// original application, conversation, credentials or model runner is involved.
const nativeId = 'synthetic-native-session';
const hostId = 'local:claude-desktop:' + '1'.repeat(64);
const originalModel = 'synthetic-native-old';
const requestedModel = 'synthetic-native-requested-alias';
const effectiveModel = 'synthetic-native-confirmed-alias[1m]';

/** @param {string} [queryToken] @param {string} [settingsToken] @returns {Value} */
function settingsScope(queryToken = 'held-query', settingsToken = 'a'.repeat(64)) {
  return { app: 'claude-desktop', appMode: 'code', nativeCollection: 'claude-code-sessions', nativeConversationId: nativeId,
    hostId, ownerGeneration: 'session-owner', runtimeGeneration: 'main-owner', queryToken, cliSessionId: 'synthetic-cli', settingsToken };
}

/** @param {Value} [scope] @param {string} [model] @param {string} [reasoningEffort] @returns {Value} */
function modelControls(scope = settingsScope(), model = originalModel, reasoningEffort = 'high') {
  return { scope, model: { available: true, current: { model, reasoningEffort, modelProvider: 'claude-desktop' },
    models: [originalModel, requestedModel, effectiveModel].map(id => ({ id, label: id,
      reasoningEfforts: ['high', 'max'], defaultReasoningEffort: 'high' })) } };
}

/** @param {string} [queryToken] @param {boolean} [readOnly] @returns {Value} */
function nativeView(queryToken = 'held-query', readOnly = false) {
  return { rows: [], requests: [], status: 'idle', currentTurnId: null, ownerGeneration: 'session-owner', nativeReadOnly: readOnly,
    nativeQuery: { version: 1, app: 'claude-desktop', nativeConversationId: nativeId, hostId, ownerGeneration: 'session-owner',
      status: 'idle', queryToken, canSend: !readOnly, canCancel: false, activeSendMode: 'queue' } };
}

class SyntheticTransport extends EventEmitter {
  /** @type {Value} */ metadata;
  /** @type {Value} */ agentState;
  /** @type {Map<string,RpcHandler>} */ rpcs;
  constructor() {
    super();
    this.sessionId = 'synthetic-happy-session';
    this.metadata = { client: { id: 'noninvasive-bridge' }, nativeSession: { isSubagent: false } };
    this.agentState = {};
    this.rpcs = new Map();
  }
  async start() {}
  /** @param {string} name @param {RpcHandler} handler */
  registerRpc(name, handler) { this.rpcs.set(name, handler); return () => { this.rpcs.delete(name); }; }
  /** @param {string} name @param {Value} params @returns {Promise<Value>} */
  async rpc(name, params) {
    const handler = this.rpcs.get(name);
    if (!handler) throw Error('The synthetic RPC was not registered');
    return handler(params);
  }
  listInbox() { return []; }
  /** @param {(current:Value)=>Value|Promise<Value>} update */
  async updateMetadata(update) { this.metadata = await update(this.metadata); }
  /** @param {(current:Value)=>Value|Promise<Value>} update */
  async updateAgentState(update) { this.agentState = await update(this.agentState); }
  async publishBatch() {}
  keepAlive() {}
  peerSnapshot() { return { seq: 0 }; }
  status() { return { pendingInbox: 0, pendingOutbox: 0 }; }
}

/** @param {import('node:test').TestContext} t @returns {Promise<Fixture>} */
async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-settings-independent-'));
  const transport = new SyntheticTransport();
  const receipts = await CommandReceipts.load(join(directory, 'receipts.json'));
  /** @type {FixtureState} */
  const state = { view: nativeView(), controls: modelControls(), writes: 0, reads: 0, readHook: null, writeHook: null };
  /** @type {Set<()=>void>} */
  const unblock = new Set();
  /** @type {FixtureAdapter} */
  const adapter = {
    supportsNativeModelSettings: true, supportsSourceCommands: false,
    supportedActions: ['send', 'interrupt', 'read-controls', 'update-settings'],
    generation(id) { return id ? 'session-owner' : 'main-owner'; },
    async snapshot() { return state.view; },
    async subscribe() { return () => {}; },
    async command(id, action, payload, commandId, context) {
      if (action === 'read-controls') {
        state.reads++;
        if (state.readHook) await state.readHook(commandId, context);
        return structuredClone(state.controls);
      }
      if (action === 'update-settings') {
        state.writes++;
        if (state.writeHook) return state.writeHook(payload, commandId, context);
      }
      throw Error('Unexpected synthetic native action');
    }
  };
  const source = { app: 'claude-desktop', kind: 'session', id: nativeId, hostId, protocol: 'claude-desktop-native',
    runtimeGeneration: 'session-owner', appMode: 'code', nativeCollection: 'claude-code-sessions' };
  const connector = new NativeHappyConnector({ transport, adapter, nativeId, sourceIdentity: source, bindingId: 'synthetic-binding',
    receipts, statePath: join(directory, 'projection.json'), encryptionKey: new Uint8Array(32),
    getGeneration: () => adapter.generation(nativeId), assertLease: () => true, supportsNativeProjection: true });
  t.after(async () => {
    for (const release of unblock) release();
    try { await connector.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  await connector.start();
  await transport.rpc('codex-controls-read', { commandId: 'initial-controls-read' });
  return { transport, receipts, state, adapter, connector, unblock,
    update: params => transport.rpc('codex-controls-update', params),
    receipt: commandId => transport.rpc('bridge-receipt', { commandId }) };
}

/** @param {string} commandId @returns {Value} */
function updateRequest(commandId) {
  return { commandId, model: requestedModel, reasoningEffort: 'max', expectedModel: originalModel,
    expectedReasoningEffort: 'high', expectedScope: settingsScope() };
}

/** @param {Value} payload @param {boolean} [readbackConfirmed] @returns {Value} */
function acknowledgedUpdate(payload, readbackConfirmed = true) {
  const confirmedScope = settingsScope('held-query', 'b'.repeat(64));
  return { applied: true, settingsReadbackConfirmed: readbackConfirmed, controls: modelControls(confirmedScope, effectiveModel, 'high'),
    nativeSettingsEvidence: { version: 1, expectedScope: payload.expectedScope, confirmedScope,
      modelAckConfirmed: true, effortAckConfirmed: true, effectiveModel, effectiveReasoningEffort: 'high' } };
}

/** @param {unknown} error @param {string} status */
function hasReceiptStatus(error, status) {
  if (!(error instanceof Error)) return false;
  return /** @type {Error & {receipt?:Value}} */ (error).receipt?.status === status;
}

/** @param {unknown} error */
function isUnknownReceipt(error) {
  return hasReceiptStatus(error, 'unknown') && /** @type {Error & {code?:string}} */ (error).code === 'delivery-unknown';
}

/** @param {Fixture} fixture @param {Value} request */
async function expectUnknown(fixture, request) {
  await assert.rejects(fixture.update(request), isUnknownReceipt);
  assert.equal((await fixture.receipt(request.commandId)).receipt.status, 'unknown');
}

test('cached settings withdraw for readonly, Query replacement and support loss; readonly catalogue remains readable', async t => {
  const f = await createFixture(t);
  f.state.view = nativeView('held-query', true);
  await f.connector.project(f.state.view);
  assert.equal(f.transport.metadata.nativeControls.model.available, false);
  assert.equal(f.transport.metadata.capabilities.modelSelection, false);
  assert.equal(f.transport.metadata.capabilities.rpcMethods.includes('codex-controls-update'), false);
  assert.equal(f.transport.metadata.capabilities.rpcMethods.includes('codex-controls-read'), true);
  const read = await f.transport.rpc('codex-controls-read', { commandId: 'readonly-controls-read' });
  assert.equal(read.receipt.status, 'complete');
  assert.equal(read.receipt.result.model.available, false);
  assert.equal(f.state.writes, 0);

  f.state.view = nativeView();
  await f.connector.project(f.state.view);
  await f.transport.rpc('codex-controls-read', { commandId: 'restored-controls-read' });
  assert.equal(f.transport.metadata.nativeControls.model.available, true);

  // Hold the replacement read so the assertion sees publication of the new
  // Query before its fresh catalogue is available, rather than a later repair.
  /** @type {()=>void} */
  let releaseRead = () => {};
  /** @type {Promise<void>} */
  const pendingRead = new Promise(resolve => { releaseRead = resolve; });
  f.unblock.add(() => releaseRead());
  f.state.readHook = () => pendingRead;
  f.state.view = nativeView('replacement-query');
  f.state.controls = modelControls(settingsScope('replacement-query'));
  await f.connector.project(f.state.view);
  assert.equal(f.transport.metadata.nativeControls?.model?.available === true, false);
  assert.equal(f.transport.metadata.capabilities.modelSelection, false);
  assert.equal(f.transport.metadata.capabilities.rpcMethods.includes('codex-controls-update'), false);
  releaseRead();
  await f.transport.rpc('codex-controls-read', { commandId: 'replacement-controls-read' });
  assert.equal(f.transport.metadata.nativeControls.scope.queryToken, 'replacement-query');
  assert.equal(f.transport.metadata.nativeControls.model.available, true);

  f.adapter.supportsNativeModelSettings = false;
  await f.connector.project(f.state.view);
  assert.equal(f.transport.metadata.nativeControls.model.available, false);
  assert.equal(f.transport.metadata.capabilities.modelSelection, false);
  assert.equal(f.transport.metadata.capabilities.rpcMethods.includes('codex-controls-update'), false);
  assert.equal(f.state.writes, 0);
});

test('readonly withdrawal during the last settings read rejects before native update dispatch', async t => {
  const f = await createFixture(t);
  f.state.readHook = async commandId => {
    if (commandId.startsWith('settings-check-')) {
      f.state.view = nativeView('held-query', true);
      await f.connector.project(f.state.view);
    }
  };
  f.state.writeHook = payload => acknowledgedUpdate(payload);
  const request = updateRequest('readonly-race-update');
  await assert.rejects(f.update(request), error => hasReceiptStatus(error, 'failed'));
  assert.equal(f.state.view.nativeReadOnly, true);
  assert.equal(f.state.writes, 0);
});

test('unknown settings cannot recover from an old Query readback after Query replacement', async t => {
  const f = await createFixture(t);
  f.state.writeHook = payload => acknowledgedUpdate(payload, false);
  const request = updateRequest('old-query-update');
  await expectUnknown(f, request);

  f.adapter.supportsNativeModelSettings = false;
  f.state.view = nativeView('replacement-query');
  await f.connector.project(f.state.view);
  f.state.controls = modelControls(settingsScope('held-query', 'b'.repeat(64)), effectiveModel, 'high');
  assert.equal((await f.receipt(request.commandId)).receipt.status, 'unknown');
  assert.equal(f.transport.metadata.nativeControls?.model?.available === true, false);
  assert.equal(f.transport.metadata.capabilities.modelSelection, false);
  assert.equal(f.state.writes, 1);
});

test('confirmed native alias and clamped effort recover the original operation without replay', async t => {
  const f = await createFixture(t);
  f.state.writeHook = payload => acknowledgedUpdate(payload, false);
  const request = updateRequest('effective-alias-update');
  await expectUnknown(f, request);
  f.state.controls = modelControls(settingsScope('held-query', 'b'.repeat(64)), effectiveModel, 'high');
  const recovered = (await f.receipt(request.commandId)).receipt;
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.result.controls.model.current.model, effectiveModel);
  assert.equal(recovered.result.controls.model.current.reasoningEffort, 'high');
  assert.notEqual(recovered.result.controls.model.current.model, request.model);
  assert.notEqual(recovered.result.controls.model.current.reasoningEffort, request.reasoningEffort);
  assert.deepEqual(recovered.result.nativeSettingsEvidence, acknowledgedUpdate(request).nativeSettingsEvidence);
  assert.ok(confirmedNativeSettingsEvidence(recovered.result.nativeSettingsEvidence, request.expectedScope, recovered.result.controls));
  assert.equal(f.transport.metadata.nativeControls.model.current.model, effectiveModel);
  assert.equal(f.transport.metadata.nativeControls.model.current.reasoningEffort, 'high');
  assert.equal((await f.update(request)).receipt.status, 'complete');
  assert.equal(f.state.writes, 1);
});

test('ordinary catalogue refresh recovers the original settings evidence without a second write', async t => {
  const f = await createFixture(t);
  f.state.writeHook = payload => acknowledgedUpdate(payload, false);
  const request = updateRequest('catalogue-recovery-update');
  await expectUnknown(f, request);
  f.state.controls = modelControls(settingsScope('held-query', 'b'.repeat(64)), effectiveModel, 'high');
  await f.transport.rpc('codex-controls-read', { commandId: 'catalogue-recovery-read' });
  const recovered = (await f.receipt(request.commandId)).receipt;
  assert.equal(recovered.status, 'complete');
  assert.deepEqual(recovered.result.nativeSettingsEvidence, acknowledgedUpdate(request).nativeSettingsEvidence);
  assert.ok(confirmedNativeSettingsEvidence(recovered.result.nativeSettingsEvidence, request.expectedScope, recovered.result.controls));
  const repeated = (await f.update(request)).receipt;
  assert.deepEqual(repeated.result.nativeSettingsEvidence, recovered.result.nativeSettingsEvidence);
  assert.equal(f.state.writes, 1);
});

for (const kind of ['applied-false', 'partial-ack', 'header-only']) {
  test(`${kind} stays unknown despite equal header/readback values and repeated requests`, async t => {
    const f = await createFixture(t);
    f.state.writeHook = payload => {
      const result = acknowledgedUpdate(payload);
      if (kind === 'applied-false') result.applied = false;
      if (kind === 'partial-ack') result.nativeSettingsEvidence.effortAckConfirmed = false;
      if (kind === 'header-only') delete result.nativeSettingsEvidence;
      return result;
    };
    const request = updateRequest(`unconfirmed-${kind}`);
    await expectUnknown(f, request);
    f.state.controls = modelControls(settingsScope('held-query', 'b'.repeat(64)), effectiveModel, 'high');
    f.state.view = { ...nativeView(), nativeModel: { model: effectiveModel, effort: 'high' } };
    await f.connector.project(f.state.view);
    assert.equal((await f.receipt(request.commandId)).receipt.status, 'unknown');
    await assert.rejects(f.update(request), error => hasReceiptStatus(error, 'unknown'));
    assert.equal(f.state.writes, 1);
  });
}
