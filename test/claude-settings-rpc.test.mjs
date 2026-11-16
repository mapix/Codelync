import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDesktopRpcClient, claudeDesktopHostId } from '../src/adapters/claude-desktop-rpc.mjs';
import { ClaudeDesktopBackend } from '../src/adapters/claude-backend.mjs';

/** @typedef {Record<string,any>} Value */
function fixture() {
  const runtime = /** @type {Value} */ ({ generation: 'original-main', storagePath: '/fixture/native-settings', origin: 'http://127.0.0.1:5555',
    accessToken: 'private-fixture-token', readOnly: false, mutationAllowed: true });
  const scope = { app: 'claude-desktop', appMode: 'code', nativeCollection: 'claude-code-sessions', nativeConversationId: 'original-session',
    hostId: claudeDesktopHostId(runtime, 'claude-code-sessions'), ownerGeneration: 'original-owner', runtimeGeneration: runtime.generation,
    queryToken: 'original-query', cliSessionId: 'original-cli', settingsToken: 'a'.repeat(64) };
  const state = /** @type {Value} */ ({ calls: [], partial: false, declaredMethods: ['code.controls', 'cowork.controls'] });
  const controls = (/** @type {Value} */ nextScope = scope, model = 'native-old') => ({ scope: nextScope, model: { available: true,
    currentConfirmed: true, current: { model, reasoningEffort: 'high', modelProvider: 'claude-desktop' },
    models: [{ id: 'native-old' }, { id: 'native-resolved[1m]' }] } });
  const rpc = new ClaudeDesktopRpcClient({ readRuntime: async () => ({ ...runtime }), fetch: async (_url, options) => {
    const request = JSON.parse(String(options?.body)); state.calls.push(request);
    const confirmedScope = { ...scope, settingsToken: 'b'.repeat(64) };
    if (request.method === 'owner.status' && state.statusFailure) throw Error('owner status failed');
    const result = request.method === 'owner.status' ? { nativeOwner: true, readOnly: runtime.readOnly, mutationAllowed: runtime.mutationAllowed,
      runtimeGeneration: state.statusEpoch ?? runtime.generation, ...(state.declaredMethods ? { nativeSettingsReadMethods: state.declaredMethods } : {}) }
      : request.method === 'code.snapshot' ? { sessionId: 'original-session', ownerGeneration: 'original-owner', executionToken: 'original-query', messages: [], requests: [], hasMore: true,
        header: { sessionId: 'original-session', sessionType: 'code', isRunning: false, turnRunning: false, queryPresent: true } }
      : request.method === 'code.taskFeed' ? {} : request.method === 'code.controls' ? controls() : { applied: true, settingsReadbackConfirmed: true,
      controls: controls(confirmedScope, 'native-resolved[1m]'), nativeSettingsEvidence: { version: 1,
        expectedScope: request.params.payload.expectedScope, confirmedScope, modelAckConfirmed: true, effortAckConfirmed: !state.partial,
        effectiveModel: 'native-resolved[1m]', effectiveReasoningEffort: 'high' } };
    return new Response(JSON.stringify({ version: 1, ok: true, ownerGeneration: runtime.generation, hostId: claudeDesktopHostId(runtime),
      ...(request.commandId ? { commandId: request.commandId } : {}), result }));
  } });
  const payload = { model: 'native-resolved[1m]', reasoningEffort: 'max', expectedModel: 'native-old', expectedReasoningEffort: 'high', expectedScope: scope };
  const params = { sessionId: scope.nativeConversationId, expectedOwnerGeneration: scope.ownerGeneration, expectedExecutionToken: scope.queryToken, payload };
  const context = { expectedGeneration: scope.ownerGeneration, expectedHostId: scope.hostId, expectedQueryToken: scope.queryToken };
  return { runtime, rpc, backend: new ClaudeDesktopBackend({ rpc }), state, scope, params, payload, context };
}

test('readonly backend catalogue read reaches only its exact native controls route without loading history', async () => {
  const f = fixture(); f.runtime.readOnly = true; f.runtime.mutationAllowed = false;
  const controls = await f.backend.command('original-session', 'read-controls', {}, 'read-controls-id', f.context);
  assert.equal(controls.model.available, false); assert.equal(controls.model.current.model, 'native-old');
  assert.deepEqual(f.state.calls.map((/** @type {Value} */ row) => row.method), ['owner.status', 'code.controls']);
  await assert.rejects(f.backend.command('original-session', 'update-settings', f.payload, 'settings-update-id', f.context), { code: 'native-read-only', effectMayHaveOccurred: false });
  assert.equal(f.state.calls.length, 2);
});

