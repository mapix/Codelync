import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeNativeSettings, claudeNativeModels, claudeNativeCommands } from '../src/adapters/claude-settings.mjs';
import { projectClaudeBridgeResult } from '../src/adapters/claude-diagnostics.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {unknown} error @param {string} code @param {boolean} effect */
function failure(error, code, effect) { return error instanceof Error && error.message === code
  && /** @type {Error & {effectMayHaveOccurred?:boolean}} */ (error).effectMayHaveOccurred === effect; }
/** Existing native owner/query fixture, with explicit readback and ACKs.
 * @param {Value} [options] */
function fixture(options = {}) {
  const value = /** @type {Value} */ ({ sessionId: 'native-settings-session', cliSessionId: 'native-cli', backend: { kind: 'local' },
    model: 'native-old', effort: 'high', modelChangeSeq: 0, modelRecordSeq: 0, isRunning: false });
  const state = /** @type {Value} */ ({ value, model: 'native-old', effort: 'high', controls: [], reads: 0, beforeIpc: null,
    modelAck: true, effortAck: true, replaceAfterAck: false, supersede: false, readEffort: true });
  const models = [{ value: 'native-old', displayName: 'Original' }, { value: 'native-alias', displayName: 'Alias', resolvedModel: 'native-alias[1m]' },
    { value: 'native-alias[1m]', displayName: 'Native context' }, { value: 'same-native-alias', resolvedModel: 'native-old', displayName: 'Native same model alias' }];
  for (const row of models) Object.assign(row, { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });
  state.models = models;
  const mode = { clampSessionEffort: (_kind = 'code', _model = '', effort = 'high') => effort === 'max' ? 'high' : effort };
  const query = /** @type {Value} */ ({
    supportedModels: async () => models,
    supportedCommands: async () => [{ name: 'help', description: 'Native help', privateDefinition: 'not public' }],
    getContextUsage: async () => { state.reads++; return { model: state.model, privateUsage: { body: 'not public' } }; },
    getSettings: async () => { state.reads++; return { applied: state.readEffort ? { effort: state.effort } : {} }; },
    setModel: async (/** @type {string} */ model) => {
      state.controls.push({ method: 'set_model', model });
      state.modelStarted?.(); if (state.modelWait && model.startsWith('native-alias')) await state.modelWait;
      if (!state.modelAck) throw Error('native-model-refused');
      state.model = state.cliAliasControl && model === 'native-alias' ? 'native-alias[1m]' : model;
      if (state.replaceAfterAck) value.query = {};
    },
    applyFlagSettings: async (/** @type {Value} */ flags) => { state.controls.push({ method: 'apply_flag_settings', ...flags });
      if (!state.effortAck) throw Error('native-effort-refused'); state.effort = flags.effortLevel ?? null; },
  });
  value.query = query;
  const manager = /** @type {Value} */ ({ sessions: new Map([[value.sessionId, value]]) });
  manager.sessionModelSettings = { applyModelChange: async (/** @type {Value} */ record, /** @type {string} */ model) => {
    record.modelChangeSeq++;
    const seq = record.modelChangeSeq;
    await record.query.setModel(model);
    if (record.modelChangeSeq !== seq) return;
    record.model = model; record.modelConfirmed = { model }; record.modelRecordSeq = record.modelChangeSeq;
    if (state.supersede) { record.modelChangeSeq++; record.modelRecordSeq++; }
  } };
  manager.sessionModelSettings.deps = { getSession: (/** @type {string} */ id) => manager.sessions.get(id) };
  manager.setModel = async (/** @type {string} */ id, /** @type {string} */ model) => {
    assert.equal(id, value.sessionId); if (state.modelVoid) return;
    return manager.sessionModelSettings.applyModelChange(value, model === 'native-alias' && !state.cliAliasControl ? 'native-alias[1m]' : model);
  };
  manager.setEffort = async (/** @type {string} */ id, /** @type {string|null} */ effort) => {
    assert.equal(id, value.sessionId); if (state.effortVoid) return;
    value.effort = state.forceEffort ?? mode.clampSessionEffort('code', value.model, effort ?? undefined);
    await value.query.applyFlagSettings({ effortLevel: value.effort });
  };
  const original = { model: manager.setModel, effort: manager.setEffort, applyModelChange: manager.sessionModelSettings.applyModelChange,
    queryModel: query.setModel, queryEffort: query.applyFlagSettings };
  const base = /** @type {Value} */ ({ app: 'claude-desktop', appMode: 'code', nativeCollection: 'claude-code-sessions', nativeConversationId: value.sessionId,
    hostId: 'native-host', ownerGeneration: 'native-owner', runtimeGeneration: 'native-runtime', queryToken: 'original-query', cliSessionId: value.cliSessionId });
  const api = { getSession: async () => ({ sessionId: value.sessionId, isRunning: state.active === true, turnRunning: false,
    hasBackgroundActivity: false, hasBackgroundWork: false, starting: false }),
  setModel: async (/** @type {string} */ id, /** @type {string} */ model) => { state.beforeIpc?.(); return manager.setModel(id, model); },
  setEffort: async (/** @type {string} */ id, /** @type {string|null} */ effort) => { state.beforeIpc?.(); return manager.setEffort(id, effort); } };
  const settings = new ClaudeNativeSettings({ manager, api: () => api, mode: () => mode, scope: () => ({ ...base }),
    assertCurrent: (record, captured) => { if (manager.sessions.get(value.sessionId) !== record || record.query !== captured || captured !== query)
      throw Object.assign(Error('stale-query'), { effectMayHaveOccurred: false }); }, writeVerified: true, readOnly: false, ...options });
  state.request = async () => { const controls = await settings.read(value); return { model: 'native-alias', reasoningEffort: 'max',
    expectedModel: controls.model.current?.model, expectedReasoningEffort: controls.model.current?.reasoningEffort, expectedScope: controls.scope }; };
  state.restored = () => { assert.equal(manager.setModel, original.model); assert.equal(manager.setEffort, original.effort);
    assert.equal(manager.sessionModelSettings.applyModelChange, original.applyModelChange); assert.equal(query.setModel, original.queryModel); assert.equal(query.applyFlagSettings, original.queryEffort); };
  return { settings, value, state, query, manager, base };
}

