import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravitySettings } from '../src/adapters/antigravity-settings.mjs';
import { AntigravityBackend, projectAntigravityTrajectory } from '../src/adapters/antigravity-backend.mjs';
import { antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';
import { NativeHappyConnector } from '../src/codelync/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';

/** @typedef {Record<string,any>} Value */
const owner = 'antigravity:fixture-owner';
const runtime = { binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server', home: '/fixture/home', appDataDir: 'fixture', generation: owner };
/** @returns {Value} */
function modelCatalogue() { return { clientModelConfigs: [
  { modelId: 'catalog-a', label: 'Source A', modelOrAlias: { model: 'MODEL_A' } },
  { modelId: 'catalog-b', label: 'Source B', modelOrAlias: { model: 'MODEL_B' } },
  { modelId: 'disabled', label: 'Disabled', modelOrAlias: { model: 'MODEL_C' }, disabled: true },
], defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_A' } } }; }
/** @returns {Value} */
function commandCatalogue() { return { commands: [
  { info: { name: 'goal', type: 'SLASH_COMMAND_TYPE_SYSTEM', modelFacingText: 'Native fixture instruction' }, description: 'Source goal' },
  { info: { name: 'compact', type: 'SLASH_COMMAND_TYPE_SYSTEM' }, description: 'Desktop action' },
  { info: { name: 'fixture-skill', type: 'SLASH_COMMAND_TYPE_SKILL', definitionPath: '/private/native/skill.md', modelFacingText: 'Native skill instruction' }, description: 'Source skill' },
] }; }
function fixture() {
  /** @type {Value[]} */ const calls = [];
  let generation = owner;
  const reply = /** @type {Value} */ ({ status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 1, trajectory: { trajectoryId: 'fixture-trajectory', cascadeId: 'fixture-cascade', metadata: { workspaceUris: ['file:///fixture'] }, steps: [
    { status: 'CORTEX_STEP_STATUS_DONE', userInput: { items: [{ text: 'Old fixture input' }], userConfig: { plannerConfig: { planModel: 'MODEL_A' } } } },
  ] } });
  const rpc = { latestRuntime: runtime, runtime: async () => runtime, generation: () => generation, dispose: async () => {},
    call: async (/** @type {string} */ method, /** @type {Value} */ body = {}, /** @type {Value} */ options = {}) => {
      calls.push({ method, body, options });
      if (method === 'GetCascadeTrajectory') return structuredClone(reply);
      if (method === 'GetCascadeModelConfigData') return modelCatalogue();
      if (method === 'GetSlashCommands') return commandCatalogue();
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { 'fixture-cascade': { status: reply.status, stepCount: reply.numTotalSteps, lastModifiedTime: String(reply.numTotalSteps) } } };
      if (method === 'SendUserCascadeMessage') {
        reply.trajectory.steps.push({ status: 'CORTEX_STEP_STATUS_DONE', userInput: { items: body.items, clientMessageId: body.clientMessageId,
          userConfig: { plannerConfig: { planModel: body.cascadeConfig?.plannerConfig.requestedModel.model ?? 'MODEL_A' } } } });
        reply.numTotalSteps++; return {};
      }
      throw Error('Unexpected native fixture request');
    } };
  const settings = new AntigravitySettings({ rpc, readVersion: async () => '2.31.2' });
  return { rpc, settings, reply, calls, changeOwner: () => { generation = 'antigravity:replacement-owner'; } };
}

test('source controls expose only native models, version and remotely usable commands without native definitions', async () => {
  const f = fixture(), view = projectAntigravityTrajectory('fixture-cascade', f.reply, owner);
  const controls = await f.settings.read('fixture-cascade', view, { expectedHostId: antigravityHostId(runtime) });
  assert.equal(controls.compatibility.appVersion, '2.31.2'); assert.ok(controls.model.current); assert.equal(controls.model.current.model, 'catalog-a');
  assert.deepEqual(controls.model.models.map((/** @type {Value} */ model) => model.id), ['catalog-a', 'catalog-b']);
  assert.equal(controls.model.selectionMode, 'next-message');
  assert.deepEqual(controls.commands.items.map((/** @type {Value} */ command) => command.name), ['goal', 'fixture-skill']);
  assert.equal(JSON.stringify(controls).includes('/private/native'), false);
  assert.ok(f.calls.every(call => call.options.expectedHostId === antigravityHostId(runtime)));
  const unverified = new AntigravitySettings({ rpc: f.rpc, readVersion: async () => '3.0.0' });
  assert.equal((await unverified.read('fixture-cascade', view)).model.available, false);
  const unknown = { ...view, nativeModel: null };
  const missingCurrent = await f.settings.read('fixture-cascade', unknown);
  assert.equal(missingCurrent.model.current, null); assert.equal(missingCurrent.model.available, false);
});

test('model validation never writes a native preference or sends a prompt; dispatch freezes the exact native model', async () => {
  const f = fixture(), view = projectAntigravityTrajectory('fixture-cascade', f.reply, owner);
  const choice = await f.settings.validate('fixture-cascade', view, { model: 'catalog-b', reasoningEffort: null });
  assert.equal(choice.staged, true); assert.equal(choice.applied, false); assert.deepEqual(choice.nativeIdentity, { model: 'MODEL_B' });
  assert.equal(f.calls.some(call => call.method === 'SendUserCascadeMessage' || call.method === 'SetUserSettings'), false);
  const message = await f.settings.message('fixture-cascade', view, { text: 'Explicit input', model: 'catalog-b', modelIdentity: choice.nativeIdentity });
  assert.deepEqual(message.cascadeConfig, { plannerConfig: { requestedModel: { model: 'MODEL_B' } } });
  await assert.rejects(f.settings.message('fixture-cascade', view, { text: 'Explicit input', model: 'catalog-b', modelIdentity: { model: 'MODEL_A' } }), { code: 'settings-conflict' });
  await assert.rejects(f.settings.validate('fixture-cascade', view, { model: 'disabled', reasoningEffort: null }), { code: 'unsupported-model-settings' });
});

test('slash dispatch uses the original native scope item and blocks a desktop-only command before dispatch', async () => {
  const f = fixture(), view = projectAntigravityTrajectory('fixture-cascade', f.reply, owner);
  const message = await f.settings.message('fixture-cascade', view, { text: '/fixture-skill user argument' });
  assert.equal(message.items[0].item.slashCommand.info.definitionPath, '/private/native/skill.md');
  assert.deepEqual(message.items[1], { text: 'user argument' });
  await assert.rejects(f.settings.message('fixture-cascade', view, { text: '/compact' }), { code: 'unsupported-action' });
  const visible = structuredClone(f.reply); visible.trajectory.steps[0].userInput.items = message.items;
  const projected = projectAntigravityTrajectory('fixture-cascade', visible, owner);
  assert.equal(projected.rows[0].text, '/fixture-skill user argument');
  assert.equal(JSON.stringify(projected).includes('/private/native'), false);
});

class Transport extends EventEmitter {
  sessionId = 'source-settings-fixture';
  /** @type {Map<string,(params:Value)=>Promise<Value>>} */ handlers = new Map();
  /** @type {Value} */ metadata = {};
  /** @type {Value[]} */ inbox = [];
  async start() {}
  status() { return { pendingInbox: this.inbox.length, pendingOutbox: 0 }; }
  listInbox() { return this.inbox; }
  async ackInbox(/** @type {string} */ id) { this.inbox = this.inbox.filter(item => item.id !== id); }
  registerRpc(/** @type {string} */ method, /** @type {(params:Value)=>Promise<Value>} */ handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method); }
  async updateMetadata(/** @type {(value:Value)=>Value} */ update) { this.metadata = update(this.metadata); }
  async updateAgentState() {}
  async publish(/** @type {string} */ localId) { return { id: localId }; }
}
/** @param {()=>boolean} condition */
async function until(condition) { const end = Date.now() + 6000; while (!condition()) { if (Date.now() > end) throw Error('Fixture state was not confirmed'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('encrypted source staging survives connector restart and is consumed only by one explicitly admitted native message', async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'antigravity-settings-'));
  const backend = new AntigravityBackend({ rpc: f.rpc, settings: f.settings, historyIndex: false });
  const transport = new Transport();
  const options = { transport, adapter: backend, nativeId: 'fixture-cascade', sourceIdentity: { app: 'antigravity', id: 'fixture-cascade', hostId: antigravityHostId(runtime), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: owner },
    bindingId: 'fixture-model-binding', encryptionKey: new Uint8Array(32).fill(3), statePath: join(directory, 'projection.json'), assertLease: () => true, getGeneration: () => f.rpc.generation() };
  const create = async () => new NativeHappyConnector({ ...options, receipts: await CommandReceipts.load(join(directory, 'receipts.json')) });
  let connector = await create();
  try {
    await connector.start(); await until(() => transport.metadata.nativeControls?.model?.available === true);
    const update = transport.handlers.get('codex-controls-update'); assert.ok(update);
    const result = await update({ commandId: 'source-model-stage-once', model: 'catalog-b', reasoningEffort: null, expectedModel: 'catalog-a', expectedReasoningEffort: null });
    assert.equal(result.receipt.result.staged, true); assert.equal(result.receipt.result.applied, false);
    await assert.rejects(update({ commandId: 'source-model-stale-choice', model: 'catalog-a', reasoningEffort: null, expectedModel: 'catalog-a', expectedReasoningEffort: null }), { code: 'settings-conflict' });
    assert.equal(f.calls.filter(call => call.method === 'SendUserCascadeMessage').length, 0);
    assert.equal((await readFile(options.statePath, 'utf8')).includes('catalog-b'), false);
    await connector.close(); connector = await create(); await connector.start();
    await until(() => transport.metadata.nativeControls?.model?.selectionState === 'staged');
    assert.equal(transport.metadata.nativeControls.model.current.model, 'catalog-b');
    transport.inbox = [{ id: 'explicit-source-input', localId: 'phone-input-stable', record: { role: 'user', content: { type: 'text', text: 'Explicit fixture input' } } }];
    await connector.processInbox();
    const calls = f.calls.filter(call => call.method === 'SendUserCascadeMessage');
    assert.equal(calls.length, 1); assert.equal(calls[0].body.cascadeConfig.plannerConfig.requestedModel.model, 'MODEL_B');
    transport.inbox = [{ id: 'explicit-source-input', localId: 'phone-input-stable', record: { role: 'user', content: { type: 'text', text: 'Explicit fixture input' } } }];
    await connector.processInbox(); assert.equal(f.calls.filter(call => call.method === 'SendUserCascadeMessage').length, 1);
    await until(() => transport.metadata.nativeControls?.model?.selectionState === 'native');
    assert.equal(transport.metadata.nativeControls.model.current.model, 'catalog-b');
  } finally { await connector.close(); await backend.dispose(); await rm(directory, { recursive: true, force: true }); }
});
