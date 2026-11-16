import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCommandReceipts } from '../src/adapters/claude-command-receipts.mjs';

test('duplicate native IDs share admission and conflicting payloads never dispatch', async () => {
  const receipts = new ClaudeCommandReceipts(); let calls = 0;
  const invoke = async () => { calls++; return { sessionId: 'local_fixture' }; };
  const first = receipts.admit('create-probe-01', 'code.create', { cwd: '/fixture' }, invoke);
  const second = receipts.admit('create-probe-01', 'code.create', { cwd: '/fixture' }, invoke);
  assert.equal(first, second);
  assert.throws(() => receipts.admit('create-probe-01', 'code.create', { cwd: '/other' }, invoke), error => error instanceof Error && error.message === 'command-id-conflict' && /** @type {Error & {effectMayHaveOccurred?:boolean}} */ (error).effectMayHaveOccurred === false);
  assert.deepEqual(await first, { sessionId: 'local_fixture' }); assert.equal(calls, 1);
});

test('timeout retains native work; later readback gets the same receipt without replay', async () => {
  const receipts = new ClaudeCommandReceipts(); let calls = 0;
  /** @type {(value:Record<string,any>)=>void} */ let resolve = () => {};
  const native = new Promise(done => { resolve = done; });
  const first = receipts.admit('send-probe-01', 'code.send', { sessionId: 'local_fixture' }, async () => { calls++; return native; });
  await assert.rejects(receipts.wait(first, 5), error => error instanceof Error && error.message === 'native-operation-timeout' && /** @type {Error & {effectMayHaveOccurred?:boolean}} */ (error).effectMayHaveOccurred === true);
  resolve({ admitted: true });
  const later = receipts.admit('send-probe-01', 'code.send', { sessionId: 'local_fixture' }, async () => { calls++; return {}; });
  assert.deepEqual(await later, { admitted: true }); assert.equal(calls, 1);
});
