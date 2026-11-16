import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDesktopBackend } from '../src/adapters/claude-backend.mjs';
import { ClaudeDesktopRpcClient, claudeDesktopHostId } from '../src/adapters/claude-desktop-rpc.mjs';

/** @typedef {Record<string,any>} Value */
function fixture() {
  /** @type {Value} */ const runtime = { generation: 'native-main', storagePath: '/fixture/readonly', origin: 'http://127.0.0.1:5555', accessToken: 'synthetic', readOnly: true, mutationAllowed: false };
  /** @type {Value[]} */ const calls = [];
  /** @type {Value} */ const state = { runtimeReads: 0, statusReadOnly: true };
  const rpc = new ClaudeDesktopRpcClient({ readRuntime: async () => { state.runtimeReads++; return { ...runtime }; },
    fetch: async (_url, options) => {
      const request = JSON.parse(String(options?.body)); calls.push(request);
      const result = request.method === 'owner.status' ? { nativeOwner: true, readOnly: state.statusReadOnly, mutationAllowed: !state.statusReadOnly }
        : request.method === 'code.snapshot' ? { sessionId: 'native-session', ownerGeneration: 'native-owner', executionToken: 'native-query',
          header: { sessionId: 'native-session', sessionType: 'code', isRunning: true, turnRunning: true, queryPresent: true }, hasMore: false, messages: [],
          requests: [{ requestId: 'request', toolName: 'Write', input: { file_path: '/fixture/file', content: 'synthetic' }, operable: true }] } : {};
      return new Response(JSON.stringify({ version: 1, ok: true, ownerGeneration: runtime.generation, hostId: claudeDesktopHostId(runtime), result }));
    } });
  return { backend: new ClaudeDesktopBackend({ rpc }), rpc, runtime, calls, state };
}

test('explicit readonly manifest disables source commands, sends, cancellation and original permission actions', async () => {
  const f = fixture();
  const status = await f.backend.status(); assert.equal(status.readOnly, true); assert.equal(status.mutationAllowed, false);
  assert.deepEqual(f.backend.supportedActions, []); assert.equal(f.backend.supportsSourceCommands, false);
  const view = await f.backend.snapshot('native-session');
  assert.equal(view.nativeInput.sendSupported, false); assert.equal(view.nativeInput.canSend, false); assert.equal(view.nativeInput.canSteer, false);
  assert.equal(view.nativeCancel.available, false); assert.equal(view.nativeQuery.canSend, false); assert.equal(view.nativeQuery.canCancel, false);
  assert.equal(view.requests[0].operable, false); assert.deepEqual(view.requests[0].allowedActions, []);
  assert.equal(view.status, 'running'); assert.equal(view.ownerGeneration, 'native-owner');
});

test('a stale writable UI callback reads current runtime and refuses commands before native admission', async () => {
  const f = fixture(); f.runtime.readOnly = false; f.runtime.mutationAllowed = true; f.state.statusReadOnly = false;
  await f.rpc.runtime(); assert.ok(f.backend.supportedActions.includes('send'));
  f.runtime.readOnly = true; f.runtime.mutationAllowed = false;
  const before = f.calls.length, reads = f.state.runtimeReads;
  await assert.rejects(f.backend.command('native-session', 'send', { text: 'must not send' }, 'stable-operation'), { code: 'native-read-only' });
  assert.ok(f.state.runtimeReads > reads); assert.equal(f.calls.length, before);
  await assert.rejects(f.backend.stopTask('native-session', 'task', 'stable-task-op', { scope: {} }), { code: 'native-read-only' });
  assert.equal(f.calls.length, before);
});

test('readonly RPC is a closed data allowlist even if a mutation is falsely tagged as a read', async () => {
  const f = fixture();
  for (const method of ['code.send', 'code.interrupt', 'code.permission', 'code.setModel', 'cowork.send']) {
    await assert.rejects(f.rpc.call(method), error => !!error && /** @type {Value} */ (error).code === 'native-read-only' && /** @type {Value} */ (error).effectMayHaveOccurred === false);
  }
  assert.equal(f.calls.length, 0);
  await f.rpc.call('code.list'); assert.equal(f.calls.length, 1);
});

test('owner readonly status denies capabilities when a legacy manifest has no mode marker; a manifest denial wins status disagreement', async () => {
  const f = fixture(); delete f.runtime.readOnly; delete f.runtime.mutationAllowed;
  await f.backend.status(); assert.equal(f.backend.readOnly, true); assert.deepEqual(f.backend.supportedActions, []);
  await assert.rejects(f.rpc.call('code.send', {}, { mutation: true, commandId: 'readonly-op' }), { code: 'native-read-only' });
  f.runtime.readOnly = true; f.runtime.mutationAllowed = false; f.state.statusReadOnly = false;
  await f.backend.status(); assert.equal(f.backend.readOnly, true); assert.deepEqual(f.backend.supportedActions, []);
});