test('readonly catalogues are native and complete while model writes remain unavailable before any Query call', async () => {
  const f = fixture({ readOnly: true }), controls = await f.settings.read(f.value), before = f.state.reads;
  assert.equal(controls.model.catalogComplete, true); assert.equal(controls.commands.complete, true); assert.equal(controls.model.available, false);
  assert.deepEqual(controls.model.current, { model: 'native-old', reasoningEffort: 'high', modelProvider: 'claude-desktop' });
  await assert.rejects(f.settings.update(f.value, {}), error => failure(error, 'native-read-only', false));
  assert.equal(f.state.reads, before); assert.deepEqual(f.state.controls, []);
});

test('default settings gate refuses writes and header picks never invent initial confirmation', async () => {
  const f = fixture({ writeVerified: false }); f.state.readEffort = false;
  const controls = await f.settings.read(f.value); assert.equal(controls.model.current, null); assert.equal(controls.model.currentConfirmed, false);
  assert.equal(controls.model.selectionMode, 'original-owner'); assert.equal(controls.model.selectionState, undefined);
  assert.equal(controls.commands.items[0].execution, 'unsupported');
  await assert.rejects(f.settings.update(f.value, {}), /native-settings-gate-unverified/); assert.deepEqual(f.state.controls, []);
});

test('private effort probe confirms and restores effort while public model writes and alias mutation stay closed', async () => {
  const f = fixture({ writeVerified: false, probeIdleEffort: true }), request = await f.state.request();
  assert.equal((await f.settings.read(f.value)).model.available, false);
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'native-model-settings-gate-unverified', false));
  request.model = request.expectedModel; request.reasoningEffort = 'medium';
  const result = await f.settings.update(f.value, request);
  assert.equal(result.settingsReadbackConfirmed, true); assert.equal(result.controls.model.available, false);
  assert.equal(result.nativeSettingsEvidence.effectiveModel, 'native-old'); assert.equal(result.nativeSettingsEvidence.effectiveReasoningEffort, 'medium');
  assert.deepEqual(f.state.controls, [{ method: 'apply_flag_settings', effortLevel: 'medium' }]);
  const restored = await f.settings.update(f.value, { ...request, reasoningEffort: 'high', expectedReasoningEffort: 'medium', expectedScope: result.controls.scope });
  assert.equal(restored.nativeSettingsEvidence.effectiveReasoningEffort, 'high'); assert.equal(restored.controls.model.available, false);
  f.state.restored();
});

