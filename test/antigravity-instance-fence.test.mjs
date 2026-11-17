import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityRpcClient, antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';
import { SourceImageAdapter } from '../src/codelync/bound-source.mjs';

/** @typedef {Record<string,any>} Value */
const original = { version: 1, pid: 42, binary: '/Applications/Antigravity.app/Contents/Resources/bin/language_server', home: '/private/original', appDataDir: 'antigravity', generation: 'owner-a', csrfToken: 'fixture-only', origin: 'http://127.0.0.1:12345' };
const copied = { ...original, binary: '/private/probe/Antigravity Probe.app/Contents/Resources/bin/language_server', home: '/private/probe/home', generation: 'owner-b' };

test('a bound instance cannot read or mutate an equal conversation ID in a replacement namespace', async () => {
  let dispatched = 0;
  const rpc = new AntigravityRpcClient({ readRuntime: async () => copied,
    fetch: async () => { dispatched++; return new Response('{}'); } });
  const expectedHostId = antigravityHostId(original);
  for (const mutation of [false, true]) {
    await assert.rejects(rpc.call('GetCascadeTrajectory', { cascadeId: 'same-native-id' }, { expectedHostId, mutation }),
      error => /** @type {Value} */ (error).code === 'source-epoch-changed' && /** @type {Value} */ (error).effectMayHaveOccurred === false);
  }
  assert.equal(dispatched, 0);
});

test('a namespace change after native dispatch remains unknown', async () => {
  let reads = 0, dispatched = 0;
  const rpc = new AntigravityRpcClient({ readRuntime: async () => ++reads === 1 ? original : copied,
    fetch: async () => { dispatched++; return new Response('{}'); } });
  await assert.rejects(rpc.call('SendUserCascadeMessage', {}, { expectedHostId: antigravityHostId(original), mutation: true }), { code: 'delivery-unknown' });
  assert.equal(dispatched, 1);
});

test('the bound projection carries its namespace and refuses foreign frames and generation', async () => {
  const hostId = antigravityHostId(original);
  let currentHost = hostId;
  /** @type {Value|null} */ let received = null;
  const native = { hostId: () => currentHost, generation: () => 'owner-a',
    snapshot: async (/** @type {string} */ _id, /** @type {Value} */ context) => { received = context; return { rows: [], status: 'idle' }; },
    command: async (/** @type {string} */ _id, /** @type {string} */ _action, /** @type {Value} */ _payload, /** @type {string} */ _commandId, /** @type {Value} */ context) => { received = context; return {}; } };
  const adapter = new SourceImageAdapter(native, /** @type {any} */ ({}), { app: 'antigravity', kind: 'session', hostId });
  await adapter.snapshot('same-native-id'); assert.equal((/** @type {Value|null} */ (received))?.expectedHostId, hostId);
  await adapter.command('same-native-id', 'send', { text: 'fixture' }, 'fixture-command', { expectedGeneration: 'owner-a', expectedHostId: 'forged' });
  assert.equal((/** @type {Value|null} */ (received))?.expectedHostId, hostId);
  currentHost = antigravityHostId(copied);
  assert.equal(adapter.generation('same-native-id'), null);
  await assert.rejects(adapter.snapshot('same-native-id'), { code: 'source-epoch-changed' });
});
