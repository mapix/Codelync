import test from 'node:test';
import assert from 'node:assert/strict';
import { codexAppInfoPaths, readCodexAppVersion, readNativeCodexCatalogue } from '../src/adapters/codex-catalog.mjs';
import { CodexBackend } from '../src/adapters/codex-backend.mjs';
import { CodexIpcAdapter } from '../src/adapters/codex-ipc.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */
const info = { CFBundleIdentifier: 'com.openai.codex', CFBundleShortVersionString: '26.1103.60933' };
const app = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
const catalogue = (/** @type {Value} */ options) => readNativeCodexCatalogue({ hostId: options.hostId, ownerGeneration: options.ownerGeneration, modelAvailable: options.modelAvailable, readVersion: async () => info.CFBundleShortVersionString });

test('desktop version follows its actual process bundle identity, excluding helper and CLI lookalikes', async () => {
  assert.deepEqual(codexAppInfoPaths(`${app}\n/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper\n/usr/bin/codex\n`), ['/Applications/ChatGPT.app/Contents/Info.plist']);
  const version = await readCodexAppVersion({ processes: async () => app, readInfo: async path => { assert.equal(path, '/Applications/ChatGPT.app/Contents/Info.plist'); return info; } });
  assert.equal(version, '26.1103.60933');
  assert.equal(await readCodexAppVersion({ processes: async () => app, readInfo: async () => ({ ...info, CFBundleIdentifier: 'foreign-app' }) }), null);
  assert.equal(await readCodexAppVersion({ processes: async () => `${app}\n/private/Copy.app/Contents/MacOS/Codex`, readInfo: async () => info }), null);
});

test('source commands remain version-bound, partial and separate from model-picker/native-action semantics', async () => {
  const supported = await catalogue({ hostId: 'local', ownerGeneration: 'local:owner', modelAvailable: true });
  assert.equal(supported.commands.available, true);
  assert.equal(supported.commands.complete, false);
  assert.equal(supported.commands.skillsAvailable, false);
  assert.equal(supported.commands.items.find(command => command.name === 'compact')?.execution, 'native-action');
  assert.equal(supported.commands.items.find(command => command.name === 'model')?.execution, 'model-picker');
  assert.equal(supported.commands.items.find(command => command.name === 'goal')?.execution, 'unsupported');
  const future = await readNativeCodexCatalogue({ hostId: 'local', ownerGeneration: 'local:owner', readVersion: async () => 'future-version' });
  assert.equal(future.compatibility.supported, true); assert.equal(future.commands.available, false); assert.deepEqual(future.commands.items, []);
  const remote = await readNativeCodexCatalogue({ hostId: 'remote', ownerGeneration: 'remote:owner', readVersion: async () => { throw Error('A remote source cannot borrow local app version'); } });
  assert.equal(remote.compatibility.appVersion, null); assert.equal(remote.commands.available, false);
});

function nativeFixture() {
  const calls = /** @type {Value[]} */ ([]);
  let view = { rows: [], requests: [], currentTurnId: /** @type {string|null} */ (null), latestTurnId: null, status: 'idle', revision: null, ownerGeneration: 'local:owner' };
  let reply = /** @type {Value} */ ({ result: { ok: true } });
  const ipc = { hostId: 'local', generation: () => 'local:owner', compact: async (/** @type {string} */ id, /** @type {string} */ commandId, /** @type {string} */ epoch) => { calls.push({ id, commandId, epoch }); return reply; }, dispose: () => {} };
  const backend = new CodexBackend({ ipc: /** @type {any} */ (ipc), readSourceCatalogue: catalogue });
  backend.freshSnapshot = async () => view;
  return { backend, calls, active: () => { view = { ...view, currentTurnId: 'original-turn', status: 'running' }; }, changeOwner: () => { view = { ...view, ownerGeneration: 'local:other' }; }, badAck: () => { reply = { result: {} }; } };
}

test('compact dispatches only the exact native action and confirms request acceptance, never a text prompt', async () => {
  const f = nativeFixture();
  const response = await f.backend.command('original-session', 'source-command', { name: 'compact', arguments: '' }, 'native-compact-once', { expectedGeneration: 'local:owner' });
  assert.deepEqual(response, { acknowledged: true, requested: true, commandName: 'compact' });
  assert.deepEqual(f.calls, [{ id: 'original-session', commandId: 'native-compact-once', epoch: 'local:owner' }]);
  await assert.rejects(f.backend.command('original-session', 'source-command', { name: 'swarm', arguments: '' }, 'foreign-command'), { code: 'unsupported-action' });
  await assert.rejects(f.backend.command('original-session', 'source-command', { name: 'compact', arguments: 'model input' }, 'unexpected-arguments'), { code: 'unsupported-action' });
  assert.equal(f.calls.length, 1);
});

test('active and stale Codex owners block compaction before dispatch; malformed native ACK stays unknown', async () => {
  const active = nativeFixture(); active.active();
  await assert.rejects(active.backend.command('s', 'source-command', { name: 'compact', arguments: '' }, 'active-source'), { code: 'stale-turn' }); assert.equal(active.calls.length, 0);
  const stale = nativeFixture(); stale.changeOwner();
  await assert.rejects(stale.backend.command('s', 'source-command', { name: 'compact', arguments: '' }, 'stale-source', { expectedGeneration: 'local:owner' }), { code: 'source-epoch-changed' }); assert.equal(stale.calls.length, 0);
  const uncertain = nativeFixture(); uncertain.badAck();
  await assert.rejects(uncertain.backend.command('s', 'source-command', { name: 'compact', arguments: '' }, 'lost-native-confirmation'), { code: 'delivery-unknown' }); assert.equal(uncertain.calls.length, 1);
});

test('compact follower frames use the shipped native version and duplicate IDs do not dispatch again', async () => {
  const ipc = new CodexIpcAdapter();
  ipc.routingOwner = async () => ({ sessionId: 's', hostId: 'local', ownerClientId: 'owner', supportsUntrustedAppInput: false });
  const frames = /** @type {Value[]} */ ([]);
  ipc.write = frame => { frames.push(frame); queueMicrotask(() => ipc.handle({ type: 'response', method: frame.method, requestId: frame.requestId, resultType: 'success', result: { ok: true }, handledByClientId: 'owner' })); };
  await ipc.compact('s', 'same-command'); await ipc.compact('s', 'same-command');
  assert.equal(frames.length, 1); assert.equal(frames[0].method, 'thread-follower-compact-thread'); assert.equal(frames[0].version, 1);
  assert.deepEqual(frames[0].params, { conversationId: 's' });
  await assert.rejects(ipc.compact('s', 'same-command', 'other-owner'), error => error instanceof BridgeError && error.code === 'command-conflict');
  ipc.dispose();
});