test('unchanged model keeps independent native record and change sequences after an earlier superseded attempt', async () => {
  const f = fixture(); f.value.modelChangeSeq = 2; f.value.modelRecordSeq = 1;
  const request = await f.state.request(); request.model = request.expectedModel;
  const result = await f.settings.update(f.value, request); assert.equal(result.settingsReadbackConfirmed, true);
  assert.deepEqual(result.controls.nativeRecordSequences, { modelChangeSeq: 2, modelRecordSeq: 1 });
});

test('failed existing Query command read has no broad facade or temporary Query fallback', async () => {
  const f = fixture(); f.query.supportedCommands = async () => { throw Error('native read failed'); };
  const controls = await f.settings.read(f.value); assert.equal(controls.model.catalogComplete, true); assert.equal(controls.commands.complete, false);
  assert.deepEqual(controls.commands.items, []); assert.deepEqual(f.state.controls, []);
});

test('an empty native record command cache cannot suppress the current Query catalogue', async () => {
  const f = fixture(); f.value.liveSlashCommands = [];
  const controls = await f.settings.read(f.value); assert.equal(controls.commands.complete, true);
  assert.equal(controls.commands.items[0].name, 'help');
});

test('separate same-Query ACKs preserve native resolved alias and actual clamped effort', async () => {
  const f = fixture(), request = await f.state.request(), result = await f.settings.update(f.value, request);
  assert.equal(result.settingsReadbackConfirmed, true); assert.equal(result.nativeSettingsEvidence.effectiveModel, 'native-alias[1m]');
  assert.equal(result.nativeSettingsEvidence.effectiveReasoningEffort, 'high'); assert.deepEqual(result.nativeSettingsEvidence.expectedScope, request.expectedScope);
  assert.equal(result.nativeSettingsEvidence.confirmedScope.settingsToken, result.controls.scope.settingsToken);
  assert.notEqual(result.controls.scope.settingsToken, request.expectedScope.settingsToken);
  assert.deepEqual(f.state.controls, [{ method: 'set_model', model: 'native-alias[1m]' }, { method: 'apply_flag_settings', effortLevel: 'high' }]); f.state.restored();
});

test('catalogue and record drift reject the displayed digest before native dispatch', async () => {
  const f = fixture(), request = await f.state.request(); f.value.modelRecordSeq++;
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'settings-conflict', false));
  assert.deepEqual(f.state.controls, []); f.state.restored();
});

test('query drift after the controls read is refused before the synchronous owner delegate', async () => {
  const f = fixture(), request = await f.state.request(), read = f.settings.read.bind(f.settings);
  f.settings.read = async value => { const result = await read(value); f.value.query = {}; return result; };
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'stale-query', false));
  assert.deepEqual(f.state.controls, []); f.state.restored();
});

test('void model facade never confirms a model ACK or invokes the effort setter', async () => {
  const f = fixture(), request = await f.state.request(); f.state.modelVoid = true;
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'native-settings-ack-unconfirmed', true));
  assert.deepEqual(f.state.controls, []); f.state.restored();
});

test('partial effort refusal and replaced Query after ACK retain effect uncertainty', async () => {
  const f = fixture(), request = await f.state.request(); f.state.effortAck = false;
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'native-effort-refused', true));
  assert.equal(f.state.controls.length, 2); f.state.restored();
  const g = fixture(), next = await g.state.request(); g.state.replaceAfterAck = true;
  await assert.rejects(g.settings.update(g.value, next), error => failure(error, 'stale-query', true));
  assert.equal(g.state.controls.length, 1); g.state.restored();
});

test('superseded native model sequence cannot produce a complete settings receipt', async () => {
  const f = fixture(), request = await f.state.request(); f.state.supersede = true;
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'settings-superseded', true));
  assert.equal(f.state.controls.filter((/** @type {Value} */ row) => row.method === 'apply_flag_settings').length, 0); f.state.restored();
});