test('settings RPC rejects false read classification, foreign scope, arbitrary fields and unstable ID before network', async () => {
  const f = fixture();
  await assert.rejects(f.rpc.call('code.settings', f.params), { code: 'invalid-settings', effectMayHaveOccurred: false });
  await assert.rejects(f.rpc.call('code.settings', f.params, { mutation: true, commandId: 'bad' }), { code: 'invalid-settings', effectMayHaveOccurred: false });
  await assert.rejects(f.rpc.call('code.settings', { ...f.params, provider: 'injected' }, { mutation: true, commandId: 'stable-settings-id' }), { code: 'invalid-settings' });
  await assert.rejects(f.rpc.call('code.settings', { ...f.params, payload: { ...f.payload, expectedScope: { ...f.scope, nativeConversationId: 'foreign' } } },
    { mutation: true, commandId: 'stable-settings-id' }), { code: 'invalid-settings' });
  assert.equal(f.state.calls.length, 0);
});

test('backend returns effective scoped settings with both ACKs and preserves the stable command ID', async () => {
  const f = fixture(), reply = await f.backend.command('original-session', 'update-settings', f.payload, 'stable-settings-id', f.context);
  assert.equal(reply.nativeSettingsEvidence.effectiveModel, 'native-resolved[1m]'); assert.equal(reply.nativeSettingsEvidence.effectiveReasoningEffort, 'high');
  assert.equal(reply.settingsReadbackConfirmed, true); assert.equal(f.state.calls.length, 3);
  assert.equal(f.state.calls[2].commandId, 'stable-settings-id'); assert.deepEqual(f.state.calls[2].params.payload.expectedScope, f.scope);
});

test('legacy readonly owner has no optional catalogue RPC advertisement and native tail remains usable', async () => {
  const f = fixture(); f.runtime.readOnly = true; f.runtime.mutationAllowed = false; delete f.state.declaredMethods;
  assert.equal(f.backend.supportsNativeModelSettings, false); await f.backend.status(); assert.equal(f.backend.supportsNativeModelSettings, false);
  const view = await f.backend.freshSnapshot('original-session'); assert.equal(view.nativeReadOnly, true); assert.equal(view.ownerGeneration, 'original-owner');
  await assert.rejects(f.backend.command('original-session', 'read-controls', {}, 'legacy-controls-id', f.context), { code: 'unsupported-action', effectMayHaveOccurred: false });
  assert.equal(f.state.calls.filter((/** @type {Value} */ row) => row.method === 'code.controls').length, 0);
});

test('only an explicit matching owner epoch and collection enable read-controls; epoch drift and status failure revoke it', async () => {
  const f = fixture(); await f.backend.status(); assert.equal(f.backend.supportsNativeModelSettings, true);
  f.runtime.generation = 'replacement-owner'; await f.rpc.runtime(); assert.equal(f.backend.supportsNativeModelSettings, false);
  f.state.statusEpoch = 'original-main'; await f.backend.status(); assert.equal(f.backend.supportsNativeModelSettings, false);
  delete f.state.statusEpoch; f.state.declaredMethods = ['cowork.controls']; await f.backend.status(); assert.equal(f.backend.supportsNativeModelSettings, false);
  f.state.declaredMethods = ['code.controls']; await f.backend.status(); assert.equal(f.backend.supportsNativeModelSettings, true);
  f.state.statusFailure = true; await f.backend.status(); assert.equal(f.backend.supportsNativeModelSettings, false);
});

test('an invalid owner status method list cannot advertise model reads', async () => {
  const f = fixture(); f.state.declaredMethods = ['code.controls', 'owner.resolveGateway']; await f.backend.status();
  assert.equal(f.backend.supportsNativeModelSettings, false);
});

test('partial native ACK remains delivery-unknown after a possible update; backend never redispatches', async () => {
  const f = fixture(); f.state.partial = true;
  await assert.rejects(f.backend.command('original-session', 'update-settings', f.payload, 'stable-settings-id', f.context), { code: 'delivery-unknown', effectMayHaveOccurred: true });
  assert.equal(f.state.calls.filter((/** @type {Value} */ row) => row.method === 'code.settings').length, 1);
});
