import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNativeToolInput, projectNativeToolInput } from '@codelync/wire/codelync';
import { projectAntigravityTrajectory } from '../src/adapters/antigravity-backend.mjs';
import { NativeHappyConnector } from '../src/codelync/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';

/** @typedef {Record<string,any>} Value */
class Transport extends EventEmitter {
  sessionId = 'native-tool-fixture';
  /** @type {Value[]} */ records = [];
  async start() {}
  listInbox() { return []; }
  status() { return { pendingInbox: 0, pendingOutbox: 0 }; }
  registerRpc() { return () => {}; }
  async updateMetadata() {}
  async updateAgentState() {}
  async publish(/** @type {string} */ localId, /** @type {Value} */ record) { this.records.push(record); return { id: localId }; }
}

test('ordinary native tool input is bounded plain JSON and never evaluates an accessor', () => {
  assert.equal(isNativeToolInput({ Path: '/isolated/input.json', options: [true, null, 1] }), true);
  let read = false;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { read = true; return 'not-json'; } });
  const cycle = /** @type {Value} */ ({}); cycle.self = cycle;
  for (const value of [accessor, cycle, { fn() {} }, { value: NaN }, JSON.parse('{"__proto__":{}}'), { [Symbol('private')]: true }, { content: 'x'.repeat(65537) }]) assert.equal(isNativeToolInput(value), false);
  assert.equal(read, false);
  assert.deepEqual(projectNativeToolInput({ content: 'x'.repeat(65537) }), { inputUnavailable: true });
});

test('sanitized real read/write shapes retain ordinary input through the selected native recent DTO', async () => {
  const reply = JSON.parse(await readFile(new URL('./fixtures/native-antigravity-tools.json', import.meta.url), 'utf8'));
  let view = projectAntigravityTrajectory('fixture-cascade', reply, 'fixture-owner');
  const transport = new Transport(), directory = await mkdtemp(join(tmpdir(), 'native-tool-input-'));
  const adapter = { snapshot: async () => view, freshSnapshot: async () => view, subscribe: async (/** @type {string} */ _id, /** @type {(value:Value)=>void} */ callback) => { callback(view); return () => {}; },
    command: async () => { throw Error('This projection must never dispatch a native command'); } };
  const connector = new NativeHappyConnector({ transport, adapter, nativeId: 'fixture-cascade', sourceIdentity: { app: 'codex', id: 'fixture-cascade', hostId: 'local' }, bindingId: 'native-tool-fixture',
    encryptionKey: new Uint8Array(32).fill(6), statePath: join(directory, 'checkpoint.json'), receipts: await CommandReceipts.load(join(directory, 'receipts.json')),
    getGeneration: () => 'fixture-owner', assertLease: () => true, supportsNativeProjection: true });
  try {
    await connector.start();
    const recent = await connector.readRecent();
    const read = recent.rows.find((/** @type {Value} */ row) => row.tools?.[0]?.name === 'read_file').tools[0];
    const write = recent.rows.find((/** @type {Value} */ row) => row.tools?.[0]?.name === 'write_file').tools[0];
    assert.deepEqual(read.input, { Path: '/isolated/codelync-qa/input.json' }); assert.equal(read.arguments, undefined);
    assert.deepEqual(write.input, { Path: '/isolated/codelync-qa/result.json', Content: '{"sum":42}\n', Overwrite: true });
    reply.trajectory.steps[2].metadata.toolCall.argumentsJson = JSON.stringify({ Path: '/isolated/codelync-qa/result.json', Content: 'Updated native input', Overwrite: true });
    view = projectAntigravityTrajectory('fixture-cascade', reply, 'fixture-owner');
    await connector.project(view);
    const revision = transport.records.findLast(record => record.content.ev.t === 'native-row-upsert');
    assert.equal(revision?.content.ev.tools[0].input.Content, 'Updated native input');
  } finally { await connector.close(); await rm(directory, { recursive: true, force: true }); }
});