test('foreign native superseding model calls pass unchanged and stop the owned operation before effort', async () => {
  const f = fixture(), request = await f.state.request(); let release = () => {}, started = () => {};
  f.state.modelWait = new Promise(resolve => { release = () => resolve(undefined); });
  const ready = new Promise(resolve => { started = () => resolve(undefined); }); f.state.modelStarted = started;
  const operation = f.settings.update(f.value, request); await ready;
  await f.manager.setModel(f.value.sessionId, 'native-foreign');
  assert.equal(f.value.model, 'native-foreign'); release();
  await assert.rejects(operation, error => failure(error, 'settings-superseded', true));
  assert.equal(f.state.controls.filter((/** @type {Value} */ row) => row.method === 'set_model').length, 2);
  assert.equal(f.state.controls.filter((/** @type {Value} */ row) => row.method === 'apply_flag_settings').length, 0); f.state.restored();
});

test('missing ACK has bounded cleanup and a late native response cannot publish confirmation or revive busy', async () => {
  const f = fixture({ ackTimeoutMs: 20 }), request = await f.state.request(); let release = () => {};
  f.state.modelWait = new Promise(resolve => { release = () => resolve(undefined); });
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'native-settings-ack-expired', true));
  f.state.restored(); assert.equal(f.settings.busy, false); assert.equal(f.settings.pending.size, 0);
  release(); await new Promise(resolve => setImmediate(resolve)); f.state.restored(); assert.equal(f.settings.busy, false);
  assert.equal(f.state.controls.filter((/** @type {Value} */ row) => row.method === 'apply_flag_settings').length, 0);
});

test('owner close revokes pending guards synchronously and late ACK cannot reopen the settings controller', async () => {
  const f = fixture(), request = await f.state.request(); let release = () => {}, started = () => {};
  f.state.modelWait = new Promise(resolve => { release = () => resolve(undefined); });
  const ready = new Promise(resolve => { started = () => resolve(undefined); }); f.state.modelStarted = started;
  const operation = f.settings.update(f.value, request); await ready; f.settings.close(); f.state.restored();
  await assert.rejects(operation, error => failure(error, 'native-settings-ack-expired', true));
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.settings.busy, false);
  await assert.rejects(f.settings.read(f.value), /native-bridge-deactivated/); f.state.restored();
});

test('active/workflow header retains catalogue reads but cannot enable idle-held settings writes', async () => {
  const f = fixture(); f.state.active = true; const request = await f.state.request();
  assert.equal((await f.settings.read(f.value)).model.available, false);
  await assert.rejects(f.settings.update(f.value, request), /settings-conflict/); assert.deepEqual(f.state.controls, []);
});

test('an unchanged native resolved alias inherits only actual same-Query model confirmation', async () => {
  const f = fixture(), request = await f.state.request(); request.model = 'same-native-alias';
  const result = await f.settings.update(f.value, request);
  assert.equal(result.settingsReadbackConfirmed, true); assert.equal(result.nativeSettingsEvidence.effectiveModel, 'native-old');
  assert.deepEqual(f.state.controls, [{ method: 'apply_flag_settings', effortLevel: 'high' }]);
});

test('a native CLI alias ACK maps to actual Query readback and keeps a resolved model selectable', async () => {
  const f = fixture(); f.state.cliAliasControl = true;
  f.state.models.splice(f.state.models.findIndex((/** @type {Value} */ row) => row.value === 'native-alias[1m]'), 1);
  const request = await f.state.request(), result = await f.settings.update(f.value, request);
  assert.equal(f.state.controls[0].model, 'native-alias'); assert.equal(result.nativeSettingsEvidence.effectiveModel, 'native-alias[1m]');
  assert.equal(result.controls.model.available, true); assert.equal(result.settingsReadbackConfirmed, true);
  assert.equal(result.controls.model.models.find((/** @type {Value} */ row) => row.id === 'native-alias').nativeResolvedModel, 'native-alias[1m]');
});

test('an actual native idle fence withdraws writes in the IPC gap before any setter entry', async () => {
  const f = fixture({ assertWritable: () => { if (f.state.hiddenActive) throw Object.assign(Error('native-settings-state-unverified'), { effectMayHaveOccurred: false }); } });
  const request = await f.state.request(), read = f.settings.read.bind(f.settings);
  f.settings.read = async value => { const result = await read(value); f.state.hiddenActive = true; return result; };
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'native-settings-state-unverified', false));
  assert.deepEqual(f.state.controls, []); f.state.restored();
});

test('diagnostic settings projection strips private native values and requires both scoped ACKs', async () => {
  const f = fixture(), request = await f.state.request(), result = await f.settings.update(f.value, request);
  result.controls.privateProvider = { apiKey: 'private-fixture-key' }; result.nativeSettingsEvidence.privateRef = f.query;
  const publicResult = projectClaudeBridgeResult('code.settings', result);
  assert.equal(publicResult.settingsReadbackConfirmed, true); assert.equal(JSON.stringify(publicResult).includes('private-fixture-key'), false);
  result.nativeSettingsEvidence.effortAckConfirmed = false;
  assert.equal(projectClaudeBridgeResult('code.settings', result).settingsReadbackConfirmed, false);
});

test('catalogue names stay bounded and malformed/duplicate identities do not claim completeness', () => {
  assert.equal(claudeNativeCommands([{ name: 'x' }, { name: 'x' }]).complete, false);
  assert.equal(claudeNativeCommands([{ name: '/injected' }]).complete, false);
  assert.equal(claudeNativeModels([{ id: 'x' }, { id: 'x' }], { clampSessionEffort: () => undefined }, 'code').complete, false);
  const mode = { clampSessionEffort: (_kind = '', _model = '', effort = 'high') => effort };
  const unknown = claudeNativeModels([{ value: 'unknown' }], mode, 'code'); assert.deepEqual(unknown.items[0].reasoningEfforts, []);
  assert.equal(unknown.items[0].effortCatalogComplete, false);
  const unsupported = claudeNativeModels([{ value: 'plain', supportsEffort: false }], mode, 'code');
  assert.deepEqual(unsupported.items[0].reasoningEfforts, []); assert.equal(unsupported.items[0].defaultReasoningEffort, null);
  const mismatch = claudeNativeModels([{ value: 'bad-default', supportsEffort: true, supportedEffortLevels: ['low', 'medium'] }],
    { clampSessionEffort: () => 'high' }, 'code');
  assert.equal(mismatch.complete, true); assert.deepEqual(mismatch.items[0].reasoningEfforts, []);
  assert.equal(mismatch.items[0].effortCatalogComplete, false); assert.equal(mismatch.items[0].defaultReasoningEffort, null);
});

test('an unsupported target effort model refuses the coupled update before either setter', async () => {
  const f = fixture(); f.state.models.find((/** @type {Value} */ row) => row.value === 'native-alias').supportsEffort = false;
  const request = await f.state.request();
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'native-effort-catalog-unavailable', false));
  assert.deepEqual(f.state.controls, []); f.state.restored();
});

test('a native clamped value changed in the IPC gap cannot reach the original Query effort request', async () => {
  const f = fixture(), request = await f.state.request(); request.model = request.expectedModel;
  f.state.forceEffort = 'low';
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'native-effort-policy-changed', true));
  assert.deepEqual(f.state.controls, []); f.state.restored();
});

test('settings enter the existing owner delegate without a delayed renderer setter request', async () => {
  const f = fixture(), request = await f.state.request(); let calls = 0;
  f.settings.options.api = () => ({ getSession: async () => ({ sessionId: f.value.sessionId, isRunning: false, turnRunning: false, hasBackgroundActivity: false, hasBackgroundWork: false }),
    setModel: () => { calls++; throw Error('renderer queue must not be used'); }, setEffort: () => { calls++; throw Error('renderer queue must not be used'); } });
  const result = await f.settings.update(f.value, request); assert.equal(result.settingsReadbackConfirmed, true); assert.equal(calls, 0);
});

test('the admitted native record token refuses an effort change made after the controls read', async () => {
  const f = fixture(), request = await f.state.request(); request.model = request.expectedModel;
  const read = f.settings.read.bind(f.settings);
  f.settings.read = async value => { const result = await read(value); f.value.effort = 'low'; return result; };
  await assert.rejects(f.settings.update(f.value, request), error => failure(error, 'settings-conflict', false));
  assert.deepEqual(f.state.controls, []); f.state.restored();
});
